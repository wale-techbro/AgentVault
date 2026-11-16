import { setTimeout as sleep } from 'node:timers/promises';
import type { AIProvider } from '../ai/provider';
import { executeTask } from './execution';
import { isRetryableFailure, sanitizeFailureCode, WorkerExecutionError } from './domain';
import { claimNextJob, completeExecution, failExecution, heartbeatJob, setExecutionStage, stopWorker, touchWorker, type WorkerSql } from './store';
import type { WorkerConfig } from './config';

function log(event: string, details: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
  const row = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details });
  if (level === 'error') console.error(row);
  else if (level === 'warn') console.warn(row);
  else console.info(row);
}

async function runClaimedJob(sql: WorkerSql, provider: AIProvider, config: WorkerConfig, workerId: string, job: Awaited<ReturnType<typeof claimNextJob>>): Promise<void> {
  if (!job) return;
  const controller = new AbortController();
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void heartbeatJob(sql, workerId, job, config.leaseMs).then((ok) => {
      if (!ok) { leaseLost = true; controller.abort(); }
    }).catch(() => {
      leaseLost = true;
      controller.abort();
    });
  }, config.heartbeatIntervalMs);
  heartbeat.unref?.();

  try {
    if (!await setExecutionStage(sql, workerId, job, 'planning')) throw new WorkerExecutionError('worker_lease_lost', false);
    if (!await setExecutionStage(sql, workerId, job, 'executing')) throw new WorkerExecutionError('worker_lease_lost', false);
    const output = await executeTask({
      task: { id: job.taskId, title: job.taskTitle, description: job.taskDescription, capabilities: job.taskCapabilities, budgetYocto: job.budgetYocto },
      agent: { id: job.agentId, name: job.agentName, role: job.agentRole, capabilities: job.agentCapabilities },
      bid: { id: job.bidId, proposal: job.bidProposal, amountYocto: job.bidAmountYocto, etaHours: job.bidEtaHours },
    }, provider, controller.signal, config.maxRunCostUsd);
    if (leaseLost) throw new WorkerExecutionError('worker_lease_lost', false);
    if (!await setExecutionStage(sql, workerId, job, 'persisting')) throw new WorkerExecutionError('worker_lease_lost', false);
    const completed = await completeExecution(sql, workerId, job, output, process.env.AI_MODEL || 'configured-model');
    if (!completed && !leaseLost) throw new WorkerExecutionError('worker_lease_lost', false);
    if (completed) log('job.succeeded', { workerId, jobId: job.jobId, runId: job.runId, correlationId: job.correlationId, attempt: job.attempt });
  } catch (error) {
    const errorCode = sanitizeFailureCode(error);
    if (leaseLost || errorCode === 'worker_lease_lost') {
      log('job.lease_lost', { workerId, jobId: job.jobId, runId: job.runId, correlationId: job.correlationId, attempt: job.attempt }, 'warn');
      return;
    }
    try {
      const outcome = await failExecution(sql, workerId, job, error);
      if (outcome !== 'stale') log(outcome === 'retry' ? 'job.retrying' : 'job.failed', {
        workerId, jobId: job.jobId, runId: job.runId, correlationId: job.correlationId,
        attempt: job.attempt, errorCode, retryable: isRetryableFailure(error),
      }, outcome === 'retry' ? 'warn' : 'error');
    } catch {
      log('job.persistence_failed', { workerId, jobId: job.jobId, runId: job.runId, correlationId: job.correlationId, errorCode: 'worker_internal_error' }, 'error');
    }
  } finally {
    clearInterval(heartbeat);
    try { await touchWorker(sql, workerId, 'idle'); }
    catch { log('worker.heartbeat_failed', { workerId, errorCode: 'worker_internal_error' }, 'warn'); }
  }
}

export async function runWorker(input: {
  sql: WorkerSql;
  provider: AIProvider | null;
  config: WorkerConfig;
  workerId: string;
  shutdownSignal: AbortSignal;
}): Promise<void> {
  const { sql, provider, config, workerId, shutdownSignal } = input;
  if (!provider) {
    await stopWorker(sql, workerId, 'error', 'ai_not_configured');
    throw new WorkerExecutionError('ai_not_configured', false);
  }
  log('worker.started', { workerId, pollIntervalMs: config.pollIntervalMs, leaseMs: config.leaseMs });

  while (!shutdownSignal.aborted) {
    try {
      await touchWorker(sql, workerId, 'idle');
      const job = await claimNextJob(sql, workerId, config);
      if (job) {
        log('job.claimed', { workerId, jobId: job.jobId, runId: job.runId, correlationId: job.correlationId, attempt: job.attempt });
        await runClaimedJob(sql, provider, config, workerId, job);
        continue;
      }
    } catch {
      log('worker.poll_failed', { workerId, errorCode: 'worker_internal_error' }, 'error');
      try { await sql`update public.worker_instances set status='error',last_error_code='worker_internal_error',last_heartbeat_at=now() where worker_id=${workerId}::uuid`; }
      catch { /* The next loop retries when PostgreSQL becomes available. */ }
    }
    if (!shutdownSignal.aborted) {
      try { await sleep(config.pollIntervalMs, undefined, { signal: shutdownSignal }); }
      catch { /* SIGTERM/SIGINT ends the idle poll promptly. */ }
    }
  }

  await touchWorker(sql, workerId, 'stopping');
  await stopWorker(sql, workerId, 'stopped');
  log('worker.stopped', { workerId });
}
