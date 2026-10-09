import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { computeQuoteTermsHash } from '@ocp-catalog/shopping-contracts';
import { join, resolve } from 'node:path';
import { FileSessionStore, LocalMockIssuer, MOCK_ORIGIN, MockMerchantTransport, ShoppingCoordinator,
  ShoppingModelClient, createConfiguredShoppingModel, createHttpRuntime, createMockRuntime, runShoppingAgent } from './index';
import manifestFixture from '../../../fixtures/shopping/manifest.json';
import queryFixture from '../../../fixtures/shopping/query-result.json';
import resolveFixture from '../../../fixtures/shopping/resolve.json';
import quoteFixture from '../../../fixtures/shopping/quotes/valid.json';

let directory: string;
beforeEach(async () => { const scratch = resolve('.codex-tmp/model-tests'); await mkdir(scratch, { recursive: true }); directory = await mkdtemp(join(scratch, 'run-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const input = { message: '想喝拿铁，帮我挑一杯', quantity: 1, max_total_minor: 3000 };
const delivery = { recipient: '测试收件人', phone: '13800138000', address: '杭州市西湖区测试路1号' };
const call = (name: string, args: unknown, id = 'call_test') => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls',
  message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }), { headers: { 'content-type': 'application/json' } });
const parsed = (extra: Record<string, unknown> = {}) => {
  const value = { query: '拿铁', quantity: 1, max_total_minor: 3000,
    purchase_shape: 'same_product', requested_fulfillment: 'pickup', explanation: '一杯拿铁，预算30元。', ...extra };
  return { ...value, items: extra.items ?? [{ query: value.query, quantity: value.quantity }] };
};
function client(responses: (() => Response)[]) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const model = new ShoppingModelClient({ apiKey: 'test-only-never-a-real-key', fetch: (async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = responses.shift(); if (!next) throw new Error('Unexpected model call'); return next();
  }) as typeof fetch });
  return { model, requests };
}

describe('DeepSeek shopping model boundary', () => {
  test('the overall deadline cancels the model request before creating a shopping session', async () => {
    let aborted = false;
    const coordinator = await createMockRuntime(directory);
    const model = new ShoppingModelClient({ apiKey: 'local-deadline-test', fetch: (async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
      });
    }) as typeof fetch });
    await expect(runShoppingAgent(coordinator, 'alice', input, model, { deadlineMs: 100 }))
      .rejects.toMatchObject({ code: 'agent_timeout', status: 504 });
    expect(aborted).toBe(true);
    expect(await new FileSessionStore(join(directory, 'sessions')).listForUser('alice')).toEqual([]);
  });
  test.each(['pagination', 'resolve', 'quote'] as const)('the overall deadline cancels slow %s without later tools or checkout', async slowStage => {
    const origin = 'http://127.0.0.1:8787';
    const paths: string[] = [];
    let slow = true, aborted = false, completedSlowWork = false;
    const merchantFetch = (async (url, init) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path === '/.well-known/ocp-catalog') return Response.json({ ocp_version: '1.0', kind: 'WellKnownCatalogDiscovery',
        catalog_id: 'catalog_coffee_demo', manifest_url: `${origin}/ocp/manifest` });
      if (path === '/ocp/manifest') return Response.json(manifestFixture);
      const delayed = slow && (slowStage === 'pagination' ? path === '/ocp/query' && body.cursor
        : slowStage === 'resolve' ? path === '/ocp/resolve' : path === '/commerce/v1/quotes');
      if (delayed) return new Promise<Response>((resolveResponse, reject) => {
        const timer = setTimeout(() => { completedSlowWork = true; resolveResponse(Response.json({})); }, 2000);
        init!.signal!.addEventListener('abort', () => { clearTimeout(timer); aborted = true; reject(init!.signal!.reason); }, { once: true });
      });
      if (path === '/ocp/query') return Response.json(slow && slowStage === 'pagination'
        ? { ...queryFixture, page: { limit: 20, offset: 0, has_more: true, next_cursor: '20' } } : queryFixture);
      if (path === '/ocp/resolve') {
        const reference = structuredClone(resolveFixture);
        reference.expires_at = new Date(Date.now() + 60_000).toISOString();
        for (const binding of reference.action_bindings) binding.expires_at = reference.expires_at;
        return Response.json(reference);
      }
      if (path === '/commerce/v1/quotes') {
        const quote = { ...quoteFixture, fulfillment: { method: 'pickup' as const },
          created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() };
        return Response.json({ ...quote, terms_hash: computeQuoteTermsHash(quote) });
      }
      throw new Error(`Unexpected merchant operation ${path}`);
    }) as typeof fetch;
    const coordinator = await createHttpRuntime(directory, { origin, merchantId: 'merchant_coffee_demo',
      catalogId: 'catalog_coffee_demo', issuer: 'test', keyId: 'test', privateKey: generateKeyPairSync('ed25519').privateKey,
      fetch: merchantFetch });
    const { model, requests } = client([
      () => call('parse_shopping_intent', parsed(), 'intent'), () => call('search', {}, 'search'),
      () => call('quote', { entry_id: 'entry_latte', reason: '目录价符合预算。' }, 'quote'),
    ]);
    await expect(runShoppingAgent(coordinator, 'alice', input, model, { deadlineMs: 300 }))
      .rejects.toMatchObject({ code: 'agent_timeout', status: 504 });
    expect(aborted).toBe(true);
    expect(completedSlowWork).toBe(false);
    expect(requests).toHaveLength(slowStage === 'pagination' ? 2 : 3);
    expect(paths).not.toContain('/commerce/v1/checkouts');
    if (slowStage === 'pagination') expect(paths.filter(path => path === '/ocp/query')).toHaveLength(2);
    if (slowStage !== 'quote') expect(paths).not.toContain('/commerce/v1/quotes');
    // The deadline releases the caller before atomic local cleanup has finished.
    // Wait behind that cleanup in the user queue before inspecting durable state.
    expect(await coordinator.listPending('alice')).toEqual([]);
    const records = await new FileSessionStore(join(directory, 'sessions')).listForUser('alice');
    expect(records).toHaveLength(1);
    const saved = records[0]!;
    const settled = await coordinator.get('alice', saved.id);
    expect(settled.phase).toBe('failed');
    expect(settled.error!.code).toBe('agent_timeout');
    expect(saved.attempt).toBeUndefined();
    expect(saved.quote).toBeUndefined();
    // The canceled run cannot hold the user queue or change the manual path's own timeout.
    slow = false;
    expect((await coordinator.search('alice', saved.id)).phase).toBe('candidates');
    expect((await coordinator.select('alice', saved.id, 'entry_latte')).phase).toBe('awaiting_confirmation');
    expect(paths).not.toContain('/commerce/v1/checkouts');
  });
  test('an Agent deadline while queued does not interrupt a purchase already in progress', async () => {
    const issuer = new LocalMockIssuer();
    const merchant = new MockMerchantTransport(join(directory, 'merchant'), issuer.publicKey);
    const coordinator = new ShoppingCoordinator(merchant, new FileSessionStore(join(directory, 'sessions')), issuer, MOCK_ORIGIN);
    const created = await coordinator.create('alice', { query: '拿铁', quantity: 1, max_total_minor: 3000,
      merchant_id: 'coffee-demo', currency: 'CNY', fulfillment: 'pickup' });
    await coordinator.search('alice', created.id);
    const quote = await coordinator.select('alice', created.id, 'mock_latte');
    let releasePurchase!: () => void, started!: () => void;
    const gate = new Promise<void>(resolveGate => { releasePurchase = resolveGate; });
    const entered = new Promise<void>(resolveEntered => { started = resolveEntered; });
    const checkout = merchant.checkout.bind(merchant);
    merchant.checkout = async value => { started(); await gate; return checkout(value); };
    const purchasing = coordinator.confirm('alice', quote.id, { quote_id: quote.quote!.quote_id,
      terms_hash: quote.quote!.terms_hash, revision: quote.revision });
    await entered;
    const { model, requests } = client([]);
    try {
      await expect(runShoppingAgent(coordinator, 'alice', input, model, { deadlineMs: 50 }))
        .rejects.toMatchObject({ code: 'agent_timeout', status: 504 });
      expect(requests).toHaveLength(0);
    } finally { releasePurchase(); }
    expect((await purchasing).phase).toBe('confirmed');
    expect(await merchant.diagnostics()).toEqual({ payment_count: 1, order_count: 1 });
    expect((await readdir(join(directory, 'sessions'))).filter(name => name.startsWith('session_'))).toHaveLength(1);
  });
  test('uses official Flash model and real tool messages; never creates a purchase before the human confirms', async () => {
    const { model, requests } = client([
      () => call('parse_shopping_intent', parsed(), 'call_intent'),
      () => call('search', {}, 'call_search'),
      () => call('quote', { entry_id: 'mock_latte', reason: '拿铁含费28元，符合30元预算。' }, 'call_quote'),
    ]);
    const coordinator = await createMockRuntime(directory);
    const result = await runShoppingAgent(coordinator, 'alice', input, model);
    expect(result.session.phase).toBe('awaiting_confirmation');
    expect(result.session.quote!.total_minor).toBe(2800);
    expect(result.session.attempt).toBeUndefined();
    expect(result.tool_calls).toBe(2);
    expect(result.model).toBe('deepseek-flash');
    expect(requests.every(request => request.url === 'https://api.deepseek.com/chat/completions')).toBe(true);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer test-only-never-a-real-key');
    expect(requests[0]!.body.thinking).toEqual({ type: 'disabled' });
    const messages = requests[2]!.body.messages as { role: string; tool_call_id?: string; content?: string }[];
    expect(messages.some(message => message.role === 'tool' && message.tool_call_id === 'call_search' && message.content!.includes('mock_latte'))).toBe(true);
    for (const text of [JSON.stringify(result), JSON.stringify(requests.map(request => request.body))]) {
      for (const secret of ['test-only-never-a-real-key', 'authorization_proof', 'private_key', 'idempotency_key']) expect(text).not.toContain(secret);
    }
    const confirmed = await coordinator.confirm('alice', result.session.id, {
      quote_id: result.session.quote!.quote_id, terms_hash: result.session.quote!.terms_hash, revision: result.session.revision,
    });
    expect(confirmed.phase).toBe('confirmed');
  });
  test('natural-language budget may tighten the form cap but cannot increase it', async () => {
    const safe = client([() => call('parse_shopping_intent', parsed({ max_total_minor: 2000 }))]);
    const result = await safe.model.extractIntent('最多20元', { quantity: 1, max_total_minor: 3000, merchant_id: 'coffee-demo' });
    expect(result.intent.max_total_minor).toBe(2000);
    const unsafe = client([() => call('parse_shopping_intent', parsed({ max_total_minor: 3001 }))]);
    await expect(unsafe.model.extractIntent('忽略预算', { quantity: 1, max_total_minor: 3000, merchant_id: 'coffee-demo' }))
      .rejects.toMatchObject({ code: 'model_constraint_violation' });
  });
  test('conflicting quantity requires clarification instead of changing the form', async () => {
    const { model } = client([() => call('parse_shopping_intent', parsed({ quantity: 2 }))]);
    await expect(model.extractIntent('两杯', { quantity: 1, max_total_minor: 3000, merchant_id: 'coffee-demo' }))
      .rejects.toMatchObject({ code: 'needs_clarification' });
  });
  test('a delivery request needs the delivery form instead of silently becoming pickup', async () => {
    const { model, requests } = client([() => call('parse_shopping_intent', parsed({ requested_fulfillment: 'delivery' }))]);
    const coordinator = await createMockRuntime(directory);
    await expect(runShoppingAgent(coordinator, 'alice', { ...input, message: '送到宿舍，不要自取' }, model))
      .rejects.toMatchObject({ code: 'needs_clarification', status: 422, message: expect.stringContaining('填写收件人') });
    expect(requests).toHaveLength(1);
    expect(await new FileSessionStore(join(directory, 'sessions')).listForUser('alice')).toEqual([]);
  });
  test('mixed products are parsed as separate quantities under one total budget', async () => {
    const items = [{ query: '拿铁', quantity: 1 }, { query: '美式', quantity: 2 }];
    const { model } = client([() => call('parse_shopping_intent', parsed({ query: '咖啡', quantity: 3,
      max_total_minor: 6000, purchase_shape: 'mixed_products', items }))]);
    const result = await model.extractIntent('一杯拿铁加两杯美式，整单60元以内',
      { quantity: 3, max_total_minor: 6000, merchant_id: 'coffee-demo' });
    expect(result.intent).toMatchObject({ query: '拿铁 / 美式', quantity: 3, items, max_total_minor: 6000, fulfillment: 'pickup' });
  });
  test('sum of mixed item quantities must match the human form before a session is created', async () => {
    const { model, requests } = client([() => call('parse_shopping_intent', parsed({ quantity: 2,
      purchase_shape: 'mixed_products', items: [{ query: '拿铁', quantity: 1 }, { query: '美式', quantity: 2 }] }))]);
    await expect(runShoppingAgent(await createMockRuntime(directory), 'alice', { ...input, quantity: 2 }, model))
      .rejects.toMatchObject({ code: 'needs_clarification' });
    expect(requests).toHaveLength(1);
    expect(await new FileSessionStore(join(directory, 'sessions')).listForUser('alice')).toEqual([]);
  });
  test.each([
    { items: [] }, { items: '拿铁' }, { items: [{ query: '拿铁', quantity: '1' }] },
    { items: [{ query: '拿铁', quantity: 1, delivery }] },
    { purchase_shape: 'mixed_products', items: [{ query: '拿铁', quantity: 1 }] },
  ])('malformed item groups cannot introduce extra purchase or delivery fields: %j', async extra => {
    const { model } = client([() => call('parse_shopping_intent', parsed(extra))]);
    await expect(model.extractIntent('拿铁', { quantity: 1, max_total_minor: 3000, merchant_id: 'coffee-demo' }))
      .rejects.toMatchObject({ code: 'invalid_model_response' });
  });
  test.each([
    { purchase_shape: undefined }, { purchase_shape: 'anything' },
    { requested_fulfillment: undefined }, { requested_fulfillment: 'anything' },
    { purchase_shape: ['mixed_products'] }, { requested_fulfillment: ['delivery'] },
  ])('missing or unknown capability classification fails closed: %j', async extra => {
    const { model } = client([() => call('parse_shopping_intent', parsed(extra))]);
    await expect(model.extractIntent('拿铁', { quantity: 1, max_total_minor: 3000, merchant_id: 'coffee-demo' }))
      .rejects.toMatchObject({ code: 'invalid_model_response' });
  });
  test('supported pickup and an alternative choice do not become a mixed or delivery request', async () => {
    const { model } = client([() => call('parse_shopping_intent', parsed({ query: '咖啡', quantity: 2 }))]);
    const result = await model.extractIntent('拿铁或美式任选两杯同款，不要配送，到店自取。',
      { quantity: 2, max_total_minor: 3000, merchant_id: 'coffee-demo' });
    expect(result.intent).toMatchObject({ quantity: 2, fulfillment: 'pickup', query: '咖啡' });
  });
  test('mixed products get one full-basket quote and never purchase without human confirmation', async () => {
    const { model, requests } = client([
      () => call('parse_shopping_intent', parsed({ quantity: 2, max_total_minor: 6000, purchase_shape: 'mixed_products',
        items: [{ query: '拿铁', quantity: 1 }, { query: '浓缩', quantity: 1 }] })),
      () => call('search', {}), () => call('quote', { entry_ids: ['mock_latte', 'mock_espresso'], reason: '按各行需求选两款。' }),
    ]);
    const result = await runShoppingAgent(await createMockRuntime(directory), 'alice',
      { message: '一杯拿铁一杯浓缩，整单60元以内', quantity: 2, max_total_minor: 6000 }, model);
    expect(result.session.phase).toBe('awaiting_confirmation'); expect(result.session.quote!.total_minor).toBe(4600);
    expect(result.session.quote!.items).toMatchObject([{ entry_id: 'mock_latte', quantity: 1 }, { entry_id: 'mock_espresso', quantity: 1 }]);
    expect(result.session.attempt).toBeUndefined(); expect(result.tool_calls).toBe(2); expect(requests).toHaveLength(3);
    expect(result.explanation).toContain('经典拿铁'); expect(result.explanation).toContain('浓缩咖啡');
    expect(result.explanation).toContain('¥46.00'); expect(result.explanation).toContain('到店自取');
    const context = JSON.stringify(requests[2]!.body);
    expect(context).toContain('candidate_groups'); expect(context).toContain('浓缩');
  });
  test('delivery uses the form address, prices the full basket, and keeps personal data out of all model requests', async () => {
    const { model, requests } = client([
      () => call('parse_shopping_intent', parsed({ quantity: 2, max_total_minor: 6000, purchase_shape: 'mixed_products',
        requested_fulfillment: 'delivery', items: [{ query: '拿铁', quantity: 1 }, { query: '浓缩', quantity: 1 }] })),
      () => call('search', {}), () => call('quote', { entry_ids: ['mock_latte', 'mock_espresso'], reason: '按两项需求配送。' }),
    ]);
    const result = await runShoppingAgent(await createMockRuntime(directory), 'alice', {
      message: `一杯拿铁一杯浓缩，配送给${delivery.recipient}，电话${delivery.phone}，地址${delivery.address}。`,
      quantity: 2, max_total_minor: 6000, fulfillment: 'delivery', delivery,
    }, model);
    expect(result.session.quote!.total_minor).toBe(5100); expect(result.session.quote!.delivery).toEqual(delivery);
    expect(result.session.quote!.fees).toEqual(expect.arrayContaining([expect.objectContaining({ label: '配送费', amount_minor: 500 })]));
    expect(result.explanation).toContain('配送'); expect(result.explanation).toContain('¥51.00');
    expect(result.session.attempt).toBeUndefined();
    const context = JSON.stringify(requests.map(request => request.body));
    for (const privateValue of Object.values(delivery)) expect(context).not.toContain(privateValue);
    expect(context).toContain('delivery_info_present');
    expect(context).not.toContain('authorization_proof'); expect(context).not.toContain('idempotency_key');
  });
  test.each([
    { formPhone: '13800138000', writtenPhone: '138-0013-8000' },
    { formPhone: '13800138000', writtenPhone: '138 0013 8000' },
    { formPhone: '13800138000', writtenPhone: '+86 138-0013-8000' },
    { formPhone: '13800138000', writtenPhone: '86-138-0013-8000' },
    { formPhone: '13800138000', writtenPhone: '+86\u00a0138\u00a00013\u00a08000' },
    { formPhone: '13800138000', writtenPhone: '138－0013－8000' },
    { formPhone: '+8613800138000', writtenPhone: '138 0013 8000' },
    { formPhone: '+86 138-0013-8000', writtenPhone: '+86-138-0013-8000' },
    { formPhone: '+442071234567', writtenPhone: '+44 20-7123-4567' },
  ])('the same delivery phone is redacted in extraction and planning across written formats: %j', async ({ formPhone, writtenPhone }) => {
    const { model, requests } = client([
      () => call('parse_shopping_intent', parsed({ quantity: 2, max_total_minor: 6000, purchase_shape: 'mixed_products',
        requested_fulfillment: 'delivery', items: [{ query: '拿铁', quantity: 1 }, { query: '浓缩', quantity: 1 }] })),
      () => call('search', {}), () => call('quote', { entry_ids: ['mock_latte', 'mock_espresso'], reason: '按两项需求配送。' }),
    ]);
    const message = `拿铁1杯、浓缩1杯，共2杯，预算60元；配送电话${writtenPhone}。商品编号2138001380004，另一号码13800138001。`;
    const sanitized = message.replace(writtenPhone, '[配送信息已由表单保存]');
    const result = await runShoppingAgent(await createMockRuntime(directory), 'alice', {
      message, quantity: 2, max_total_minor: 6000, fulfillment: 'delivery', delivery: { ...delivery, phone: formPhone },
    }, model);
    expect(result.session.intent.items).toEqual([{ query: '拿铁', quantity: 1 }, { query: '浓缩', quantity: 1 }]);
    expect(result.session.intent).toMatchObject({ quantity: 2, max_total_minor: 6000 });
    expect(result.session.quote!.total_minor).toBe(5100); expect(result.session.attempt).toBeUndefined();
    expect(requests).toHaveLength(3);
    for (const [index, request] of requests.entries()) {
      const user = (request.body.messages as { role: string; content: string }[]).find(value => value.role === 'user')!;
      expect(index === 0 ? JSON.parse(user.content).message : user.content).toBe(sanitized);
    }
  });
  test('an over-budget mixed basket can change one item and reuse the other valid selection', async () => {
    const { model, requests } = client([
      () => call('parse_shopping_intent', parsed({ quantity: 2, max_total_minor: 4800, purchase_shape: 'mixed_products',
        items: [{ query: '拿铁', quantity: 1 }, { query: '浓缩', quantity: 1 }] })), () => call('search', {}),
      () => call('quote', { entry_ids: ['mock_special_latte', 'mock_espresso'], reason: '先查看整篮报价。' }),
      () => call('quote', { entry_ids: ['mock_latte', 'mock_espresso'], reason: '只替换拿铁这一项。' }),
    ]);
    const result = await runShoppingAgent(await createMockRuntime(directory), 'alice',
      { message: '一杯拿铁一杯浓缩，整单48元以内', quantity: 2, max_total_minor: 4800 }, model);
    expect(result.session.quote!.total_minor).toBe(4600); expect(result.session.attempt).toBeUndefined();
    expect(result.tool_calls).toBe(3); expect(requests).toHaveLength(4);
    const messages = requests[3]!.body.messages as { role: string; content?: string }[];
    const state = JSON.parse(messages.filter(message => message.role === 'tool').at(-1)!.content!).state;
    expect(state.quote.total_minor).toBe(4900);
    expect(state.candidate_groups[1].candidates[0].entry_id).toBe('mock_espresso');
    expect(state.attempted_baskets).toHaveLength(1);
    expect(result.explanation).toContain('¥46.00');
  });
  test('a natural-language pickup requirement conflicts with the delivery form rather than changing it', async () => {
    const { model, requests } = client([() => call('parse_shopping_intent', parsed())]);
    await expect(runShoppingAgent(await createMockRuntime(directory), 'alice', { ...input,
      message: '不要配送，必须到店自取', fulfillment: 'delivery', delivery }, model))
      .rejects.toMatchObject({ code: 'needs_clarification', message: expect.stringContaining('表单选择了配送') });
    expect(requests).toHaveLength(1);
  });
  test('incomplete delivery details are rejected before paying for a model request', async () => {
    const { model, requests } = client([]);
    await expect(runShoppingAgent(await createMockRuntime(directory), 'alice', { ...input,
      fulfillment: 'delivery', delivery: { recipient: delivery.recipient, phone: delivery.phone } }, model))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });
  test.each([
    { entry_ids: ['invented', 'mock_espresso'] }, { entry_ids: ['mock_espresso', 'mock_latte'] }, { entry_ids: ['mock_latte'] },
  ])('basket quote must choose one real candidate from every matching group: %j', async ({ entry_ids }) => {
    const { model } = client([
      () => call('parse_shopping_intent', parsed({ quantity: 2, max_total_minor: 6000, purchase_shape: 'mixed_products',
        items: [{ query: '拿铁', quantity: 1 }, { query: '浓缩', quantity: 1 }] })),
      () => call('search', {}), () => call('quote', { entry_ids, reason: '选两款' }),
    ]);
    await expect(runShoppingAgent(await createMockRuntime(directory), 'alice',
      { message: '一杯拿铁一杯浓缩', quantity: 2, max_total_minor: 6000 }, model))
      .rejects.toMatchObject({ code: 'invalid_tool' });
  });
  test('an empty candidate group stops the basket even when another group has stock', async () => {
    const issuer = new LocalMockIssuer();
    const merchant = new MockMerchantTransport(join(directory, 'merchant'), issuer.publicKey);
    const originalSearch = merchant.search.bind(merchant);
    merchant.search = async intent => intent.query === '缺货商品' ? [] : originalSearch(intent);
    const coordinator = new ShoppingCoordinator(merchant, new FileSessionStore(join(directory, 'sessions')), issuer, MOCK_ORIGIN);
    const { model, requests } = client([
      () => call('parse_shopping_intent', parsed({ quantity: 2, max_total_minor: 6000, purchase_shape: 'mixed_products',
        items: [{ query: '拿铁', quantity: 1 }, { query: '缺货商品', quantity: 1 }] })), () => call('search', {}),
    ]);
    const result = await runShoppingAgent(coordinator, 'alice', { message: '两款各一杯', quantity: 2, max_total_minor: 6000 }, model);
    expect(result.outcome).toBe('no_candidates'); expect(result.session.candidates.length).toBeGreaterThan(0);
    expect(result.session.quote).toBeUndefined(); expect(result.session.attempt).toBeUndefined(); expect(requests).toHaveLength(2);
  });
  test('empty affordable search returns a useful result without asking the model to search again', async () => {
    const { model, requests } = client([
      () => call('parse_shopping_intent', parsed({ max_total_minor: 800 })),
      () => call('search', {}), () => call('search', {}),
    ]);
    const result = await runShoppingAgent(await createMockRuntime(directory), 'alice', { ...input, max_total_minor: 800 }, model);
    expect(result).toMatchObject({ outcome: 'no_candidates', tool_calls: 1, next_actions: ['edit_request'] });
    expect(result.session.candidates).toEqual([]);
    expect(result.session.quote).toBeUndefined(); expect(result.session.attempt).toBeUndefined();
    expect(result.explanation).toContain('满足本次'); expect(result.explanation).toContain('不代表目录中不存在');
    expect(requests).toHaveLength(2);
  });
  test('price, delivery and payment hallucinations in model prose cannot become the quote explanation', async () => {
    const { model } = client([
      () => call('parse_shopping_intent', parsed()), () => call('search', {}),
      () => call('quote', { entry_id: 'mock_latte', reason: '最终29元，已付款，将配送到宿舍。' }),
    ]);
    const result = await runShoppingAgent(await createMockRuntime(directory), 'alice', input, model);
    expect(result.session.quote!.total_minor).toBe(2800);
    expect(result.explanation).toContain('¥28.00'); expect(result.explanation).toContain('到店自取');
    for (const unverified of ['29元', '已付款', '配送到宿舍']) expect(result.explanation).not.toContain(unverified);
    expect(result).toMatchObject({ outcome: 'quote_ready', next_actions: ['confirm_quote', 'choose_candidate', 'edit_request'] });
    expect(result.session.attempt).toBeUndefined();
  });
  test('a rejected all-in quote reaches the model and a different affordable candidate can succeed', async () => {
    const { model, requests } = client([
      () => call('parse_shopping_intent', parsed()), () => call('search', {}),
      () => call('quote', { entry_id: 'mock_special_latte', reason: '先看特调报价。' }),
      () => call('quote', { entry_id: 'mock_latte', reason: '改选另一杯拿铁。' }),
    ]);
    const result = await runShoppingAgent(await createMockRuntime(directory), 'alice', input, model);
    expect(result).toMatchObject({ outcome: 'quote_ready', tool_calls: 3 });
    expect(result.session.selected!.entry_id).toBe('mock_latte'); expect(result.session.quote!.total_minor).toBe(2800);
    expect(requests).toHaveLength(4);
    const messages = requests[3]!.body.messages as { role: string; content?: string }[];
    const state = JSON.parse(messages.filter(message => message.role === 'tool').at(-1)!.content!);
    expect(state.tool_error.code).toBe('budget_exceeded'); expect(state.state.quote.total_minor).toBe(3100);
    expect(state.state.candidates.map((candidate: { entry_id: string }) => candidate.entry_id)).not.toContain('mock_special_latte');
    expect(state.state.attempted_entries).toContain('mock_special_latte');
    expect(result.explanation).toContain('¥28.00'); expect(result.session.attempt).toBeUndefined();
  });
  test('a model may decline unsuitable candidates but cannot suggest invented UI or conversation actions', async () => {
    const { model } = client([
      () => call('parse_shopping_intent', parsed()), () => call('search', {}),
      () => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '请在页面改为配送，然后聊天告诉我要哪一杯。' } }] }),
    ]);
    const result = await runShoppingAgent(await createMockRuntime(directory), 'alice', input, model);
    expect(result.outcome).toBe('selection_required'); expect(result.session.quote).toBeUndefined();
    expect(result.next_actions).toEqual(['choose_candidate', 'edit_request']);
    expect(result.explanation).toContain('查看最终报价');
    expect(result.explanation).not.toContain('配送'); expect(result.explanation).not.toContain('聊天');
  });
  test('a large catalog puts its cheapest directory candidate in the model view and reports the limited comparison scope', async () => {
    const issuer = new LocalMockIssuer();
    const merchant = new MockMerchantTransport(join(directory, 'merchant'), issuer.publicKey);
    merchant.search = async () => Array.from({ length: 41 }, (_, index) => ({
      entry_id: `candidate_${index}`, catalog_id: 'mock_coffee_catalog', merchant_id: 'coffee-demo', title: `咖啡${index}`,
      description: '目录候选', search_price_minor: index === 40 ? 990 : 2000 + index, currency: 'CNY', in_stock: true,
    }));
    const coordinator = new ShoppingCoordinator(merchant, new FileSessionStore(join(directory, 'sessions')), issuer, MOCK_ORIGIN);
    const { model, requests } = client([
      () => call('parse_shopping_intent', parsed({ query: '咖啡' })), () => call('search', {}),
      () => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '暂不选品。' } }] }),
    ]);
    const result = await runShoppingAgent(coordinator, 'alice', input, model);
    const messages = requests[2]!.body.messages as { role: string; content?: string }[];
    const state = JSON.parse(messages.find(message => message.role === 'tool')!.content!).state;
    expect(state.candidates_total).toBe(41); expect(state.candidates_shown).toBe(40);
    expect(state.candidates[0].entry_id).toBe('candidate_40');
    expect(result.warnings.join(' ')).toContain('不代表全部商品');
    expect(result.next_actions).toEqual(['choose_candidate', 'edit_request']);
  });
  test.each(['checkout', 'confirm', 'cancel', 'recover'])('rejects unauthorized model tool %s', async name => {
    const { model } = client([() => call('parse_shopping_intent', parsed()), () => call(name, {})]);
    const coordinator = await createMockRuntime(directory);
    await expect(runShoppingAgent(coordinator, 'alice', input, model)).rejects.toMatchObject({ code: 'invalid_tool' });
    expect(await coordinator.listPending('alice')).toEqual([]);
  });
  test('rejects a fabricated candidate and extra tool arguments', async () => {
    const { model } = client([() => call('parse_shopping_intent', parsed()), () => call('quote', { entry_id: 'invented', reason: '买它' })]);
    await expect(runShoppingAgent(await createMockRuntime(directory), 'alice', input, model)).rejects.toMatchObject({ code: 'invalid_tool' });
    const extra = client([() => call('parse_shopping_intent', parsed()), () => call('search', { approved: true })]);
    await expect(runShoppingAgent(await createMockRuntime(join(directory, 'other')), 'alice', input, extra.model))
      .rejects.toMatchObject({ code: 'invalid_model_response' });
  });
  test.each([401, 429, 500])('sanitizes provider HTTP %s without reflecting key/body', async status => {
    const { model } = client([() => new Response('secret error test-only-never-a-real-key', { status })]);
    let caught: unknown;
    try { await model.extractIntent('拿铁', { quantity: 1, max_total_minor: 3000, merchant_id: 'coffee-demo' }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain('test-only-never-a-real-key');
    expect(String(caught)).not.toContain('secret error');
  });
  test('rejects truncated, malformed and multiple-tool responses', async () => {
    for (const response of [new Response('{'), new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'cut' } }] })),
      new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{}, {}] } }] }))]) {
      const { model } = client([() => response]);
      await expect(model.extractIntent('拿铁', { quantity: 1, max_total_minor: 3000, merchant_id: 'coffee-demo' }))
        .rejects.toMatchObject({ code: 'invalid_model_response' });
    }
  });
  test('has no implicit key and validates endpoint/timeout configuration', () => {
    expect(createConfiguredShoppingModel({})).toBeUndefined();
    expect(createConfiguredShoppingModel({ DEEPSEEK_API_KEY: '' })).toBeUndefined();
    expect(createConfiguredShoppingModel({ DEEPSEEK_API_KEY: 'test-key' })!.model).toBe('deepseek-flash');
    expect(() => new ShoppingModelClient({ apiKey: 'test', baseUrl: 'http://outside.example' })).toThrow('HTTPS');
    expect(() => new ShoppingModelClient({ apiKey: 'test', baseUrl: 'https://example.com?secret=1' })).toThrow('HTTPS');
    expect(() => new ShoppingModelClient({ apiKey: 'test', timeoutMs: 1 })).toThrow('TIMEOUT');
  });
  test('invalid human constraints do not issue a model request', async () => {
    const { model, requests } = client([]);
    await expect(runShoppingAgent(await createMockRuntime(directory), 'alice', { ...input, max_total_minor: 30.5 }, model))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });
  test('a concurrent unknown purchase stops an in-flight planner before another model call', async () => {
    const coordinator = await createMockRuntime(directory, { fault: 'response_lost' });
    const original = await coordinator.create('alice', { query: '拿铁', quantity: 1, max_total_minor: 3000,
      merchant_id: 'coffee-demo', currency: 'CNY', fulfillment: 'pickup' });
    await coordinator.search('alice', original.id);
    const quoted = await coordinator.select('alice', original.id, 'mock_latte');
    let requests = 0;
    const model = new ShoppingModelClient({ apiKey: 'local-race-test-only', fetch: (async () => {
      requests += 1;
      if (requests === 1) return call('parse_shopping_intent', parsed(), 'intent');
      if (requests === 2) {
        // Another tab buys while this planner is waiting for its first search decision.
        const unknown = await coordinator.confirm('alice', original.id, {
          quote_id: quoted.quote!.quote_id, terms_hash: quoted.quote!.terms_hash, revision: quoted.revision,
        });
        expect(unknown.phase).toBe('unknown');
        return call('search', {}, 'search');
      }
      throw new Error('A blocked tool must not trigger another paid model request');
    }) as unknown as typeof fetch });
    await expect(runShoppingAgent(coordinator, 'alice', input, model)).rejects.toMatchObject({ code: 'unresolved_purchase' });
    expect(requests).toBe(2);
    expect((await coordinator.listPending('alice')).map(session => session.id)).toEqual([original.id]);
  });
});
