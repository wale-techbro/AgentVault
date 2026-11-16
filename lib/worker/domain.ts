import { z } from 'zod';

export type FailureCode =
  | 'unsupported_task'
  | 'ai_not_configured'
  | 'ai_configuration_invalid'
  | 'ai_timeout'
  | 'ai_unavailable'
  | 'ai_provider_rejected'
  | 'ai_invalid_output'
  | 'ai_input_limit'
  | 'ai_cost_limit'
  | 'task_not_executable'
  | 'worker_lease_lost'
  | 'worker_lease_expired'
  | 'worker_internal_error';

export class WorkerExecutionError extends Error {
  constructor(readonly code: FailureCode, readonly retryable: boolean) { super(code); }
}

export type JobRetryPolicy = { baseDelayMs: number; maxDelayMs: number; jitterRatio: number };

export function retryDelayMs(attempt: number, random = 0.5, policy: JobRetryPolicy = { baseDelayMs: 30_000, maxDelayMs: 15 * 60_000, jitterRatio: 0.25 }): number {
  const safeAttempt = Math.max(1, Math.min(30, Math.floor(attempt)));
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** (safeAttempt - 1)));
  const normalizedRandom = Math.max(0, Math.min(1, random));
  return Math.round(Math.min(policy.maxDelayMs, base * (1 - policy.jitterRatio + normalizedRandom * policy.jitterRatio * 2)));
}

const providerDeliverableSchema = z.object({
  outcome: z.enum(['completed', 'unsupported']),
  reason: z.string().trim().min(1).max(500),
  plan: z.array(z.string().trim().min(1).max(240)).max(8),
  deliverable: z.object({
    title: z.string().trim().min(3).max(160),
    summary: z.string().trim().min(10).max(1200),
    bodyMarkdown: z.string().trim().min(100).max(24_000),
    limitations: z.array(z.string().trim().min(1).max(240)).max(10),
  }).optional(),
});

export type ProviderDeliverable = z.infer<typeof providerDeliverableSchema>;

export function isSupportedTask(input: { title: string; description: string; capabilities: string[] }): boolean {
  const brief = `${input.title}\n${input.description}`.toLowerCase();
  const highImpact = /\b(send|email|message|contact|purchase|pay|transfer|deploy|delete|execute code|run code|install|publish|submit application|medical diagnosis|legal advice|investment advice|latest data|current statistics|current prices)\b/i;
  if (highImpact.test(brief)) return false;

  const externalResearch = /\b(research|sources?|citations?|browse|search the web|market size|competitors|verify facts|latest|up[- ]to[- ]date)\b/i;
  const sourceMaterialProvided = /\b(provided (source|data|material|dataset|document|notes)|based only on the (following|provided))\b/i.test(input.description);
  if (externalResearch.test(`${input.title}\n${input.capabilities.join(' ')}`) && !sourceMaterialProvided) return false;

  const textWork = /\b(write|draft|summari[sz]e|analy[sz]e|synthesi[sz]e|plan|document|edit|rewrite|format|extract|outline|compare)\b/i;
  return textWork.test(brief) || input.capabilities.some((capability) => /\b(writing|summari[sz]ation|analysis|planning|documentation|editing|synthesis|formatting|content)\b/i.test(capability));
}

export function parseProviderDeliverable(value: string): ProviderDeliverable {
  let json: unknown;
  try { json = JSON.parse(value); }
  catch { throw new WorkerExecutionError('ai_invalid_output', true); }
  const parsed = providerDeliverableSchema.safeParse(json);
  if (!parsed.success) throw new WorkerExecutionError('ai_invalid_output', true);
  if (parsed.data.outcome === 'completed') {
    if (!parsed.data.deliverable || parsed.data.plan.length === 0) throw new WorkerExecutionError('ai_invalid_output', true);
    const contextUrls = new Set(value.match(/https?:\/\/[^\s)\]}>,]+/gi) || []);
    if (contextUrls.size > 0) throw new WorkerExecutionError('ai_invalid_output', true);
    if (/https?:\/\/|\[[^\]]+\]\(https?:\/\//i.test(parsed.data.deliverable.bodyMarkdown)) throw new WorkerExecutionError('ai_invalid_output', true);
  }
  return parsed.data;
}

export type ExecutionInput = {
  task: { id: string; title: string; description: string; capabilities: string[]; budgetYocto: string };
  agent: { id: string; name: string; role: string; capabilities: string[] };
  bid: { id: string; proposal: string; amountYocto: string; etaHours: number };
};

export function buildExecutionPrompt(input: ExecutionInput): string {
  return JSON.stringify({
    task: input.task,
    selectedAgent: { name: input.agent.name, role: input.agent.role, capabilities: input.agent.capabilities },
    acceptedProposal: input.bid.proposal,
    executionRules: [
      'Only perform bounded text drafting, summarization, planning, transformation, or analysis of information explicitly contained in the task, its description, or accepted proposal.',
      'Do not browse, call tools, claim external research, fabricate sources, statistics, tool results, tests, or completed real-world actions.',
      'If the task needs external research, code execution, external communication, payments, or other unsupported work, return outcome unsupported with a brief reason.',
      'If the brief lacks information, state the limitation in the deliverable rather than inventing facts.',
      'Return one JSON object with outcome, reason, plan, and deliverable. For completed work, include a useful Markdown draft and explicit limitations.',
      'Do not include URLs, citations, credentials, hidden reasoning, or a claim that owner approval or payment has occurred.',
    ],
  });
}

export const executionSystemPrompt = [
  'You are a bounded task text-synthesis engine for an autonomous marketplace worker.',
  'You may only produce text using the supplied brief and accepted proposal. You have no browser, shell, file, network, payment, or messaging tools.',
  'Never invent research, sources, citations, tool results, external facts, or claims that work was tested or delivered outside this database.',
  'If the request cannot be completed from the supplied text alone, return outcome unsupported. Keep the plan concise and return JSON only.',
].join(' ');

export function sanitizeFailureCode(value: unknown): FailureCode {
  if (value instanceof WorkerExecutionError) return value.code;
  if (value && typeof value === 'object' && 'code' in value) {
    const code = value.code;
    if (typeof code === 'string' && [
      'ai_timeout','ai_unavailable','ai_provider_rejected','ai_invalid_output','ai_input_limit','ai_cost_limit',
      'worker_lease_lost','worker_lease_expired','task_not_executable','unsupported_task','ai_not_configured','ai_configuration_invalid',
    ].includes(code)) return code as FailureCode;
  }
  return 'worker_internal_error';
}

export function isRetryableFailure(value: unknown): boolean {
  if (value instanceof WorkerExecutionError) return value.retryable;
  return ['ai_timeout','ai_unavailable','ai_invalid_output','worker_lease_expired','worker_internal_error'].includes(sanitizeFailureCode(value));
}
