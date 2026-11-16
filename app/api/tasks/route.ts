import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { databaseIsConfigured, getDatabase } from '@/lib/db/postgres';
import { createTaskSchema, nearToYocto, yoctoToNearNumber } from '@/lib/validation/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type TaskRow = {
  id: string;
  title: string;
  description: string;
  budget_yocto: string;
  capabilities: string[];
  deadline_at: Date | null;
  status: string;
  agent_name: string | null;
  agent_account_id: string | null;
  created_at: Date;
};

function taskDto(row: TaskRow) {
  const category = row.capabilities[0] || 'General';
  const agentName = row.agent_name || 'Awaiting bids';
  const initials = agentName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const status = row.status === 'open' || row.status === 'bidding'
    ? 'Open'
    : row.status === 'in_progress' || row.status === 'assigned'
      ? 'In progress'
      : row.status === 'completed' || row.status === 'refunded'
        ? 'Completed'
        : row.status === 'submitted' || row.status === 'verified' || row.status === 'approved' || row.status === 'settling'
          ? 'In review'
          : 'Needs attention';
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category,
    agent: agentName,
    agentId: initials || '—',
    amount: yoctoToNearNumber(row.budget_yocto),
    eta: row.deadline_at ? new Date(row.deadline_at).toLocaleDateString('en-GB', { timeZone: 'UTC' }) : 'No deadline',
    score: '—',
    status,
    color: 'gold',
    workerAccountId: row.agent_account_id,
    createdAt: row.created_at,
  };
}

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
             t.deadline_at, t.status, a.name as agent_name, a.account_id as agent_account_id, t.created_at
      from public.tasks t
      left join public.agents a on a.id = t.selected_agent_id
      where t.status in ('open', 'bidding') or t.owner_user_id = ${auth.user.id}::uuid
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
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) return serviceUnavailable('Cross-origin task writes are not allowed.', 403);
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > 16_384) return serviceUnavailable('Task request is too large.', 413);

  const idempotencyKey = request.headers.get('idempotency-key') || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    return serviceUnavailable('A valid Idempotency-Key UUID is required.', 400);
  }

  let parsedBody: unknown;
  try {
    const bodyText = await request.text();
    if (bodyText.length > 16_384) return serviceUnavailable('Task request is too large.', 413);
    parsedBody = JSON.parse(bodyText);
  } catch {
    return serviceUnavailable('Request body must be valid JSON.', 400);
  }
  const parsed = createTaskSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid task details.', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const sql = getDatabase();
    const result = await sql.begin(async (transaction) => {
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
        returning id::text, title, description, budget_yocto::text, capabilities, deadline_at, status, null::text as agent_name, null::text as agent_account_id, created_at
      `;
      const created = inserted[0];
      const row = created || (await transaction<TaskRow[]>`
        select t.id::text, t.title, t.description, t.budget_yocto::text, t.capabilities, t.deadline_at, t.status,
               a.name as agent_name, a.account_id as agent_account_id, t.created_at
        from public.tasks t left join public.agents a on a.id = t.selected_agent_id
        where t.owner_user_id = ${auth.user.id}::uuid and t.idempotency_key = ${idempotencyKey}::uuid
        limit 1
      `)[0];
      if (!row) throw new Error('task_insert_failed');
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
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return serviceUnavailable('Task could not be saved. Confirm migration 002 is applied and retry with the same idempotency key.', 500);
  }
}
