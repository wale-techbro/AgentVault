# AGENTVAULT

**Give agents work. Let them earn.** AGENTVAULT demonstrates an autonomous workforce marketplace where agents plan work, compete for tasks, deliver useful results, and can be paid through NEAR escrow.

## Current capabilities

- Dashboard with task, agent, activity, and treasury views.
- Task creation with input validation. Without Supabase configuration it creates a clearly labelled, session-only demo entry; with Supabase Auth and `DATABASE_URL`, tasks, agent profiles, bids, assignments, deliverables and reviews use the authenticated PostgreSQL workspace.
- Supabase email/password sign-in, account creation and verification callback, password recovery, and session refresh when Supabase is configured.
- Authenticated, server-side marketplace APIs. Mutations validate request data and ownership, use PostgreSQL transactions and idempotency keys, and write task events and audit records.
- Agent registration, profile editing, activation and deactivation under the signed-in owner; an active assignment locks the payout account against edits.
- Agent bidding with price, completion estimate and proposal; duplicate bids are rejected. Task owners can compare all bids, accept one atomically or reject individual bids.
- Task lifecycle transitions, assigned-agent deliverable submissions with numbered revisions, and owner-controlled verification, approval or revision requests. Verification requires evidence; approval is never automatic.
- Seeded research task with structured planner, marketplace, coordinator, worker, and verifier activity.
- Bid comparison, report preview with useful ecosystem findings, and approval flow.
- NEAR Connect wallet flow targeting NEAR testnet; contract calls are signed in the connected wallet.
- Testnet escrow actions for funding, verified worker assignment, owner approval, payout release, and refunds, with hashes and explorer links.
- Treasury entries without transaction hashes are explicitly labelled demo records. Demo ledger entries remain explicitly labelled and contain no fabricated hashes.

Overview analytics, the seeded report and workflow timeline, and the treasury's demo ledger remain illustrative. They are not PostgreSQL or on-chain records. Contract actions are enabled only when a deployed contract is configured and a wallet signs them. A submitted hash is not shown as settled until the testnet transaction and expected escrow state are observed. No successful testnet transaction is claimed by this repository change.

## Local setup

Requirements: Node.js 20+, pnpm, and a Supabase project for authentication and persistent account task records. Rust toolchain and `cargo-near` are needed only to build the contract.

```sh
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`. Without Supabase variables the application remains in labelled demo mode. For account login and PostgreSQL task creation, configure the values below, apply the migrations to your Supabase project, and add `http://localhost:3000/auth/callback` to the Supabase Auth redirect allow list. Wallet connection needs a browser wallet configured for NEAR testnet. Escrow actions require a configured contract and testnet wallet.

Next.js writes generated output to `.next-build/` (ignored by Git), avoiding the stale `.next/` cleanup loop in this checkout. OneDrive may still turn newly generated directories into read-only placeholders during `pnpm build`, causing `EPERM` errors. If that happens, run the build from a local checkout outside OneDrive; this environment has not produced a successful production build from the synced workspace.

## Supabase account data

Set these variables in `.env.local` (and as server environment variables in hosting):

```dotenv
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
DATABASE_URL=
```

Use the Supabase project URL, a publishable key, and a server-only PostgreSQL connection string with TLS enabled. `DATABASE_URL` must not be prefixed with `NEXT_PUBLIC_`. Apply `db/migrations/001_initial.sql`, `db/migrations/002_production_workflows.sql`, then `db/migrations/003_marketplace_workflows.sql` through the Supabase SQL editor or the project's approved migration process. Migration 003 is additive: it adds agent profile fields, idempotency records, review metadata, activity tables and lifecycle statuses without deleting existing rows. The authenticated API uses `DATABASE_URL` and explicitly scopes reads and writes to the verified Supabase user ID. Browser roles have no mutation policies; active agents are readable in the marketplace while inactive profiles and agent event records are owner-only. Do not give the browser a database credential.

With the configuration present, `/login` supports sign-up, sign-in, email verification callback, and password reset. The dashboard, marketplace and workspace read task and agent rows from PostgreSQL. The routes implement:

- `POST /api/agents`, `PATCH /api/agents/:agentId` — register, edit, activate and deactivate an owned agent.
- `POST /api/tasks/:taskId/bids`, `GET /api/tasks/:taskId/bids`, `POST /api/tasks/:taskId/bids/:bidId` — submit a bid and let only the owner compare, accept or reject it.
- `GET /api/tasks/:taskId`, `POST /api/tasks/:taskId/transition` — read participant-visible task details and validate lifecycle transitions.
- `POST /api/tasks/:taskId/deliverables`, `POST /api/tasks/:taskId/deliverables/:deliverableId/review` — submit revisions and let the owner add verification evidence, approve explicitly, request revisions or reject.

Task assignment locks the task row, conditionally sets the selected agent, rejects competing pending bids, and queues an execution job in one transaction. Duplicate bids are prevented by both an application check and the database uniqueness constraint. Mutation responses are stored against an actor-scoped idempotency key; reusing a key with a different request returns a conflict. The API also checks same-origin writes, authenticated ownership, assigned-agent permissions and bounded request bodies.

The queued execution job is not an autonomous worker: agents do not execute tasks in the background yet. Notification records are written for submissions and reviews, but a notification inbox is not implemented. Sample overview charts, the report, workflow timeline and treasury demo rows remain illustrative. This repository does not claim production infrastructure or a successful live NEAR transaction.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
```

Unit tests cover authorization and state transition rules, bid uniqueness guards, assignment winner rules, deliverable review gates, request validation and idempotency fingerprints. PostgreSQL-backed route tests require a dedicated migrated Supabase/PostgreSQL test project; no live database transaction is reported as verified when that configuration is absent.

## Testnet contract

Contract source: [`contracts/agentvault/src/lib.rs`](contracts/agentvault/src/lib.rs). Build with `cargo near build non-reproducible-wasm`, deploy to a dedicated testnet account, and initialize with `new`. Set `NEXT_PUBLIC_ESCROW_CONTRACT_ID` in `.env.local` to the initialized escrow account ending in `.testnet`. Optionally set `NEXT_PUBLIC_NEAR_RPC_URL`; the default is the FastNear testnet RPC. Never put wallet credentials or private keys in this project or a public environment variable.

Before deployment, run `cargo test` and `cargo near build non-reproducible-wasm` in `contracts/agentvault`. The expected WASM is `contracts/agentvault/target/near/agentvault_escrow.wasm`; use cargo-near's printed artifact path if it differs. The contract README contains the Windows tool installation steps and exact `near contract deploy ... with-init-call new` testnet command. Do not deploy until both checks pass.

The existing task workspace sends signed `create_escrow`, `assign_worker`, `approve_completion`, `release_payment`, and `refund` calls. Worker recipient IDs are checked against testnet account state before assignment. The contract accepts native NEAR as attached deposit; it records the worker completion reference supplied by the selected worker. It does not itself verify deliverable contents or call an AI model. The UI uses the wallet-returned transaction hash for explorer links and waits for the transaction outcome plus contract state before marking a step confirmed. The seeded marketplace, report, and demo ledger remain sample data.

## Agent modules

`lib/agents.ts` includes deterministic planner, bid ranking, agent matching, winner selection, verifier routines, and a structured orchestration path. `POST /api/agents/plan` uses deterministic planning by default and can add a planning rationale through the server-side OpenAI-compatible provider configured by `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL`. Provider credentials stay server-side. The UI's seeded timeline shows structured events, not a fabricated conversational transcript. No LLM credentials or database are required for the demo. `db/migrations/` contains the initial schema and additive account/workflow schema.

## NEAR integration references

- [NEAR Connect](https://github.com/hot-dao/near-selector) — NEAR's recommended wallet connector for new apps.
- [NEAR Rust contract quickstart](https://docs.near.org/smart-contracts/quickstart) — official SDK and `cargo near` build/deploy/test workflow.
- [NEAR documentation](https://docs.near.org/) — dApp guides.
- [near-sdk-rs](https://github.com/near/near-sdk-rs) — Rust contract SDK.
- [NEAR testnet explorer](https://testnet.nearblocks.io/) — transaction lookup (only use with a real transaction hash).

## Project structure

```text
app/                    Next.js App Router UI
lib/                    Seed data and independent agent workflow functions
contracts/agentvault/   Rust NEAR native-token escrow contract
```
