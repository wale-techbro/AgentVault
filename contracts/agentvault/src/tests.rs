use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};

fn context(predecessor: &str, deposit: NearToken) {
    let mut builder = VMContextBuilder::new();
    builder.current_account_id("vault.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .attached_deposit(deposit);
    testing_env!(builder.build());
}

#[test]
fn creates_and_assigns_funded_escrow() {
    context("owner.testnet", NearToken::from_near(1));
    let mut vault = AgentVault::new();
    vault.create_escrow("task-1".to_string());
    vault.assign_worker("task-1".to_string(), "worker.testnet".parse().unwrap());
    let task = vault.get_task("task-1".to_string()).unwrap();
    assert_eq!(task.owner, "owner.testnet".parse().unwrap());
    assert_eq!(task.worker.unwrap(), "worker.testnet".parse().unwrap());
    assert_eq!(task.amount, NearToken::from_near(1));
    assert!(!task.completion_submitted);
    assert!(!task.complete);
    assert!(!task.transfer_failed);
}

#[test]
fn worker_submission_is_separate_from_owner_approval() {
    context("owner.testnet", NearToken::from_near(1));
    let mut vault = AgentVault::new();
    vault.create_escrow("task-completion".to_string());
    vault.assign_worker("task-completion".to_string(), "worker.testnet".parse().unwrap());
    context("worker.testnet", NearToken::from_near(0));
    vault.record_completion("task-completion".to_string(), "deliverable-123".to_string());

    let submitted = vault.get_task("task-completion".to_string()).unwrap();
    assert!(submitted.completion_submitted);
    assert!(!submitted.complete, "worker submission must not imply owner approval");
    assert_eq!(submitted.transaction_ref.as_deref(), Some("deliverable-123"));

    context("owner.testnet", NearToken::from_near(0));
    vault.approve_completion("task-completion".to_string());
    assert!(vault.get_task("task-completion".to_string()).unwrap().complete);
}

#[test]
#[should_panic(expected = "only task owner can select worker")]
fn rejects_worker_assignment_by_other_account() {
    context("owner.testnet", NearToken::from_near(1));
    let mut vault = AgentVault::new();
    vault.create_escrow("task-2".to_string());
    context("stranger.testnet", NearToken::from_near(0));
    vault.assign_worker("task-2".to_string(), "worker.testnet".parse().unwrap());
}

#[test]
#[should_panic(expected = "only selected worker can submit completion")]
fn rejects_completion_from_non_worker() {
    context("owner.testnet", NearToken::from_near(1));
    let mut vault = AgentVault::new();
    vault.create_escrow("task-3".to_string());
    vault.assign_worker("task-3".to_string(), "worker.testnet".parse().unwrap());
    context("stranger.testnet", NearToken::from_near(0));
    vault.record_completion("task-3".to_string(), "ref".to_string());
}
