import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DeterministicMockPlanner, FileSessionStore, FlowError, LocalMockIssuer, MOCK_ORIGIN,
  MockMerchantTransport, ShoppingCoordinator, createMockRuntime, ocpAmountToMinor, runToolLoop,
  trustedUrl, verifyLocalMockProof,
  type ApprovalClaims, type Intent, type MockOptions, type Planner, type PublicSession,
} from './index';

const intent: Intent = { query: '30 元以内一杯拿铁', items: [{ query: '30 元以内一杯拿铁', quantity: 1 }], quantity: 1, currency: 'CNY', max_total_minor: 3000, merchant_id: 'coffee-demo', fulfillment: 'pickup' };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'ocp-agent-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function setup(options: MockOptions = {}) {
  const issuer = new LocalMockIssuer(options.now);
  const merchant = new MockMerchantTransport(join(directory, 'mock'), issuer.publicKey, options);
  const store = new FileSessionStore(join(directory, 'sessions'));
  const coordinator = new ShoppingCoordinator(merchant, store, issuer, MOCK_ORIGIN, options.now);
  return { issuer, merchant, store, coordinator };
}
async function ready(coordinator: ShoppingCoordinator, entry = 'mock_latte'): Promise<PublicSession> {
  const created = await coordinator.create('alice', intent);
  await coordinator.search('alice', created.id);
  return coordinator.select('alice', created.id, entry);
}
function confirmation(session: PublicSession) {
  return { quote_id: session.quote!.quote_id, terms_hash: session.quote!.terms_hash, revision: session.revision };
}

describe('A purchase coordinator (explicit development mock)', () => {
  test('legacy merchant search remains compatible and clears an older search warning', async () => {
    const { coordinator, store, merchant } = setup();
    const created = await coordinator.create('alice', intent);
    const saved = (await store.read(created.id))!;
    saved.search_warnings = ['旧搜索结果不完整'];
    await store.write(saved);
    const searched = await coordinator.search('alice', created.id);
    expect(searched.phase).toBe('candidates');
    expect(searched.candidates.length).toBeGreaterThan(0);
    expect(searched.search_warnings).toEqual([]);
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('includes all fees, waits for explicit confirmation, separates payment from fulfillment', async () => {
    const { coordinator, merchant } = setup();
    const quoted = await ready(coordinator);
    expect(quoted.phase).toBe('awaiting_confirmation');
    expect(quoted.quote!.total_minor).toBe(2800);
    expect(quoted.quote!.fees[0]!.amount_minor).toBe(200);
    expect(merchant.checkoutCalls).toBe(0);
    const purchased = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    expect(purchased.phase).toBe('confirmed');
    expect(purchased.order!.payment_status).toBe('paid');
    expect(purchased.order!.fulfillment_status).toBe('preparing');
    expect(await merchant.diagnostics()).toEqual({ payment_count: 1, order_count: 1 });
  });
  test('sequential and concurrent duplicate confirmations retain one attempt/key/payment/order', async () => {
    const { coordinator, merchant, store } = setup();
    const quoted = await ready(coordinator);
    const results = await Promise.all(Array.from({ length: 8 }, () => coordinator.confirm('alice', quoted.id, confirmation(quoted))));
    const original = await store.read(quoted.id);
    const repeat = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    expect(new Set(results.map(result => result.order!.order_id)).size).toBe(1);
    expect(repeat.attempt!.purchase_attempt_id).toBe(original!.attempt!.purchase_attempt_id);
    expect(merchant.checkoutCalls).toBe(1);
    expect(await merchant.diagnostics()).toEqual({ payment_count: 1, order_count: 1 });
  });
  test('final fees exceeding the budget block checkout and remain visible', async () => {
    const { coordinator, merchant } = setup();
    const quote = await ready(coordinator, 'mock_special_latte');
    expect(quote.quote!.total_minor).toBe(3100);
    expect(quote.error!.code).toBe('budget_exceeded');
    expect(quote.phase).toBe('failed');
    await expect(coordinator.confirm('alice', quote.id, confirmation(quote))).rejects.toMatchObject({ code: 'invalid_state' });
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('unknown entry, stale revision, wrong hash and quote ID cannot authorize checkout', async () => {
    const { coordinator, merchant } = setup();
    const quoted = await ready(coordinator);
    await expect(coordinator.select('alice', quoted.id, 'invented_entry')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(coordinator.confirm('alice', quoted.id, { ...confirmation(quoted), revision: 0 })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(coordinator.confirm('alice', quoted.id, { ...confirmation(quoted), terms_hash: 'changed' })).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    await expect(coordinator.confirm('alice', quoted.id, { ...confirmation(quoted), quote_id: 'another' })).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('expired quote requires a new quote and explicit confirmation without purchase', async () => {
    let time = Date.now();
    const { coordinator, merchant } = setup({ now: () => time });
    const quoted = await ready(coordinator);
    time += 121_000;
    const expired = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    expect(expired.phase).toBe('requote_required');
    expect(expired.error!.code).toBe('quote_expired');
    expect(merchant.checkoutCalls).toBe(0);
    const fresh = await coordinator.select('alice', quoted.id, 'mock_latte');
    expect(fresh.quote!.quote_id).not.toBe(quoted.quote!.quote_id);
    await expect(coordinator.confirm('alice', quoted.id, confirmation(quoted))).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    expect((await coordinator.confirm('alice', quoted.id, confirmation(fresh))).phase).toBe('confirmed');
  });
  test.each(['out_of_stock', 'requote_required', 'payment_failed'] as const)('merchant %s rejection does not manufacture a successful order', async fault => {
    const { coordinator, merchant } = setup({ fault });
    const quoted = await ready(coordinator);
    const result = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    expect(result.phase).toBe(fault === 'requote_required' ? 'requote_required' : 'failed');
    expect(result.error!.code).toBe(fault);
    expect(result.order).toBeUndefined();
    expect(await merchant.diagnostics()).toEqual({ payment_count: 0, order_count: 0 });
    const duplicate = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    expect(duplicate.attempt!.purchase_attempt_id).toBe(result.attempt!.purchase_attempt_id);
    expect(merchant.checkoutCalls).toBe(1);
    const fresh = await coordinator.select('alice', quoted.id, 'mock_latte');
    expect(fresh.phase).toBe('awaiting_confirmation');
    expect(fresh.attempt).toBeUndefined();
    expect(fresh.attempt_history).toHaveLength(1);
    expect(fresh.attempt_history![0]!.purchase_attempt_id).toBe(result.attempt!.purchase_attempt_id);
    await expect(coordinator.confirm('alice', quoted.id, confirmation(quoted))).rejects.toMatchObject({ code: 'confirmation_mismatch' });
  });
  test('lost success response recovers the original order after runtime restart, without repurchasing', async () => {
    const { coordinator, merchant } = setup({ fault: 'response_lost' });
    const quoted = await ready(coordinator);
    const unknown = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    expect(unknown.phase).toBe('unknown');
    expect(unknown.attempt!.status).toBe('processing');
    const restarted = await createMockRuntime(directory);
    const recovered = await restarted.recover('alice', quoted.id);
    expect(recovered.phase).toBe('confirmed');
    expect(recovered.attempt!.purchase_attempt_id).toBe(unknown.attempt!.purchase_attempt_id);
    expect((await restarted.confirm('alice', quoted.id, confirmation(quoted))).order!.order_id).toBe(recovered.order!.order_id);
    expect(merchant.checkoutCalls).toBe(1);
    expect(await merchant.diagnostics()).toEqual({ payment_count: 1, order_count: 1 });
  });
  test('persisted pending attempt with no merchant result stays unknown and never retries', async () => {
    const { coordinator, merchant, store } = setup();
    const quoted = await ready(coordinator);
    const saved = (await store.read(quoted.id))!;
    saved.attempt = { purchase_attempt_id: 'attempt_crash', idempotency_key: 'original_key', status: 'processing' };
    saved.phase = 'checkout_pending'; await store.write(saved);
    const restarted = await createMockRuntime(directory);
    expect((await restarted.get('alice', quoted.id)).phase).toBe('unknown');
    expect((await restarted.recover('alice', quoted.id)).phase).toBe('unknown');
    expect((await restarted.confirm('alice', quoted.id, confirmation(quoted))).attempt!.purchase_attempt_id).toBe('attempt_crash');
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('processing response remains unknown during recovery', async () => {
    const { coordinator, merchant } = setup({ fault: 'processing' });
    const quoted = await ready(coordinator);
    expect((await coordinator.confirm('alice', quoted.id, confirmation(quoted))).phase).toBe('unknown');
    expect((await coordinator.recover('alice', quoted.id)).phase).toBe('unknown');
    expect(await merchant.diagnostics()).toEqual({ payment_count: 0, order_count: 0 });
  });
  test('malformed failure error stays unknown with redacted protocol diagnostics and original attempt', async () => {
    const { coordinator, merchant, store } = setup();
    const quoted = await ready(coordinator);
    merchant.checkout = async input => ({ purchase_attempt_id: input.purchase_attempt_id, status: 'failed',
      error: { code: 42, message: { signature: 'secret-proof' } } } as never);
    const unknown = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    expect(unknown.phase).toBe('unknown');
    expect(unknown.error!.code).toBe('result_unknown');
    expect(unknown.diagnostic!.category).toBe('protocol');
    const saved = await store.read(quoted.id);
    expect(saved!.attempt!.status).toBe('processing');
    expect(JSON.stringify(saved)).not.toContain('secret-proof');
    await expect(coordinator.select('alice', quoted.id, 'mock_latte')).rejects.toMatchObject({ code: 'invalid_state' });
    const recovered = await coordinator.recover('alice', quoted.id);
    expect(recovered.phase).toBe('unknown');
    expect(recovered.diagnostic!.category).toBe('not_found');
    expect(recovered.attempt!.purchase_attempt_id).toBe(unknown.attempt!.purchase_attempt_id);
  });
  test('idempotency conflict cannot unlock a new key or silently repurchase', async () => {
    const { coordinator, merchant } = setup();
    const quoted = await ready(coordinator);
    merchant.checkout = async () => { throw new FlowError('idempotency_conflict', 'conflict'); };
    const unknown = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    expect(unknown.phase).toBe('unknown');
    await expect(coordinator.search('alice', quoted.id)).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(coordinator.cancel('alice', quoted.id)).rejects.toMatchObject({ code: 'invalid_state' });
    expect((await coordinator.confirm('alice', quoted.id, confirmation(quoted))).attempt!.purchase_attempt_id)
      .toBe(unknown.attempt!.purchase_attempt_id);
  });
  test('confirmed merchant attempt cannot regress into a failure that unlocks repurchase', async () => {
    const { coordinator, merchant } = setup();
    const quoted = await ready(coordinator);
    const paid = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    merchant.getAttempt = async (_user, attempt) => ({ purchase_attempt_id: attempt, status: 'failed',
      error: { code: 'payment_failed', message: 'declined' } });
    const result = await coordinator.recover('alice', quoted.id);
    expect(result.phase).toBe('unknown');
    expect(result.order).toBeUndefined();
    expect(result.attempt!.status).toBe('confirmed');
    expect(result.attempt!.purchase_attempt_id).toBe(paid.attempt!.purchase_attempt_id);
    await expect(coordinator.select('alice', quoted.id, 'mock_latte')).rejects.toMatchObject({ code: 'invalid_state' });
  });
  test('an order-query authorization failure after confirmed checkout still locks the original purchase', async () => {
    const { coordinator, merchant } = setup();
    const quoted = await ready(coordinator);
    merchant.getOrder = async () => { throw new FlowError('unauthorized', 'denied order query'); };
    const result = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    expect(result.phase).toBe('unknown');
    expect(result.attempt!.status).toBe('confirmed');
    await expect(coordinator.search('alice', quoted.id)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await merchant.diagnostics()).toEqual({ payment_count: 1, order_count: 1 });
  });
  test('unknown purchase blocks another same-user session, including across runtime restart', async () => {
    const { coordinator, merchant } = setup({ fault: 'response_lost' });
    const first = await ready(coordinator);
    const second = await ready(coordinator);
    expect((await coordinator.confirm('alice', first.id, confirmation(first))).phase).toBe('unknown');
    await expect(coordinator.create('alice', intent)).rejects.toMatchObject({ code: 'unresolved_purchase' });
    await expect(coordinator.confirm('alice', second.id, confirmation(second))).rejects.toMatchObject({ code: 'unresolved_purchase' });
    await expect(coordinator.cancel('alice', second.id)).rejects.toMatchObject({ code: 'unresolved_purchase' });
    expect((await coordinator.get('alice', second.id)).phase).toBe('awaiting_confirmation');
    const restarted = await createMockRuntime(directory);
    await expect(restarted.create('alice', intent)).rejects.toMatchObject({ code: 'unresolved_purchase' });
    await expect(restarted.cancel('alice', second.id)).rejects.toMatchObject({ code: 'unresolved_purchase' });
    const pending = await restarted.listPending('alice');
    expect(pending.map(session => session.id)).toEqual([first.id]);
    expect(pending[0]!.attempt!.purchase_attempt_id).toBe((await coordinator.get('alice', first.id)).attempt!.purchase_attempt_id);
    expect(await restarted.listPending('bob')).toEqual([]);
    for (const secret of ['user_id', 'idempotency_key', 'authorization_proof', 'checkout_url']) {
      expect(JSON.stringify(pending)).not.toContain(secret);
    }
    expect((await restarted.recover('alice', first.id)).phase).toBe('confirmed');
    expect(await restarted.listPending('alice')).toEqual([]);
    expect((await restarted.cancel('alice', second.id)).phase).toBe('cancelled');
    expect((await restarted.create('alice', intent)).phase).toBe('new');
    expect(await merchant.diagnostics()).toEqual({ payment_count: 1, order_count: 1 });
  });
  test('pending lookup retains a persisted pre-response attempt without reissuing checkout', async () => {
    const { coordinator, store, merchant } = setup();
    const quoted = await ready(coordinator);
    const saved = (await store.read(quoted.id))!;
    saved.phase = 'checkout_pending';
    saved.attempt = { purchase_attempt_id: 'attempt_before_crash', idempotency_key: 'private_stable_key', status: 'processing' };
    await store.write(saved);
    const pending = await coordinator.listPending('alice');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempt).toEqual({ purchase_attempt_id: 'attempt_before_crash', status: 'processing' });
    expect((await store.read(quoted.id))!.attempt).toEqual(saved.attempt);
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('pre-checkout outages suggest retrying the actual operation without inventing a purchase', async () => {
    const { coordinator, merchant } = setup();
    const selected = await ready(coordinator);
    merchant.quoteBasket = async () => { throw new Error('private network detail'); };
    const failedQuote = await coordinator.select('alice', selected.id, 'mock_latte');
    expect(failedQuote.error).toEqual({ code: 'unavailable', message: '报价服务暂时不可用，请重试。' });
    expect(failedQuote.attempt).toBeUndefined();
    merchant.search = async () => { throw new Error('private network detail'); };
    const failedSearch = await coordinator.search('alice', selected.id);
    expect(failedSearch.error).toEqual({ code: 'unavailable', message: '目录服务暂时不可用，请重试。' });
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('pre-checkout transport faults keep their codes while directing users to retry search or quote', async () => {
    const { coordinator, merchant } = setup();
    const selected = await ready(coordinator);
    for (const code of ['network_error', 'timeout', 'protocol_error', 'catalog_unavailable', 'merchant_unavailable']) {
      const fault = new FlowError(code, '请查询原购买尝试。', 503);
      merchant.quoteBasket = async () => { throw fault; };
      const failedQuote = await coordinator.select('alice', selected.id, 'mock_latte');
      expect(failedQuote.error).toEqual({ code, message: '报价服务暂时不可用，请重试。' });
      expect(failedQuote.attempt).toBeUndefined();
      merchant.search = async () => { throw fault; };
      const failedSearch = await coordinator.search('alice', selected.id);
      expect(failedSearch.error).toEqual({ code, message: '目录服务暂时不可用，请重试。' });
      expect(failedSearch.attempt).toBeUndefined();
      expect(fault).toMatchObject({ code, status: 503 });
    }
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('health inspection distinguishes an explicit mock and a failing merchant probe', async () => {
    const { coordinator, merchant } = setup();
    expect(await coordinator.inspectHealth()).toMatchObject({ mode: 'mock', status: 'simulated', ready: true });
    Object.assign(merchant, { health: async () => ({ status: 'degraded', ready: false, checked_at: new Date().toISOString() }) });
    expect(await coordinator.inspectHealth()).toMatchObject({ mode: 'mock', status: 'degraded', ready: false });
    const httpMerchant = { ...merchant, mode: 'http' as const, health: async () => { throw new Error('private merchant URL'); },
      search: merchant.search.bind(merchant), resolve: merchant.resolve.bind(merchant), quote: merchant.quote.bind(merchant),
      checkout: merchant.checkout.bind(merchant), getAttempt: merchant.getAttempt.bind(merchant), getOrder: merchant.getOrder.bind(merchant) };
    const unavailable = new ShoppingCoordinator(httpMerchant, new FileSessionStore(join(directory, 'other-sessions')), new LocalMockIssuer(), MOCK_ORIGIN);
    expect(await unavailable.inspectHealth()).toMatchObject({ mode: 'http', status: 'unavailable', ready: false });
    expect(JSON.stringify(await unavailable.inspectHealth())).not.toContain('private merchant URL');
  });
  test('persistent scope refuses switching backend mode or origin while allowing same-scope restart', async () => {
    const runtime = await createMockRuntime(directory);
    const quoted = await ready(runtime);
    const store = new FileSessionStore(join(directory, 'sessions'));
    await expect(store.bindScope({ mode: 'http', origin: 'http://127.0.0.1:4401',
      merchant_id: 'merchant_coffee_demo', catalog_id: 'catalog_coffee_demo' })).rejects.toThrow('不同模式');
    await expect(store.bindScope({ mode: 'mock', origin: 'http://127.0.0.1:9999',
      merchant_id: 'coffee-demo', catalog_id: 'mock_coffee_catalog' })).rejects.toThrow('不同模式');
    await expect(store.bindScope({ mode: 'mock', origin: MOCK_ORIGIN,
      merchant_id: 'coffee-demo', catalog_id: 'other_catalog' })).rejects.toThrow('不同模式');
    await expect(store.bindScope({ mode: 'mock', origin: MOCK_ORIGIN,
      merchant_id: 'other_merchant', catalog_id: 'mock_coffee_catalog' })).rejects.toThrow('不同模式');
    const restarted = await createMockRuntime(directory);
    expect((await restarted.get('alice', quoted.id)).quote!.quote_id).toBe(quoted.quote!.quote_id);
  });
  test('foreign users cannot inspect, confirm, recover or cancel another user session', async () => {
    const { coordinator } = setup();
    const quoted = await ready(coordinator);
    for (const action of [
      () => coordinator.get('bob', quoted.id), () => coordinator.confirm('bob', quoted.id, confirmation(quoted)),
      () => coordinator.recover('bob', quoted.id), () => coordinator.cancel('bob', quoted.id),
    ]) await expect(action()).rejects.toMatchObject({ code: 'not_found' });
  });
  test('cancel prevents confirmation and search', async () => {
    const { coordinator, merchant } = setup();
    const quoted = await ready(coordinator);
    expect((await coordinator.cancel('alice', quoted.id)).phase).toBe('cancelled');
    await expect(coordinator.confirm('alice', quoted.id, confirmation(quoted))).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(coordinator.search('alice', quoted.id)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('public state and persisted local data contain no usable authorization proof or private key', async () => {
    const { coordinator } = setup();
    const quoted = await ready(coordinator);
    const purchased = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    const publicText = JSON.stringify(purchased);
    for (const prohibited of ['authorization_proof', 'privateKey', 'local-mock-v1.', 'idempotency_key', 'user_id']) {
      expect(publicText.includes(prohibited)).toBe(false);
    }
    const sessionFiles = await readdir(join(directory, 'sessions'));
    const persisted = (await Promise.all(sessionFiles.map(name => readFile(join(directory, 'sessions', name), 'utf8')))).join('')
      + await readFile(join(directory, 'mock', 'mock-transport.json'), 'utf8');
    expect(persisted.includes('local-mock-v1.')).toBe(false);
    expect(persisted.includes('PRIVATE KEY')).toBe(false);
    expect(persisted.includes('authorization_proof')).toBe(false);
  });
  test('integer money conversion rejects sub-cent precision and unsafe budgets', async () => {
    expect(ocpAmountToMinor(26.1)).toBe(2610);
    expect(() => ocpAmountToMinor(26.001)).toThrow(FlowError);
    expect(() => ocpAmountToMinor(Infinity)).toThrow(FlowError);
    await expect(setup().coordinator.create('alice', { ...intent, max_total_minor: 30.5 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(setup().coordinator.create('alice', { ...intent, quantity: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
  });
  test('checkout URL rejects credentials, foreign origin, redirect-like query and wrong path', () => {
    expect(trustedUrl(`${MOCK_ORIGIN}/commerce/v1/checkouts`, MOCK_ORIGIN, ['/commerce/v1/checkouts'])).toContain('/checkouts');
    for (const url of ['https://evil.example/commerce/v1/checkouts', `${MOCK_ORIGIN}/elsewhere`,
      'http://secret@127.0.0.1:4401/commerce/v1/checkouts', `${MOCK_ORIGIN}/commerce/v1/checkouts?redirect=evil`]) {
      expect(() => trustedUrl(url, MOCK_ORIGIN, ['/commerce/v1/checkouts'])).toThrow(FlowError);
    }
  });
  test('coordinator blocks an untrusted resolved endpoint before requesting a quote or signing', async () => {
    const { coordinator, merchant } = setup();
    let quoteCalls = 0;
    const originalQuote = merchant.quoteBasket.bind(merchant);
    merchant.quoteBasket = async (...args) => { quoteCalls += 1; return originalQuote(...args); };
    merchant.resolve = async () => ({ checkout_url: 'https://evil.example/commerce/v1/checkouts', expires_at: new Date(Date.now() + 10000).toISOString() });
    const result = await ready(coordinator);
    expect(result.phase).toBe('failed');
    expect(result.error!.code).toBe('untrusted_endpoint');
    expect(quoteCalls).toBe(0);
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('inconsistent merchant quote is rejected, and an inconsistent returned order remains unknown', async () => {
    const { coordinator, merchant } = setup();
    const originalQuote = merchant.quoteBasket.bind(merchant);
    merchant.quoteBasket = async (...args) => ({ ...await originalQuote(...args), total_minor: 1 });
    const invalid = await ready(coordinator);
    expect(invalid.phase).toBe('failed'); expect(invalid.error!.code).toBe('invalid_quote');
    expect(merchant.checkoutCalls).toBe(0);
    merchant.quoteBasket = originalQuote;
    const quoted = await coordinator.select('alice', invalid.id, 'mock_latte');
    const originalOrder = merchant.getOrder.bind(merchant);
    merchant.getOrder = async (...args) => ({ ...await originalOrder(...args), total_minor: 1 });
    const unknown = await coordinator.confirm('alice', quoted.id, confirmation(quoted));
    expect(unknown.phase).toBe('unknown'); expect(unknown.order).toBeUndefined();
    merchant.getOrder = originalOrder;
    expect((await coordinator.recover('alice', quoted.id)).phase).toBe('confirmed');
    expect(await merchant.diagnostics()).toEqual({ payment_count: 1, order_count: 1 });
  });
});

describe('planner and authorization boundary', () => {
  test('deterministic tool loop reaches a quote, stops for the user, and never buys', async () => {
    const { coordinator, merchant } = setup();
    const created = await coordinator.create('alice', intent);
    const result = await runToolLoop(coordinator, 'alice', created.id, new DeterministicMockPlanner());
    expect(result.planner_mode).toBe('mock');
    expect(result.tool_calls).toBe(2);
    expect(result.session.phase).toBe('awaiting_confirmation');
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('model cannot create an approval or run checkout', async () => {
    const { coordinator, merchant } = setup();
    const created = await coordinator.create('alice', intent);
    const planner = { mode: 'llm', next: async () => ({ type: 'tool', tool: { name: 'checkout', approved: true } }) } as unknown as Planner;
    await expect(runToolLoop(coordinator, 'alice', created.id, planner)).rejects.toMatchObject({ code: 'invalid_tool' });
    expect(merchant.checkoutCalls).toBe(0);
  });
  test('model sees detached read models and cannot mutate the persisted budget', async () => {
    const { coordinator } = setup();
    const created = await coordinator.create('alice', intent);
    const planner: Planner = { mode: 'llm', next: async ({ session }) => {
      session.intent.max_total_minor = 999999;
      return { type: 'done' };
    } };
    await runToolLoop(coordinator, 'alice', created.id, planner);
    expect((await coordinator.get('alice', created.id)).intent.max_total_minor).toBe(3000);
  });
  test('repeated tools and unbounded planning are stopped', async () => {
    const { coordinator } = setup();
    const created = await coordinator.create('alice', intent);
    const repeat: Planner = { mode: 'mock', next: async () => ({ type: 'tool', tool: { name: 'inspect' } }) };
    await expect(runToolLoop(coordinator, 'alice', created.id, repeat)).rejects.toMatchObject({ code: 'repeated_tool' });
    await expect(runToolLoop(coordinator, 'alice', created.id, repeat, { maxSteps: 1 })).rejects.toMatchObject({ code: 'tool_limit' });
    const hang: Planner = { mode: 'mock', next: () => new Promise(() => {}) };
    await expect(runToolLoop(coordinator, 'alice', created.id, hang, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'planner_timeout' });
  });
  test('signature verification accepts only the trusted mock key and nonexpired claims', () => {
    let time = Date.now();
    const issuer = new LocalMockIssuer(() => time);
    const claims: ApprovalClaims = {
      issuer: 'shopping-agent-local-mock', user_id: 'alice', merchant_id: 'coffee-demo', quote_id: 'quote_one',
      terms_hash: 'terms', entry_id: 'mock_latte', quantity: 1, fulfillment: 'pickup', currency: 'CNY',
      max_total_minor: 3000, purchase_attempt_id: 'attempt_one', expires_at: new Date(time + 1000).toISOString(),
    };
    const proof = issuer.issue(claims);
    expect(verifyLocalMockProof(proof, issuer.publicKey, time).purchase_attempt_id).toBe('attempt_one');
    expect(() => verifyLocalMockProof(proof, new LocalMockIssuer().publicKey, time)).toThrow(FlowError);
    expect(() => verifyLocalMockProof('approved:true', issuer.publicKey, time)).toThrow(FlowError);
    time += 1001;
    expect(() => verifyLocalMockProof(proof, issuer.publicKey, time)).toThrow(FlowError);
  });
  test('mock verification binds user, merchant, item, quantity, terms, currency and attempt', async () => {
    const { coordinator, merchant, issuer } = setup();
    const session = await ready(coordinator);
    const quote = session.quote!;
    const claims: ApprovalClaims = {
      issuer: 'shopping-agent-local-mock', user_id: 'alice', merchant_id: 'coffee-demo', quote_id: quote.quote_id,
      terms_hash: quote.terms_hash, entry_id: quote.entry_id, quantity: quote.quantity, fulfillment: 'pickup',
      currency: quote.currency, max_total_minor: 3000, purchase_attempt_id: 'attempt_bound',
      expires_at: new Date(Date.now() + 10_000).toISOString(),
    };
    const input = {
      user_id: 'alice', purchase_attempt_id: 'attempt_bound', idempotency_key: 'key_bound',
      quote_id: quote.quote_id, terms_hash: quote.terms_hash, checkout_url: `${MOCK_ORIGIN}/commerce/v1/checkouts`,
    };
    for (const change of [
      { user_id: 'bob' }, { merchant_id: 'other' }, { entry_id: 'mock_espresso' }, { quantity: 2 },
      { terms_hash: 'changed' }, { currency: 'USD' }, { purchase_attempt_id: 'another' },
    ]) {
      await expect(merchant.checkout({ ...input, authorization_proof: issuer.issue({ ...claims, ...change }) })).rejects.toMatchObject({ code: 'authorization_invalid' });
    }
    const proof = issuer.issue(claims);
    const result = await merchant.checkout({ ...input, authorization_proof: proof });
    expect(result.status).toBe('confirmed');
    await expect(merchant.checkout({ ...input, purchase_attempt_id: 'attempt_replay', idempotency_key: 'new_key', authorization_proof: proof })).rejects.toMatchObject({ code: 'authorization_invalid' });
    await expect(merchant.checkout({ ...input, terms_hash: 'changed', authorization_proof: proof })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await merchant.diagnostics()).toEqual({ payment_count: 1, order_count: 1 });
    await expect(merchant.getOrder('bob', result.order_id!)).rejects.toMatchObject({ code: 'not_found' });
    await expect(merchant.getAttempt('bob', result.purchase_attempt_id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
