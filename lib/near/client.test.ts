import { describe, expect, it } from 'vitest';
import { isValidNearAccountId, toYoctoNear } from './client';

describe('NEAR account recipient validation', () => {
  it.each(['kemi.testnet', 'sub.account.testnet', 'aa_bb.testnet', 'aa-bb.testnet'])('accepts syntactically valid ID %s', (accountId) => {
    expect(isValidNearAccountId(accountId)).toBe(true);
  });

  it.each(['', 'A.testnet', 'a.testnet', 'foo..testnet', '-bad.testnet', 'foo.testnet/'])('rejects invalid ID %s', (accountId) => {
    expect(isValidNearAccountId(accountId)).toBe(false);
  });
});

describe('NEAR deposit conversion', () => {
  it('converts a decimal NEAR amount to exact yoctoNEAR', async () => {
    expect(await toYoctoNear(0.5)).toBe('500000000000000000000000');
  });
});
