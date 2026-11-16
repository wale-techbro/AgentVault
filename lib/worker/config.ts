import type { WorkerSettings } from './store';

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name} worker setting.`);
  return value;
}

export type WorkerConfig = WorkerSettings & {
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  maxRunCostUsd: number;
};

export function loadWorkerConfig(): WorkerConfig {
  const leaseMs = integerEnv('WORKER_LEASE_MS', 120_000, 30_000, 600_000);
  const heartbeatIntervalMs = integerEnv('WORKER_HEARTBEAT_MS', 20_000, 1_000, 120_000);
  if (heartbeatIntervalMs >= leaseMs / 2) throw new Error('WORKER_HEARTBEAT_MS must be less than half of WORKER_LEASE_MS.');
  const maxRunCostUsd = Number(process.env.AI_MAX_RUN_COST_USD || '0.10');
  if (!Number.isFinite(maxRunCostUsd) || maxRunCostUsd <= 0 || maxRunCostUsd > 10) throw new Error('Invalid AI_MAX_RUN_COST_USD worker setting.');
  return {
    pollIntervalMs: integerEnv('WORKER_POLL_INTERVAL_MS', 2_000, 250, 60_000),
    heartbeatIntervalMs,
    leaseMs,
    maxAttempts: integerEnv('WORKER_MAX_ATTEMPTS', 4, 1, 10),
    maxConcurrentPerAgent: integerEnv('WORKER_MAX_PER_AGENT', 1, 1, 10),
    maxConcurrentPerTask: integerEnv('WORKER_MAX_PER_TASK', 1, 1, 3),
    maxRunCostUsd,
  };
}
