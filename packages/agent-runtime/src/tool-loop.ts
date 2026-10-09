import { FlowError, publicError } from './errors';
import { abortable } from './cancellation';
import type { ShoppingCoordinator } from './coordinator';
import type { PublicSession } from './types';
import { shouldStopPlanning } from '@ocp-catalog/shopping-contracts/browser';

export type ToolRequest = { name: 'search' } | { name: 'quote'; entry_id: string }
  | { name: 'quote'; entry_ids: string[] } | { name: 'inspect' };
export type PlannerStep = { type: 'tool'; tool: ToolRequest } | { type: 'wait_for_user' } | { type: 'done' };
export interface Planner {
  readonly mode: 'mock' | 'llm';
  next(context: { session: PublicSession; history: { tool: string; error?: { code: string; message: string } }[] }): Promise<PlannerStep>;
}

// Only determinate, pre-purchase selection failures may lead to another quote.
// Identity, authorization, transport and protocol failures stop the run.
const RECOVERABLE_SELECTION_ERRORS = new Set(['budget_exceeded', 'out_of_stock', 'quote_expired', 'requote_required']);

/** Normalize the actual basket quantities, rather than its group ordering. */
export function quoteFingerprint(session: PublicSession, entryIds: readonly string[]): string {
  const totals = new Map<string, number>();
  entryIds.forEach((entryId, index) => {
    const quantity = session.candidate_groups?.[index]?.quantity ?? session.intent.quantity;
    totals.set(entryId, (totals.get(entryId) ?? 0) + quantity);
  });
  return JSON.stringify({ name: 'quote', items: [...totals].sort(([left], [right]) => left.localeCompare(right))
    .map(([entry_id, quantity]) => ({ entry_id, quantity })) });
}

export function hasUntriedQuote(session: PublicSession, attempted: ReadonlySet<string>): boolean {
  const groups = session.candidate_groups ?? [{ quantity: session.intent.quantity, candidates: session.candidates }];
  if (!groups.length || groups.some(group => group.candidates.length === 0)) return false;
  const choices = groups.map(group => [...new Set(group.candidates.map(candidate => candidate.entry_id))]);
  const selection: string[] = [];
  const visit = (index: number): boolean => {
    if (index === groups.length) return !attempted.has(quoteFingerprint(session, selection));
    for (const entryId of choices[index]!) {
      selection[index] = entryId;
      if (visit(index + 1)) return true;
    }
    return false;
  };
  return visit(0);
}

/** Models may inspect/search/request quotes. Confirmation/signing/checkout are not tools. */
export async function runToolLoop(
  coordinator: ShoppingCoordinator, userId: string, sessionId: string, planner: Planner,
  options: { maxSteps?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ session: PublicSession; planner_mode: 'mock' | 'llm'; tool_calls: number }> {
  const maxSteps = options.maxSteps ?? 8;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 12) throw new FlowError('invalid_request', '工具次数上限必须为 1–12。');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const history: { tool: string; error?: { code: string; message: string } }[] = [];
  const seen = new Set<string>();
  options.signal?.throwIfAborted();
  let session = await coordinator.get(userId, sessionId, options);
  const result = () => ({ session, planner_mode: planner.mode, tool_calls: history.length });
  const finished = () => {
    if (shouldStopPlanning(session)) return true;
    if (session.phase === 'candidates' && (!session.candidates.length
      || session.candidate_groups?.some(group => !group.candidates.length))) return true;
    if (!['requote_required', 'failed'].includes(session.phase)) return false;
    const latest = history[history.length - 1];
    return latest?.tool !== 'quote' || !latest.error || !RECOVERABLE_SELECTION_ERRORS.has(latest.error.code)
      || !hasUntriedQuote(session, seen);
  };
  for (let step = 0; step < maxSteps; step += 1) {
    options.signal?.throwIfAborted();
    session = await coordinator.get(userId, sessionId, options);
    if (finished()) return result();
    if ((await coordinator.listPending(userId, options)).some(pending => pending.id !== sessionId)) {
      throw new FlowError('unresolved_purchase', '此身份有未决购买，请先查询原结果，再继续 Agent 规划。', 409);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proposed: PlannerStep;
    try {
      proposed = await Promise.race([
        abortable(planner.next({ session: structuredClone(session), history: structuredClone(history) }), options.signal),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new FlowError('planner_timeout', '模型规划超时。')), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    options.signal?.throwIfAborted();
    if (!proposed || !['tool', 'wait_for_user', 'done'].includes(proposed.type)) throw new FlowError('invalid_tool', '模型返回了无效步骤。');
    if (proposed.type !== 'tool') return result();
    const tool = proposed.tool;
    if (!tool || !['search', 'quote', 'inspect'].includes(tool.name)) throw new FlowError('invalid_tool', '模型工具未获准执行。');
    const entryIds = tool.name === 'quote' ? ('entry_ids' in tool ? tool.entry_ids : [tool.entry_id]) : undefined;
    if (tool.name === 'quote' && (!Array.isArray(entryIds) || entryIds.length !== (session.candidate_groups?.length ?? 1)
      || entryIds.some(id => typeof id !== 'string' || !id.trim()))) throw new FlowError('invalid_tool', '模型必须为每个商品需求选择一个目录候选。');
    // Build the fingerprint from allowed fields, so extra model keys cannot bypass repetition limits.
    const fingerprint = entryIds ? quoteFingerprint(session, entryIds) : JSON.stringify({ name: tool.name });
    if (seen.has(fingerprint)) throw new FlowError('repeated_tool', '工具动作重复，已暂停执行。');
    seen.add(fingerprint);
    try {
      if (tool.name === 'search') session = await coordinator.search(userId, sessionId, options);
      else if (tool.name === 'quote') session = await coordinator.select(userId, sessionId,
        'entry_ids' in tool ? tool.entry_ids : tool.entry_id, options);
      else session = await coordinator.get(userId, sessionId, options);
      // Coordinator failures are returned as session state, not always thrown.
      history.push({ tool: tool.name, ...(session.error ? { error: structuredClone(session.error) } : {}) });
    } catch (error) {
      options.signal?.throwIfAborted();
      history.push({ tool: tool.name, error: publicError(error) });
      if (tool.name !== 'quote' || !(error instanceof FlowError) || !RECOVERABLE_SELECTION_ERRORS.has(error.code)) throw error;
    }
    options.signal?.throwIfAborted();
    // A final allowed tool can finish successfully; it need not consume a
    // further model request merely to rediscover the terminal state.
    if (finished()) return result();
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
