use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use near_sdk::serde_json::{json, Value};

type Sandbox = Worker<near_workspaces::network::Sandbox>;

async fn deploy() -> anyhow::Result<(Sandbox, Contract, Account)> {
    let sandbox = near_workspaces::sandbox().await?;
    let wasm = near_workspaces::compile_project(env!("CARGO_MANIFEST_DIR")).await?;
    let contract = sandbox.dev_deploy(&wasm).await?;
    let outcome = contract.call("new").transact().await?;
    assert!(outcome.is_success(), "contract init failed: {outcome:?}");
    let owner = sandbox.dev_create_account().await?;
    Ok((sandbox, contract, owner))
}

async fn task_view(contract: &Contract, task_id: &str) -> anyhow::Result<Value> {
    Ok(contract.view("get_task")
        .args_json(json!({ "task_id": task_id }))
        .await?
        .json::<Value>()?)
}

#[tokio::test]
async fn funds_assigns_approves_pays_and_refunds_in_sandbox() -> anyhow::Result<()> {
    let (sandbox, contract, owner) = deploy().await?;
    let worker = sandbox.dev_create_account().await?;

    let funded = owner.call(contract.id(), "create_escrow")
        .args_json(json!({ "task_id": "payout-case" }))
        .deposit(NearToken::from_near(1))
        .transact().await?;
    assert!(funded.is_success(), "funding failed: {funded:?}");

    let assigned = owner.call(contract.id(), "assign_worker")
        .args_json(json!({ "task_id": "payout-case", "worker": worker.id() }))
        .transact().await?;
    assert!(assigned.is_success(), "assignment failed: {assigned:?}");

    let submission = worker.call(contract.id(), "record_completion")
        .args_json(json!({ "task_id": "payout-case", "transaction_ref": "deliverable-123" }))
        .transact().await?;
    assert!(submission.is_success(), "worker completion submission failed: {submission:?}");
    let submitted = task_view(&contract, "payout-case").await?;
    assert_eq!(submitted["completion_submitted"], true);
    assert_eq!(submitted["complete"], false, "worker submission is not owner approval");

    let approved = owner.call(contract.id(), "approve_completion")
        .args_json(json!({ "task_id": "payout-case" }))
        .transact().await?;
    assert!(approved.is_success(), "approval failed: {approved:?}");
    let approved_state = task_view(&contract, "payout-case").await?;
    assert_eq!(approved_state["complete"], true);

    let payout = owner.call(contract.id(), "release_payment")
        .args_json(json!({ "task_id": "payout-case" }))
        .transact().await?;
    assert!(payout.is_success(), "payout receipt chain failed: {payout:?}");
    let paid = task_view(&contract, "payout-case").await?;
    assert_eq!(paid["complete"], true);
    assert_eq!(paid["pending"], false);
    assert_eq!(paid["settled"], true);
    assert_eq!(paid["worker"], worker.id().as_str());

    let funded_refund = owner.call(contract.id(), "create_escrow")
        .args_json(json!({ "task_id": "refund-case" }))
        .deposit(NearToken::from_near(1))
        .transact().await?;
    assert!(funded_refund.is_success(), "refund escrow funding failed: {funded_refund:?}");

    let refund = owner.call(contract.id(), "refund")
        .args_json(json!({ "task_id": "refund-case" }))
        .transact().await?;
    assert!(refund.is_success(), "refund receipt chain failed: {refund:?}");
    let refunded = task_view(&contract, "refund-case").await?;
    assert_eq!(refunded["pending"], false);
    assert_eq!(refunded["settled"], true);
    assert_eq!(refunded["complete"], false);
    Ok(())
}

#[tokio::test]
async fn failed_worker_transfer_clears_pending_and_owner_can_refund() -> anyhow::Result<()> {
    let (_sandbox, contract, owner) = deploy().await?;
    let missing_recipient = "missing-worker.testnet";

    assert!(owner.call(contract.id(), "create_escrow")
        .args_json(json!({ "task_id": "failure-case" }))
        .deposit(NearToken::from_near(1)).transact().await?.is_success());
    assert!(owner.call(contract.id(), "assign_worker")
        .args_json(json!({ "task_id": "failure-case", "worker": missing_recipient }))
        .transact().await?.is_success());
    assert!(owner.call(contract.id(), "approve_completion")
        .args_json(json!({ "task_id": "failure-case" }))
        .transact().await?.is_success());

    // The NEAR transaction succeeds, but its transfer receipt fails because the
    // syntactically valid recipient account does not exist in the sandbox.
    let payout = owner.call(contract.id(), "release_payment")
        .args_json(json!({ "task_id": "failure-case" }))
        .transact().await?;
    assert!(payout.is_success(), "callback should handle the failed transfer: {payout:?}");
    let failed = task_view(&contract, "failure-case").await?;
    assert_eq!(failed["pending"], false);
    assert_eq!(failed["settled"], false);
    assert_eq!(failed["transfer_failed"], true);

    let refund = owner.call(contract.id(), "refund")
        .args_json(json!({ "task_id": "failure-case" }))
        .transact().await?;
    assert!(refund.is_success(), "owner refund after failed payout failed: {refund:?}");
    let refunded = task_view(&contract, "failure-case").await?;
    assert_eq!(refunded["pending"], false);
    assert_eq!(refunded["settled"], true);
    Ok(())
}
