import { JsonRpcProvider } from 'near-api-js';

const TESTNET_RPC_URL = process.env.NEXT_PUBLIC_NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
const connectorOptions = { network: 'testnet' as const };

export type EscrowView = {
  owner: string;
  worker: string | null;
  amount: string;
  completion_submitted: boolean;
  complete: boolean;
  pending: boolean;
  transfer_failed: boolean;
  settled: boolean;
  transaction_ref: string | null;
};
export type EscrowCall = 'create_escrow' | 'assign_worker' | 'approve_completion' | 'release_payment' | 'refund';

let connectorSingleton: import('@hot-labs/near-connect').NearConnector | undefined;
let providerSingleton: JsonRpcProvider | undefined;

export function isValidNearAccountId(accountId: string): boolean {
  return accountId.length >= 2 && accountId.length <= 64 && /^[a-z0-9]{2,64}(?:[-_.][a-z0-9]{2,64})*$/.test(accountId);
}

export function getEscrowContractId(): string {
  const contractId = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID?.trim().toLowerCase();
  if (!contractId) throw new Error('Set NEXT_PUBLIC_ESCROW_CONTRACT_ID to a deployed NEAR testnet contract account.');
  if (!contractId.endsWith('.testnet') || !isValidNearAccountId(contractId)) {
    throw new Error('Escrow contract must be a valid NEAR testnet account ID ending in .testnet.');
  }
  return contractId;
}

function getProvider() {
  return providerSingleton ?? (providerSingleton = new JsonRpcProvider({ url: TESTNET_RPC_URL }));
}

export async function connectNearWallet() {
  const { NearConnector } = await import('@hot-labs/near-connect');
  const connector = connectorSingleton ?? (connectorSingleton = new NearConnector(connectorOptions));
  const wallet = await connector.connect();
  const accountId = (await wallet.getAccounts())[0]?.accountId;
  if (!accountId || !isValidNearAccountId(accountId)) throw new Error('Connected wallet returned an invalid NEAR account ID.');
  return { connector, wallet, accountId };
}

export async function currentNearWallet() {
  if (!connectorSingleton) throw new Error('Connect a NEAR testnet wallet first.');
  const wallet = await connectorSingleton.wallet();
  const accountId = (await wallet.getAccounts())[0]?.accountId;
  if (!accountId) throw new Error('The connected NEAR wallet has no active account.');
  return { wallet, accountId };
}

export async function verifyTestnetAccount(accountId: string): Promise<void> {
  if (!isValidNearAccountId(accountId)) throw new Error('Enter a valid NEAR account ID (2–64 lowercase letters or digits per label, separated by dots, underscores, or hyphens).');
  await getProvider().viewAccount({ accountId });
}

export async function readEscrow(taskId: string): Promise<EscrowView | null> {
  const contractId = getEscrowContractId();
  const task = await getProvider().callFunction<EscrowView>({
    contractId,
    method: 'get_task',
    args: { task_id: taskId },
  });
  return (task ?? null) as EscrowView | null;
}

export async function signEscrowCall(call: EscrowCall, taskId: string, options: { workerId?: string; depositYocto?: string; expectedSignerId?: string } = {}) {
  const contractId = getEscrowContractId();
  if (!taskId || taskId.length > 128) throw new Error('Task ID must contain between 1 and 128 characters.');
  if (call === 'assign_worker' && (!options.workerId || !isValidNearAccountId(options.workerId))) {
    throw new Error('A valid worker NEAR account ID is required before assignment.');
  }
  if (call === 'create_escrow' && (!options.depositYocto || !/^\d+$/.test(options.depositYocto) || BigInt(options.depositYocto) <= BigInt('0'))) {
    throw new Error('A positive escrow deposit in yoctoNEAR is required.');
  }

  const { wallet, accountId } = await currentNearWallet();
  if (options.expectedSignerId && accountId !== options.expectedSignerId) {
    throw new Error(`Wallet account changed to ${accountId}. Reconnect or switch back to ${options.expectedSignerId} before signing.`);
  }
  const args: Record<string, string> = { task_id: taskId };
  if (call === 'assign_worker') args.worker = options.workerId!;
  const result = await wallet.signAndSendTransaction({
    receiverId: contractId,
    actions: [{
      type: 'FunctionCall',
      params: {
        methodName: call,
        args,
        gas: call === 'release_payment' || call === 'refund' ? '80000000000000' : '30000000000000',
        deposit: options.depositYocto || '0',
      },
    }],
  });
  const hash = result.transaction?.hash;
  if (!hash) throw new Error('NEAR wallet returned no transaction hash. No receipt was recorded.');
  return { hash, signerAccountId: accountId, contractId };
}

export async function waitForEscrow(taskId: string, predicate: (state: EscrowView | null) => boolean, timeoutMs = 30_000): Promise<EscrowView> {
  const deadline = Date.now() + timeoutMs;
  let lastState: EscrowView | null = null;
  while (Date.now() < deadline) {
    lastState = await readEscrow(taskId);
    if (predicate(lastState)) return lastState!;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(lastState?.pending
    ? 'The contract transfer is still pending. Check the transaction before retrying.'
    : 'Transaction was submitted, but the expected contract state is not confirmed yet. The receipt remains pending.');
}

export async function waitForTransaction(hash: string, signerAccountId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'Transaction is not indexed by the testnet RPC yet.';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(TESTNET_RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'agentvault', method: 'tx', params: [hash, signerAccountId] }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await response.json() as { result?: { status?: Record<string, unknown> }; error?: { message?: string } };
      if (payload.error) {
        lastError = payload.error.message || lastError;
      } else if (payload.result?.status) {
        if ('Failure' in payload.result.status) throw new Error(`NEAR transaction failed: ${JSON.stringify(payload.result.status.Failure)}`);
        if ('SuccessValue' in payload.result.status) return;
        lastError = `Transaction status: ${Object.keys(payload.result.status).join(', ') || 'not final'}`;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('NEAR transaction failed:')) throw error;
      lastError = error instanceof Error ? error.message : lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`${lastError} The transaction is not confirmed; check the hash before retrying.`);
}

export async function toYoctoNear(amount: number): Promise<string> {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a NEAR amount greater than zero.');
  const [whole, fraction = ''] = amount.toString().split('.');
  if (fraction.length > 24) throw new Error('NEAR amounts cannot have more than 24 decimal places.');
  return (BigInt(whole) * BigInt('10') ** BigInt('24') + BigInt(fraction.padEnd(24, '0') || '0')).toString();
}

export function nearExplorerUrl(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`;
}
