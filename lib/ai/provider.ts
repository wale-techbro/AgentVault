export type AIProvider = {
  complete: (system: string, prompt: string) => Promise<string>;
};

/** Server-only OpenAI-compatible provider. No credential is exposed to client code. */
class OpenAICompatibleProvider implements AIProvider {
  constructor(private readonly apiKey: string, private readonly baseUrl: string, private readonly model: string) {}

  async complete(system: string, prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`);
    const result = await response.json() as { choices?: { message?: { content?: string } }[] };
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI provider returned no content.');
    return content;
  }
}

export function getAIProvider(): AIProvider | null {
  const name = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (!name || name === 'demo') return null;
  if (name !== 'openai-compatible') throw new Error(`Unsupported AI_PROVIDER: ${name}`);
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error('AI_API_KEY is required when AI_PROVIDER=openai-compatible.');
  return new OpenAICompatibleProvider(
    apiKey,
    process.env.AI_BASE_URL || 'https://api.openai.com/v1',
    process.env.AI_MODEL || 'gpt-4o-mini',
  );
}
