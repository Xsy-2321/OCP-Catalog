import { FlowError, publicError } from './errors';
import type { ShoppingCoordinator } from './coordinator';
import type { PublicSession } from './types';

export type ToolRequest = { name: 'search' } | { name: 'quote'; entry_id: string } | { name: 'inspect' };
export type PlannerStep = { type: 'tool'; tool: ToolRequest } | { type: 'wait_for_user' } | { type: 'done' };
export interface Planner {
  readonly mode: 'mock' | 'llm';
  next(context: { session: PublicSession; history: { tool: string; error?: { code: string; message: string } }[] }): Promise<PlannerStep>;
}

/** Models may inspect/search/request quotes. Confirmation/signing/checkout are not tools. */
export async function runToolLoop(
  coordinator: ShoppingCoordinator, userId: string, sessionId: string, planner: Planner,
  options: { maxSteps?: number; timeoutMs?: number } = {},
): Promise<{ session: PublicSession; planner_mode: 'mock' | 'llm'; tool_calls: number }> {
  const maxSteps = options.maxSteps ?? 8;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 12) throw new FlowError('invalid_request', '工具次数上限必须为 1–12。');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const history: { tool: string; error?: { code: string; message: string } }[] = [];
  const seen = new Set<string>();
  let session = await coordinator.get(userId, sessionId);
  for (let step = 0; step < maxSteps; step += 1) {
    if (session.attempt || ['awaiting_confirmation', 'cancelled', 'requote_required', 'failed'].includes(session.phase)) {
      return { session, planner_mode: planner.mode, tool_calls: history.length };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proposed: PlannerStep;
    try {
      proposed = await Promise.race([
        planner.next({ session: structuredClone(session), history: structuredClone(history) }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new FlowError('planner_timeout', '模型规划超时。')), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    if (!proposed || !['tool', 'wait_for_user', 'done'].includes(proposed.type)) throw new FlowError('invalid_tool', '模型返回了无效步骤。');
    if (proposed.type !== 'tool') return { session, planner_mode: planner.mode, tool_calls: history.length };
    const tool = proposed.tool;
    if (!tool || !['search', 'quote', 'inspect'].includes(tool.name)
      || (tool.name === 'quote' && typeof tool.entry_id !== 'string')) throw new FlowError('invalid_tool', '模型工具未获准执行。');
    // Build the fingerprint from allowed fields, so extra model keys cannot bypass repetition limits.
    const fingerprint = JSON.stringify({ name: tool.name, entry: tool.name === 'quote' ? tool.entry_id : undefined });
    if (seen.has(fingerprint)) throw new FlowError('repeated_tool', '工具动作重复，已暂停执行。');
    seen.add(fingerprint);
    try {
      if (tool.name === 'search') session = await coordinator.search(userId, sessionId);
      else if (tool.name === 'quote') session = await coordinator.select(userId, sessionId, tool.entry_id);
      else session = await coordinator.get(userId, sessionId);
      history.push({ tool: tool.name });
    } catch (error) { history.push({ tool: tool.name, error: publicError(error) }); }
  }
  throw new FlowError('tool_limit', '达到工具执行次数上限，已暂停执行。');
}

/** Explicit deterministic fixture planner; no network/model calls. */
export class DeterministicMockPlanner implements Planner {
  readonly mode = 'mock' as const;
  async next({ session }: { session: PublicSession }): Promise<PlannerStep> {
    if (session.phase === 'new') return { type: 'tool', tool: { name: 'search' } };
    if (session.phase === 'candidates' && session.candidates[0]) {
      return { type: 'tool', tool: { name: 'quote', entry_id: session.candidates[0].entry_id } };
    }
    return { type: 'wait_for_user' };
  }
}
