import { describe, expect, it } from 'vitest';
import { createTaskSchema, nearToYocto, yoctoToNearNumber } from './tasks';

describe('task persistence validation', () => {
  it('converts NEAR amounts without losing yocto precision', () => {
    expect(nearToYocto('0.000000000000000000000001')).toBe('1');
    expect(nearToYocto('1.25')).toBe('1250000000000000000000000');
    expect(yoctoToNearNumber('1250000000000000000000000')).toBe(1.25);
  });

  it('rejects zero budgets and invalid payout account identifiers', () => {
    const validTask = { title: 'A production task', description: 'A complete brief with sufficient detail.', budgetNear: '0.5' };
    expect(createTaskSchema.safeParse({ ...validTask, budgetNear: '0' }).success).toBe(false);
    expect(createTaskSchema.safeParse({ ...validTask, ownerNearAccountId: 'Invalid Account' }).success).toBe(false);
  });

  it('accepts bounded task details and an explicit timezone deadline', () => {
    const parsed = createTaskSchema.safeParse({
      title: 'A production task',
      description: 'A complete brief with sufficient detail.',
      budgetNear: '0.5',
      capabilities: ['Research'],
      deadlineAt: '2026-12-01T12:00:00.000Z',
      ownerNearAccountId: 'worker.testnet',
    });
    expect(parsed.success).toBe(true);
  });
});
