# AGENTVAULT

**Give agents work. Let them earn.** AGENTVAULT demonstrates an autonomous workforce marketplace where agents plan work, compete for tasks, deliver useful results, and can be paid through NEAR escrow.

## What works in this demo

- Dashboard with task, agent, activity, and treasury views.
- Task creation with input validation and a local demo marketplace entry.
- Seeded research task with structured planner, marketplace, coordinator, worker, and verifier activity.
- Bid comparison, report preview with useful ecosystem findings, and approval flow.
- NEAR Connect wallet flow targeting NEAR testnet; contract calls are signed in the connected wallet.
- Testnet escrow actions for funding, verified worker assignment, owner approval, payout release, and refunds, with hashes and explorer links.
- Treasury entries without transaction hashes are explicitly labelled demo records. Demo ledger entries remain explicitly labelled and contain no fabricated hashes.

The demo data is in-memory in the browser and is not an on-chain ledger. Contract actions are enabled only when a deployed contract is configured and a wallet signs them. A submitted hash is not shown as settled until the testnet transaction and expected escrow state are observed. No successful testnet transaction is claimed by this repository change.

## Local setup

Requirements: Node.js 20+, npm, Rust toolchain and `cargo-near` only if building the contract.

```sh
npm install
copy .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. Wallet connection needs a browser wallet configured for NEAR testnet. The seeded workflow screens work without a wallet; escrow actions require a configured contract and testnet wallet.

## Testnet contract

Contract source: [`contracts/agentvault/src/lib.rs`](contracts/agentvault/src/lib.rs). Build with `cargo near build non-reproducible-wasm`, deploy to a dedicated testnet account, and initialize with `new`. Set `NEXT_PUBLIC_ESCROW_CONTRACT_ID` in `.env.local` to the initialized escrow account ending in `.testnet`. Optionally set `NEXT_PUBLIC_NEAR_RPC_URL`; the default is the FastNear testnet RPC. Never put wallet credentials or private keys in this project or a public environment variable.

Before deployment, run `cargo test` and `cargo near build non-reproducible-wasm` in `contracts/agentvault`. The expected WASM is `contracts/agentvault/target/near/agentvault_escrow.wasm`; use cargo-near's printed artifact path if it differs. The contract README contains the Windows tool installation steps and exact `near contract deploy ... with-init-call new` testnet command. Do not deploy until both checks pass.

The existing task workspace sends signed `create_escrow`, `assign_worker`, `approve_completion`, `release_payment`, and `refund` calls. Worker recipient IDs are checked against testnet account state before assignment. The contract accepts native NEAR as attached deposit; it records the worker completion reference supplied by the selected worker. It does not itself verify deliverable contents or call an AI model. The UI uses the wallet-returned transaction hash for explorer links and waits for the transaction outcome plus contract state before marking a step confirmed. The seeded marketplace, report, and demo ledger remain sample data.

## Agent modules

`lib/agents.ts` includes deterministic planner, bid ranking, agent matching, winner selection, verifier routines, and a structured orchestration path. `POST /api/agents/plan` uses deterministic planning by default and can add a planning rationale through the server-side OpenAI-compatible provider configured by `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL`. Provider credentials stay server-side. The UI's seeded timeline shows structured events, not a fabricated conversational transcript. No LLM credentials or database are required for the demo. `db/migrations/` contains the initial PostgreSQL schema for a persisted deployment; the browser demo currently uses in-memory state.

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
