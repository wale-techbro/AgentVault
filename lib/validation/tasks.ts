import { z } from 'zod';

export const createTaskSchema = z.object({
  title: z.string().trim().min(4).max(120),
  description: z.string().trim().min(20).max(6000),
  budgetNear: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,24})?$/, 'Enter a positive NEAR amount with at most 24 decimals.'),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  deadlineAt: z.string().datetime({ offset: true }).optional(),
  ownerNearAccountId: z.string().trim().min(2).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i).optional(),
}).refine((task) => {
  try { return BigInt(nearToYocto(task.budgetNear)) > BigInt('0'); } catch { return false; }
}, { path: ['budgetNear'], message: 'Budget must be greater than zero.' });

export function nearToYocto(amount: string): string {
  const [whole, fraction = ''] = amount.split('.');
  return (BigInt(whole) * BigInt('10') ** BigInt('24') + BigInt(fraction.padEnd(24, '0') || '0')).toString();
}

export function yoctoToNearNumber(amount: string): number {
  const value = BigInt(amount);
  const whole = value / (BigInt('10') ** BigInt('24'));
  const fraction = (value % (BigInt('10') ** BigInt('24'))).toString().padStart(24, '0').replace(/0+$/, '');
  return Number(fraction ? `${whole}.${fraction}` : whole.toString());
}
