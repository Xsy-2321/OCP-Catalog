import { describe, expect, test } from 'bun:test';
import { parseSessionView } from '../../../packages/shopping-contracts/src/browser';
import { createPageState, draftFromSession, draftQuantity, configurationDraftKey, configurationDraftLifetime,
  saveConfigurationDraft, readConfigurationDraft, paidPurchaseContext, canRestoreConfigurationDraft } from '../public/view-model.js';

function session(intent: Record<string, unknown> = {}) {
  return parseSessionView({ id: 'session_restore', mode: 'mock', phase: 'candidates',
    intent: { query: '拿铁', quantity: 2, currency: 'CNY', max_total_minor: 5201,
      merchant_id: 'coffee', fulfillment: 'pickup', ...intent }, candidates: [], revision: 1,
    created_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:00.000Z' });
}

describe('pure draft restoration', () => {
  test('legacy single request restores exact amounts without requiring normalized items', () => {
    const draft = draftFromSession(session());
    expect(draft).toEqual({ mode: 'manual', message: '', query: '拿铁', quantity: 2,
      budget: '52.01', mixed: false, items: [], fulfillment: 'pickup',
      delivery: { recipient: '', phone: '', address: '' }, changed: false });
    expect(draftQuantity(draft)).toBe(2);
  });

  test('normalized single request retains the single input rather than a hidden basket', () => {
    const draft = draftFromSession(session({ items: [{ query: '拿铁', quantity: 2 }] }));
    expect(draft.mixed).toBe(false);
    expect(draft.items).toEqual([]);
    expect(draft.quantity).toBe(2);
  });

  test('mixed request replaces the previous basket and resets dirty state', () => {
    const previous = createPageState().draft;
    previous.items = [{ query: '旧需求', quantity: 20 }];
    previous.changed = true;
    const draft = draftFromSession(session({ query: '拿铁、浓缩', quantity: 5,
      items: [{ query: '拿铁', quantity: 2 }, { query: '浓缩', quantity: 3 }] }), previous);
    expect(draft.mixed).toBe(true);
    expect(draft.items).toEqual([{ query: '拿铁', quantity: 2 }, { query: '浓缩', quantity: 3 }]);
    expect(draftQuantity(draft)).toBe(5);
    expect(draft.changed).toBe(false);
    expect(previous.items).toEqual([{ query: '旧需求', quantity: 20 }]);
    expect(previous.changed).toBe(true);
  });

  test('restoring an agent result retains its selected mode and original message', () => {
    const draft = draftFromSession(session(), { mode: 'agent', message: '请推荐两杯拿铁' });
    expect(draft.mode).toBe('agent');
    expect(draft.message).toBe('请推荐两杯拿铁');
    expect(draft.changed).toBe(false);
  });

  test('delivery and basket values are detached from the validated server snapshot', () => {
    const restored = session({ query: '拿铁、浓缩', quantity: 5, fulfillment: 'delivery',
      delivery: { recipient: '测试收件人', phone: '13800000000', address: '测试路一号' },
      items: [{ query: '拿铁', quantity: 2 }, { query: '浓缩', quantity: 3 }] });
    const before = JSON.stringify(restored);
    const draft = draftFromSession(restored);
    expect(draft.fulfillment).toBe('delivery');
    expect(draft.delivery).toEqual(restored.intent.delivery!);
    expect(draft.items).not.toBe(restored.intent.items);
    expect(draft.items[0]).not.toBe(restored.intent.items![0]);
    expect(draft.delivery).not.toBe(restored.intent.delivery);
    draft.items[0].query = '已编辑';
    draft.items[1].quantity = 1;
    draft.delivery.recipient = '已编辑';
    expect(JSON.stringify(restored)).toBe(before);
  });

  test('pickup restoration clears stale delivery details from the previous draft', () => {
    const previous = createPageState().draft;
    previous.fulfillment = 'delivery';
    previous.delivery = { recipient: '旧收件人', phone: '13800000000', address: '旧地址一号' };
    const draft = draftFromSession(session(), previous);
    expect(draft.fulfillment).toBe('pickup');
    expect(draft.delivery).toEqual({ recipient: '', phone: '', address: '' });
    expect(previous.delivery.recipient).toBe('旧收件人');
  });
});

describe('configuration detour draft', () => {
  function store() {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  }

  function paidSession() {
    return parseSessionView({ ...session(), phase: 'confirmed', revision: 3,
      attempt: { purchase_attempt_id: 'attempt_paid_restore', status: 'confirmed' },
      order: { order_id: 'ORDER-PAID-RESTORE', purchase_attempt_id: 'attempt_paid_restore', title: '拿铁', quantity: 2,
        currency: 'CNY', total_minor: 4000, payment_status: 'paid', fulfillment_status: 'ready', fulfillment: 'pickup',
        updated_at: '2026-10-08T00:00:00.000Z' } });
  }

  test('candidate and unpaid draft restoration retain exact session and revision checks', () => {
    const storage = store(), state = createPageState();
    state.uiStatus.pendingCheckFailed = false;
    for (const phase of ['candidates', 'awaiting_confirmation'] as const) {
      state.serverSession = parseSessionView({ ...session(), phase });
      saveConfigurationDraft(storage, { ...state.draft, changed: true }, state.serverSession, 0);
      const record = readConfigurationDraft(storage)!;
      expect(canRestoreConfigurationDraft(record, state, true)).toBe(true);
      state.serverSession.revision++;
      expect(canRestoreConfigurationDraft(record, state, true)).toBe(false);
      state.serverSession.id = 'session_other';
      expect(canRestoreConfigurationDraft(record, state, true)).toBe(false);
    }
  });

  test('an explicitly edited new request survives only the same paid purchase revision refresh', () => {
    const storage = store(), state = createPageState(), paid = paidSession();
    state.uiStatus.pendingCheckFailed = false;
    state.serverSession = parseSessionView({ ...paid, revision: paid.revision + 1 });
    saveConfigurationDraft(storage, { ...state.draft, changed: true }, paid, 0);
    const record = readConfigurationDraft(storage)!;
    expect(record.paidPurchase).toEqual({ sessionId: paid.id, attemptId: paid.attempt!.purchase_attempt_id, orderId: paid.order!.order_id });
    expect(canRestoreConfigurationDraft(record, state, true)).toBe(true);
    expect(canRestoreConfigurationDraft({ ...record, step: 1 }, state, true)).toBe(false);
    expect(canRestoreConfigurationDraft({ ...record, draft: { ...record.draft, changed: false } }, state, true)).toBe(false);
    expect(canRestoreConfigurationDraft({ ...record, paidPurchase: null }, state, true)).toBe(false);
    for (const key of ['sessionId', 'attemptId', 'orderId'] as const) {
      expect(canRestoreConfigurationDraft({ ...record, paidPurchase: { ...record.paidPurchase!, [key]: 'different_identity' } }, state, true)).toBe(false);
    }
  });

  test('portal draft with null session requires the explicit completed paid projection context', () => {
    const storage = store(), state = createPageState(), paid = paidSession(), now = 1_000_000;
    state.uiStatus.pendingCheckFailed = false;
    state.serverSession = parseSessionView({ ...paid, revision: paid.revision + 2 });
    saveConfigurationDraft(storage, { ...state.draft, changed: true }, null, 0, now, paidPurchaseContext(paid));
    const record = readConfigurationDraft(storage, false, now)!;
    expect(record.sessionId).toBeNull();
    expect(record.revision).toBeNull();
    expect(canRestoreConfigurationDraft(record, state, true)).toBe(true);
    expect(canRestoreConfigurationDraft({ ...record, paidPurchase: null }, state, true)).toBe(false);
    expect(canRestoreConfigurationDraft({ ...record, sessionId: 'session_unpaid_prior' }, state, true)).toBe(false);
  });

  test('recovery errors, discovered pending purchases and payment uncertainty override every transferred field', () => {
    const storage = store(), state = createPageState(), paid = paidSession();
    state.uiStatus.pendingCheckFailed = false;
    state.serverSession = parseSessionView({ ...paid, revision: paid.revision + 1 });
    saveConfigurationDraft(storage, { ...state.draft, mode: 'agent', message: '不应覆盖原购买', changed: true }, paid, 0);
    const record = readConfigurationDraft(storage)!;
    expect(canRestoreConfigurationDraft(record, state, false)).toBe(false);
    expect(canRestoreConfigurationDraft(record, state, true, true)).toBe(false);
    for (const flag of ['pendingCheckFailed', 'transportUncertain'] as const) {
      state.uiStatus[flag] = true;
      expect(canRestoreConfigurationDraft(record, state, true)).toBe(false);
      state.uiStatus[flag] = false;
    }
    state.uiStatus.pendingSessions = [parseSessionView({ ...paid, phase: 'unknown' })];
    expect(canRestoreConfigurationDraft(record, state, true)).toBe(false);
    state.uiStatus.pendingSessions = [];
    for (const updated of [
      { ...paid, phase: 'unknown' },
      { ...paid, phase: 'awaiting_confirmation' },
      { ...paid, attempt: { ...paid.attempt!, status: 'processing' } },
      { ...paid, order: { ...paid.order!, payment_status: 'pending' } },
      { ...paid, order: { ...paid.order!, order_id: 'ORDER-OTHER' } },
      { ...paid, attempt: { ...paid.attempt!, purchase_attempt_id: 'attempt_other' } },
      { ...paid, error: { code: 'unavailable', message: '读取失败' } },
    ]) {
      state.serverSession = parseSessionView({ ...updated, revision: paid.revision + 1 });
      expect(canRestoreConfigurationDraft(record, state, true)).toBe(false);
    }
  });

  test('keeps only detached shopping fields, and consumes private delivery on return', () => {
    const storage = store(), state = createPageState(), now = 1_000_000;
    state.draft = { ...state.draft, mode: 'agent', query: '未提交拿铁', message: '不甜，两种咖啡', budget: '66.66', quantity: 3,
      mixed: true, items: [{ query: '拿铁', quantity: 2 }, { query: '美式', quantity: 1 }], fulfillment: 'delivery',
      delivery: { recipient: '仅本次收件人', phone: '13800000000', address: '仅本次浏览器会话一号楼' }, changed: true };
    Object.assign(state.draft, { api_key: 'fixture-key-must-not-transfer', arbitrary: { token: 'fixture-token' } });
    expect(saveConfigurationDraft(storage, state.draft, session(), 0, now)).toBe(true);
    expect(storage.values.get(configurationDraftKey)).not.toContain('fixture-key-must-not-transfer');
    expect(storage.values.get(configurationDraftKey)).not.toContain('fixture-token');
    const copied = readConfigurationDraft(storage, false, now + 1)!;
    expect(copied.sessionId).toBe('session_restore');
    expect(copied.revision).toBe(1);
    expect(copied.draft.items).toEqual(state.draft.items);
    copied.draft.items[0].query = '改副本';
    expect(readConfigurationDraft(storage, true, now + 2)!.draft.items[0].query).toBe('拿铁');
    expect(state.draft.items[0].query).toBe('拿铁');
    expect(storage.values.size).toBe(0);
  });

  test('expires and removes the transient private draft', () => {
    const storage = store(), now = 1_000_000;
    saveConfigurationDraft(storage, createPageState().draft, null, 0, now);
    expect(readConfigurationDraft(storage, false, now + configurationDraftLifetime + 1)).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  test('malformed, oversized or invalid drafts are discarded rather than restoring runtime state', () => {
    const storage = store(), now = 1_000_000;
    for (const value of ['{', 'x'.repeat(16385), JSON.stringify({ version: 1, createdAt: now,
      sessionId: null, revision: null, step: 9, draft: createPageState().draft })]) {
      storage.setItem(configurationDraftKey, value);
      expect(readConfigurationDraft(storage, false, now)).toBeNull();
      expect(storage.values.size).toBe(0);
    }
  });

  test('disabled session storage has no persistent-storage fallback', () => {
    const storage = { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); }, removeItem() { throw new Error('disabled'); } };
    expect(saveConfigurationDraft(storage, createPageState().draft, null, 0)).toBe(false);
    expect(readConfigurationDraft(storage, true)).toBeNull();
  });
});
