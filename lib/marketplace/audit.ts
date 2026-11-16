import type { TransactionSql } from 'postgres';

export async function recordTaskChange(
  transaction: TransactionSql,
  input: {
    taskId: string;
    actorUserId: string;
    sender: 'owner' | 'marketplace' | 'coordinator' | 'worker' | 'verifier' | 'contract';
    eventType: string;
    summary: string;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await transaction`
    insert into public.task_events (task_id, sender, event_type, payload, actor_user_id, idempotency_key)
    values (${input.taskId}::uuid, ${input.sender}, ${input.eventType}, ${transaction.json(input.payload || {})}, ${input.actorUserId}::uuid, ${input.idempotencyKey})
    on conflict (task_id, idempotency_key) where idempotency_key is not null do nothing
  `;
  await transaction`
    insert into public.audit_logs (actor_user_id, task_id, event_type, summary, metadata, idempotency_key)
    values (${input.actorUserId}::uuid, ${input.taskId}::uuid, ${input.eventType}, ${input.summary}, ${transaction.json(input.payload || {})}, ${`task:${input.taskId}:${input.idempotencyKey}`})
    on conflict (idempotency_key) do nothing
  `;
}
