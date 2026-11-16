import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { readJsonBody, isSameOriginRequest, validIdempotencyKey } from '@/lib/api/request';
import { getDatabase, databaseIsConfigured } from '@/lib/db/postgres';
import { IdempotencyConflict, requestFingerprint, withIdempotency } from '@/lib/db/idempotency';
import { createAgentSchema } from '@/lib/validation/marketplace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AgentRow = {
  id: string;
  account_id: string | null;
  name: string;
  role: string;
  description: string;
  capabilities: string[];
  status: string;
  availability: 'available' | 'busy' | 'offline';
  is_active: boolean;
  owner_user_id: string | null;
};

function toAgent(agent: AgentRow, userId: string) {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    initials: agent.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(),
    color: 'green',
    status: agent.availability === 'busy' ? 'Busy' : agent.availability === 'offline' ? 'Offline' : 'Available',
    availability: agent.availability,
    isActive: agent.is_active,
    isMine: agent.owner_user_id === userId,
    rating: '—',
    reviews: 0,
    skills: agent.capabilities,
    completed: 0,
    success: 0,
    earned: '0',
    nearAccountId: agent.account_id || '',
  };
}

export async function GET() {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: { 'Cache-Control': 'no-store' } });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured. Set DATABASE_URL on the server.' }, { status: 503 });
  try {
    const sql = getDatabase();
    const rows = await sql<AgentRow[]>`
      select id::text, account_id, name, role, description, capabilities, status, availability, is_active, owner_user_id::text
      from public.agents
      where is_active = true or owner_user_id = ${auth.user.id}::uuid
      order by is_active desc, name asc
      limit 200
    `;
    return NextResponse.json({ agents: rows.map((agent) => toAgent(agent, auth.user.id)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Agents could not be loaded. Confirm database connectivity and apply migrations 001–003.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'Cross-origin writes are not allowed.' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(key)) return NextResponse.json({ error: 'A valid Idempotency-Key UUID is required.' }, { status: 400 });
  const body = await readJsonBody(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const parsed = createAgentSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid agent profile.', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400 });
  const input = { ...parsed.data, nearAccountId: parsed.data.nearAccountId.toLowerCase() };
  const hash = requestFingerprint(input);

  try {
    const sql = getDatabase();
    const result = await sql.begin(async (transaction) => withIdempotency(transaction, {
      actorUserId: auth.user.id, key, operation: 'agent.register', requestHash: hash,
    }, async () => {
      const [agent] = await transaction<AgentRow[]>`
        insert into public.agents (owner_user_id, account_id, name, role, description, capabilities, status, availability, is_active, registration_idempotency_key)
        values (
          ${auth.user.id}::uuid, ${input.nearAccountId}, ${input.name}, ${input.role}, ${input.description},
          ${transaction.array(input.capabilities)}::text[], ${input.availability === 'offline' ? 'offline' : 'idle'},
          ${input.availability}, true, ${key}::uuid
        )
        returning id::text, account_id, name, role, description, capabilities, status, availability, is_active, owner_user_id::text
      `;
      const response = toAgent(agent, auth.user.id);
      await transaction`
        insert into public.agent_events (agent_id, actor_user_id, event_type, payload, idempotency_key)
        values (${agent.id}::uuid, ${auth.user.id}::uuid, 'agent.registered', ${transaction.json({ name: agent.name, capabilities: agent.capabilities })}, ${key})
        on conflict (agent_id, idempotency_key) where idempotency_key is not null do nothing
      `;
      await transaction`
        insert into public.audit_logs (actor_user_id, event_type, summary, metadata, idempotency_key)
        values (${auth.user.id}::uuid, 'agent.registered', 'Agent registered by owner', ${transaction.json({ agentId: agent.id, accountId: agent.account_id })}, ${`agent:${agent.id}:${key}`})
        on conflict (idempotency_key) do nothing
      `;
      return response;
    }));
    return NextResponse.json({ agent: result.value, replayed: result.replayed }, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof IdempotencyConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return NextResponse.json({ error: 'This NEAR account or registration key is already registered.' }, { status: 409 });
    return NextResponse.json({ error: 'Agent registration failed. Confirm migration 003 is applied.' }, { status: 500 });
  }
}
