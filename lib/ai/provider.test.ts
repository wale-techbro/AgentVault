import { describe, expect, it, vi } from 'vitest';
import { AIProviderError, createMockableAIProvider } from './provider';

const completion = (content: string, usage = { prompt_tokens: 12, completion_tokens: 20 }) => new Response(JSON.stringify({
  choices: [{ message: { content } }], usage,
}), { status: 200, headers: { 'content-type': 'application/json' } });

describe('OpenAI-compatible execution provider', () => {
  it('sends bounded JSON requests and reports token and configured-cost usage', async () => {
    const requestFetch = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-only-key');
      const body = JSON.parse(String(init?.body)) as { max_tokens: number; response_format: { type: string } };
      expect(body.max_tokens).toBe(300);
      expect(body.response_format.type).toBe('json_object');
      return completion('{"outcome":"unsupported"}');
    });
    const provider = createMockableAIProvider({ apiKey: 'test-only-key', baseUrl: 'https://ai.example/v1', model: 'test-model', requestFetch });
    await expect(provider.completeDetailed('system', 'prompt', { maxCompletionTokens: 300, maxCostUsd: 0.1 })).resolves.toMatchObject({
      content: '{"outcome":"unsupported"}', promptTokens: 12, completionTokens: 20, estimatedCostUsd: 0.00064,
    });
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it('retries provider rate limits only while the reserved cost budget permits', async () => {
    const requestFetch = vi.fn<typeof fetch>(async () => new Response('private provider body', { status: 429 }));
    const provider = createMockableAIProvider({ apiKey: 'test-only-key', baseUrl: 'https://ai.example/v1', model: 'test-model', maxCompletionTokens: 10, maxRunCostUsd: 0.0004, requestFetch });
    await expect(provider.complete('system', 'prompt')).rejects.toMatchObject({ code: 'ai_cost_limit', retryable: false });
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it('enforces input and cost limits before making a provider request', async () => {
    const requestFetch = vi.fn<typeof fetch>();
    const provider = createMockableAIProvider({ apiKey: 'test-only-key', baseUrl: 'https://ai.example/v1', model: 'test-model', maxInputTokens: 1, requestFetch });
    await expect(provider.complete('system prompt', 'task prompt')).rejects.toMatchObject({ code: 'ai_input_limit' });
    expect(requestFetch).not.toHaveBeenCalled();
    const costLimited = createMockableAIProvider({ apiKey: 'test-only-key', baseUrl: 'https://ai.example/v1', model: 'test-model', maxRunCostUsd: 0.0001, requestFetch });
    await expect(costLimited.complete('s', 'p')).rejects.toMatchObject({ code: 'ai_cost_limit' });
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('rejects a provider response that exceeds the configured output token limit', async () => {
    const requestFetch = vi.fn<typeof fetch>(async () => completion('x'.repeat(4_900), { prompt_tokens: 12, completion_tokens: 301 }));
    const provider = createMockableAIProvider({ apiKey: 'test-only-key', baseUrl: 'https://ai.example/v1', model: 'test-model', maxCompletionTokens: 300, requestFetch });
    await expect(provider.complete('system', 'prompt')).rejects.toMatchObject({ code: 'ai_cost_limit', retryable: false });
  });

  it('retries timeout errors and never returns response body details to callers', async () => {
    const requestFetch = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private body and provider key')), { once: true });
    }));
    const provider = createMockableAIProvider({ apiKey: 'test-only-key', baseUrl: 'https://ai.example/v1', model: 'test-model', timeoutMs: 5, maxCompletionTokens: 100, requestFetch });
    let thrown: unknown;
    try { await provider.complete('system', 'prompt'); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AIProviderError);
    expect(thrown).toMatchObject({ code: 'ai_timeout', retryable: true });
    expect(String(thrown)).not.toContain('private body');
    expect(requestFetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry cancellation from the worker lease controller', async () => {
    const requestFetch = vi.fn<typeof fetch>();
    const provider = createMockableAIProvider({ apiKey: 'test-only-key', baseUrl: 'https://ai.example/v1', model: 'test-model', requestFetch });
    const controller = new AbortController(); controller.abort();
    await expect(provider.complete('system', 'prompt', { signal: controller.signal })).rejects.toMatchObject({ code: 'ai_cancelled', retryable: false });
    expect(requestFetch).not.toHaveBeenCalled();
  });
});
