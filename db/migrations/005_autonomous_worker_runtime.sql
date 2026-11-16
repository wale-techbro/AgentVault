-- Durable, leased execution queue metadata. Existing jobs, runs and deliverables
-- are retained; worker output is linked to a job/run for attribution and dedupe.

alter table public.agent_execution_jobs
  add column if not exists max_attempts integer not null default 4,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists execution_stage text not null default 'queued';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'agent_execution_jobs_max_attempts_check') then
    alter table public.agent_execution_jobs add constraint agent_execution_jobs_max_attempts_check check (max_attempts between 1 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_execution_jobs_stage_check') then
    alter table public.agent_execution_jobs add constraint agent_execution_jobs_stage_check
      check (execution_stage in ('queued','planning','executing','persisting','submitted','retrying','failed','cancelled'));
  end if;
end $$;

create index if not exists agent_execution_jobs_claim_idx
  on public.agent_execution_jobs(available_at, created_at)
  where job_type = 'execute_task' and status in ('queued','retry');
create index if not exists agent_execution_jobs_expired_lease_idx
  on public.agent_execution_jobs(lease_expires_at)
  where job_type = 'execute_task' and status = 'running';
create index if not exists agent_execution_jobs_task_running_idx
  on public.agent_execution_jobs(task_id, status, lease_expires_at)
  where job_type = 'execute_task';

alter table public.agent_runs
  add column if not exists execution_job_id uuid references public.agent_execution_jobs(id) on delete set null,
  add column if not exists correlation_id uuid not null default gen_random_uuid(),
  add column if not exists attempt integer not null default 1,
  add column if not exists stage text,
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists estimated_cost_usd numeric(12,6);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'agent_runs_attempt_check') then
    alter table public.agent_runs add constraint agent_runs_attempt_check check (attempt > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_runs_token_usage_check') then
    alter table public.agent_runs add constraint agent_runs_token_usage_check
      check ((input_tokens is null or input_tokens >= 0) and (output_tokens is null or output_tokens >= 0));
  end if;
end $$;
create unique index if not exists agent_runs_job_attempt_unique
  on public.agent_runs(execution_job_id, attempt) where execution_job_id is not null;
create index if not exists agent_runs_correlation_idx on public.agent_runs(correlation_id);

alter table public.deliverables
  add column if not exists execution_job_id uuid references public.agent_execution_jobs(id) on delete set null,
  add column if not exists execution_run_id uuid references public.agent_runs(id) on delete set null;
create unique index if not exists deliverables_execution_job_unique
  on public.deliverables(execution_job_id) where execution_job_id is not null;
create unique index if not exists deliverables_execution_run_unique
  on public.deliverables(execution_run_id) where execution_run_id is not null;

create table if not exists public.worker_instances (
  worker_id uuid primary key,
  status text not null check (status in ('starting','idle','running','stopping','stopped','error')),
  current_job_id uuid references public.agent_execution_jobs(id) on delete set null,
  started_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  stopped_at timestamptz,
  last_error_code text
);
create index if not exists worker_instances_heartbeat_idx on public.worker_instances(last_heartbeat_at desc);

create table if not exists public.worker_execution_logs (
  id bigint generated always as identity primary key,
  worker_id uuid not null,
  job_id uuid not null references public.agent_execution_jobs(id) on delete cascade,
  run_id uuid references public.agent_runs(id) on delete set null,
  correlation_id uuid not null,
  level text not null check (level in ('info','warn','error')),
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists worker_execution_logs_job_created_idx
  on public.worker_execution_logs(job_id, created_at desc);
create index if not exists worker_execution_logs_correlation_idx
  on public.worker_execution_logs(correlation_id, created_at);

alter table public.worker_instances enable row level security;
alter table public.worker_execution_logs enable row level security;
drop policy if exists worker_instances_read_health on public.worker_instances;
drop policy if exists worker_execution_logs_read_participants on public.worker_execution_logs;
create policy worker_execution_logs_read_participants on public.worker_execution_logs for select to authenticated using (
  exists (
    select 1 from public.agent_execution_jobs j join public.tasks t on t.id = j.task_id
    where j.id = worker_execution_logs.job_id and t.owner_user_id = (select auth.uid())
  ) or exists (
    select 1 from public.agent_execution_jobs j
    join public.tasks t on t.id = j.task_id
    join public.agents a on a.id = t.selected_agent_id
    where j.id = worker_execution_logs.job_id and a.owner_user_id = (select auth.uid())
  )
);

drop policy if exists agent_runs_read_assigned_agent on public.agent_runs;
create policy agent_runs_read_assigned_agent on public.agent_runs for select to authenticated using (
  exists (
    select 1 from public.tasks t join public.agents a on a.id = t.selected_agent_id
    where t.id = agent_runs.task_id and a.owner_user_id = (select auth.uid())
  )
);

-- The process uses the server-only DATABASE_URL. Browser roles receive no
-- write policies for jobs, runs, worker heartbeats or execution logs.
