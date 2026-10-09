import { isPendingPurchase, canRequestQuote } from './contracts.js';

/** @typedef {import('./contracts.js').SessionView} SessionView */
/** @typedef {import('./contracts.js').ConfigView} ConfigView */
/** @typedef {import('./contracts.js').AgentRunView} AgentRunView */
/** @typedef {{ query: string, quantity: number }} DraftItem */
/** @typedef {{ recipient: string, phone: string, address: string }} Delivery */
/** @typedef {{ mode: 'manual' | 'agent', mixed: boolean, query: string, message: string, budget: string, quantity: number, items: DraftItem[], fulfillment: 'pickup' | 'delivery', delivery: Delivery, changed: boolean }} Draft */
/** @typedef {{ busy: boolean, backgroundChecking: boolean, transportUncertain: boolean, pendingCheckFailed: boolean, connectionFailed: boolean, pendingSessions: SessionView[], refreshQueued: boolean, basketChanged: boolean, basketChoices: Map<number, string>, transient: { text: string, kind: string } }} UiStatus */
/** @typedef {{ draft: Draft, serverSession: SessionView | null, configuration: ConfigView | null, plannerResult: AgentRunView | null, uiStatus: UiStatus }} PageState */
/** @typedef {{ sessionId: string, attemptId: string, orderId: string }} PaidPurchase */
/** @typedef {{ version: 1, createdAt: number, sessionId: string | null, revision: number | null, step: number, draft: Draft, paidPurchase: PaidPurchase | null }} ConfigurationDraft */
/** @typedef {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} DraftStorage */

export const configurationDraftKey = 'ocp-shopping-configuration-draft';
export const configurationDraftLifetime = 30 * 60 * 1000;

/** Keep only the identity of a completed simulated purchase, never its private order details.
 * @param {unknown} value @returns {PaidPurchase | null}
 */
function safePaidPurchase(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const purchase = /** @type {Record<string, unknown>} */ (value);
  if (![purchase.sessionId, purchase.attemptId, purchase.orderId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(id))) return null;
  return { sessionId: /** @type {string} */ (purchase.sessionId), attemptId: /** @type {string} */ (purchase.attemptId), orderId: /** @type {string} */ (purchase.orderId) };
}

/** @param {SessionView | null} session @returns {PaidPurchase | null} */
export function paidPurchaseContext(session) {
  if (session?.phase !== 'confirmed' || session.attempt?.status !== 'confirmed' || session.order?.payment_status !== 'paid'
    || session.error || session.order.purchase_attempt_id !== session.attempt.purchase_attempt_id) return null;
  return safePaidPurchase({ sessionId: session.id, attemptId: session.attempt.purchase_attempt_id, orderId: session.order.order_id });
}

/** A changed projection is acceptable only for an explicit new request tied to the same completed purchase.
 * Unpaid work still requires its exact session and revision; pending discovery always wins.
 * @param {ConfigurationDraft} record @param {PageState} state @param {boolean} factsRestored @param {boolean} [pendingObserved]
 */
export function canRestoreConfigurationDraft(record, state, factsRestored, pendingObserved = false) {
  const { serverSession: session, uiStatus: ui } = state;
  if (!factsRestored || pendingObserved || ui.pendingCheckFailed || ui.transportUncertain || ui.pendingSessions.length
    || (session && isPendingPurchase(session))) return false;
  if (record.sessionId === (session?.id ?? null) && record.revision === (session?.revision ?? null)) return true;
  const paid = paidPurchaseContext(session), previous = record.paidPurchase;
  return Boolean(record.step === 0 && record.draft.changed && paid && previous
    && (record.sessionId === null || record.sessionId === paid.sessionId)
    && previous.sessionId === paid.sessionId && previous.attemptId === paid.attemptId && previous.orderId === paid.orderId);
}

/** Only shopping form fields cross the configuration detour; never copy arbitrary page or API settings.
 * @param {unknown} value
 * @returns {Draft | null}
 */
function safeDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = /** @type {Record<string, unknown>} */ (value);
  /** @param {unknown} text @param {number} length */
  const boundedText = (text, length) => typeof text === 'string' && text.length <= length;
  /** @param {unknown} quantity */
  const boundedQuantity = quantity => typeof quantity === 'number' && Number.isFinite(quantity) && quantity >= 0 && quantity <= 1000;
  if (!['manual', 'agent'].includes(String(draft.mode)) || typeof draft.mixed !== 'boolean' || typeof draft.changed !== 'boolean'
    || !boundedText(draft.query, 500) || !boundedText(draft.message, 1000) || !boundedText(draft.budget, 64)
    || !boundedQuantity(draft.quantity) || !['pickup', 'delivery'].includes(String(draft.fulfillment))
    || !Array.isArray(draft.items) || draft.items.length > 10 || !draft.delivery || typeof draft.delivery !== 'object' || Array.isArray(draft.delivery)) return null;
  const delivery = /** @type {Record<string, unknown>} */ (draft.delivery);
  if (!boundedText(delivery.recipient, 60) || !boundedText(delivery.phone, 20) || !boundedText(delivery.address, 300)) return null;
  /** @type {DraftItem[]} */
  const items = [];
  for (const value of draft.items) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = /** @type {Record<string, unknown>} */ (value);
    if (!boundedText(item.query, 500) || !boundedQuantity(item.quantity)) return null;
    items.push({ query: /** @type {string} */ (item.query), quantity: /** @type {number} */ (item.quantity) });
  }
  return { mode: /** @type {Draft['mode']} */ (draft.mode), mixed: draft.mixed, query: /** @type {string} */ (draft.query),
    message: /** @type {string} */ (draft.message), budget: /** @type {string} */ (draft.budget), quantity: /** @type {number} */ (draft.quantity),
    items, fulfillment: /** @type {Draft['fulfillment']} */ (draft.fulfillment), changed: draft.changed,
    delivery: { recipient: /** @type {string} */ (delivery.recipient), phone: /** @type {string} */ (delivery.phone), address: /** @type {string} */ (delivery.address) } };
}

/** Save an explicit, short-lived configuration detour in this tab's session storage.
 * @param {DraftStorage} storage @param {Draft} draft @param {SessionView | null} session @param {number} step @param {number} [now]
 * @param {PaidPurchase | null} [completedPaidPurchase]
 */
export function saveConfigurationDraft(storage, draft, session, step, now = Date.now(), completedPaidPurchase = null) {
  const copy = safeDraft(draft);
  if (!copy) return false;
  try {
    storage.setItem(configurationDraftKey, JSON.stringify({ version: 1, createdAt: now, sessionId: session?.id ?? null,
      revision: session?.revision ?? null, step, draft: copy,
      paidPurchase: paidPurchaseContext(session) ?? (session ? null : safePaidPurchase(completedPaidPurchase)) }));
    return true;
  } catch { return false; }
}

/** @param {DraftStorage} storage */
export function clearConfigurationDraft(storage) {
  try { storage.removeItem(configurationDraftKey); } catch { /* Storage may be disabled; no persistent fallback. */ }
}

/** Read without trusting storage contents; a returning buyer consumes and deletes the record immediately.
 * @param {DraftStorage} storage @param {boolean} [consume] @param {number} [now]
 * @returns {ConfigurationDraft | null}
 */
export function readConfigurationDraft(storage, consume = false, now = Date.now()) {
  try {
    const text = storage.getItem(configurationDraftKey);
    if (consume) clearConfigurationDraft(storage);
    if (!text) return null;
    if (text.length > 16384) throw new Error();
    const value = /** @type {Record<string, unknown>} */ (JSON.parse(text));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || now < value.createdAt || now - value.createdAt > configurationDraftLifetime
      || !(value.sessionId === null || (typeof value.sessionId === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value.sessionId)))
      || !(value.revision === null || (typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0))
      || typeof value.step !== 'number' || !Number.isInteger(value.step) || value.step < 0 || value.step > 3) throw new Error();
    const draft = safeDraft(value.draft);
    if (!draft) throw new Error();
    const paidPurchase = safePaidPurchase(value.paidPurchase);
    if (value.paidPurchase !== undefined && value.paidPurchase !== null && !paidPurchase) throw new Error();
    return { version: 1, createdAt: value.createdAt, sessionId: value.sessionId, revision: value.revision, step: value.step, draft, paidPurchase };
  } catch { clearConfigurationDraft(storage); return null; }
}

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
