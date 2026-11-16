import { describe, expect, it } from 'vitest';
import { isRetryableFailure, isSupportedTask, parseProviderDeliverable, retryDelayMs, sanitizeFailureCode, WorkerExecutionError } from './domain';

const validOutput = JSON.stringify({
  outcome: 'completed',
  reason: 'The supplied notes were reorganized into a concise draft.',
  plan: ['Review the supplied notes', 'Write the requested draft'],
  deliverable: {
    title: 'Proposal follow-up draft',
    summary: 'A concise follow-up draft based only on the task details provided.',
    bodyMarkdown: 'This draft uses the information supplied in the task. It avoids making claims about research, external sources, or actions that have not occurred. The owner should review and personalize it before use.',
    limitations: ['No external research or fact checking was performed.'],
  },
});

describe('bounded worker execution domain', () => {
  it('allows text synthesis and refuses external or consequential tasks', () => {
    expect(isSupportedTask({ title: 'Draft a project summary', description: 'Summarize the provided project notes.', capabilities: [] })).toBe(true);
    expect(isSupportedTask({ title: 'Research current market prices', description: 'Find current prices and sources.', capabilities: ['research'] })).toBe(false);
    expect(isSupportedTask({ title: 'Send the report to the client', description: 'Email the completed report.', capabilities: ['writing'] })).toBe(false);
    expect(isSupportedTask({ title: 'Deploy application', description: 'Deploy the application to production.', capabilities: ['planning'] })).toBe(false);
  });

  it('validates structured output and rejects malformed output and fabricated URLs', () => {
    expect(parseProviderDeliverable(validOutput).deliverable?.title).toBe('Proposal follow-up draft');
    expect(() => parseProviderDeliverable('{"outcome":"completed"}')).toThrowError(new WorkerExecutionError('ai_invalid_output', true));
    expect(() => parseProviderDeliverable(validOutput.replace('This draft uses', 'See https://unverified.example. This draft uses'))).toThrowError(new WorkerExecutionError('ai_invalid_output', true));
  });

  it('uses capped exponential backoff with bounded jitter', () => {
    expect(retryDelayMs(1, 0.5)).toBe(30_000);
    expect(retryDelayMs(2, 0)).toBe(45_000);
    expect(retryDelayMs(2, 1)).toBe(75_000);
    expect(retryDelayMs(30, 1)).toBe(15 * 60_000);
  });

  it('stores only allowlisted failure codes and retries transient failures', () => {
    expect(sanitizeFailureCode(new Error('Bearer super-secret-key'))).toBe('worker_internal_error');
    expect(isRetryableFailure(new WorkerExecutionError('unsupported_task', false))).toBe(false);
    expect(isRetryableFailure(new WorkerExecutionError('ai_timeout', true))).toBe(true);
  });
});
