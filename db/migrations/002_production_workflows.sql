-- Additive production workflow and authorization schema.
-- Apply through Supabase migrations after reviewing the target project.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 120),
  role text not null default 'member' check (role in ('member','admin')),
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agents add column if not exists owner_user_id uuid references auth.users(id) on delete set null;
alter table public.agents add column if not exists updated_at timestamptz not null default now();

alter table public.tasks alter column owner_account_id drop not null;
alter table public.tasks add column if not exists owner_user_id uuid references auth.users(id) on delete restrict;
alter table public.tasks add column if not exists owner_near_account_id text;
alter table public.tasks add column if not exists idempotency_key uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_owner_near_account_id_format') then
    alter table public.tasks add constraint tasks_owner_near_account_id_format
      check (owner_near_account_id is null or (char_length(owner_near_account_id) between 2 and 64 and owner_near_account_id ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'));
  end if;
end $$;
create unique index if not exists tasks_owner_idempotency_unique
  on public.tasks(owner_user_id, idempotency_key) where idempotency_key is not null;

alter table public.bids add column if not exists bidder_user_id uuid references auth.users(id) on delete restrict;
alter table public.task_events add column if not exists actor_user_id uuid references auth.users(id) on delete set null;
alter table public.task_events add column if not exists idempotency_key text;
create unique index if not exists task_events_idempotency_unique
  on public.task_events(task_id, idempotency_key) where idempotency_key is not null;
alter table public.deliverables add column if not exists submitted_by_user_id uuid references auth.users(id) on delete restrict;
alter table public.deliverables add column if not exists revision integer not null default 1 check (revision > 0);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  run_type text not null check (run_type in ('planning','monitoring','execution','verification')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  input jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_execution_jobs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  run_id uuid references public.agent_runs(id) on delete set null,
  job_type text not null check (job_type in ('execute_task','verify_deliverable','monitor_escrow')),
  status text not null default 'queued' check (status in ('queued','running','retry','succeeded','failed','cancelled')),
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action_type text not null check (action_type in ('plan_task','assign_agent','submit_deliverable','verify_deliverable','request_approval','release_payment','refund','notify_owner')),
  status text not null default 'proposed' check (status in ('proposed','pending_approval','approved','rejected','executing','executed','failed','skipped')),
  requires_approval boolean not null default true,
  reason text not null check (char_length(reason) between 1 and 1000),
  idempotency_key text not null unique,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  executed_at timestamptz
);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null unique references public.agent_actions(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  decision_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  notification_type text not null,
  title text not null check (char_length(title) between 1 and 200),
  body text not null default '' check (char_length(body) <= 2000),
  idempotency_key text not null unique,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete restrict,
  opened_by_user_id uuid not null references auth.users(id) on delete restrict,
  reason text not null check (char_length(reason) between 10 and 4000),
  status text not null default 'open' check (status in ('open','under_review','resolved','closed')),
  resolution jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  event_type text not null,
  summary text not null check (char_length(summary) between 1 and 1000),
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.platform_settings(key, value) values ('agent_control', '{"state":"active"}'::jsonb)
  on conflict (key) do nothing;

create index if not exists tasks_owner_user_created_idx on public.tasks(owner_user_id, created_at desc);
create index if not exists tasks_open_created_idx on public.tasks(status, created_at desc) where status in ('open','bidding');
create index if not exists bids_bidder_created_idx on public.bids(bidder_user_id, created_at desc);
create index if not exists jobs_due_idx on public.agent_execution_jobs(status, available_at) where status in ('queued','retry');
create index if not exists actions_task_created_idx on public.agent_actions(task_id, created_at desc);
create index if not exists approvals_owner_status_idx on public.approvals(owner_user_id, status, created_at desc);
create index if not exists notifications_user_created_idx on public.notifications(user_id, created_at desc);
create index if not exists disputes_status_created_idx on public.disputes(status, created_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists agents_set_updated_at on public.agents;
create trigger agents_set_updated_at before update on public.agents for each row execute function public.set_updated_at();
drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at before update on public.tasks for each row execute function public.set_updated_at();
drop trigger if exists jobs_set_updated_at on public.agent_execution_jobs;
create trigger jobs_set_updated_at before update on public.agent_execution_jobs for each row execute function public.set_updated_at();
drop trigger if exists actions_set_updated_at on public.agent_actions;
create trigger actions_set_updated_at before update on public.agent_actions for each row execute function public.set_updated_at();
drop trigger if exists disputes_set_updated_at on public.disputes;
create trigger disputes_set_updated_at before update on public.disputes for each row execute function public.set_updated_at();
drop trigger if exists settings_set_updated_at on public.platform_settings;
create trigger settings_set_updated_at before update on public.platform_settings for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 120))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.agents enable row level security;
alter table public.tasks enable row level security;
alter table public.bids enable row level security;
alter table public.task_events enable row level security;
alter table public.deliverables enable row level security;
alter table public.escrow_receipts enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_execution_jobs enable row level security;
alter table public.agent_actions enable row level security;
alter table public.approvals enable row level security;
alter table public.notifications enable row level security;
alter table public.disputes enable row level security;
alter table public.audit_logs enable row level security;
alter table public.platform_settings enable row level security;

-- Remove any console-created policies on these tables so this migration's read
-- policies are the complete browser access model. Mutations are server mediated.
do $$
declare policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public' and tablename = any (array[
      'profiles','agents','tasks','bids','task_events','deliverables','escrow_receipts',
      'agent_runs','agent_execution_jobs','agent_actions','approvals','notifications',
      'disputes','audit_logs','platform_settings'
    ])
  loop
    execute format('drop policy if exists %I on %I.%I', policy_row.policyname, policy_row.schemaname, policy_row.tablename);
  end loop;
end $$;

drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists profiles_insert_self on public.profiles;
drop policy if exists profiles_update_self on public.profiles;

drop policy if exists agents_read_marketplace on public.agents;
create policy agents_read_marketplace on public.agents for select to authenticated using (true);
drop policy if exists agents_insert_owner on public.agents;
drop policy if exists agents_update_owner on public.agents;

drop policy if exists tasks_read_open_or_owned on public.tasks;
create policy tasks_read_open_or_owned on public.tasks for select to authenticated using (
  status in ('open','bidding') or owner_user_id = (select auth.uid()) or exists (
    select 1 from public.agents a where a.id = tasks.selected_agent_id and a.owner_user_id = (select auth.uid())
  )
);
drop policy if exists tasks_insert_owner on public.tasks;
drop policy if exists tasks_update_owner on public.tasks;

drop policy if exists bids_read_participants on public.bids;
create policy bids_read_participants on public.bids for select to authenticated using (
  bidder_user_id = (select auth.uid()) or exists (select 1 from public.tasks t where t.id = bids.task_id and t.owner_user_id = (select auth.uid()))
);
drop policy if exists bids_insert_agent_owner on public.bids;
drop policy if exists bids_update_participant on public.bids;

drop policy if exists task_events_read_participants on public.task_events;
create policy task_events_read_participants on public.task_events for select to authenticated using (
  actor_user_id = (select auth.uid()) or exists (select 1 from public.tasks t where t.id = task_events.task_id and (t.owner_user_id = (select auth.uid()) or exists (select 1 from public.agents a where a.id = t.selected_agent_id and a.owner_user_id = (select auth.uid()))))
);
drop policy if exists task_events_insert_actor on public.task_events;

drop policy if exists deliverables_read_participants on public.deliverables;
create policy deliverables_read_participants on public.deliverables for select to authenticated using (
  submitted_by_user_id = (select auth.uid()) or exists (select 1 from public.tasks t where t.id = deliverables.task_id and (t.owner_user_id = (select auth.uid()) or exists (select 1 from public.agents a where a.id = t.selected_agent_id and a.owner_user_id = (select auth.uid()))))
);
drop policy if exists deliverables_insert_assigned_agent on public.deliverables;

drop policy if exists escrow_receipts_read_participants on public.escrow_receipts;
create policy escrow_receipts_read_participants on public.escrow_receipts for select to authenticated using (
  exists (select 1 from public.tasks t where t.id = escrow_receipts.task_id and (t.owner_user_id = (select auth.uid()) or exists (select 1 from public.agents a where a.id = t.selected_agent_id and a.owner_user_id = (select auth.uid()))))
);

drop policy if exists runs_read_self on public.agent_runs;
create policy runs_read_self on public.agent_runs for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists actions_read_task_owner on public.agent_actions;
create policy actions_read_task_owner on public.agent_actions for select to authenticated using (exists (select 1 from public.tasks t where t.id = agent_actions.task_id and t.owner_user_id = (select auth.uid())));
drop policy if exists approvals_read_owner on public.approvals;
create policy approvals_read_owner on public.approvals for select to authenticated using (owner_user_id = (select auth.uid()));
drop policy if exists approvals_decide_owner on public.approvals;
drop policy if exists notifications_read_self on public.notifications;
create policy notifications_read_self on public.notifications for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists notifications_update_self on public.notifications;
drop policy if exists disputes_read_participants on public.disputes;
create policy disputes_read_participants on public.disputes for select to authenticated using (
  opened_by_user_id = (select auth.uid()) or exists (select 1 from public.tasks t where t.id = disputes.task_id and (t.owner_user_id = (select auth.uid()) or exists (select 1 from public.agents a where a.id = t.selected_agent_id and a.owner_user_id = (select auth.uid()))))
);
drop policy if exists disputes_open_owner on public.disputes;
drop policy if exists audit_logs_read_actor on public.audit_logs;
create policy audit_logs_read_actor on public.audit_logs for select to authenticated using (actor_user_id = (select auth.uid()));
drop policy if exists audit_logs_insert_actor on public.audit_logs;

-- Mutations go through authenticated server routes using the server-only DATABASE_URL.
-- The client roles receive no INSERT/UPDATE/DELETE policies; task and workflow writes
-- must be validated and audited by the server before reaching PostgreSQL.
-- No client-facing policies are intentionally created for execution jobs or platform settings.
