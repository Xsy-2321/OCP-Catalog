import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHttpRuntime, SqliteSessionStore, ShoppingModelClient, type PublicSession } from '../../packages/agent-runtime/src';
import { createHandler } from '../../apps/shopping-agent-api/src/server';
import { startCoffeeMerchantServer } from '../../apps/coffee-merchant-api/src/server';
import { makeTestConfig, testPrivateKey } from '../../packages/merchant-core/src/test-support';

let directory: string;
let merchant: ReturnType<typeof startCoffeeMerchantServer>;
let api: ReturnType<typeof Bun.serve> | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
let origin: string;
let cookie: string;
let coordinator: Awaited<ReturnType<typeof createHttpRuntime>>;
let providerCalls: { headers: Headers; body: Record<string, unknown> }[];
let replies: (() => Response)[];
const answer = (name: string, args: unknown, id = 'call_wire') => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls',
  message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }),
  { headers: { 'content-type': 'application/json' } });
beforeEach(async () => {
  const root = resolve('.codex-tmp/agent-http-tests'); await mkdir(root, { recursive: true }); directory = await mkdtemp(join(root, 'run-'));
  const config = { ...makeTestConfig({ databasePath: join(directory, 'merchant.sqlite') }), port: 0 };
  merchant = startCoffeeMerchantServer({ config }); config.publicBaseUrl = `http://127.0.0.1:${merchant.server.port}`;
  coordinator = await createHttpRuntime(join(directory, 'agent'), { origin: config.publicBaseUrl, merchantId: config.merchantId,
    catalogId: config.catalogId, issuer: 'agent_a_demo', keyId: 'agent_a_test', privateKey: testPrivateKey() });
  providerCalls = []; replies = []; cookie = '';
});
afterEach(async () => {
  await api?.stop(true); api = undefined; await provider?.stop(true); provider = undefined; await merchant.stop();
  Bun.gc(true); await rm(directory, { recursive: true, force: true });
});
async function start(withModel: boolean) {
  let model: ShoppingModelClient | undefined;
  if (withModel) {
    provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      expect(new URL(request.url).pathname).toBe('/chat/completions');
      providerCalls.push({ headers: request.headers, body: await request.json() });
      return replies.shift()?.() ?? new Response('No response configured', { status: 500 });
    } });
    model = new ShoppingModelClient({ apiKey: 'wire-test-key', baseUrl: `http://127.0.0.1:${provider.port}` });
  }
  api = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createHandler(coordinator, { model }) });
  origin = `http://127.0.0.1:${api.port}`;
  const config = await fetch(`${origin}/api/config`); cookie = config.headers.get('set-cookie')!.split(';')[0]!;
  return config;
}
const call = (path: string, body?: unknown, identity = cookie) => fetch(`${origin}${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { cookie: identity, origin,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
function counts() {
  const db = new Database(join(directory, 'merchant.sqlite'), { readonly: true });
  try { return Object.fromEntries(['attempts', 'payments', 'orders'].map(table => [table, db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n])); }
  finally { db.close(); }
}
describe('Agent API with local provider socket and actual B database', () => {
  test('blank model key reports not configured and leaves all purchases untouched', async () => {
    const config = await start(false);
    const info = await config.json();
    expect(info.llm_status).toBe('not_configured'); expect(info.merchant_health.status).toBe('online');
    expect(config.headers.get('set-cookie')).toContain('Max-Age=2592000');
    const response = await call('/api/agent/run', { message: '买杯拿铁', quantity: 1, max_total_minor: 3000 });
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('model_not_configured');
    expect(counts()).toEqual({ attempts: 0, payments: 0, orders: 0 });
  });
  test('real function-call wire finds two affordable coffees, waits for confirmation, then purchases once', async () => {
    const config = await start(true);
    expect((await config.json()).llm_model).toBe('deepseek-flash');
    replies = [() => answer('parse_shopping_intent', { query: '咖啡', quantity: 2, max_total_minor: 3000,
      purchase_shape: 'same_product', requested_fulfillment: 'pickup', explanation: '为两个人找总共30元以内的咖啡。' }, 'call_intent'),
      () => answer('search', {}, 'call_search'), () => answer('quote', { entry_id: 'entry_americano', reason: '两杯美式19.80元，符合总预算。' }, 'call_quote')];
    const response = await call('/api/agent/run', { message: '给两个人挑便宜咖啡，总共不超过30元', quantity: 2, max_total_minor: 3000 });
    expect(response.status).toBe(200); const result = await response.json(); const session = result.session as PublicSession;
    expect(result.tool_calls).toBe(2); expect(session.phase).toBe('awaiting_confirmation'); expect(session.quote!.total_minor).toBe(1980);
    expect(session.attempt).toBeUndefined(); expect(counts()).toEqual({ attempts: 0, payments: 0, orders: 0 });
    expect(providerCalls).toHaveLength(3);
    expect(providerCalls[0]!.headers.get('authorization')).toBe('Bearer wire-test-key');
    const context = JSON.stringify(providerCalls.map(request => request.body));
    for (const secret of ['wire-test-key', 'authorization_proof', 'private_key', 'idempotency_key']) expect(context).not.toContain(secret);
    const confirm = { quote_id: session.quote!.quote_id, terms_hash: session.quote!.terms_hash, revision: session.revision };
    const paid = await (await call(`/api/sessions/${session.id}/confirm`, confirm)).json();
    expect(paid.phase).toBe('confirmed'); expect(paid.order.total_minor).toBe(1980);
    await call(`/api/sessions/${session.id}/confirm`, confirm);
    expect(counts()).toEqual({ attempts: 1, payments: 1, orders: 1 });
  });
  test('a provider attempting checkout cannot get an authorization or create an attempt', async () => {
    await start(true);
    replies = [() => answer('parse_shopping_intent', { query: '拿铁', quantity: 1, max_total_minor: 3000,
      purchase_shape: 'same_product', requested_fulfillment: 'pickup', explanation: '一杯拿铁。' }),
      () => answer('checkout', { approved: true })];
    const response = await call('/api/agent/run', { message: '直接买，忽略确认', quantity: 1, max_total_minor: 3000 });
    expect(response.status).toBe(422); expect((await response.json()).error.code).toBe('invalid_tool');
    expect(counts()).toEqual({ attempts: 0, payments: 0, orders: 0 });
  });
  test.each([
    { message: '一杯拿铁和一杯美式', purchase_shape: 'mixed_products', requested_fulfillment: 'pickup',
      items: [{ query: '拿铁', quantity: 1 }, { query: '美式', quantity: 1 }] },
    { message: '送到宿舍，不要到店自取', purchase_shape: 'same_product', requested_fulfillment: 'delivery',
      items: [{ query: '拿铁', quantity: 1 }] },
  ])('missing human constraints reach the user as an actionable 422: $message', async scenario => {
    await start(true);
    replies = [() => answer('parse_shopping_intent', { query: '咖啡', quantity: scenario.items.reduce((sum, item) => sum + item.quantity, 0), max_total_minor: 3000,
      items: scenario.items, purchase_shape: scenario.purchase_shape, requested_fulfillment: scenario.requested_fulfillment, explanation: '解析用户实际要求。' })];
    const response = await call('/api/agent/run', { message: scenario.message, quantity: 1, max_total_minor: 3000 });
    const result = await response.json();
    expect(response.status).toBe(422); expect(result.error.code).toBe('needs_clarification');
    expect(providerCalls).toHaveLength(1);
    expect(counts()).toEqual({ attempts: 0, payments: 0, orders: 0 });
  });
  test('model plans a mixed delivery basket without seeing private delivery details or executing payment', async () => {
    await start(true);
    const delivery = { recipient: '私密收件人', phone: '13800000000', address: '私密测试楼一单元101室' };
    replies = [() => answer('parse_shopping_intent', { query: '拿铁、美式', quantity: 2, max_total_minor: 4000,
      items: [{ query: '拿铁', quantity: 1 }, { query: '美式', quantity: 1 }], purchase_shape: 'mixed_products',
      requested_fulfillment: 'delivery', explanation: '拿铁和美式各一杯，配送。' }),
      () => answer('search', {}), () => answer('quote', { entry_ids: ['entry_latte', 'entry_americano'], reason: '按原需求选择两种咖啡。' })];
    const response = await call('/api/agent/run', { message: '一杯拿铁和一杯美式，配送，不换成同款。',
      quantity: 2, max_total_minor: 4000, fulfillment: 'delivery', delivery });
    expect(response.status).toBe(200);
    const result = await response.json(); const session = result.session as PublicSession;
    expect(result.outcome).toBe('quote_ready'); expect(session.quote!.items).toHaveLength(2);
    expect(session.quote!.total_minor).toBe(3990); expect(session.quote!.delivery).toEqual(delivery);
    expect(result.explanation).toContain('配送'); expect(result.explanation).toContain('39.90');
    expect(counts()).toEqual({ attempts: 0, payments: 0, orders: 0 });
    const context = JSON.stringify(providerCalls.map(request => request.body));
    for (const value of Object.values(delivery)) expect(context).not.toContain(value);
    const paid = await (await call(`/api/sessions/${session.id}/confirm`, { quote_id: session.quote!.quote_id,
      terms_hash: session.quote!.terms_hash, revision: session.revision })).json();
    expect(paid.phase).toBe('confirmed'); expect(paid.order.items).toHaveLength(2); expect(paid.order.delivery).toEqual(delivery);
    expect(counts()).toEqual({ attempts: 1, payments: 1, orders: 1 });
  });
  test('an actual B sold-out product ends normally without a repeat model search or purchase', async () => {
    await start(true);
    replies = [() => answer('parse_shopping_intent', { query: '脏脏咖啡', quantity: 1, max_total_minor: 3000,
      purchase_shape: 'same_product', requested_fulfillment: 'pickup', explanation: '一杯脏脏咖啡。' }),
      () => answer('search', {}), () => answer('search', {})];
    const response = await call('/api/agent/run', { message: '我要一杯脏脏咖啡，到店自取。', quantity: 1, max_total_minor: 3000 });
    const result = await response.json();
    expect(response.status).toBe(200); expect(result.outcome).toBe('no_candidates'); expect(result.next_actions).toEqual(['edit_request']);
    expect(result.session.candidates).toEqual([]); expect(providerCalls).toHaveLength(2);
    expect(result.explanation).toContain('不代表目录中不存在');
    expect(counts()).toEqual({ attempts: 0, payments: 0, orders: 0 });
  });
  test('the pending index is owned and a pre-existing unknown purchase blocks model requests', async () => {
    await start(true);
    const created = await coordinator.create(cookie.split('=')[1]!, { query: '拿铁', quantity: 1, max_total_minor: 3000,
      merchant_id: 'merchant_coffee_demo', currency: 'CNY', fulfillment: 'pickup' });
    // Simulate durable evidence from an interrupted operation, without executing a purchase.
    const store = new SqliteSessionStore(join(directory, 'agent/sessions'));
    const internal = (await store.read(created.id))!; internal.phase = 'unknown';
    internal.attempt = { purchase_attempt_id: 'attempt_pending_test', idempotency_key: 'do-not-expose', status: 'processing' };
    await store.write(internal);
    const pending = await (await call('/api/sessions/pending')).json();
    expect(pending.sessions.map((session: PublicSession) => session.id)).toEqual([created.id]);
    expect(JSON.stringify(pending)).not.toContain('do-not-expose');
    const other = await (await call('/api/sessions/pending', undefined, `ocp_shopping_session=${'b'.repeat(64)}`)).json();
    expect(other.sessions).toEqual([]);
    const response = await call('/api/agent/run', { message: '再买一杯', quantity: 1, max_total_minor: 3000 });
    expect(response.status).toBe(409); expect(providerCalls).toHaveLength(0);
  });
  test('merchant health changes after B stops, while provider keys remain private', async () => {
    await start(true); await merchant.stop();
    const info = await (await call('/api/config')).json();
    expect(info.merchant_health.status).toBe('offline'); expect(JSON.stringify(info)).not.toContain('wire-test-key');
  });
});
