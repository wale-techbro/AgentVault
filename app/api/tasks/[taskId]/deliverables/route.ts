import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { isSameOriginRequest, readJsonBody, validIdempotencyKey } from '@/lib/api/request';
import { IdempotencyConflict, requestFingerprint, withIdempotency } from '@/lib/db/idempotency';
import { databaseIsConfigured, getDatabase } from '@/lib/db/postgres';
import { recordTaskChange } from '@/lib/marketplace/audit';
import { submitDeliverableSchema } from '@/lib/validation/marketplace';

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
  const body = await readJsonBody(request, 96_000);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const parsed = submitDeliverableSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid deliverable.', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400 });

  try {
    const sql = getDatabase();
    const result = await sql.begin(async (transaction) => withIdempotency(transaction, {
      actorUserId: auth.user.id, key, operation: `deliverable.submit:${taskId}`, requestHash: requestFingerprint(parsed.data),
    }, async () => {
      const [task] = await transaction<{ id: string; owner_user_id: string | null; selected_agent_id: string | null; status: string }[]>`
        select id::text,owner_user_id::text,selected_agent_id::text,status from public.tasks where id=${taskId}::uuid for update
      `;
      if (!task) throw new Error('task_not_found');
      if (task.status !== 'in_progress' || !task.selected_agent_id) throw new Error('task_not_accepting_deliverable');
      const [agent] = await transaction<{ id: string; owner_user_id: string | null }[]>`
        select id::text,owner_user_id::text from public.agents where id=${task.selected_agent_id}::uuid
      `;
      if (!agent || agent.owner_user_id !== auth.user.id) throw new Error('not_assigned_agent');
      const [revisionRow] = await transaction<{ next_revision: number }[]>`
        select coalesce(max(revision),0)::int+1 as next_revision from public.deliverables where task_id=${taskId}::uuid and agent_id=${agent.id}::uuid
      `;
      const revision = revisionRow.next_revision;
      const [deliverable] = await transaction<{ id: string; revision: number; status: string; submitted_at: Date }[]>`
        insert into public.deliverables (task_id,agent_id,submitted_by_user_id,revision,content,metadata,verification_evidence,status,idempotency_key)
        values (${taskId}::uuid,${agent.id}::uuid,${auth.user.id}::uuid,${revision},
          ${transaction.json({ title: parsed.data.title, body: parsed.data.content })},${transaction.json(parsed.data.metadata)},
          ${transaction.json(parsed.data.evidence)},'submitted',${key}::uuid)
        returning id::text,revision,status,submitted_at
      `;
      const [updated] = await transaction<{ status: string }[]>`
        update public.tasks set status='submitted' where id=${taskId}::uuid and status='in_progress' returning status
      `;
      if (!updated) throw new Error('task_state_conflict');
      await transaction`update public.agent_runs set status='cancelled',stage='cancelled',error_code='task_not_executable',finished_at=coalesce(finished_at,now())
        where id in (select run_id from public.agent_execution_jobs where task_id=${taskId}::uuid and status='running' and run_id is not null) and status='running'`;
      await transaction`update public.agent_execution_jobs set status='cancelled',execution_stage='cancelled',finished_at=now(),last_error_code='task_not_executable',
        lease_token=null,lease_expires_at=null,locked_by=null,locked_at=null,heartbeat_at=null
        where task_id=${taskId}::uuid and status in ('queued','retry','running')`;
      await recordTaskChange(transaction, { taskId, actorUserId: auth.user.id, sender: 'worker', eventType: 'deliverable.submitted',
        summary: 'Assigned agent submitted a deliverable', idempotencyKey: `deliverable-submitted:${key}`,
        payload: { deliverableId: deliverable.id, revision, title: parsed.data.title, evidenceCount: parsed.data.evidence.length, taskTransition: { from: task.status, to: updated.status } } });
      if (task.owner_user_id) await transaction`
        insert into public.notifications(user_id,task_id,notification_type,title,body,idempotency_key)
        values (${task.owner_user_id}::uuid,${taskId}::uuid,'deliverable.submitted','Deliverable ready for review',${parsed.data.title},${`deliverable:${deliverable.id}:owner`})
        on conflict (idempotency_key) do nothing
      `;
      return { id: deliverable.id, taskId, revision, title: parsed.data.title, status: deliverable.status, submittedAt: deliverable.submitted_at };
    }));
    return NextResponse.json({ deliverable: result.value, replayed: result.replayed }, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof IdempotencyConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return NextResponse.json({ error: 'This deliverable submission was already recorded.' }, { status: 409 });
    if (error instanceof Error) {
      const responses: Record<string, [string, number]> = {
        task_not_found: ['Task not found.', 404], task_not_accepting_deliverable: ['Start the assigned task before submitting a deliverable.', 409],
        not_assigned_agent: ['Only the assigned agent can submit work for this task.', 403], task_state_conflict: ['Task status changed; refresh before retrying.', 409],
      };
      const response = responses[error.message];
      if (response) return NextResponse.json({ error: response[0] }, { status: response[1] });
    }
    return NextResponse.json({ error: 'Deliverable could not be saved. Confirm migration 003 is applied.' }, { status: 500 });
  }
}
