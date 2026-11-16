import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAuthenticatedUser } from '@/lib/auth';
import { isSameOriginRequest, readJsonBody, validIdempotencyKey } from '@/lib/api/request';
import { databaseIsConfigured, getDatabase } from '@/lib/db/postgres';
import { IdempotencyConflict, requestFingerprint, withIdempotency } from '@/lib/db/idempotency';
import { canAssignTask, canDecideBid, ownsAgent, type TaskStatus } from '@/lib/marketplace/domain';
import { recordTaskChange } from '@/lib/marketplace/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const decisionSchema = z.object({ decision: z.enum(['accept', 'reject']) });

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string; bidId: string }> }) {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'Cross-origin writes are not allowed.' }, { status: 403 });
  const { taskId, bidId } = await context.params;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(taskId) || !uuid.test(bidId)) return NextResponse.json({ error: 'Invalid task or bid ID.' }, { status: 400 });
  const key = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(key)) return NextResponse.json({ error: 'A valid Idempotency-Key UUID is required.' }, { status: 400 });
  const body = await readJsonBody(request, 2048);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const parsed = decisionSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid bid decision.' }, { status: 400 });

  try {
    const sql = getDatabase();
    const result = await sql.begin(async (transaction) => withIdempotency(transaction, {
      actorUserId: auth.user.id, key, operation: `task.bid-decision:${taskId}:${bidId}`, requestHash: requestFingerprint(parsed.data),
    }, async () => {
      const [task] = await transaction<{ id: string; owner_user_id: string | null; status: TaskStatus; selected_agent_id: string | null }[]>`
        select id::text,owner_user_id::text,status,selected_agent_id::text from public.tasks where id=${taskId}::uuid for update
      `;
      if (!task) throw new Error('task_not_found');
      const [bid] = await transaction<{ id: string; agent_id: string; bidder_user_id: string; status: 'pending' | 'selected' | 'rejected' | 'withdrawn'; amount_yocto: string; eta_hours: number }[]>`
        select id::text,agent_id::text,bidder_user_id::text,status,amount_yocto::text,eta_hours from public.bids where id=${bidId}::uuid and task_id=${taskId}::uuid for update
      `;
      if (!bid) throw new Error('bid_not_found');
      if (!canDecideBid({ actorId: auth.user.id, taskOwnerId: task.owner_user_id || '', taskStatus: task.status, bidStatus: bid.status, decision: parsed.data.decision })) {
        throw new Error('decision_not_allowed');
      }
      const [agent] = await transaction<{ id: string; name: string; account_id: string | null; owner_user_id: string | null; availability: 'available' | 'busy' | 'offline'; is_active: boolean }[]>`
        select id::text,name,account_id,owner_user_id::text,availability,is_active from public.agents where id=${bid.agent_id}::uuid for update
      `;
      if (!agent) throw new Error('agent_not_found');
      if (parsed.data.decision === 'accept') {
        if (!ownsAgent(agent.owner_user_id, bid.bidder_user_id)) throw new Error('bid_agent_owner_mismatch');
        if (!agent.is_active || agent.availability !== 'available' || !agent.account_id) throw new Error('agent_unavailable');
        if (!canAssignTask({ taskStatus: task.status, selectedAgentId: task.selected_agent_id, ownerId: task.owner_user_id, actorId: auth.user.id })) throw new Error('task_already_assigned');
        const [assigned] = await transaction<{ id: string }[]>`
          update public.tasks set selected_agent_id=${agent.id}::uuid,status='assigned'
          where id=${taskId}::uuid and owner_user_id=${auth.user.id}::uuid and status in ('open','bidding') and selected_agent_id is null
          returning id::text
        `;
        if (!assigned) throw new Error('task_already_assigned');
        await transaction`update public.bids set status=case when id=${bidId}::uuid then 'selected' else 'rejected' end where task_id=${taskId}::uuid and status='pending'`;
        await transaction`update public.agents set availability='busy',status='working' where id=${agent.id}::uuid`;
        const [run] = await transaction<{ id: string }[]>`
          insert into public.agent_runs (user_id,task_id,run_type,status,input)
          values (${auth.user.id}::uuid,${taskId}::uuid,'execution','queued',${transaction.json({ agentId: agent.id, bidId })})
          returning id::text
        `;
        await transaction`
          insert into public.agent_execution_jobs (task_id,run_id,job_type,status,idempotency_key,payload)
          values (${taskId}::uuid,${run.id}::uuid,'execute_task','queued',${`execute-task:${taskId}`},${transaction.json({ agentId: agent.id, bidId })})
          on conflict (idempotency_key) do nothing
        `;
        await recordTaskChange(transaction, { taskId, actorUserId: auth.user.id, sender: 'owner', eventType: 'task.assigned',
          summary: 'Owner accepted a bid and assigned an agent', idempotencyKey: `assignment:${key}`,
          payload: { bidId, agentId: agent.id, amountYocto: bid.amount_yocto, etaHours: bid.eta_hours, runId: run.id, from: task.status, to: 'assigned' } });
        await transaction`
          insert into public.agent_events (agent_id,actor_user_id,event_type,payload,idempotency_key)
          values (${agent.id}::uuid,${auth.user.id}::uuid,'agent.assigned',${transaction.json({ taskId, bidId })},${`assigned:${taskId}`})
          on conflict (agent_id,idempotency_key) where idempotency_key is not null do nothing
        `;
        return { taskId, status: 'assigned', selectedAgent: { id: agent.id, name: agent.name, nearAccountId: agent.account_id }, bidId, jobQueued: true };
      }
      await transaction`update public.bids set status='rejected' where id=${bidId}::uuid and status='pending'`;
      await recordTaskChange(transaction, { taskId, actorUserId: auth.user.id, sender: 'owner', eventType: 'bid.rejected',
        summary: 'Task owner rejected a bid', idempotencyKey: `bid-rejected:${key}`, payload: { bidId } });
      return { taskId, status: task.status, bidId, bidStatus: 'rejected' };
    }));
    return NextResponse.json({ result: result.value, replayed: result.replayed }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof IdempotencyConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof Error) {
      const responses: Record<string, [string, number]> = {
        task_not_found: ['Task not found.', 404], bid_not_found: ['Bid not found.', 404], agent_not_found: ['Agent profile not found.', 409],
        decision_not_allowed: ['Only the task owner can decide a pending bid while the task is open.', 409],
        agent_unavailable: ['The agent is unavailable or has no payout account.', 409], task_already_assigned: ['Another bid has already been assigned to this task.', 409],
        bid_agent_owner_mismatch: ['Bid owner no longer matches the agent owner.', 409],
      };
      const response = responses[error.message];
      if (response) return NextResponse.json({ error: response[0] }, { status: response[1] });
    }
    return NextResponse.json({ error: 'Bid decision could not be saved. Confirm migration 003 is applied.' }, { status: 500 });
  }
}
