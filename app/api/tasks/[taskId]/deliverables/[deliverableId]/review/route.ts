import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { isSameOriginRequest, readJsonBody, validIdempotencyKey } from '@/lib/api/request';
import { IdempotencyConflict, requestFingerprint, withIdempotency } from '@/lib/db/idempotency';
import { databaseIsConfigured, getDatabase } from '@/lib/db/postgres';
import { recordTaskChange } from '@/lib/marketplace/audit';
import { deliverableReviewResult } from '@/lib/marketplace/domain';
import { reviewDeliverableSchema } from '@/lib/validation/marketplace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string; deliverableId: string }> }) {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'Cross-origin writes are not allowed.' }, { status: 403 });
  const { taskId, deliverableId } = await context.params;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(taskId) || !uuid.test(deliverableId)) return NextResponse.json({ error: 'Invalid task or deliverable ID.' }, { status: 400 });
  const key = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(key)) return NextResponse.json({ error: 'A valid Idempotency-Key UUID is required.' }, { status: 400 });
  const body = await readJsonBody(request, 12_288);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const parsed = reviewDeliverableSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid review decision.', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400 });

  try {
    const sql = getDatabase();
    const result = await sql.begin(async (transaction) => withIdempotency(transaction, {
      actorUserId: auth.user.id, key, operation: `deliverable.review:${taskId}:${deliverableId}`, requestHash: requestFingerprint(parsed.data),
    }, async () => {
      const [task] = await transaction<{ id: string; owner_user_id: string | null; selected_agent_id: string | null; status: string }[]>`
        select id::text,owner_user_id::text,selected_agent_id::text,status from public.tasks where id=${taskId}::uuid for update
      `;
      if (!task) throw new Error('task_not_found');
      if (task.owner_user_id !== auth.user.id) throw new Error('not_task_owner');
      const [deliverable] = await transaction<{ id: string; agent_id: string; revision: number; status: string; content: { title?: string } }[]>`
        select id::text,agent_id::text,revision,status,content from public.deliverables where id=${deliverableId}::uuid and task_id=${taskId}::uuid for update
      `;
      if (!deliverable) throw new Error('deliverable_not_found');
      const [latest] = await transaction<{ revision: number }[]>`
        select max(revision)::int as revision from public.deliverables where task_id=${taskId}::uuid and agent_id=${deliverable.agent_id}::uuid
      `;
      if (latest.revision !== deliverable.revision) throw new Error('not_latest_deliverable');
      const transition = deliverableReviewResult(deliverable.status, parsed.data.decision);
      if (!transition) throw new Error('review_not_allowed');
      const expectedTaskStatus = parsed.data.decision === 'verify' ? 'submitted' : parsed.data.decision === 'approve' ? 'verified' : ['submitted','verified'].includes(task.status) ? task.status : '';
      if (task.status !== expectedTaskStatus) throw new Error('review_task_state_mismatch');
      const [updatedTask] = await transaction<{ status: string }[]>`
        update public.tasks set status=${transition.taskStatus} where id=${taskId}::uuid and status=${task.status} returning status
      `;
      if (!updatedTask) throw new Error('review_task_state_mismatch');
      await transaction`
        update public.deliverables set status=${transition.deliverableStatus},verification_evidence=coalesce(verification_evidence,'[]'::jsonb)||${transaction.json(parsed.data.evidence)}::jsonb,
          review_note=${parsed.data.note || null},reviewed_by_user_id=${auth.user.id}::uuid,reviewed_at=now(),verifier_notes=${transaction.json({ note: parsed.data.note })}
        where id=${deliverableId}::uuid and task_id=${taskId}::uuid
      `;
      await transaction`
        insert into public.deliverable_reviews(task_id,deliverable_id,owner_user_id,decision,note,evidence,idempotency_key)
        values (${taskId}::uuid,${deliverableId}::uuid,${auth.user.id}::uuid,${parsed.data.decision},${parsed.data.note},${transaction.json(parsed.data.evidence)},${key}::uuid)
      `;
      if (parsed.data.decision === 'reject') await transaction`
        insert into public.disputes(task_id,opened_by_user_id,reason,status)
        values (${taskId}::uuid,${auth.user.id}::uuid,${parsed.data.note},'open')
      `;
      await recordTaskChange(transaction, { taskId, actorUserId: auth.user.id, sender: 'owner', eventType: `deliverable.${parsed.data.decision}`,
        summary: parsed.data.decision === 'approve' ? 'Owner explicitly approved the deliverable' : `Owner marked the deliverable ${parsed.data.decision.replace('_',' ')}`,
        idempotencyKey: `deliverable-review:${key}`, payload: { deliverableId, revision: deliverable.revision, note: parsed.data.note, evidenceCount: parsed.data.evidence.length, taskTransition: { from: task.status, to: updatedTask.status } } });
      if (task.selected_agent_id && ['request_revision','reject','approve'].includes(parsed.data.decision)) await transaction`
        insert into public.notifications(user_id,task_id,notification_type,title,body,idempotency_key)
        select owner_user_id,${taskId}::uuid,${`deliverable.${parsed.data.decision}`},${parsed.data.decision === 'approve' ? 'Deliverable approved' : parsed.data.decision === 'reject' ? 'Deliverable rejected' : 'Revision requested'},${parsed.data.note},${`review:${key}:agent`}
        from public.agents where id=${task.selected_agent_id}::uuid
        on conflict (idempotency_key) do nothing
      `;
      return { taskId, deliverableId, revision: deliverable.revision, deliverableStatus: transition.deliverableStatus, taskStatus: updatedTask.status };
    }));
    return NextResponse.json({ review: result.value, replayed: result.replayed }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof IdempotencyConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return NextResponse.json({ error: 'This review has already been recorded.' }, { status: 409 });
    if (error instanceof Error) {
      const responses: Record<string, [string, number]> = {
        task_not_found: ['Task not found.', 404], not_task_owner: ['Only the task owner can review deliverables.', 403],
        deliverable_not_found: ['Deliverable not found.', 404], not_latest_deliverable: ['Review the latest deliverable revision.', 409],
        review_not_allowed: ['This deliverable can no longer receive that review decision.', 409], review_task_state_mismatch: ['Task state changed; reload before reviewing.', 409],
      };
      const response = responses[error.message];
      if (response) return NextResponse.json({ error: response[0] }, { status: response[1] });
    }
    return NextResponse.json({ error: 'Review could not be saved. Confirm migration 003 is applied.' }, { status: 500 });
  }
}
