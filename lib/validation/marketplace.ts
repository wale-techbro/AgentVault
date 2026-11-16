import { z } from 'zod';
import { nearToYocto } from './tasks';

const nearAccountId = z.string().trim().min(2).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i, 'Enter a valid NEAR account ID.');
const capability = z.string().trim().min(1).max(40);

export const createAgentSchema = z.object({
  name: z.string().trim().min(2).max(80),
  role: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).default(''),
  capabilities: z.array(capability).min(1).max(12),
  nearAccountId,
  availability: z.enum(['available', 'offline']).default('available'),
}).superRefine((agent, ctx) => {
  const normalized = agent.capabilities.map((item) => item.toLowerCase());
  if (new Set(normalized).size !== normalized.length) ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'Capabilities must be unique.' });
});

export const updateAgentSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  role: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  capabilities: z.array(capability).min(1).max(12).optional(),
  nearAccountId: nearAccountId.optional(),
  availability: z.enum(['available', 'offline']).optional(),
  isActive: z.boolean().optional(),
}).refine((agent) => Object.keys(agent).length > 0, 'Provide at least one field to update.')
  .superRefine((agent, ctx) => {
    if (!agent.capabilities) return;
    const normalized = agent.capabilities.map((item) => item.toLowerCase());
    if (new Set(normalized).size !== normalized.length) ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'Capabilities must be unique.' });
  });

export const createBidSchema = z.object({
  agentId: z.string().uuid(),
  amountNear: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,24})?$/),
  etaHours: z.number().finite().int().min(1).max(8760),
  proposal: z.string().trim().min(20).max(5000),
}).refine((bid) => {
  try { return BigInt(nearToYocto(bid.amountNear)) > BigInt('0'); } catch { return false; }
}, { path: ['amountNear'], message: 'Bid amount must be greater than zero.' });

const evidenceItem = z.object({ label: z.string().trim().min(1).max(120), url: z.string().url().refine((url) => url.startsWith('https://'), 'Evidence links must use HTTPS.') });

export const submitDeliverableSchema = z.object({
  title: z.string().trim().min(3).max(160),
  content: z.string().trim().min(50).max(60_000),
  evidence: z.array(evidenceItem).max(30).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const reviewDeliverableSchema = z.object({
  decision: z.enum(['verify', 'approve', 'request_revision', 'reject']),
  note: z.string().trim().max(4000).default(''),
  evidence: z.array(evidenceItem).max(30).default([]),
}).superRefine((review, ctx) => {
  if ((review.decision === 'request_revision' && review.note.length < 5) || (review.decision === 'reject' && review.note.length < 10)) {
    ctx.addIssue({ code: 'custom', path: ['note'], message: 'Explain the requested revision or rejection.' });
  }
  if (review.decision === 'verify' && review.evidence.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Add at least one evidence link to verify this deliverable.' });
  }
});

export const taskTransitionSchema = z.object({
  to: z.enum(['in_progress', 'cancelled', 'disputed', 'completed']),
  note: z.string().trim().max(4000).default(''),
}).superRefine((transition, ctx) => {
  if (transition.to === 'disputed' && transition.note.length < 10) {
    ctx.addIssue({ code: 'custom', path: ['note'], message: 'Add at least 10 characters describing the dispute.' });
  }
});

export const uuidSchema = z.string().uuid();
export const idempotencyKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
