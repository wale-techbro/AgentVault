use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::LookupMap;

#[derive(BorshDeserialize, BorshSerialize, Clone, near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct TaskEscrow {
    pub owner: AccountId,
    pub worker: Option<AccountId>,
    pub amount: NearToken,
    pub completion_submitted: bool,
    pub complete: bool,
    pub pending: bool,
    pub transfer_failed: bool,
    pub settled: bool,
    pub transaction_ref: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AgentVault {
    tasks: LookupMap<String, TaskEscrow>,
}

#[near]
impl AgentVault {
    /// Creates the contract's task map. The SDK enforces this initializer runs once.
    #[init]
    pub fn new() -> Self { Self { tasks: LookupMap::new(b"t") } }

    /// Deposits the attached NEAR into contract custody for this task.
    #[payable]
    pub fn create_escrow(&mut self, task_id: String) {
        require!(!task_id.is_empty(), "task id is required");
        require!(self.tasks.get(&task_id).is_none(), "task already exists");
        let amount = env::attached_deposit();
        require!(amount.as_yoctonear() > 0, "deposit must be positive");
        self.tasks.insert(&task_id, &TaskEscrow { owner: env::predecessor_account_id(), worker: None, amount, completion_submitted: false, complete: false, pending: false, transfer_failed: false, settled: false, transaction_ref: None });
        env::log_str(&format!("escrow_created:{task_id}"));
    }

    pub fn assign_worker(&mut self, task_id: String, worker: AccountId) {
        let mut task = self.tasks.get(&task_id).expect("task not found");
        require!(env::predecessor_account_id() == task.owner, "only task owner can select worker");
        require!(!task.settled && !task.pending, "task is already settling or settled");
        require!(!task.complete && !task.completion_submitted, "worker cannot change after completion submission");
        task.worker = Some(worker);
        self.tasks.insert(&task_id, &task);
    }

    pub fn record_completion(&mut self, task_id: String, transaction_ref: String) {
        let mut task = self.tasks.get(&task_id).expect("task not found");
        require!(task.worker.as_ref() == Some(&env::predecessor_account_id()), "only selected worker can submit completion");
        require!(!task.settled && !task.pending, "task is already settling or settled");
        require!(!task.complete && !task.completion_submitted, "completion was already submitted");
        require!(!transaction_ref.is_empty(), "completion reference is required");
        task.completion_submitted = true;
        task.transaction_ref = Some(transaction_ref);
        self.tasks.insert(&task_id, &task);
    }

    /// The task owner explicitly approves the delivered work before payment release.
    pub fn approve_completion(&mut self, task_id: String) {
        let mut task = self.tasks.get(&task_id).expect("task not found");
        require!(env::predecessor_account_id() == task.owner, "only task owner can approve completion");
        require!(task.worker.is_some(), "worker is not assigned");
        require!(!task.complete && !task.pending && !task.settled, "task is already complete or settling");
        task.complete = true;
        self.tasks.insert(&task_id, &task);
        env::log_str(&format!("completion_approved:{task_id}"));
    }

    /// Owner approval releases the escrow to the selected worker. Promise is the payout receipt.
    pub fn release_payment(&mut self, task_id: String) -> Promise {
        let mut task = self.tasks.get(&task_id).expect("task not found");
        require!(env::predecessor_account_id() == task.owner, "only task owner can approve payment");
        require!(task.complete, "task is not complete");
        require!(!task.settled && !task.pending, "task is already settling or settled");
        let worker = task.worker.clone().expect("worker is not assigned");
        task.pending = true;
        task.transfer_failed = false;
        self.tasks.insert(&task_id, &task);
        Promise::new(worker).transfer(task.amount).then(
            Promise::new(env::current_account_id()).function_call(
                "on_transfer_complete".to_string(),
                near_sdk::serde_json::to_vec(&task_id).expect("task id serialization failed"),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(20),
            )
        )
    }

    /// Owner can refund incomplete work, or reclaim funds after a failed payout receipt.
    pub fn refund(&mut self, task_id: String) -> Promise {
        let mut task = self.tasks.get(&task_id).expect("task not found");
        require!(env::predecessor_account_id() == task.owner, "only task owner can refund");
        require!(!task.settled && !task.pending, "task is already settling or settled");
        require!(!task.complete || task.transfer_failed, "completed work cannot be refunded unless payout failed");
        task.pending = true;
        task.transfer_failed = false;
        self.tasks.insert(&task_id, &task);
        Promise::new(task.owner).transfer(task.amount).then(
            Promise::new(env::current_account_id()).function_call(
                "on_transfer_complete".to_string(),
                near_sdk::serde_json::to_vec(&task_id).expect("task id serialization failed"),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(20),
            )
        )
    }

    #[private]
    pub fn on_transfer_complete(&mut self, task_id: String) -> bool {
        require!(env::promise_results_count() == 1, "expected one transfer result");
        let mut task = self.tasks.get(&task_id).expect("task not found");
        require!(task.pending && !task.settled, "task has no pending transfer");
        task.pending = false;
        task.settled = matches!(env::promise_result(0), PromiseResult::Successful(_));
        task.transfer_failed = !task.settled;
        if !task.settled { env::log_str(&format!("escrow_transfer_failed:{task_id}")); }
        self.tasks.insert(&task_id, &task);
        task.settled
    }

    pub fn get_task(&self, task_id: String) -> Option<TaskEscrow> { self.tasks.get(&task_id) }
}

#[cfg(test)]
mod tests;
