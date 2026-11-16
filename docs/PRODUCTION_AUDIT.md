# AgentVault production readiness audit

Audit date: 2026-11-16
Baseline branch: `production-readiness`
Baseline commit: `dc55d30` (`Initial AgentVault implementation`)

## Existing functionality

- Next.js App Router, React 19, TypeScript, and a single large client-side dashboard in `app/page.tsx`.
- Existing visual identity, dashboard, task marketplace, agent directory, treasury, and task workspace.
- Task creation, task switching, demo records, and approval presentation are React component state. No persistence API is called by the dashboard.
- `/api/agents/plan` validates a bounded request, runs deterministic planning, and can optionally request a rationale from a server-side OpenAI-compatible provider.
- NEAR Connect wallet connection, testnet account verification, contract read/call helpers, hash links, and a Rust native-token escrow contract are present. The browser flow depends on a configured testnet contract and has not been proven against a live deployment.
- Rust unit and sandbox workflow tests are present, but the environment previously could not fetch crates.io packages, so their passing status is unverified.
- `db/migrations/001_initial.sql` defines agents, tasks, bids, events, deliverables, and escrow receipts. It has no auth-user ownership, RLS policies, updated-at trigger, durable job/action/approval/notification tables, or application database client.

## Incomplete functionality

- No Supabase client, auth callbacks, session middleware, sign-in, sign-up, password reset, profiles, or account roles.
- No PostgreSQL runtime integration. Dashboard operations do not use the existing tables.
- Marketplace entries, bids, agents, activity, and treasury demo rows are seeded/in-memory data. Task creation is local-only.
- No persistent agent assignment, worker execution queue, deliverable submission API, dispute flow, notifications, or admin operations.
- No independent worker or durable job runner; no idempotent execution ledger or restart recovery.
- The task planner endpoint is unauthenticated and has no rate limiting. It returns provider error text to callers.
- No integration tests for authenticated database routes, RLS, or the live NEAR testnet workflow.

## Architecture and configuration

- The repo contains both `pnpm-lock.yaml` and `package-lock.json`, plus `pnpm-workspace.yaml`. Use pnpm for dependency changes and avoid regenerating the npm lockfile.
- `DATABASE_URL` exists only as an empty template in `.env.example`; the application does not read it. Supabase URL/anon key configuration is absent.
- `NEXT_PUBLIC_ESCROW_CONTRACT_ID` is intentionally unset in the template. No server-side credentials or live Supabase configuration were inspected.
- The Vercel and Supabase project claims in the supplied brief cannot be verified from the checked-out files or available connections; this implementation will not alter remote infrastructure.

## Security and integrity risks

- In-memory task ownership is not an authorization boundary. Client-supplied wallet/account state cannot safely establish user identity.
- Existing migration has no row-level policies and uses free-form text for task owner identity. Do not expose the existing schema to a browser client until a versioned ownership/RLS migration has been applied.
- The planning endpoint can spend an optional provider key without auth or rate limits and currently maps some server exceptions to HTTP 400.
- Demo content and seeded aggregate metrics must remain explicitly distinguishable from persisted marketplace records and successful chain transactions.
- A testnet transaction hash is not proof that the corresponding task action is authorized or that the DB state is consistent; chain and DB transitions need explicit ownership checks and audit events.

## Recommended implementation sequence

1. Add a versioned, additive Supabase migration for profiles, ownership columns, task execution/audit records, approvals, notifications, idempotency, constraints, indexes, timestamps, and RLS policies. Preserve migration 001 and existing rows.
2. Add server-only Supabase clients and cookie/session refresh, auth pages/actions, and authenticated session/authorization helpers.
3. Add Zod-validated, authenticated, RLS-backed task, bid, assignment, deliverable, event, and receipt routes. Move task marketplace data to server queries; retain demo mode as a separate, explicitly labeled option.
4. Add a durable worker/job model with lease/claim semantics, retries, idempotency windows, pause/stop settings, and audit logs before enabling autonomous actions.
5. Integrate NEAR receipts with authorized DB transitions; test against sandbox and a configured testnet contract before claiming live execution.
6. Add route/service tests and run pnpm typecheck, tests, and production build. Apply migrations only through an explicitly selected Supabase project; do not apply them to production from this local task.

This audit records repository evidence only. It does not claim production infrastructure or testnet behavior has been verified.

## Implementation status

On `production-readiness`, this change adds Supabase Auth browser/server clients, session-refresh middleware, sign-in/sign-up/password-reset routes, and an additive migration for user ownership, execution/audit records, idempotency, and RLS. The dashboard's task and agent marketplace views load from PostgreSQL when Auth is configured. Task creation is authenticated and transactionally writes a task, event, and audit record. Without Supabase configuration, the existing local demo remains available and is labeled as demo data.

The server routes use only `DATABASE_URL`, scope task queries to the verified user or open marketplace tasks, validate inputs, and avoid returning SQL errors. RLS policies permit scoped reads and deny browser-role mutations; mutations must go through the server. Apply migration 002 to each environment before enabling these routes. No Supabase credentials or production project access were available during this change, so database migration execution and live account round trips have not been verified.

The rest of the production marketplace remains incomplete: persistent bid submission/selection, task transitions, deliverables, verification, disputes, notifications, worker/job execution, admin operations, and persistent escrow receipts are not wired to the UI. Summary analytics and treasury demo rows remain sample data. NEAR testnet success is not asserted.

The attached production prompt ends during its authentication section, after requesting authorization checks for role-sensitive operations. Requirements after that point were not available in the supplied file and are not represented as completed.

## Local validation

- `pnpm typecheck`: passed.
- `pnpm test`: passed, 20 tests across 3 files.
- `pnpm build`: did not complete in this environment. Next.js 15.5.29 printed its version then remained silent; the same occurred with `--no-lint`, `--debug`, and compile-only mode on Node 26.13.0 / Windows 11. The build process was interrupted after extended stalls; no source error was emitted.
- PostgreSQL and Supabase CLIs/configuration were not available, so migration execution and authenticated database integration could not be tested.
