import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { isSameOriginRequest, readJsonBody, validIdempotencyKey } from '@/lib/api/request';
import { IdempotencyConflict, requestFingerprint, withIdempotency } from '@/lib/db/idempotency';
import { databaseIsConfigured, getDatabase } from '@/lib/db/postgres';
import { recordTaskChange } from '@/lib/marketplace/audit';
import { canTransitionTask, type TaskStatus, type WorkflowActor } from '@/lib/marketplace/domain';
import { taskTransitionSchema } from '@/lib/validation/marketplace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'Cross-origin writes are not allowed.' }, { status: 403 });
  const { taskId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) return NextResponse.json({ error: 'Invalid task ID.' }, { status: 400 });
  const key = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(key)) return NextResponse.json({ error: 'A valid Idempotency-Key UUID is required.' }, { status: 400 });
  const body = await readJsonBody(request, 8192);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const parsed = taskTransitionSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid task transition.', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400 });

  try {
    const sql = getDatabase();
    const result = await sql.begin(async (transaction) => withIdempotency(transaction, {
      actorUserId: auth.user.id, key, operation: `task.transition:${taskId}`, requestHash: requestFingerprint(parsed.data),
    }, async () => {
      const [task] = await transaction<{ id: string; owner_user_id: string | null; selected_agent_id: string | null; status: TaskStatus }[]>`
        select id::text,owner_user_id::text,selected_agent_id::text,status from public.tasks where id=${taskId}::uuid for update
      `;
      if (!task) throw new Error('task_not_found');
      const isOwner = task.owner_user_id === auth.user.id;
      const [agent] = task.selected_agent_id ? await transaction<{ id: string; owner_user_id: string | null }[]>`
        select id::text,owner_user_id::text from public.agents where id=${task.selected_agent_id}::uuid
      ` : [];
      const isAssignedAgent = agent?.owner_user_id === auth.user.id;
      const actor: WorkflowActor = isOwner ? 'owner' : isAssignedAgent ? 'assigned_agent' : 'other';
      if (!canTransitionTask(task.status, parsed.data.to, actor)) throw new Error('transition_not_allowed');

      if (parsed.data.to === 'disputed') {
        await transaction`
          insert into public.disputes(task_id,opened_by_user_id,reason,status)
          values (${taskId}::uuid,${auth.user.id}::uuid,${parsed.data.note},'open')
        `;
      }
      const [updated] = await transaction<{ status: TaskStatus }[]>`
        update public.tasks set status=${parsed.data.to}
        where id=${taskId}::uuid and status=${task.status}
        returning status
      `;
      if (!updated) throw new Error('transition_conflict');
      if (parsed.data.to === 'cancelled' || parsed.data.to === 'disputed') {
        await transaction`update public.agent_runs set status='cancelled',stage='cancelled',error_code='task_not_executable',finished_at=coalesce(finished_at,now())
          where id in (select run_id from public.agent_execution_jobs where task_id=${taskId}::uuid and status='running' and run_id is not null) and status='running'`;
        await transaction`update public.agent_execution_jobs set status='cancelled',execution_stage='cancelled',finished_at=now(),last_error_code='task_not_executable',
          lease_token=null,lease_expires_at=null,locked_by=null,locked_at=null,heartbeat_at=null
          where task_id=${taskId}::uuid and status in ('queued','retry','running')`;
        await transaction`update public.bids set status='rejected' where task_id=${taskId}::uuid and status='pending'`;
      }
      if (task.selected_agent_id && (parsed.data.to === 'completed' || parsed.data.to === 'cancelled')) {
        const [active] = await transaction<{ exists: boolean }[]>`
          select exists(select 1 from public.tasks where selected_agent_id=${task.selected_agent_id}::uuid and id<>${taskId}::uuid and status in ('assigned','in_progress','submitted','verified','approved')) as exists
        `;
        if (!active?.exists) await transaction`update public.agents set availability='available',status='idle' where id=${task.selected_agent_id}::uuid and is_active=true`;
      }
      await recordTaskChange(transaction, { taskId, actorUserId: auth.user.id, sender: actor === 'assigned_agent' ? 'worker' : 'owner',
        eventType: `task.${parsed.data.to}`, summary: `Task transitioned to ${parsed.data.to}`, idempotencyKey: `transition:${key}`,
        payload: { from: task.status, to: parsed.data.to, note: parsed.data.note } });
      return { taskId, from: task.status, to: updated.status };
    }));
    return NextResponse.json({ transition: result.value, replayed: result.replayed }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof IdempotencyConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof Error && error.message === 'task_not_found') return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
    if (error instanceof Error && ['transition_not_allowed','transition_conflict'].includes(error.message)) return NextResponse.json({ error: 'You are not allowed to make that task status transition.' }, { status: 409 });
    return NextResponse.json({ error: 'Task state could not be changed. Confirm migration 003 is applied.' }, { status: 500 });
  }
}
