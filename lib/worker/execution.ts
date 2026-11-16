import { AIProviderError, type AICompletion, type AIProvider } from '../ai/provider';
import {
  buildExecutionPrompt,
  executionSystemPrompt,
  isSupportedTask,
  parseProviderDeliverable,
  WorkerExecutionError,
  type ExecutionInput,
} from './domain';

export type ExecutedText = {
  title: string;
  summary: string;
  bodyMarkdown: string;
  plan: string[];
  limitations: string[];
  usage: Omit<AICompletion, 'content'>;
};

export type WorkerTool = (input: ExecutionInput, provider: AIProvider, signal: AbortSignal, maxCostUsd: number) => Promise<ExecutedText>;

async function textSynthesisTool(input: ExecutionInput, provider: AIProvider, signal: AbortSignal, maxCostUsd: number): Promise<ExecutedText> {
  if (!isSupportedTask({ title: input.task.title, description: input.task.description, capabilities: input.task.capabilities })) {
    throw new WorkerExecutionError('unsupported_task', false);
  }

  let completion: AICompletion;
  try {
    completion = await provider.completeDetailed(executionSystemPrompt, buildExecutionPrompt(input), { signal, maxCostUsd });
  } catch (error) {
    if (error instanceof AIProviderError) {
      if (error.code === 'ai_cancelled') throw new WorkerExecutionError('worker_lease_lost', false);
      const code = error.code === 'ai_invalid_response' || error.code === 'ai_empty_response'
        ? 'ai_invalid_output'
        : error.code;
      throw new WorkerExecutionError(code, error.retryable);
    }
    throw error;
  }

  const result = parseProviderDeliverable(completion.content);
  if (result.outcome !== 'completed' || !result.deliverable) throw new WorkerExecutionError('unsupported_task', false);
  return {
    title: result.deliverable.title,
    summary: result.deliverable.summary,
    bodyMarkdown: result.deliverable.bodyMarkdown,
    plan: result.plan,
    limitations: [...new Set([...result.deliverable.limitations, 'Generated only from the task brief and accepted proposal. No external research, tools, or verification were performed.'])],
    usage: { promptTokens: completion.promptTokens, completionTokens: completion.completionTokens, estimatedCostUsd: completion.estimatedCostUsd },
  };
}

/** Deliberately small server-side registry: this worker has no shell, browser, network, or payment tools. */
export const workerToolRegistry = {
  text_synthesis: textSynthesisTool,
} satisfies Record<string, WorkerTool>;

export async function executeTask(input: ExecutionInput, provider: AIProvider, signal: AbortSignal, maxCostUsd: number): Promise<ExecutedText> {
  return workerToolRegistry.text_synthesis(input, provider, signal, maxCostUsd);
}
