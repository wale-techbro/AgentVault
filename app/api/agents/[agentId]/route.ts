import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { isSameOriginRequest, readJsonBody, validIdempotencyKey } from '@/lib/api/request';
import { getDatabase, databaseIsConfigured } from '@/lib/db/postgres';
import { IdempotencyConflict, requestFingerprint, withIdempotency } from '@/lib/db/idempotency';
import { updateAgentSchema } from '@/lib/validation/marketplace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AgentRow = {
  id: string; owner_user_id: string; account_id: string; name: string; role: string; description: string;
  capabilities: string[]; status: string; availability: 'available' | 'busy' | 'offline'; is_active: boolean;
};

function dto(agent: AgentRow) {
  return { id: agent.id, name: agent.name, role: agent.role, description: agent.description,
    initials: agent.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(),
    color: 'green', status: agent.availability === 'busy' ? 'Busy' : agent.availability === 'offline' ? 'Offline' : 'Available',
    availability: agent.availability, isActive: agent.is_active, isMine: true, rating: '—', reviews: 0,
    skills: agent.capabilities, completed: 0, success: 0, earned: '0', nearAccountId: agent.account_id };
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ agentId: string }> }) {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'Cross-origin writes are not allowed.' }, { status: 403 });
  const { agentId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)) return NextResponse.json({ error: 'Invalid agent ID.' }, { status: 400 });
  const key = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(key)) return NextResponse.json({ error: 'A valid Idempotency-Key UUID is required.' }, { status: 400 });
  const body = await readJsonBody(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const parsed = updateAgentSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid agent update.', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400 });
  const update = { ...parsed.data, nearAccountId: parsed.data.nearAccountId?.toLowerCase() };

  try {
    const sql = getDatabase();
    const result = await sql.begin(async (transaction) => withIdempotency(transaction, {
      actorUserId: auth.user.id, key, operation: `agent.update:${agentId}`, requestHash: requestFingerprint(update),
    }, async () => {
      const [current] = await transaction<AgentRow[]>`
        select id::text, owner_user_id::text, account_id, name, role, description, capabilities, status, availability, is_active
        from public.agents where id = ${agentId}::uuid and owner_user_id = ${auth.user.id}::uuid for update
      `;
      if (!current) throw new Error('agent_not_found');
      const accountChanged = update.nearAccountId !== undefined && update.nearAccountId !== current.account_id;
      const movingOffline = update.availability === 'offline' && current.availability !== 'offline';
      if (((update.isActive === false && current.is_active) || accountChanged || movingOffline)) {
        const [activeTask] = await transaction<{ id: string }[]>`
          select id::text from public.tasks where selected_agent_id = ${agentId}::uuid
            and status in ('assigned','in_progress','submitted','verified','approved') limit 1
        `;
        if (activeTask) throw new Error(accountChanged ? 'agent_account_locked_by_active_task' : 'agent_has_active_task');
      }
      const name = update.name ?? current.name;
      const role = update.role ?? current.role;
      const description = update.description ?? current.description;
      const capabilities = update.capabilities ?? current.capabilities;
      const accountId = update.nearAccountId ?? current.account_id;
      const availability = update.isActive === false ? 'offline' : update.availability ?? current.availability;
      const isActive = update.isActive ?? current.is_active;
      const [agent] = await transaction<AgentRow[]>`
        update public.agents set name = ${name}, role = ${role}, description = ${description},
          capabilities = ${transaction.array(capabilities)}::text[], account_id = ${accountId},
          availability = ${availability}, is_active = ${isActive},
          status = case when not ${isActive} or ${availability} = 'offline' then 'offline' when ${availability} = 'busy' then 'working' else 'idle' end
        where id = ${agentId}::uuid and owner_user_id = ${auth.user.id}::uuid
        returning id::text, owner_user_id::text, account_id, name, role, description, capabilities, status, availability, is_active
      `;
      await transaction`
        insert into public.agent_events (agent_id, actor_user_id, event_type, payload, idempotency_key)
        values (${agentId}::uuid, ${auth.user.id}::uuid, 'agent.updated', ${transaction.json({ fields: Object.keys(update), isActive, availability })}, ${key})
        on conflict (agent_id, idempotency_key) where idempotency_key is not null do nothing
      `;
      await transaction`
        insert into public.audit_logs (actor_user_id, event_type, summary, metadata, idempotency_key)
        values (${auth.user.id}::uuid, 'agent.updated', 'Agent profile updated', ${transaction.json({ agentId, isActive, availability })}, ${`agent:${agentId}:${key}`})
        on conflict (idempotency_key) do nothing
      `;
      return dto(agent);
    }));
    return NextResponse.json({ agent: result.value, replayed: result.replayed }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof IdempotencyConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof Error && error.message === 'agent_not_found') return NextResponse.json({ error: 'Agent not found.' }, { status: 404 });
    if (error instanceof Error && error.message === 'agent_has_active_task') return NextResponse.json({ error: 'An agent cannot be deactivated or moved offline while assigned work is active.' }, { status: 409 });
    if (error instanceof Error && error.message === 'agent_account_locked_by_active_task') return NextResponse.json({ error: 'Change the payout account after this agent has no active assignments.' }, { status: 409 });
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return NextResponse.json({ error: 'That NEAR account is already registered to an agent.' }, { status: 409 });
    return NextResponse.json({ error: 'Agent update failed. Confirm migration 003 is applied.' }, { status: 500 });
  }
}
