import { randomUUID } from 'node:crypto';
import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';
import { getAIProvider } from '../lib/ai/provider';
import { loadWorkerConfig } from '../lib/worker/config';
import { WorkerExecutionError } from '../lib/worker/domain';
import { registerWorker, stopWorker } from '../lib/worker/store';
import { runWorker } from '../lib/worker/runner';

loadEnvConfig(process.cwd());

function emit(event: string, errorCode?: string): void {
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), event, ...(errorCode ? { errorCode } : {}) }));
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new WorkerExecutionError('worker_internal_error', false);
  const config = loadWorkerConfig();
  const workerId = randomUUID();
  const sql = postgres(databaseUrl, { max: 2, idle_timeout: 20, connect_timeout: 10, prepare: false, ssl: 'require', onnotice: () => {} });
  const shutdown = new AbortController();
  const onShutdown = (signal: string) => {
    if (!shutdown.signal.aborted) {
      emit('worker.shutdown_requested', signal);
      shutdown.abort();
    }
  };
  process.once('SIGTERM', () => onShutdown('SIGTERM'));
  process.once('SIGINT', () => onShutdown('SIGINT'));

  try {
    await registerWorker(sql, workerId);
    let provider;
    try { provider = getAIProvider(); }
    catch {
      await stopWorker(sql, workerId, 'error', 'ai_configuration_invalid');
      emit('worker.configuration_error', 'ai_configuration_invalid');
      process.exitCode = 1;
      return;
    }
    if (!provider) {
      await stopWorker(sql, workerId, 'error', 'ai_not_configured');
      emit('worker.configuration_error', 'ai_not_configured');
      process.exitCode = 1;
      return;
    }
    await runWorker({ sql, provider, config, workerId, shutdownSignal: shutdown.signal });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  const code = error instanceof WorkerExecutionError ? error.code : 'worker_internal_error';
  emit('worker.fatal', code);
  process.exitCode = 1;
});
