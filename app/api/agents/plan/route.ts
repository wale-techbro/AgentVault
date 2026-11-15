import { NextResponse } from 'next/server';
import { planTask, type TaskRequest } from '@/lib/agents';
import { getAIProvider } from '@/lib/ai/provider';

export async function POST(request: Request) {
  let task: TaskRequest;
  try {
    task = await request.json() as TaskRequest;
    if (!task || typeof task.title !== 'string' || task.title.length > 120 ||
        typeof task.description !== 'string' || task.description.length > 6000 ||
        typeof task.budgetNear !== 'number' || !Number.isFinite(task.budgetNear) ||
        !Array.isArray(task.capabilities) || task.capabilities.length > 12 ||
        !task.capabilities.every((item) => typeof item === 'string' && item.length <= 40)) {
      return NextResponse.json({ error: 'Invalid task shape.' }, { status: 400 });
    }
    const plan = planTask(task);
    const provider = getAIProvider();
    if (!provider) return NextResponse.json({ source: 'deterministic-demo', plan });

    const rationaleJSON = await provider.complete(
      'Return a JSON object with one short string field named rationale. Explain how the task can be divided into the supplied capability workstreams. Do not add claims, costs, or tasks.',
      JSON.stringify({ title: task.title, description: task.description, subtasks: plan.map(({ title, capability }) => ({ title, capability })) }),
    );
    const parsed: unknown = JSON.parse(rationaleJSON);
    const rationale = typeof parsed === 'object' && parsed !== null && 'rationale' in parsed && typeof parsed.rationale === 'string'
      ? parsed.rationale.slice(0, 800)
      : '';
    if (!rationale) throw new Error('Configured provider returned an invalid planning rationale.');
    return NextResponse.json({ source: 'configured-provider', plan, rationale });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to plan this task.';
    const status = message.includes('required') || message.includes('Unsupported') ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
