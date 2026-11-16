import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { databaseIsConfigured, getDatabase } from '@/lib/db/postgres';
import { taskDto, type TaskRow } from '@/lib/marketplace/task-dto';
import type { TaskStatus } from '@/lib/marketplace/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DetailTask = TaskRow & { owner_user_id: string | null; selected_agent_id: string | null; is_mine: boolean; is_assigned_agent: boolean };

export async function GET(_request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
  const { taskId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) return NextResponse.json({ error: 'Invalid task ID.' }, { status: 400 });
  try {
    const sql = getDatabase();
    const [row] = await sql<DetailTask[]>`
      select t.id::text,t.title,t.description,t.budget_yocto::text,t.capabilities,t.deadline_at,t.status,
        selected.name as agent_name,selected.account_id as agent_account_id,t.created_at,
        (select count(*)::int from public.bids b where b.task_id=t.id) as bid_count,
        t.owner_user_id::text as owner_user_id,(t.owner_user_id=${auth.user.id}::uuid) as is_mine,
        t.selected_agent_id::text as selected_agent_id,
        exists(select 1 from public.agents mine where mine.id=t.selected_agent_id and mine.owner_user_id=${auth.user.id}::uuid) as is_assigned_agent
      from public.tasks t left join public.agents selected on selected.id=t.selected_agent_id
      where t.id=${taskId}::uuid
    `;
    if (!row) return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
    const isOpen = row.status === 'open' || row.status === 'bidding';
    if (!row.owner_user_id || (!row.is_mine && !row.is_assigned_agent && !isOpen)) return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
    const isParticipant = row.is_mine || row.is_assigned_agent;
    const [deliverables, events] = await Promise.all([
      isParticipant ? sql<{ id: string; agent_id: string; agent_name: string; revision: number; title: string; content: { title?: string; body?: string }; status: string; metadata: Record<string, unknown>; verification_evidence: unknown[]; review_note: string | null; submitted_at: Date; reviewed_at: Date | null }[]>`
        select d.id::text,d.agent_id::text,a.name as agent_name,d.revision,d.content->>'title' as title,d.content,d.status,d.metadata,d.verification_evidence,d.review_note,d.submitted_at,d.reviewed_at
        from public.deliverables d join public.agents a on a.id=d.agent_id where d.task_id=${taskId}::uuid order by d.revision desc
      ` : Promise.resolve([]),
      isParticipant ? sql<{ sender: string; event_type: string; payload: Record<string, unknown>; created_at: Date }[]>`
        select sender,event_type,case when ${row.is_mine} then payload when event_type like 'bid.%' then '{}'::jsonb else payload end as payload,created_at
        from public.task_events where task_id=${taskId}::uuid order by created_at asc,id asc limit 200
      ` : Promise.resolve([]),
    ]);
    return NextResponse.json({
      task: taskDto(row),
      taskStatus: row.status,
      isOwner: row.is_mine,
      isAssignedAgent: row.is_assigned_agent,
      deliverables: deliverables.map((item) => ({ ...item, submittedAt: item.submitted_at, reviewedAt: item.reviewed_at, submitted_at: undefined, reviewed_at: undefined })),
      events,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Task details could not be loaded. Confirm migration 003 is applied.' }, { status: 500 });
  }
}
