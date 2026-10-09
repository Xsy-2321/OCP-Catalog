import { describe, expect, test } from 'bun:test';
import { parseConfigView, parseSessionView } from '../../../packages/shopping-contracts/src/browser';
import { createPageState, deriveViewModel, draftQuantity } from '../public/view-model.js';

const now = Date.parse('2026-10-08T00:00:00.000Z');
function page() {
  const state = createPageState();
  state.uiStatus.pendingCheckFailed = false;
  state.configuration = parseConfigView({ mode: 'mock', merchant_id: 'coffee', payment_mode: 'local_simulated',
    c0_status: 'integrated', contract_version: '1', llm_status: 'configured', llm_model: 'fixture',
    merchant_health: { status: 'mock', message: 'local', checked_at: new Date(now).toISOString() } });
  const candidate = { entry_id: 'latte', catalog_id: 'coffee', merchant_id: 'coffee', title: 'Latte', description: 'Milk coffee',
    search_price_minor: 2600, currency: 'CNY', in_stock: true };
  state.serverSession = parseSessionView({ id: 'session_fixture', mode: 'mock', phase: 'awaiting_confirmation',
    intent: { query: 'latte', quantity: 1, currency: 'CNY', max_total_minor: 3000, merchant_id: 'coffee', fulfillment: 'pickup' },
    candidates: [candidate], selected: candidate,
    quote: { quote_id: 'quote_fixture', merchant_id: 'coffee', entry_id: 'latte', title: 'Latte', quantity: 1, fulfillment: 'pickup',
      currency: 'CNY', unit_price_minor: 2600, fees: [], total_minor: 2600, terms_hash: 'fixture', expires_at: new Date(now + 60_000).toISOString() },
    revision: 1, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
  return state;
}

describe('pure shopping page decisions', () => {
  test('fresh quote permits explicit confirmation without changing the server facts', () => {
    const state = page();
    const before = JSON.stringify(state.serverSession);
    const view = deriveViewModel(state, now);
    expect(view.actions.confirm).toBe(true);
    expect(view.expiry).toBe('报价剩余 60 秒');
    expect(JSON.stringify(state.serverSession)).toBe(before);
    expect(state.serverSession?.attempt).toBeUndefined();
  });

  test('quote expiry disables confirmation and its planner suggestion while requoting stays available', () => {
    const state = page();
    state.plannerResult = { session: state.serverSession!, planner_mode: 'llm', tool_calls: 1, explanation: 'Choose', model: 'fixture',
      outcome: 'quote_ready', next_actions: ['confirm_quote', 'choose_candidate', 'edit_request'], warnings: [] };
    const view = deriveViewModel(state, now + 60_000);
    expect(view.actions.confirm).toBe(false);
    expect(view.actions.quote).toBe(true);
    expect(view.nextActions).toEqual(['choose_candidate', 'edit_request']);
    expect(view.expiry).toBe('报价已过期，请重新报价');
  });

  test.each(['unknown', 'checkout_pending'] as const)('pending phase %s blocks new purchases and preserves the original attempt', (phase) => {
    const state = page();
    state.serverSession!.phase = phase;
    state.serverSession!.attempt = { purchase_attempt_id: 'original_attempt', status: 'processing' };
    const view = deriveViewModel(state, now);
    expect(view.locked).toBe(true);
    expect(view.actions.search).toBe(false);
    expect(view.actions.quote).toBe(false);
    expect(view.actions.confirm).toBe(false);
    expect(view.actions.cancel).toBe(false);
    expect(view.actions.recover).toBe(true);
    expect(state.serverSession!.attempt.purchase_attempt_id).toBe('original_attempt');
  });

  test('another tab pending record and failed pending discovery each block a new request', () => {
    const state = page();
    state.uiStatus.pendingSessions = [{ ...state.serverSession!, id: 'other_tab', phase: 'unknown' }];
    expect(deriveViewModel(state, now).actions.search).toBe(false);
    state.uiStatus.pendingSessions = [];
    state.uiStatus.pendingCheckFailed = true;
    expect(deriveViewModel(state, now).actions.search).toBe(false);
    expect(deriveViewModel(state, now).actions.confirm).toBe(false);
  });

  test('background focus checks preserve editing while purchase actions and known pending records remain locked', () => {
    const state = page();
    state.uiStatus.busy = true;
    state.uiStatus.backgroundChecking = true;
    const view = deriveViewModel(state, now);
    expect(view.actions.edit).toBe(true);
    expect(view.actions.search).toBe(false);
    expect(view.actions.quote).toBe(false);
    expect(view.actions.confirm).toBe(false);
    expect(view.actions.cancel).toBe(false);
    state.uiStatus.pendingCheckFailed = true;
    expect(deriveViewModel(state, now).actions.edit).toBe(false);
    state.uiStatus.pendingCheckFailed = false;
    state.uiStatus.transportUncertain = true;
    expect(deriveViewModel(state, now).actions.edit).toBe(false);
  });

  test('uncertain confirmation response takes priority over ordinary notices', () => {
    const state = page();
    state.uiStatus.transportUncertain = true;
    state.uiStatus.transient = { text: 'ordinary message', kind: '' };
    const view = deriveViewModel(state, now);
    expect(view.notice.text).toContain('不要重新购买');
    expect(view.orderVisible).toBe(true);
    expect(view.step).toBe(3);
    expect(view.actions.confirm).toBe(false);
  });

  test('empty search still has a candidate step, while a rejected quote cannot advance to confirmation', () => {
    const state = page();
    state.serverSession!.phase = 'candidates';
    state.serverSession!.candidates = [];
    delete state.serverSession!.quote;
    expect(deriveViewModel(state, now).step).toBe(1);

    const rejected = page();
    rejected.serverSession!.phase = 'failed';
    rejected.serverSession!.error = { code: 'over_budget', message: 'Budget exceeded' };
    expect(deriveViewModel(rejected, now).step).toBe(1);
    expect(deriveViewModel(rejected, now).actions.confirm).toBe(false);
    rejected.serverSession!.phase = 'cancelled';
    expect(deriveViewModel(rejected, now).step).toBe(0);
  });

  test('a changed draft disables the old quote while allowing a new explicit search', () => {
    const state = page();
    state.draft.changed = true;
    const view = deriveViewModel(state, now);
    expect(view.actions.confirm).toBe(false);
    expect(view.actions.quote).toBe(false);
    expect(view.actions.search).toBe(true);
    expect(view.draftNoteVisible).toBe(true);
  });

  test('a failed attempt can be requoted but never reuses the old confirmation', () => {
    const state = page();
    state.serverSession!.phase = 'failed';
    state.serverSession!.attempt = { purchase_attempt_id: 'failed_attempt', status: 'failed' };
    const view = deriveViewModel(state, now);
    expect(view.actions.quote).toBe(true);
    expect(view.actions.confirm).toBe(false);
  });

  test('confirmed purchase stays final even when its separate payment/order projection is unknown', () => {
    const state = page();
    state.serverSession!.phase = 'confirmed';
    state.serverSession!.attempt = { purchase_attempt_id: 'confirmed_attempt', status: 'confirmed' };
    const view = deriveViewModel(state, now);
    expect(view.pending).toBe(false);
    expect(view.actions.quote).toBe(false);
    expect(view.actions.confirm).toBe(false);
    expect(view.actions.recover).toBe(true);
  });

  test('basket completeness and draft quantity derive from draft/groups rather than DOM form values', () => {
    const state = page();
    state.draft.mixed = true;
    state.draft.items = [{ query: 'latte', quantity: 2 }, { query: 'espresso', quantity: 3 }];
    state.draft.quantity = 99;
    expect(draftQuantity(state.draft)).toBe(5);
    const candidate = state.serverSession!.candidates[0];
    state.serverSession!.candidate_groups = [{ query: 'latte', quantity: 2, candidates: [candidate] }, { query: 'espresso', quantity: 3, candidates: [{ ...candidate, entry_id: 'espresso' }] }];
    state.uiStatus.basketChoices.set(0, 'latte');
    expect(deriveViewModel(state, now).actions.basketQuote).toBe(false);
    state.uiStatus.basketChoices.set(1, 'espresso');
    state.uiStatus.basketChanged = true;
    const view = deriveViewModel(state, now);
    expect(view.actions.basketQuote).toBe(true);
    expect(view.actions.confirm).toBe(false);
    expect(view.quoteVisible).toBe(false);
    expect(view.totalQuantity).toBe(5);
  });
});
