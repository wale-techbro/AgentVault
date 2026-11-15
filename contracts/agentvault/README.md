# AgentVault escrow contract

Native NEAR escrow built with `near-sdk`. The Rust tests include unit tests and sandbox integration tests for funding, worker submission, owner approval, release, refund, and failed payout recovery.

## Initialization and access control

`new()` is the one-time `#[init]` initializer. It creates the task map and requires no arguments. Deploy the contract and initialize it in the same `near contract deploy ... with-init-call new` transaction shown below.

| Method | Authorization / behavior |
| --- | --- |
| `create_escrow` | Any caller can create a unique task ID; attached NEAR must be positive. Caller becomes owner. |
| `assign_worker` | Owner only; cannot change assignment after completion submission, approval, or settlement. |
| `record_completion` | Currently assigned worker only; records a non-empty completion reference without approving payout. |
| `approve_completion` | Owner only; requires an assigned worker; records owner approval separately from worker submission. |
| `release_payment` | Owner only; requires approval; transfers escrow amount to the assigned worker. |
| `refund` | Owner only; allowed before approval or after a failed worker transfer. |
| `on_transfer_complete` | Private callback; only the contract can invoke it. Marks settled only after the transfer promise succeeds; otherwise records failure and clears pending state. |
| `get_task` | Public view method. |

## Test and build

Run tests before building or deploying. The sandbox integration tests compile and deploy the contract locally using `near-workspaces`.

```powershell
cd C:\Users\HP\OneDrive\Documents\ChatGPT\AgentVault\contracts\agentvault
cargo test
cargo near build non-reproducible-wasm
```

The expected WASM output is `target\near\agentvault_escrow.wasm` relative to this crate. Use the path printed by `cargo near build` as the source of truth; a successful output has not yet been generated in this environment.

## Testnet deployment and initialization

Prerequisites: Rust stable, the `wasm32-unknown-unknown` target, [`cargo-near`](https://github.com/near/cargo-near), and [`near-cli-rs`](https://github.com/near/near-cli-rs). Install the Windows `cargo-near` binary with the official PowerShell installer:

```powershell
irm https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.ps1 | iex
rustup target add wasm32-unknown-unknown
irm https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.ps1 | iex
```

Create or select a funded NEAR testnet account using `near` CLI setup. Keep signing material in the CLI's secure keychain; never paste private keys into commands, source files, or the app. After `cargo test` and `cargo near build` both pass, set the deployed account ID and deploy plus initialize:

```powershell
$env:CONTRACT_ID = "your-contract-account.testnet"
$wasm = ".\target\near\agentvault_escrow.wasm"
if (-not (Test-Path $wasm)) { throw "WASM not found: $wasm" }
near contract deploy $env:CONTRACT_ID `
  use-file $wasm `
  with-init-call new `
    json-args '{}' `
    prepaid-gas '100.0 Tgas' `
    attached-deposit '0 NEAR' `
  network-config testnet `
  sign-with-keychain `
  send
```

The CLI will prompt for signing through the configured keychain. Do not proceed to deploy unless the test and build commands above have passed. After deployment, set `NEXT_PUBLIC_ESCROW_CONTRACT_ID` in the app's `.env.local` to this initialized testnet account ID.

The contract only manages NEAR custody and transfer state. It does not store deliverable contents or verify off-chain work. `transaction_ref` is a worker-provided reference string, not a cryptographic proof.
