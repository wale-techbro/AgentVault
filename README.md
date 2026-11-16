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
- Separate PostgreSQL-backed Node worker for queued task execution, with atomic claims, leases, retries, attempt history, execution logs and a deliverable review handoff.

Overview analytics, the seeded report and workflow timeline, and the treasury's demo ledger remain illustrative. They are not PostgreSQL or on-chain records. Contract actions are enabled only when a deployed contract is configured and a wallet signs them. A submitted hash is not shown as settled until the testnet transaction and expected escrow state are observed. No successful testnet transaction is claimed by this repository change.

## Local setup

Requirements: Node.js 20+, pnpm, and a Supabase project for authentication and persistent account task records. Rust toolchain and `cargo-near` are needed only to build the contract.

```sh
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`. Without Supabase variables the application remains in labelled demo mode. For account login and PostgreSQL task creation, configure the values below, apply the migrations to your Supabase project, and add `http://localhost:3000/auth/callback` to the Supabase Auth redirect allow list. Wallet connection needs a browser wallet configured for NEAR testnet. Escrow actions require a configured contract and testnet wallet.

Next.js uses its default `.next/` output directory. If OneDrive blocks generated files with `EPERM`, point `NEXT_BUILD_DIR` to a directory outside the synced folder for both build and start. The default remains unchanged when this variable is unset. In PowerShell:

```powershell
$env:NEXT_BUILD_DIR = Join-Path $env:TEMP 'AgentVault-next-build'
pnpm build
pnpm start
```

Keep that PowerShell environment variable set while running `pnpm start` so Next.js loads the same build directory.

## Supabase account data

Set these variables in `.env.local` (and as server environment variables in hosting):

```dotenv
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
DATABASE_URL=
```

Use the Supabase project URL, a publishable key, and a server-only PostgreSQL connection string with TLS enabled. `DATABASE_URL` must not be prefixed with `NEXT_PUBLIC_`. Apply `db/migrations/001_initial.sql` through `db/migrations/005_autonomous_worker_runtime.sql` in order through the Supabase SQL editor or the project's approved migration process. Migration 004 hardens auth-trigger permissions. Migrations 003 and 005 are additive: they preserve existing marketplace records while adding workflow metadata, worker leases, per-attempt execution records, worker health and logs, and deliverable attribution/deduplication. The authenticated API uses `DATABASE_URL` and scopes reads and writes to the verified Supabase user ID. Browser roles have no mutation policies; active agents are readable in the marketplace while worker heartbeat rows are server-only. Do not give the browser a database credential.

With the configuration present, `/login` supports sign-up, sign-in, email verification callback, and password reset. The dashboard, marketplace and workspace read task and agent rows from PostgreSQL. The routes implement:

- `POST /api/agents`, `PATCH /api/agents/:agentId` — register, edit, activate and deactivate an owned agent.
- `POST /api/tasks/:taskId/bids`, `GET /api/tasks/:taskId/bids`, `POST /api/tasks/:taskId/bids/:bidId` — submit a bid and let only the owner compare, accept or reject it.
- `GET /api/tasks/:taskId`, `POST /api/tasks/:taskId/transition` — read participant-visible task details and validate lifecycle transitions.
- `POST /api/tasks/:taskId/deliverables`, `POST /api/tasks/:taskId/deliverables/:deliverableId/review` — submit revisions and let the owner add verification evidence, approve explicitly, request revisions or reject.

Task assignment locks the task row, conditionally sets the selected agent, rejects competing pending bids, and queues an execution job in one transaction. Duplicate bids are prevented by both an application check and the database uniqueness constraint. Mutation responses are stored against an actor-scoped idempotency key; reusing a key with a different request returns a conflict. The API also checks same-origin writes, authenticated ownership, assigned-agent permissions and bounded request bodies.

With the worker running and `AI_PROVIDER=openai-compatible` configured, an accepted task is claimed from PostgreSQL and executed independently of the browser. The current allowlisted capability is bounded text synthesis from the task description and accepted proposal. Research requiring external sources, code execution, messaging, payment and other side effects are rejected as unsupported; the worker has no shell, browser, unrestricted network or payment tools. It records one `agent_runs` row per attempt, maintains a lease and heartbeat, uses capped retries, and writes an attributed deliverable for owner review. Invalid or failed executions do not create deliverables. The worker cannot verify or approve its own work and cannot release or refund NEAR escrow. The task workspace shows persisted queue, planning, running, retry, failure, submission and owner-review states. Notification rows are persisted, but a notification inbox is not implemented. Sample overview charts, the report, workflow timeline and treasury demo rows remain illustrative. This repository does not claim a successful live NEAR transaction.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
```

Unit tests cover authorization and state transition rules, bid uniqueness guards, assignment winner rules, deliverable review gates, request validation, idempotency fingerprints, bounded execution and provider timeout/retry/limits. To run PostgreSQL queue integration tests, configure `WORKER_TEST_DATABASE_URL` to a **separate disposable database** with migrations 001–005 applied, then run `pnpm test`. The integration case inserts uniquely named fixture rows, exercises concurrent workers, lease recovery, retries and duplicate completion, then removes its fixtures. Do not point it at production or a database containing important data. Without that variable the PostgreSQL test is skipped; no live database transaction is claimed as verified.

## Autonomous execution worker

The worker is a separate long-running Node process. Start it in another terminal from the web app:

```sh
pnpm worker
```

`pnpm worker` compiles the dedicated worker TypeScript project into ignored `dist-worker/` output, loads local `.env.local` values, connects directly to PostgreSQL and polls for assigned task jobs. The same command can run without the Next.js web process, but both processes must use the same database. Apply migrations through 005 before starting it. Set `AI_PROVIDER=openai-compatible`, `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL`; supported provider endpoints use the OpenAI-compatible chat completions format and JSON mode. `AI_API_KEY`, `DATABASE_URL`, and task/agent context are server-side only. Task content and the accepted proposal are sent to the configured AI provider for execution, so do not include credentials or secrets in task descriptions. Set conservative `AI_MAX_*` limits and set `AI_COST_PER_1K_TOKENS_USD` at or above the model's blended input/output rate; the worker uses provider-reported token counts when present, reserves the configured worst-case request cost before retries, and enforces the configured estimated run cost cap.

Worker controls are `WORKER_POLL_INTERVAL_MS`, `WORKER_LEASE_MS`, `WORKER_HEARTBEAT_MS`, `WORKER_MAX_ATTEMPTS`, `WORKER_MAX_PER_AGENT`, and `WORKER_MAX_PER_TASK`; defaults are in `.env.example`. Leases are claimed transactionally with `FOR UPDATE SKIP LOCKED`. A new attempt receives a new run record, expired leases are recovered, and the unique job/run deliverable indexes prevent duplicate worker submissions. Errors are persisted as safe codes only. The authenticated `GET /api/worker/health` endpoint reports whether any worker has checked in recently; it returns no database credentials or provider secrets.

### Render background worker

Create a separate **Background Worker** service in Render linked to this repository. Select `production-readiness` as its branch. Configure:

- Runtime: Node.
- Build command: `corepack enable && pnpm install --frozen-lockfile && pnpm worker:build`.
- Start command: `node dist-worker/worker/index.js` (or `pnpm worker`, which also compiles on startup).
- Environment: `DATABASE_URL`, `AI_PROVIDER=openai-compatible`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, and any desired worker/AI limits from `.env.example`.
- Set the worker's shutdown grace period to at least 120 seconds so an in-flight bounded provider request can finish before Render stops the process.

Keep secrets in Render's service environment, never in the repository or `NEXT_PUBLIC_*` variables. Deploy this worker only after migrations and provider configuration are ready; this repository change does not create or deploy a Render service. See [Render Background Workers](https://render.com/docs/background-workers) and the [Render Blueprint service reference](https://render.com/docs/blueprint-spec).

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
