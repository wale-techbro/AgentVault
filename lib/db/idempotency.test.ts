import { describe, expect, it } from 'vitest';
import { idempotencyRequestMatches, requestFingerprint } from './idempotency';

describe('idempotency fingerprints', () => {
  it('is stable when object keys arrive in a different order', () => {
    expect(requestFingerprint({ title: 'Report', options: { eta: 4, price: '0.2' } }))
      .toBe(requestFingerprint({ options: { price: '0.2', eta: 4 }, title: 'Report' }));
  });

  it('changes when a request payload changes', () => {
    expect(requestFingerprint({ title: 'Report' })).not.toBe(requestFingerprint({ title: 'Proposal' }));
  });

  it('replays only when both operation and request payload match', () => {
    const hash = requestFingerprint({ amount: '0.2' });
    const saved = { operation: 'bid.create', request_hash: hash };
    expect(idempotencyRequestMatches(saved, { operation: 'bid.create', requestHash: hash })).toBe(true);
    expect(idempotencyRequestMatches(saved, { operation: 'bid.reject', requestHash: hash })).toBe(false);
    expect(idempotencyRequestMatches(saved, { operation: 'bid.create', requestHash: '0'.repeat(64) })).toBe(false);
  });
});
