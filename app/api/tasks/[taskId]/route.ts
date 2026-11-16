import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { databaseIsConfigured, getDatabase } from '@/lib/db/postgres';
import { taskDto, type TaskRow } from '@/lib/marketplace/task-dto';
import type { TaskStatus } from '@/lib/marketplace/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DetailTask = TaskRow & { owner_user_id: string | null; selected_agent_id: string | null; is_mine: boolean; is_assigned_agent: boolean };
type ExecutionRow = {
  id: string; status: string; execution_stage: string; attempts: number; max_attempts: number; last_error_code: string | null;
  available_at: Date; run_id: string | null; correlation_id: string | null; run_status: string | null;
  run_started_at: Date | null; run_finished_at: Date | null; run_error_code: string | null;
  deliverable_id: string | null; revision: number | null;
};

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
    const [deliverables, events, execution, workerSummary] = await Promise.all([
      isParticipant ? sql<{ id: string; agent_id: string; agent_name: string; revision: number; title: string; content: { title?: string; body?: string }; status: string; metadata: Record<string, unknown>; verification_evidence: unknown[]; review_note: string | null; submitted_at: Date; reviewed_at: Date | null }[]>`
        select d.id::text,d.agent_id::text,a.name as agent_name,d.revision,d.content->>'title' as title,d.content,d.status,d.metadata,d.verification_evidence,d.review_note,d.submitted_at,d.reviewed_at
        from public.deliverables d join public.agents a on a.id=d.agent_id where d.task_id=${taskId}::uuid order by d.revision desc
      ` : Promise.resolve([]),
      isParticipant ? sql<{ sender: string; event_type: string; payload: Record<string, unknown>; created_at: Date }[]>`
        select sender,event_type,case when ${row.is_mine} then payload when event_type like 'bid.%' then '{}'::jsonb else payload end as payload,created_at
        from public.task_events where task_id=${taskId}::uuid order by created_at asc,id asc limit 200
      ` : Promise.resolve([]),
      isParticipant ? sql<ExecutionRow[]>`
        select j.id::text,j.status,j.execution_stage,j.attempts,j.max_attempts,j.last_error_code,j.available_at,
          r.id::text as run_id,r.correlation_id::text,r.status as run_status,r.started_at as run_started_at,
          r.finished_at as run_finished_at,r.error_code as run_error_code,d.id::text as deliverable_id,d.revision
        from public.agent_execution_jobs j left join public.agent_runs r on r.id=j.run_id
        left join public.deliverables d on d.execution_job_id=j.id
        where j.task_id=${taskId}::uuid and j.job_type='execute_task' order by j.created_at desc limit 1
      ` : Promise.resolve([]),
      isParticipant ? sql<{ active_workers: number; last_heartbeat_at: Date | null }[]>`
        select count(*)::int as active_workers,max(last_heartbeat_at) as last_heartbeat_at from public.worker_instances
        where status in ('starting','idle','running','stopping') and last_heartbeat_at>now()-interval '90 seconds'
      ` : Promise.resolve([]),
    ]);
    const [workerLogs] = execution[0] ? await Promise.all([sql<{ event_type: string; level: string; details: Record<string, unknown>; correlation_id: string; created_at: Date }[]>`
      select event_type,level,details,correlation_id::text,created_at from public.worker_execution_logs
      where job_id=${execution[0].id}::uuid order by created_at desc limit 20
    `]) : [[] as { event_type: string; level: string; details: Record<string, unknown>; correlation_id: string; created_at: Date }[]];
    const worker = workerSummary[0] || { active_workers: 0, last_heartbeat_at: null };
    return NextResponse.json({
      task: taskDto(row),
      taskStatus: row.status,
      isOwner: row.is_mine,
      isAssignedAgent: row.is_assigned_agent,
      deliverables: deliverables.map((item) => ({ ...item, submittedAt: item.submitted_at, reviewedAt: item.reviewed_at, submitted_at: undefined, reviewed_at: undefined })),
      events,
      execution: execution[0] ? { ...execution[0], logs: workerLogs } : null,
      workerHealth: { healthy: worker.active_workers > 0, activeWorkers: worker.active_workers, lastHeartbeatAt: worker.last_heartbeat_at },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Task details could not be loaded. Confirm migrations 003 and 004 are applied.' }, { status: 500 });
  }
}
