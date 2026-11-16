import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { isSameOriginRequest, readJsonBody, validIdempotencyKey } from '@/lib/api/request';
import { getDatabase, databaseIsConfigured } from '@/lib/db/postgres';
import { IdempotencyConflict, requestFingerprint, withIdempotency } from '@/lib/db/idempotency';
import { canSubmitBid, type TaskStatus } from '@/lib/marketplace/domain';
import { recordTaskChange } from '@/lib/marketplace/audit';
import { createBidSchema } from '@/lib/validation/marketplace';
import { nearToYocto, yoctoToNearNumber } from '@/lib/validation/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type TaskRow = { id: string; owner_user_id: string | null; status: TaskStatus; budget_yocto: string; capabilities: string[] };
type AgentRow = { id: string; owner_user_id: string; name: string; account_id: string; capabilities: string[]; availability: 'available' | 'busy' | 'offline'; is_active: boolean };
type BidRow = { id: string; task_id: string; agent_id: string; agent_name: string; agent_account_id: string; amount_yocto: string; eta_hours: number; capability_score: number; proposal: { text?: string }; status: string; bidder_user_id: string; created_at: Date };

function bidDto(bid: BidRow) {
  return { id: bid.id, taskId: bid.task_id, agentId: bid.agent_id, agent: bid.agent_name, agentAccountId: bid.agent_account_id,
    amountNear: yoctoToNearNumber(bid.amount_yocto), amountYocto: bid.amount_yocto, etaHours: Number(bid.eta_hours),
    capabilityScore: Number(bid.capability_score), proposal: bid.proposal?.text || '', status: bid.status, createdAt: bid.created_at };
}

export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
  const { taskId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) return NextResponse.json({ error: 'Invalid task ID.' }, { status: 400 });
  try {
    const sql = getDatabase();
    const [task] = await sql<{ owner_user_id: string | null; selected_agent_id: string | null; status: TaskStatus }[]>`
      select t.owner_user_id::text, t.selected_agent_id::text, t.status from public.tasks t where t.id = ${taskId}::uuid
    `;
    if (!task) return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
    const isOwner = task.owner_user_id === auth.user.id;
    const isAssignedAgent = task.selected_agent_id ? Boolean((await sql<{ id: string }[]>`
      select id::text from public.agents where id = ${task.selected_agent_id}::uuid and owner_user_id = ${auth.user.id}::uuid
    `)[0]) : false;
    if (!isOwner && !isAssignedAgent && task.status !== 'open' && task.status !== 'bidding') return NextResponse.json({ error: 'You cannot access bids for this task.' }, { status: 403 });
    const rows = isOwner
      ? await sql<BidRow[]>`
          select b.id::text,b.task_id::text,b.agent_id::text,a.name as agent_name,a.account_id as agent_account_id,
                 b.amount_yocto::text,b.eta_hours,b.capability_score,b.proposal,b.status,b.bidder_user_id::text,b.created_at
          from public.bids b join public.agents a on a.id=b.agent_id where b.task_id=${taskId}::uuid order by b.created_at asc
        `
      : await sql<BidRow[]>`
          select b.id::text,b.task_id::text,b.agent_id::text,a.name as agent_name,a.account_id as agent_account_id,
                 b.amount_yocto::text,b.eta_hours,b.capability_score,b.proposal,b.status,b.bidder_user_id::text,b.created_at
          from public.bids b join public.agents a on a.id=b.agent_id where b.task_id=${taskId}::uuid and b.bidder_user_id=${auth.user.id}::uuid
          order by b.created_at asc
        `;
    return NextResponse.json({ bids: rows.map(bidDto), isOwner }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Bids could not be loaded. Confirm migration 003 is applied.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'Cross-origin writes are not allowed.' }, { status: 403 });
  const { taskId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) return NextResponse.json({ error: 'Invalid task ID.' }, { status: 400 });
  const key = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(key)) return NextResponse.json({ error: 'A valid Idempotency-Key UUID is required.' }, { status: 400 });
  const body = await readJsonBody(request, 12_288);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const parsed = createBidSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid bid.', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400 });
  const hash = requestFingerprint(parsed.data);

  try {
    const sql = getDatabase();
    const result = await sql.begin(async (transaction) => withIdempotency(transaction, {
      actorUserId: auth.user.id, key, operation: `task.bid:${taskId}`, requestHash: hash,
    }, async () => {
      const [task] = await transaction<TaskRow[]>`
        select id::text,owner_user_id::text,status,budget_yocto::text,capabilities
        from public.tasks where id=${taskId}::uuid for update
      `;
      if (!task) throw new Error('task_not_found');
      if (!task.owner_user_id) throw new Error('task_has_no_owner');
      if (task.owner_user_id === auth.user.id) throw new Error('owner_cannot_bid');
      const [agent] = await transaction<AgentRow[]>`
        select id::text,owner_user_id::text,name,account_id,capabilities,availability,is_active
        from public.agents where id=${parsed.data.agentId}::uuid and owner_user_id=${auth.user.id}::uuid for update
      `;
      if (!agent) throw new Error('agent_not_owned');
      if (!agent.account_id) throw new Error('agent_near_account_required');
      const [existingBid] = await transaction<{ id: string }[]>`
        select id::text from public.bids where task_id=${taskId}::uuid and agent_id=${agent.id}::uuid
      `;
      const bidAmountYocto = nearToYocto(parsed.data.amountNear);
      if (!canSubmitBid({ taskStatus: task.status, taskOwnerId: task.owner_user_id, bidderId: auth.user.id,
        agentActive: agent.is_active, agentAvailability: agent.availability, alreadyBid: Boolean(existingBid), bidYocto: BigInt(bidAmountYocto), budgetYocto: BigInt(task.budget_yocto) })) {
        throw new Error('bid_not_allowed');
      }
      const required = task.capabilities.map((item) => item.toLowerCase());
      const actual = new Set(agent.capabilities.map((item) => item.toLowerCase()));
      const score = required.length === 0 ? 100 : Math.round(required.filter((item) => actual.has(item)).length / required.length * 100);
      const [bid] = await transaction<BidRow[]>`
        insert into public.bids (task_id,agent_id,bidder_user_id,amount_yocto,eta_hours,capability_score,proposal,status,idempotency_key)
        values (${taskId}::uuid,${agent.id}::uuid,${auth.user.id}::uuid,${bidAmountYocto}::numeric(39,0),${parsed.data.etaHours},${score},
          ${transaction.json({ text: parsed.data.proposal })},'pending',${key}::uuid)
        returning id::text,task_id::text,agent_id::text,${agent.name}::text as agent_name,${agent.account_id}::text as agent_account_id,
          amount_yocto::text,eta_hours,capability_score,proposal,status,bidder_user_id::text,created_at
      `;
      if (task.status === 'open') {
        await transaction`update public.tasks set status='bidding' where id=${taskId}::uuid and status='open'`;
        await recordTaskChange(transaction, { taskId, actorUserId: auth.user.id, sender: 'marketplace', eventType: 'task.bidding',
          summary: 'Task entered bidding after its first offer', idempotencyKey: `task-bidding:${key}`, payload: { from: 'open', to: 'bidding' } });
      }
      await recordTaskChange(transaction, { taskId, actorUserId: auth.user.id, sender: 'marketplace', eventType: 'bid.submitted',
        summary: 'Agent submitted a bid', idempotencyKey: `bid:${key}`, payload: { bidId: bid.id, agentId: agent.id, amountYocto: bidAmountYocto, etaHours: parsed.data.etaHours, capabilityScore: score, taskStatus: task.status === 'open' ? 'bidding' : task.status } });
      return bidDto(bid);
    }));
    return NextResponse.json({ bid: result.value, replayed: result.replayed }, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof IdempotencyConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return NextResponse.json({ error: 'This agent already bid on this task.' }, { status: 409 });
    if (error instanceof Error) {
      const responses: Record<string, [string, number]> = {
        task_not_found: ['Task not found.', 404], owner_cannot_bid: ['Task owners cannot bid on their own tasks.', 403],
        task_has_no_owner: ['This legacy task has no authenticated owner and cannot accept bids.', 409],
        agent_not_owned: ['Register or select an agent owned by your account.', 403], agent_near_account_required: ['Add a NEAR payout account to the agent before bidding.', 409],
        bid_not_allowed: ['The task is closed, the agent is unavailable, or the bid exceeds the task budget.', 409],
      };
      const response = responses[error.message];
      if (response) return NextResponse.json({ error: response[0] }, { status: response[1] });
    }
    return NextResponse.json({ error: 'Bid could not be saved. Confirm migration 003 is applied.' }, { status: 500 });
  }
}
