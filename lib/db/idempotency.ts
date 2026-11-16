import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';

export class IdempotencyConflict extends Error {
  constructor() { super('The idempotency key was already used for a different request.'); }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function idempotencyRequestMatches(
  existing: { operation: string; request_hash: string },
  request: { operation: string; requestHash: string },
): boolean {
  return existing.operation === request.operation && existing.request_hash === request.requestHash;
}

export async function withIdempotency<T>(
  transaction: TransactionSql,
  input: { actorUserId: string; key: string; operation: string; requestHash: string },
  perform: () => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  const inserted = await transaction<{ actor_user_id: string }[]>`
    insert into public.api_idempotency(actor_user_id, idempotency_key, operation, request_hash)
    values (${input.actorUserId}::uuid, ${input.key}::uuid, ${input.operation}, ${input.requestHash})
    on conflict (actor_user_id, idempotency_key) do nothing
    returning actor_user_id::text
  `;
  if (inserted.length === 0) {
    const [existing] = await transaction<{ operation: string; request_hash: string; response: T | null }[]>`
      select operation, request_hash, response
      from public.api_idempotency
      where actor_user_id = ${input.actorUserId}::uuid and idempotency_key = ${input.key}::uuid
      for update
    `;
    if (!existing || !idempotencyRequestMatches(existing, input)) throw new IdempotencyConflict();
    if (existing.response === null) throw new Error('An earlier request with this key did not finish. Retry with a new key.');
    return { value: existing.response, replayed: true };
  }

  const value = await perform();
  const serializedValue = JSON.parse(JSON.stringify(value)) as never;
  await transaction`
    update public.api_idempotency set response = ${transaction.json(serializedValue)}::jsonb
    where actor_user_id = ${input.actorUserId}::uuid and idempotency_key = ${input.key}::uuid
  `;
  return { value, replayed: false };
}
