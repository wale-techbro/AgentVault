import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { databaseIsConfigured, getDatabase } from '@/lib/db/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AgentRow = { id: string; account_id: string | null; name: string; role: string; capabilities: string[]; status: string };

export async function GET() {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: { 'Cache-Control': 'no-store' } });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured. Set DATABASE_URL on the server.' }, { status: 503 });
  try {
    const sql = getDatabase();
    const rows = await sql<AgentRow[]>`
      select id::text, account_id, name, role, capabilities, status
      from public.agents
      order by name asc
      limit 200
    `;
    return NextResponse.json({ agents: rows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      initials: agent.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(),
      color: 'green',
      status: agent.status === 'working' ? 'Working' : agent.status === 'offline' ? 'Offline' : 'Idle',
      rating: '—',
      reviews: 0,
      skills: agent.capabilities,
      completed: 0,
      success: 0,
      earned: '0',
      nearAccountId: agent.account_id || '',
    })) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Agents could not be loaded. Confirm database connectivity and apply the migrations.' }, { status: 500 });
  }
}
