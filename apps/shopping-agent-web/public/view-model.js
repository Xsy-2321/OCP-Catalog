import { isPendingPurchase, canRequestQuote } from './contracts.js';

/** @typedef {import('./contracts.js').SessionView} SessionView */
/** @typedef {import('./contracts.js').ConfigView} ConfigView */
/** @typedef {import('./contracts.js').AgentRunView} AgentRunView */
/** @typedef {{ query: string, quantity: number }} DraftItem */
/** @typedef {{ recipient: string, phone: string, address: string }} Delivery */
/** @typedef {{ mode: 'manual' | 'agent', mixed: boolean, query: string, message: string, budget: string, quantity: number, items: DraftItem[], fulfillment: 'pickup' | 'delivery', delivery: Delivery, changed: boolean }} Draft */
/** @typedef {{ busy: boolean, backgroundChecking: boolean, transportUncertain: boolean, pendingCheckFailed: boolean, connectionFailed: boolean, pendingSessions: SessionView[], refreshQueued: boolean, basketChanged: boolean, basketChoices: Map<number, string>, transient: { text: string, kind: string } }} UiStatus */
/** @typedef {{ draft: Draft, serverSession: SessionView | null, configuration: ConfigView | null, plannerResult: AgentRunView | null, uiStatus: UiStatus }} PageState */

/** @returns {PageState} */
export function createPageState() {
  return {
    draft: { mode: 'manual', mixed: false, query: '拿铁', message: '', budget: '30.00', quantity: 1,
      items: [], fulfillment: 'pickup', delivery: { recipient: '', phone: '', address: '' }, changed: false },
    serverSession: null,
    configuration: null,
    plannerResult: null,
    uiStatus: { busy: false, backgroundChecking: false, transportUncertain: false, pendingCheckFailed: true, connectionFailed: false,
      pendingSessions: [], refreshQueued: false, basketChanged: false, basketChoices: new Map(), transient: { text: '', kind: '' } },
  };
}

/** Restore server facts into a new draft while retaining the user's selected input mode and message.
 * Nested values are copied so editing the draft cannot change the server snapshot.
 * @param {SessionView} session
 * @param {Pick<Draft, 'mode' | 'message'>} [preferences]
 * @returns {Draft}
 */
export function draftFromSession(session, preferences = { mode: 'manual', message: '' }) {
  const { intent } = session;
  const mixed = Boolean(intent.items && intent.items.length > 1);
  return {
    mode: preferences.mode,
    message: preferences.message,
    query: intent.query,
    budget: (intent.max_total_minor / 100).toFixed(2),
    quantity: intent.quantity,
    mixed,
    items: mixed ? (intent.items ?? []).map(item => ({ query: item.query, quantity: item.quantity })) : [],
    fulfillment: intent.fulfillment,
    delivery: intent.fulfillment === 'delivery' && intent.delivery
      ? { ...intent.delivery } : { recipient: '', phone: '', address: '' },
    changed: false,
  };
}

/** @param {Draft} draft */
export function draftQuantity(draft) {
  return draft.mode === 'manual' && draft.mixed ? draft.items.reduce((sum, item) => sum + item.quantity, 0) : draft.quantity;
}

/** Derive every business action from page facts; this function never reads or writes the DOM.
 * @param {PageState} state
 * @param {number} now
 */
export function deriveViewModel(state, now) {
  const { draft, serverSession: session, configuration, plannerResult, uiStatus: ui } = state;
  const phase = session?.phase ?? 'new';
  const pending = Boolean(session && isPendingPurchase(session));
  const locked = ui.transportUncertain || ui.pendingCheckFailed || ui.pendingSessions.length > 0 || pending;
  const activeAttempt = Boolean(session?.attempt && session.attempt.status !== 'failed');
  const quoteSeconds = session?.quote ? Math.max(0, Math.ceil((Date.parse(session.quote.expires_at) - now) / 1000)) : 0;
  const freshQuote = Boolean(session?.quote && Number.isFinite(quoteSeconds) && quoteSeconds > 0);
  const editable = !ui.busy && !locked;
  const quote = editable && !draft.changed && Boolean(session && canRequestQuote(session));
  const groups = session?.candidate_groups ?? [{ quantity: session?.intent.quantity ?? 0, query: session?.intent.query ?? '', candidates: session?.candidates ?? [] }];
  const grouped = Boolean(session?.candidate_groups && session.candidate_groups.length > 1);
  const basketComplete = groups.every((group, index) => group.candidates.some((candidate) => candidate.entry_id === ui.basketChoices.get(index)));
  const actions = {
    search: editable && Boolean(configuration) && (draft.mode !== 'agent' || configuration?.llm_status === 'configured'),
    quote,
    basketQuote: quote && basketComplete,
    confirm: editable && !draft.changed && !ui.basketChanged && phase === 'awaiting_confirmation' && !session?.attempt && freshQuote,
    cancel: editable && !activeAttempt && phase !== 'cancelled',
    recover: !ui.busy,
    edit: !locked && (!ui.busy || ui.backgroundChecking),
  };
  const nextActions = (plannerResult?.next_actions ?? []).filter((action) => action === 'confirm_quote' ? actions.confirm
    : action === 'choose_candidate' ? actions.quote && Boolean(session?.candidates.length) : action === 'edit_request' && actions.edit);
  let notice = { text: '', kind: '' };
  if (ui.transportUncertain) notice = { text: '确认请求的结果未知，请查询原购买结果；不要重新购买。', kind: 'warning' };
  else if (ui.transient.text) notice = ui.transient;
  else if (session?.error) notice = { text: session.error.message, kind: ['result_unknown', 'processing'].includes(session.error.code) ? 'warning' : 'error' };
  else if (phase === 'cancelled') notice = { text: '本次购买已取消，没有执行结账。', kind: '' };
  else if (phase === 'confirmed') notice = { text: '模拟订单已确认。付款和制作状态以本地模拟商家返回的结果为准。', kind: '' };
  else if (phase === 'candidates' && !session?.candidates.length) notice = { text: '没有符合目录价格、币种和库存要求的候选。请调整需求或预算。', kind: 'warning' };
  return {
    phase, locked, activeAttempt, pending, actions, groups, grouped, notice,
    totalQuantity: draftQuantity(draft),
    mixed: draft.mode === 'manual' && draft.mixed,
    delivery: draft.fulfillment === 'delivery',
    step: session?.attempt || ui.transportUncertain ? 3 : phase === 'cancelled' ? 0
      : session?.quote && phase === 'awaiting_confirmation' ? 2 : phase === 'candidates' || session?.candidates.length ? 1 : 0,
    quoteSeconds,
    expiry: session?.attempt ? '报价已绑定本次购买' : quoteSeconds ? `报价剩余 ${quoteSeconds} 秒` : '报价已过期，请重新报价',
    quoteVisible: Boolean(session?.quote) && !ui.basketChanged,
    orderVisible: Boolean(session?.attempt) || ui.transportUncertain,
    draftNoteVisible: draft.changed && Boolean(session?.quote) && !session?.attempt,
    nextActions,
  };
}
