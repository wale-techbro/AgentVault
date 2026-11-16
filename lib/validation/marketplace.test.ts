import { describe, expect, it } from 'vitest';
import { createAgentSchema, createBidSchema, reviewDeliverableSchema, submitDeliverableSchema, updateAgentSchema } from './marketplace';

describe('marketplace API validation', () => {
  it('accepts an agent profile and rejects invalid account IDs or repeated capabilities', () => {
    const valid = { name: 'Research Finch', role: 'Market research', capabilities: ['Research', 'Writing'], nearAccountId: 'finch.testnet' };
    expect(createAgentSchema.safeParse(valid).success).toBe(true);
    expect(createAgentSchema.safeParse({ ...valid, nearAccountId: 'bad account' }).success).toBe(false);
    expect(createAgentSchema.safeParse({ ...valid, capabilities: ['Research', 'research'] }).success).toBe(false);
    expect(updateAgentSchema.safeParse({}).success).toBe(false);
  });

  it('validates a bid amount, estimate, and non-empty proposal', () => {
    const valid = { agentId: '488d6a6c-9b6e-4a36-ae70-5f3aece01be9', amountNear: '0.125', etaHours: 12, proposal: 'I will research the market and deliver a source-backed summary.' };
    expect(createBidSchema.safeParse(valid).success).toBe(true);
    expect(createBidSchema.safeParse({ ...valid, amountNear: '0' }).success).toBe(false);
    expect(createBidSchema.safeParse({ ...valid, etaHours: 0 }).success).toBe(false);
  });

  it('requires deliverable content and HTTPS evidence URLs', () => {
    const valid = { title: 'Research summary', content: 'A detailed report with sufficient context and evidence for the task owner to review the submitted work.', evidence: [{ label: 'Source', url: 'https://example.com/report' }] };
    expect(submitDeliverableSchema.safeParse(valid).success).toBe(true);
    expect(submitDeliverableSchema.safeParse({ ...valid, evidence: [{ label: 'Source', url: 'http://example.com/report' }] }).success).toBe(false);
  });

  it('requires evidence before verification and a reason for revisions or rejection', () => {
    const evidence = [{ label: 'Review proof', url: 'https://example.com/proof' }];
    expect(reviewDeliverableSchema.safeParse({ decision: 'verify', evidence }).success).toBe(true);
    expect(reviewDeliverableSchema.safeParse({ decision: 'verify' }).success).toBe(false);
    expect(reviewDeliverableSchema.safeParse({ decision: 'request_revision', note: 'Fix the missing source.' }).success).toBe(true);
    expect(reviewDeliverableSchema.safeParse({ decision: 'reject', note: 'No' }).success).toBe(false);
  });
});
