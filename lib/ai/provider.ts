export type AIProvider = {
  complete: (system: string, prompt: string, options?: AIRequestOptions) => Promise<string>;
  completeDetailed: (system: string, prompt: string, options?: AIRequestOptions) => Promise<AICompletion>;
};

export type AIRequestOptions = { signal?: AbortSignal; maxCompletionTokens?: number; maxCostUsd?: number };
export type AICompletion = { content: string; promptTokens: number; completionTokens: number; estimatedCostUsd: number };

export class AIProviderError extends Error {
  constructor(readonly code: 'ai_timeout' | 'ai_unavailable' | 'ai_provider_rejected' | 'ai_invalid_response' | 'ai_empty_response' | 'ai_input_limit' | 'ai_cost_limit' | 'ai_cancelled', readonly retryable: boolean) {
    super(code);
  }
}

function positiveNumber(value: string | undefined, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) throw new Error('Invalid AI execution limit configuration.');
  return parsed;
}

/** Server-only OpenAI-compatible provider. Credentials never leave this process. */
class OpenAICompatibleProvider implements AIProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly maxInputTokens: number,
    private readonly maxCompletionTokens: number,
    private readonly maxRunCostUsd: number,
    private readonly costPerThousandTokensUsd: number,
    private readonly requestFetch: typeof fetch = fetch,
  ) {}

  async complete(system: string, prompt: string, options?: AIRequestOptions): Promise<string> {
    return (await this.completeDetailed(system, prompt, options)).content;
  }

  async completeDetailed(system: string, prompt: string, options: AIRequestOptions = {}): Promise<AICompletion> {
    const inputTokens = Math.ceil((system.length + prompt.length) / 4);
    const outputLimit = options.maxCompletionTokens ?? this.maxCompletionTokens;
    const costLimit = options.maxCostUsd ?? this.maxRunCostUsd;
    if (inputTokens > this.maxInputTokens) throw new AIProviderError('ai_input_limit', false);
    if ((inputTokens + outputLimit) / 1000 * this.costPerThousandTokensUsd > costLimit) throw new AIProviderError('ai_cost_limit', false);

    let lastError: AIProviderError = new AIProviderError('ai_unavailable', true);
    let reservedRetryCostUsd = 0;
    const requestCostReservationUsd = (inputTokens + outputLimit) / 1000 * this.costPerThousandTokensUsd;
    for (let attempt = 0; attempt < 3; attempt++) {
      // A timed-out request may still have been processed upstream. Reserve its
      // configured worst-case token cost before spending the retry budget.
      if (reservedRetryCostUsd + requestCostReservationUsd > costLimit) throw new AIProviderError('ai_cost_limit', false);
      reservedRetryCostUsd += requestCostReservationUsd;
      if (options.signal?.aborted) throw new AIProviderError('ai_cancelled', false);
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
      try {
        const response = await this.requestFetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            temperature: 0.2,
            max_tokens: outputLimit,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          }),
          signal,
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          lastError = new AIProviderError(retryable ? 'ai_unavailable' : 'ai_provider_rejected', retryable);
          if (retryable && attempt < 2) { await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt))); continue; }
          throw lastError;
        }
        const responseText = await response.text();
        if (responseText.length > 1_000_000) throw new AIProviderError('ai_invalid_response', false);
        let result: { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        try { result = JSON.parse(responseText) as typeof result; }
        catch { throw new AIProviderError('ai_invalid_response', true); }
        const content = result.choices?.[0]?.message?.content;
        if (!content || content.length > 32_000) throw new AIProviderError('ai_empty_response', true);
        const promptTokens = Number.isInteger(result.usage?.prompt_tokens) ? result.usage!.prompt_tokens! : inputTokens;
        const completionTokens = Number.isInteger(result.usage?.completion_tokens) ? result.usage!.completion_tokens! : Math.ceil(content.length / 4);
        if (promptTokens < 0 || completionTokens < 0) throw new AIProviderError('ai_invalid_response', false);
        if (promptTokens > this.maxInputTokens) throw new AIProviderError('ai_input_limit', false);
        if (completionTokens > outputLimit || content.length > outputLimit * 16) throw new AIProviderError('ai_cost_limit', false);
        const estimatedCostUsd = Number(((promptTokens + completionTokens) / 1000 * this.costPerThousandTokensUsd).toFixed(6));
        if (estimatedCostUsd > costLimit) throw new AIProviderError('ai_cost_limit', false);
        return { content, promptTokens, completionTokens, estimatedCostUsd };
      } catch (error) {
        if (error instanceof AIProviderError) {
          if (!error.retryable || attempt === 2) throw error;
          lastError = error;
        } else if (options.signal?.aborted) {
          throw new AIProviderError('ai_cancelled', false);
        } else {
          const timeout = timeoutSignal.aborted;
          lastError = new AIProviderError(timeout ? 'ai_timeout' : 'ai_unavailable', true);
          if (attempt === 2) throw lastError;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
      }
    }
    throw lastError;
  }
}

export function getAIProvider(): AIProvider | null {
  const name = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (!name || name === 'demo') return null;
  if (name !== 'openai-compatible') throw new Error(`Unsupported AI_PROVIDER: ${name}`);
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) throw new Error('AI_API_KEY is required when AI_PROVIDER=openai-compatible.');
  const timeoutMs = positiveNumber(process.env.AI_TIMEOUT_MS, 25_000, 120_000);
  const maxInputTokens = positiveNumber(process.env.AI_MAX_INPUT_TOKENS, 6_000, 32_000);
  const maxCompletionTokens = positiveNumber(process.env.AI_MAX_COMPLETION_TOKENS, 2_000, 8_000);
  const maxRunCostUsd = positiveNumber(process.env.AI_MAX_RUN_COST_USD, 0.1, 10);
  const costPerThousandTokensUsd = positiveNumber(process.env.AI_COST_PER_1K_TOKENS_USD, 0.02, 100);
  return new OpenAICompatibleProvider(
    apiKey,
    process.env.AI_BASE_URL || 'https://api.openai.com/v1',
    process.env.AI_MODEL || 'gpt-4o-mini',
    timeoutMs,
    maxInputTokens,
    maxCompletionTokens,
    maxRunCostUsd,
    costPerThousandTokensUsd,
  );
}

export function createMockableAIProvider(input: {
  apiKey: string; baseUrl: string; model: string; timeoutMs?: number; maxInputTokens?: number;
  maxCompletionTokens?: number; maxRunCostUsd?: number; costPerThousandTokensUsd?: number; requestFetch: typeof fetch;
}): AIProvider {
  return new OpenAICompatibleProvider(input.apiKey, input.baseUrl, input.model, input.timeoutMs ?? 25_000,
    input.maxInputTokens ?? 6_000, input.maxCompletionTokens ?? 2_000, input.maxRunCostUsd ?? 0.1,
    input.costPerThousandTokensUsd ?? 0.02, input.requestFetch);
}
