-- Agent profiles, bid idempotency, assignment lifecycle, and reviewed deliverables.
-- Additive only: existing rows and legacy status values are preserved.

alter table public.agents add column if not exists description text not null default '';
alter table public.agents add column if not exists availability text not null default 'available';
alter table public.agents add column if not exists is_active boolean not null default true;
alter table public.agents add column if not exists registration_idempotency_key uuid;
update public.agents set availability = case status when 'working' then 'busy' when 'offline' then 'offline' else 'available' end
where availability = 'available' and status in ('working','offline');
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'agents_availability_check') then
    alter table public.agents add constraint agents_availability_check check (availability in ('available','busy','offline'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agents_description_length_check') then
    alter table public.agents add constraint agents_description_length_check check (char_length(description) <= 2000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agents_account_id_format_check') then
    alter table public.agents add constraint agents_account_id_format_check
      check (account_id is null or (char_length(account_id) between 2 and 64 and account_id ~ '^[a-z0-9]+([._-][a-z0-9]+)*$')) not valid;
  end if;
end $$;
create unique index if not exists agents_owner_registration_idempotency_unique
  on public.agents(owner_user_id, registration_idempotency_key) where registration_idempotency_key is not null;
create index if not exists agents_active_availability_idx on public.agents(is_active, availability, name);

alter table public.bids add column if not exists idempotency_key uuid;
create unique index if not exists bids_owner_idempotency_unique
  on public.bids(bidder_user_id, idempotency_key) where idempotency_key is not null;

alter table public.deliverables add column if not exists status text not null default 'submitted';
alter table public.deliverables add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.deliverables add column if not exists verification_evidence jsonb not null default '[]'::jsonb;
alter table public.deliverables add column if not exists review_note text;
alter table public.deliverables add column if not exists reviewed_by_user_id uuid references auth.users(id) on delete set null;
alter table public.deliverables add column if not exists reviewed_at timestamptz;
alter table public.deliverables add column if not exists idempotency_key uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deliverables_status_check') then
    alter table public.deliverables add constraint deliverables_status_check
      check (status in ('submitted','revision_requested','verified','approved','rejected'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deliverables_review_note_check') then
    alter table public.deliverables add constraint deliverables_review_note_check
      check (review_note is null or char_length(review_note) <= 4000);
  end if;
end $$;
create unique index if not exists deliverables_idempotency_unique
  on public.deliverables(submitted_by_user_id, idempotency_key) where idempotency_key is not null;
create index if not exists deliverables_task_revision_idx on public.deliverables(task_id, agent_id, revision desc);

create table if not exists public.agent_events (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz not null default now()
);
create unique index if not exists agent_events_idempotency_unique
  on public.agent_events(agent_id, idempotency_key) where idempotency_key is not null;
create index if not exists agent_events_agent_created_idx on public.agent_events(agent_id, created_at desc);

create table if not exists public.deliverable_reviews (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  deliverable_id uuid not null references public.deliverables(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check (decision in ('verify','approve','request_revision','reject')),
  note text not null default '' check (char_length(note) <= 4000),
  evidence jsonb not null default '[]'::jsonb,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  unique(owner_user_id, idempotency_key)
);
create index if not exists deliverable_reviews_task_created_idx on public.deliverable_reviews(task_id, created_at desc);

create table if not exists public.api_idempotency (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  operation text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb,
  created_at timestamptz not null default now(),
  primary key(actor_user_id, idempotency_key)
);

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check check (status in (
  'open','bidding','assigned','in_progress','submitted','verified','approved','completed',
  'cancelled','disputed','settling','refunded','failed'
));
create index if not exists tasks_selected_agent_idx on public.tasks(selected_agent_id, status);

alter table public.agent_events enable row level security;
alter table public.deliverable_reviews enable row level security;
alter table public.api_idempotency enable row level security;
drop policy if exists agent_events_read_participants on public.agent_events;
create policy agent_events_read_participants on public.agent_events for select to authenticated using (
  exists (select 1 from public.agents a where a.id = agent_events.agent_id and a.owner_user_id = (select auth.uid()))
);
drop policy if exists agents_read_marketplace on public.agents;
create policy agents_read_marketplace on public.agents for select to authenticated using (
  is_active or owner_user_id = (select auth.uid())
);
drop policy if exists task_events_read_participants on public.task_events;
create policy task_events_read_participants on public.task_events for select to authenticated using (
  actor_user_id = (select auth.uid())
  or exists (select 1 from public.tasks t where t.id = task_events.task_id and t.owner_user_id = (select auth.uid()))
  or (
    event_type not like 'bid.%'
    and exists (
      select 1 from public.tasks t join public.agents a on a.id = t.selected_agent_id
      where t.id = task_events.task_id and a.owner_user_id = (select auth.uid())
    )
  )
);
drop policy if exists deliverable_reviews_read_participants on public.deliverable_reviews;
create policy deliverable_reviews_read_participants on public.deliverable_reviews for select to authenticated using (
  owner_user_id = (select auth.uid()) or exists (
    select 1 from public.tasks t join public.agents a on a.id = t.selected_agent_id
    where t.id = deliverable_reviews.task_id and a.owner_user_id = (select auth.uid())
  )
);
-- No browser write policies are granted. Mutations are authenticated, validated,
-- and audited by the server routes using the server-only PostgreSQL connection.
