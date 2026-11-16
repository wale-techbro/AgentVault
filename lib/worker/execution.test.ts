import { describe, expect, it, vi } from 'vitest';
import type { AIProvider } from '../ai/provider';
import { executeTask } from './execution';
import { WorkerExecutionError } from './domain';

const input = {
  task: { id: 'task-1', title: 'Draft a project summary', description: 'Summarize the supplied project notes into a clear short report.', capabilities: ['writing'], budgetYocto: '1' },
  agent: { id: 'agent-1', name: 'Writer', role: 'Technical writer', capabilities: ['writing', 'editing'] },
  bid: { id: 'bid-1', proposal: 'I will summarize only the materials provided.', amountYocto: '1', etaHours: 24 },
};
const providerOutput = JSON.stringify({
  outcome: 'completed', reason: 'A concise draft was prepared from the provided brief.', plan: ['Review the brief', 'Draft the summary'],
  deliverable: { title: 'Project summary', summary: 'A draft based on the provided project notes only.',
    bodyMarkdown: 'This is a draft summary made only from the supplied project brief. The worker did not inspect files, run code, verify external facts, contact anyone, or submit anything outside the AgentVault database. The owner should review it before accepting the work.',
    limitations: ['The source material was not independently verified.'] },
});

describe('worker task executor', () => {
  it('uses the injected provider and returns an attributed, bounded text deliverable', async () => {
    const completeDetailed = vi.fn(async () => ({ content: providerOutput, promptTokens: 110, completionTokens: 210, estimatedCostUsd: 0.0064 }));
    const provider = { complete: vi.fn(), completeDetailed } as unknown as AIProvider;
    const result = await executeTask(input, provider, new AbortController().signal, 0.1);
    expect(completeDetailed).toHaveBeenCalledTimes(1);
    expect(result.title).toBe('Project summary');
    expect(result.limitations.join(' ')).toContain('No external research');
    expect(result.usage).toEqual({ promptTokens: 110, completionTokens: 210, estimatedCostUsd: 0.0064 });
  });

  it('refuses unsupported work without calling the provider', async () => {
    const provider = { complete: vi.fn(), completeDetailed: vi.fn() } as unknown as AIProvider;
    await expect(executeTask({ ...input, task: { ...input.task, title: 'Send the report to the customer' } }, provider, new AbortController().signal, 0.1))
      .rejects.toMatchObject(new WorkerExecutionError('unsupported_task', false));
    expect(provider.completeDetailed).not.toHaveBeenCalled();
  });

  it('maps malformed provider output to a retryable sanitized failure and produces no deliverable', async () => {
    const provider = { complete: vi.fn(), completeDetailed: vi.fn(async () => ({ content: 'not-json', promptTokens: 1, completionTokens: 1, estimatedCostUsd: 0 })) } as unknown as AIProvider;
    await expect(executeTask(input, provider, new AbortController().signal, 0.1)).rejects.toMatchObject({ code: 'ai_invalid_output', retryable: true });
  });
});
