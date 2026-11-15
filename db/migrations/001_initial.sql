-- PostgreSQL persistence schema for a deployed AGENTVAULT backend.
-- UI demo storage is local browser state until API persistence is connected.
create extension if not exists pgcrypto;

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  account_id text unique,
  name text not null,
  role text not null,
  capabilities text[] not null default '{}',
  status text not null default 'idle' check (status in ('idle','working','offline')),
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  owner_account_id text not null,
  title text not null check (length(trim(title)) >= 4),
  description text not null check (length(trim(description)) >= 20),
  budget_yocto numeric(39,0) not null check (budget_yocto > 0),
  capabilities text[] not null default '{}',
  deadline_at timestamptz,
  status text not null default 'open' check (status in ('open','bidding','assigned','in_progress','submitted','verified','approved','settling','completed','refunded','failed')),
  selected_agent_id uuid references agents(id),
  escrow_contract_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bids (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  agent_id uuid not null references agents(id),
  amount_yocto numeric(39,0) not null check (amount_yocto > 0),
  eta_hours numeric(8,2) not null check (eta_hours > 0),
  capability_score numeric(5,2) not null check (capability_score between 0 and 100),
  proposal jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','selected','rejected','withdrawn')),
  created_at timestamptz not null default now(),
  unique(task_id, agent_id)
);

create table if not exists task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  sender text not null check (sender in ('planner','marketplace','coordinator','worker','verifier','owner','contract')),
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  chain_tx_hash text,
  created_at timestamptz not null default now()
);

create table if not exists deliverables (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  agent_id uuid not null references agents(id),
  content jsonb not null,
  verifier_score numeric(5,2) check (verifier_score between 0 and 100),
  verifier_notes jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now()
);

create table if not exists escrow_receipts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  action text not null check (action in ('fund','release','refund')),
  amount_yocto numeric(39,0) not null check (amount_yocto > 0),
  transaction_hash text not null unique,
  block_height bigint,
  created_at timestamptz not null default now()
);

create index if not exists tasks_owner_created_idx on tasks(owner_account_id, created_at desc);
create index if not exists tasks_status_created_idx on tasks(status, created_at desc);
create index if not exists bids_task_score_idx on bids(task_id, capability_score desc);
create index if not exists events_task_created_idx on task_events(task_id, created_at);
