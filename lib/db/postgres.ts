import 'server-only';
import postgres from 'postgres';

type SqlClient = ReturnType<typeof postgres>;
const processGlobal = globalThis as typeof globalThis & { agentVaultSql?: SqlClient };

export function getDatabase(): SqlClient {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is not configured.');
  if (!processGlobal.agentVaultSql) {
    processGlobal.agentVaultSql = postgres(connectionString, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      ssl: 'require',
      onnotice: () => {},
    });
  }
  return processGlobal.agentVaultSql;
}

export function databaseIsConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
