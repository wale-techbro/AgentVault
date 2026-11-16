import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { databaseIsConfigured, getDatabase } from '@/lib/db/postgres';
import { createTaskSchema, nearToYocto } from '@/lib/validation/tasks';
import { isSameOriginRequest, readJsonBody, validIdempotencyKey } from '@/lib/api/request';
import { IdempotencyConflict, requestFingerprint, withIdempotency } from '@/lib/db/idempotency';
import { taskDto, type TaskRow } from '@/lib/marketplace/task-dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function serviceUnavailable(message: string, status = 503) {
  return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET() {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return serviceUnavailable(auth.error, auth.status);
  if (!databaseIsConfigured()) return serviceUnavailable('Database is not configured. Set DATABASE_URL on the server.');

  try {
    const sql = getDatabase();
    const rows = await sql<TaskRow[]>`
      select t.id::text, t.title, t.description, t.budget_yocto::text, t.capabilities,
             t.deadline_at, t.status, a.name as agent_name, a.account_id as agent_account_id, t.created_at,
             (select count(*)::int from public.bids b where b.task_id=t.id) as bid_count,
             t.owner_user_id::text as owner_user_id, (t.owner_user_id=${auth.user.id}::uuid) as is_mine, t.selected_agent_id::text as selected_agent_id
      from public.tasks t
      left join public.agents a on a.id = t.selected_agent_id
      where t.owner_user_id is not null and (
        t.status in ('open', 'bidding')
        or t.owner_user_id = ${auth.user.id}::uuid
        or exists (select 1 from public.agents mine where mine.id=t.selected_agent_id and mine.owner_user_id=${auth.user.id}::uuid)
      )
      order by t.created_at desc
      limit 100
    `;
    return NextResponse.json({ tasks: rows.map(taskDto) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return serviceUnavailable('Tasks could not be loaded. Confirm database connectivity and apply the migrations.', 500);
  }
}

export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return serviceUnavailable(auth.error, auth.status);
  if (!databaseIsConfigured()) return serviceUnavailable('Database is not configured. Set DATABASE_URL on the server.');
  if (!isSameOriginRequest(request)) return serviceUnavailable('Cross-origin task writes are not allowed.', 403);

  const idempotencyKey = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(idempotencyKey)) {
    return serviceUnavailable('A valid Idempotency-Key UUID is required.', 400);
  }

  const body = await readJsonBody(request);
  if (!body.ok) return serviceUnavailable(body.error, body.status);
  const parsed = createTaskSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid task details.', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const sql = getDatabase();
    const result = await sql.begin(async (transaction) => withIdempotency(transaction, {
      actorUserId: auth.user.id, key: idempotencyKey, operation: 'task.create', requestHash: requestFingerprint(parsed.data),
    }, async () => {
      const inserted = await transaction<TaskRow[]>`
        insert into public.tasks (owner_user_id, owner_near_account_id, title, description, budget_yocto, capabilities, deadline_at, status, idempotency_key)
        values (
          ${auth.user.id}::uuid,
          ${parsed.data.ownerNearAccountId || null},
          ${parsed.data.title},
          ${parsed.data.description},
          ${nearToYocto(parsed.data.budgetNear)}::numeric(39,0),
          ${transaction.array(parsed.data.capabilities)}::text[],
          ${parsed.data.deadlineAt || null}::timestamptz,
          'open',
          ${idempotencyKey}::uuid
        )
        on conflict (owner_user_id, idempotency_key) where idempotency_key is not null do nothing
        returning id::text, title, description, budget_yocto::text, capabilities, deadline_at, status, null::text as agent_name, null::text as agent_account_id, created_at, 0::int as bid_count, owner_user_id::text as owner_user_id, true as is_mine, selected_agent_id::text as selected_agent_id
      `;
      const created = inserted[0];
      const row = created || (await transaction<TaskRow[]>`
        select t.id::text, t.title, t.description, t.budget_yocto::text, t.capabilities, t.deadline_at, t.status,
               a.name as agent_name, a.account_id as agent_account_id, t.created_at,
               (select count(*)::int from public.bids b where b.task_id=t.id) as bid_count,
               t.owner_user_id::text as owner_user_id, t.owner_near_account_id, true as is_mine, t.selected_agent_id::text as selected_agent_id
        from public.tasks t left join public.agents a on a.id = t.selected_agent_id
        where t.owner_user_id = ${auth.user.id}::uuid and t.idempotency_key = ${idempotencyKey}::uuid
        limit 1
      `)[0];
      if (!row) throw new Error('task_insert_failed');
      if (!created) {
        const sameLegacyRequest = row.title === parsed.data.title
          && row.description === parsed.data.description
          && row.budget_yocto === nearToYocto(parsed.data.budgetNear)
          && row.owner_near_account_id === (parsed.data.ownerNearAccountId || null)
          && JSON.stringify(row.capabilities) === JSON.stringify(parsed.data.capabilities)
          && (row.deadline_at?.getTime() ?? null) === (parsed.data.deadlineAt ? new Date(parsed.data.deadlineAt).getTime() : null);
        if (!sameLegacyRequest) throw new IdempotencyConflict();
      }
      if (created) {
        await transaction`
          insert into public.task_events (task_id, sender, event_type, payload, actor_user_id, idempotency_key)
          values (${row.id}::uuid, 'owner', 'task.created', ${transaction.json({ title: row.title, status: row.status })}, ${auth.user.id}::uuid, ${idempotencyKey})
          on conflict (task_id, idempotency_key) where idempotency_key is not null do nothing
        `;
        await transaction`
          insert into public.audit_logs (actor_user_id, task_id, event_type, summary, metadata, idempotency_key)
          values (${auth.user.id}::uuid, ${row.id}::uuid, 'task.created', 'Task created by owner', ${transaction.json({ category: parsed.data.capabilities[0] || 'General' })}, ${`task-created:${idempotencyKey}`})
          on conflict (idempotency_key) do nothing
        `;
      }
      return { task: taskDto(row), created: Boolean(created) };
    }));
    return NextResponse.json({ task: result.value.task, created: result.value.created && !result.replayed, replayed: result.replayed }, { status: result.replayed || !result.value.created ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof IdempotencyConflict) return serviceUnavailable(error.message, 409);
    return serviceUnavailable('Task could not be saved. Confirm migration 002 is applied and retry with the same idempotency key.', 500);
  }
}
