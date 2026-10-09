import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQuoteTerms, computeQuoteTermsHash, computeTermsHash, type Quote as WireQuote } from '@ocp-catalog/shopping-contracts';
import { createMockRuntime, Ed25519AuthorizationIssuer, FileSessionStore, FlowError, HttpMerchantTransport, LocalMockIssuer, MOCK_ORIGIN,
  MockMerchantTransport, ShoppingCoordinator, assertQuote, parseIntent, type Candidate, type Intent, type PublicSession } from './index';
import manifestFixture from '../../../fixtures/shopping/manifest.json';
import queryFixture from '../../../fixtures/shopping/query-result.json';

const delivery = { recipient: '测试收件人', phone: '13800138000', address: '杭州市西湖区测试路1号' };
const basket: Intent = { query: '拿铁 / 浓缩', items: [{ query: '拿铁', quantity: 1 }, { query: '浓缩', quantity: 1 }],
  quantity: 2, currency: 'CNY', max_total_minor: 6000, merchant_id: 'coffee-demo', fulfillment: 'pickup' };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'ocp-runtime-basket-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function setup(options: { fault?: 'response_lost' } = {}) {
  const issuer = new LocalMockIssuer();
  const merchant = new MockMerchantTransport(join(directory, 'mock'), issuer.publicKey, options);
  const store = new FileSessionStore(join(directory, 'sessions'));
  return { merchant, store, coordinator: new ShoppingCoordinator(merchant, store, issuer, MOCK_ORIGIN) };
}
const confirm = (session: PublicSession) => ({ quote_id: session.quote!.quote_id, terms_hash: session.quote!.terms_hash, revision: session.revision });
async function quoted(runtime: ReturnType<typeof setup>, intent: Intent = basket, ids = ['mock_latte', 'mock_espresso']) {
  const created = await runtime.coordinator.create('alice', intent);
  await runtime.coordinator.search('alice', created.id);
  return runtime.coordinator.select('alice', created.id, ids);
}

describe('mixed item and delivery constraints', () => {
  test('intent normalizes lines and delivery while preserving the total human quantity', () => {
    expect(parseIntent(basket).items).toEqual(basket.items);
    const parsed = parseIntent({ ...basket, fulfillment: 'delivery', delivery: { ...delivery, recipient: ' 测试收件人 ' } });
    expect(parsed.delivery!.recipient).toBe('测试收件人');
    expect(parsed.quantity).toBe(2);
  });
  test.each([
    { quantity: 3 }, { items: [] }, { items: Array.from({ length: 11 }, () => ({ query: '咖啡', quantity: 1 })), quantity: 11 },
    { items: [{ query: '拿铁', quantity: -1 }, { query: '咖啡', quantity: 3 }] },
    { fulfillment: ['delivery'] }, { fulfillment: 'delivery' }, { fulfillment: 'delivery', delivery: { ...delivery, phone: 'invalid' } },
    { delivery }, { items: [{ query: '拿铁', quantity: 2, price: 1 }] },
  ])('rejects invalid basket or fulfillment %#', change => {
    expect(() => parseIntent({ ...basket, ...change })).toThrow(FlowError);
  });

  test('each demand has its own catalog candidates, and a mixed basket is quoted and purchased only once', async () => {
    const runtime = setup(), session = await quoted(runtime);
    expect(session.candidate_groups!.map(group => ({ query: group.query, quantity: group.quantity }))).toEqual([...basket.items]);
    expect(session.selected_entry_ids).toEqual(['mock_latte', 'mock_espresso']);
    expect(session.quote!.items!.map(item => [item.entry_id, item.quantity])).toEqual([['mock_latte', 1], ['mock_espresso', 1]]);
    expect(session.quote!.quantity).toBe(2);
    expect(session.quote!.total_minor).toBe(4600);
    expect(session.quote!.fees).toHaveLength(1);
    expect(runtime.merchant.checkoutCalls).toBe(0);
    const results = await Promise.all([runtime.coordinator.confirm('alice', session.id, confirm(session)), runtime.coordinator.confirm('alice', session.id, confirm(session))]);
    expect(results[0]!.order!.items).toEqual(session.quote!.items);
    expect(results[1]!.order!.order_id).toBe(results[0]!.order!.order_id);
    expect(runtime.merchant.checkoutCalls).toBe(1);
    expect(await runtime.merchant.diagnostics()).toEqual({ payment_count: 1, order_count: 1 });
  });

  test('selection ids are checked against their corresponding demand group', async () => {
    const runtime = setup(), session = await runtime.coordinator.create('alice', basket);
    await runtime.coordinator.search('alice', session.id);
    await expect(runtime.coordinator.select('alice', session.id, ['mock_espresso', 'mock_latte'])).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(runtime.coordinator.select('alice', session.id, ['mock_latte'])).rejects.toMatchObject({ code: 'invalid_request' });
    expect(runtime.merchant.checkoutCalls).toBe(0);
  });

  test('repeated entry ids across groups merge into a single correctly sized priced line', async () => {
    const runtime = setup(), intent: Intent = { ...basket, query: '拿铁 / 咖啡',
      items: [{ query: '拿铁', quantity: 1 }, { query: '咖啡', quantity: 2 }], quantity: 3, max_total_minor: 9000 };
    const session = await quoted(runtime, intent, ['mock_latte', 'mock_latte']);
    expect(session.selected_entry_ids).toEqual(['mock_latte', 'mock_latte']);
    expect(session.quote!.items).toHaveLength(1);
    expect(session.quote!.items![0]!.quantity).toBe(3);
    expect(session.quote!.total_minor).toBe(8000);
    expect(session.quote!.wire_terms!.items).toHaveLength(1);
    expect(session.quote!.wire_terms!.items[0]!.quantity).toBe(3);
  });

  test('delivery filters unsupported products and binds its one fee and address to the order', async () => {
    const runtime = setup(), intent: Intent = { ...basket, fulfillment: 'delivery', delivery };
    const session = await quoted(runtime, intent);
    expect(session.candidate_groups![0]!.candidates.some(candidate => candidate.entry_id === 'mock_special_latte')).toBe(false);
    expect(session.quote!.total_minor).toBe(5100);
    expect(session.quote!.fees.map(fee => fee.amount_minor)).toEqual([200, 500]);
    expect(session.quote!.wire_terms!.fulfillment).toEqual({ method: 'delivery', delivery });
    const result = await runtime.coordinator.confirm('alice', session.id, confirm(session));
    expect(result.order!.delivery).toEqual(delivery);
    expect(result.order!.fulfillment).toBe('delivery');
    expect(result.order!.items).toEqual(session.quote!.items);
  });

  test('the full basket total including delivery must fit the budget', async () => {
    const runtime = setup(), session = await quoted(runtime, { ...basket, fulfillment: 'delivery', delivery, max_total_minor: 5000 });
    expect(session.phase).toBe('failed');
    expect(session.error!.code).toBe('budget_exceeded');
    expect(session.quote!.total_minor).toBe(5100);
    await expect(runtime.coordinator.confirm('alice', session.id, confirm(session))).rejects.toMatchObject({ code: 'invalid_state' });
    expect(runtime.merchant.checkoutCalls).toBe(0);
  });

  test('all line quantities, units and delivery address must remain bound at confirmation', async () => {
    const runtime = setup(), session = await quoted(runtime, { ...basket, fulfillment: 'delivery', delivery });
    const selections = session.selected_items!;
    for (const change of [
      { delivery: { ...delivery, address: '其他地址' } },
      { items: session.quote!.items!.map((item, index) => ({ ...item, quantity: index ? 2 : 1 })) },
      { items: session.quote!.items!.slice(0, 1) },
      { quantity: 1 },
      { fees: [{ label: '打包费', amount_minor: 300 }, { label: '配送费', amount_minor: 400 }] },
      { fees: session.quote!.fees.map(fee => ({ ...fee, code: 'foreign_fee' })) },
    ]) {
      expect(() => assertQuote({ ...session.quote!, user_id: 'alice', ...change }, 'alice', selections, { ...basket, fulfillment: 'delivery', delivery }, Date.now())).toThrow(FlowError);
    }
    const changed = structuredClone(session.quote!.wire_terms!);
    changed.fulfillment.delivery = { ...delivery, address: '杭州市另一条路2号' };
    expect(computeTermsHash(changed)).not.toBe(session.quote!.terms_hash);
    expect(runtime.merchant.checkoutCalls).toBe(0);
  });

  test('every resolved item must pass, and the shortest expiry bounds the whole basket', async () => {
    const runtime = setup();
    runtime.merchant.resolve = async candidate => ({ checkout_url: `${MOCK_ORIGIN}/commerce/v1/checkouts`,
      expires_at: new Date(Date.now() + (candidate.entry_id === 'mock_latte' ? 60_000 : 1000)).toISOString() });
    const session = await quoted(runtime);
    const saved = (await runtime.store.read(session.id))!;
    saved.resolve_expires_at = new Date(Date.now() - 1).toISOString(); await runtime.store.write(saved);
    const expired = await runtime.coordinator.confirm('alice', session.id, confirm(session));
    expect(expired.phase).toBe('requote_required');
    expect(runtime.merchant.checkoutCalls).toBe(0);
  });

  test('an unsupported basket adapter does not silently split the transaction', async () => {
    const runtime = setup(); runtime.merchant.quoteBasket = undefined as never;
    const session = await quoted(runtime);
    expect(session.error!.code).toBe('unsupported_capability');
    expect(session.attempt).toBeUndefined();
    expect(runtime.merchant.checkoutCalls).toBe(0);
  });

  test('lost mixed-delivery checkout recovers the same full order after restart, and locks other purchases', async () => {
    const runtime = setup({ fault: 'response_lost' }), session = await quoted(runtime, { ...basket, fulfillment: 'delivery', delivery });
    const unknown = await runtime.coordinator.confirm('alice', session.id, confirm(session));
    expect(unknown.phase).toBe('unknown');
    const restarted = await createMockRuntime(directory);
    await expect(restarted.create('alice', basket)).rejects.toMatchObject({ code: 'unresolved_purchase' });
    const recovered = await restarted.recover('alice', session.id);
    expect(recovered.phase).toBe('confirmed');
    expect(recovered.attempt!.purchase_attempt_id).toBe(unknown.attempt!.purchase_attempt_id);
    expect(recovered.order!.items).toEqual(session.quote!.items);
    expect(recovered.order!.delivery).toEqual(delivery);
    expect(await runtime.merchant.diagnostics()).toEqual({ payment_count: 1, order_count: 1 });
  });

  test('a changed order line or address during recovery stays unknown and does not permit another purchase', async () => {
    const runtime = setup(), session = await quoted(runtime, { ...basket, fulfillment: 'delivery', delivery });
    await runtime.coordinator.confirm('alice', session.id, confirm(session));
    const original = runtime.merchant.getOrder.bind(runtime.merchant);
    runtime.merchant.getOrder = async (...args) => ({ ...await original(...args), delivery: { ...delivery, address: '更换后的地址' } });
    const recovered = await runtime.coordinator.recover('alice', session.id);
    expect(recovered.phase).toBe('unknown');
    expect(recovered.attempt!.status).toBe('confirmed');
    await expect(runtime.coordinator.create('alice', basket)).rejects.toMatchObject({ code: 'unresolved_purchase' });
    expect(runtime.merchant.checkoutCalls).toBe(1);
  });
  test('duplicate order rows cannot conceal a missing item during recovery', async () => {
    const runtime = setup(), session = await quoted(runtime);
    await runtime.coordinator.confirm('alice', session.id, confirm(session));
    const original = runtime.merchant.getOrder.bind(runtime.merchant);
    runtime.merchant.getOrder = async (...args) => {
      const order = await original(...args);
      return { ...order, items: [order.items![0]!, structuredClone(order.items![0]!)] };
    };
    const recovered = await runtime.coordinator.recover('alice', session.id);
    expect(recovered.phase).toBe('unknown');
    expect(recovered.attempt!.status).toBe('confirmed');
    expect(recovered.order).toBeUndefined();
    expect(runtime.merchant.checkoutCalls).toBe(1);
  });
});

describe('HTTP basket wire boundary', () => {
  const first: Candidate = { entry_id: 'latte', title: '拿铁', catalog_id: 'catalog', merchant_id: 'merchant',
    search_price_minor: 1000, currency: 'CNY', in_stock: true, description: '', fulfillment_methods: ['pickup', 'delivery'] };
  const second: Candidate = { ...first, entry_id: 'espresso', title: '浓缩', search_price_minor: 500 };
  const requested: Intent = { ...basket, merchant_id: 'merchant', fulfillment: 'delivery', delivery };
  function wire(): WireQuote {
    const draft = { quote_id: 'quote_basket', merchant_id: 'merchant', catalog_id: 'catalog', currency: 'CNY',
      items: [{ entry_id: 'latte', title: '拿铁', quantity: 1, unit_minor: 1000, line_total_minor: 1000 },
        { entry_id: 'espresso', title: '浓缩', quantity: 1, unit_minor: 500, line_total_minor: 500 }],
      fees: [{ code: 'delivery', label: '配送费', amount_minor: 500 }], subtotal_minor: 1500, total_minor: 2000,
      fulfillment: { method: 'delivery' as const, delivery }, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() };
    return { ...draft, terms_hash: computeQuoteTermsHash(draft) };
  }
  test('delivery search requires methods advertised by the actual catalog item', async () => {
    const manifest = structuredClone(manifestFixture);
    for (const [name, endpoint] of Object.entries(manifest.endpoints)) endpoint.url = `${MOCK_ORIGIN}/ocp/${name}`;
    const pickupOnly = structuredClone(queryFixture.entries[0]!);
    pickupOnly.entry.entry_id = 'pickup_only'; pickupOnly.entry.attributes.fulfillment.methods = ['pickup'];
    const deliveryItem = structuredClone(queryFixture.entries[0]!);
    deliveryItem.entry.entry_id = 'delivery_available';
    const transport = new HttpMerchantTransport({ origin: MOCK_ORIGIN, merchantId: 'merchant', catalogId: manifest.catalog_id,
      fetch: (async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/.well-known/ocp-catalog') return Response.json({ ocp_version: '1.0', kind: 'WellKnownCatalogDiscovery',
          catalog_id: manifest.catalog_id, manifest_url: `${MOCK_ORIGIN}/ocp/manifest` });
        if (path === '/ocp/manifest') return Response.json(manifest);
        return Response.json({ ...queryFixture, result_count: 2, entries: [pickupOnly, deliveryItem] });
      }) as typeof fetch });
    const found = await transport.search({ ...requested, query: '拿铁', quantity: 1, items: [{ query: '拿铁', quantity: 1 }] });
    expect(found.map(candidate => candidate.entry_id)).toEqual(['delivery_available']);
    expect(found[0]!.fulfillment_methods).toEqual(['pickup', 'delivery']);
  });
  test('one HTTP quote carries every selected line and fulfillment, and maps total quantity truthfully', async () => {
    let body: unknown;
    const transport = new HttpMerchantTransport({ origin: MOCK_ORIGIN, merchantId: 'merchant', catalogId: 'catalog',
      fetch: (async (_url, options) => { body = JSON.parse(options!.body as string); return Response.json(wire()); }) as typeof fetch });
    const result = await transport.quoteBasket('alice', [{ candidate: first, quantity: 1 }, { candidate: second, quantity: 1 }], requested);
    expect(body).toEqual({ items: [{ entry_id: 'latte', quantity: 1 }, { entry_id: 'espresso', quantity: 1 }], fulfillment: { method: 'delivery', delivery } });
    expect(result.quantity).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.delivery).toEqual(delivery);
    expect(result.wire_terms).toEqual(buildQuoteTerms(wire()));
  });
  test('the HTTP response cannot replace an item, its quantity or the delivery address', async () => {
    for (const mutate of [
      (quote: WireQuote) => { quote.items[1]!.entry_id = 'foreign'; },
      (quote: WireQuote) => { quote.items[1]!.quantity = 2; quote.items[1]!.line_total_minor = 1000; quote.subtotal_minor = 2000; quote.total_minor = 2500; },
      (quote: WireQuote) => { quote.fulfillment.delivery = { ...delivery, address: '更换后的地址' }; },
    ]) {
      const changed = wire(); mutate(changed); changed.terms_hash = computeQuoteTermsHash(changed);
      const transport = new HttpMerchantTransport({ origin: MOCK_ORIGIN, merchantId: 'merchant', catalogId: 'catalog', fetch: (async () => Response.json(changed)) as unknown as typeof fetch });
      await expect(transport.quoteBasket('alice', [{ candidate: first, quantity: 1 }, { candidate: second, quantity: 1 }], requested)).rejects.toMatchObject({ code: 'protocol_error' });
    }
  });
  test('HTTP checkout binds every row and address to one authorization and one order', async () => {
    const original = wire(), now = Date.now(), keys = generateKeyPairSync('ed25519');
    const signer = new Ed25519AuthorizationIssuer({ issuer: 'agent', keyId: 'test', privateKey: keys.privateKey, now: () => now });
    let checkoutCalls = 0;
    const transport = new HttpMerchantTransport({ origin: MOCK_ORIGIN, merchantId: 'merchant', catalogId: 'catalog', now: () => now,
      fetch: (async url => {
        if (new URL(String(url)).pathname === '/commerce/v1/quotes') return Response.json(original);
        checkoutCalls++;
        const { expires_at: _expiry, ...orderTerms } = original;
        return Response.json({ status: 'confirmed', purchase_attempt: { purchase_attempt_id: 'attempt_basket', merchant_id: 'merchant',
          catalog_id: 'catalog', quote_id: original.quote_id, status: 'confirmed', order_id: 'order_basket',
          created_at: original.created_at, updated_at: original.created_at },
        order: { ...orderTerms, order_id: 'order_basket', purchase_attempt_id: 'attempt_basket',
          payment: { status: 'paid', updated_at: original.created_at }, fulfillment_status: { status: 'pending', updated_at: original.created_at }, updated_at: original.created_at } });
      }) as typeof fetch });
    const basketQuote = await transport.quoteBasket('alice', [{ candidate: first, quantity: 1 }, { candidate: second, quantity: 1 }], requested);
    const input = { user_id: 'alice', purchase_attempt_id: 'attempt_basket', idempotency_key: 'key_basket',
      quote_id: basketQuote.quote_id, terms_hash: basketQuote.terms_hash, checkout_url: `${MOCK_ORIGIN}/commerce/v1/checkouts`, quote: basketQuote,
      authorization_proof: signer.issue({ issuer: 'agent', user_id: 'alice', merchant_id: 'merchant', quote_id: basketQuote.quote_id,
        terms_hash: basketQuote.terms_hash, entry_id: first.entry_id, quantity: 2, fulfillment: 'delivery', currency: 'CNY',
        max_total_minor: 6000, purchase_attempt_id: 'attempt_basket', expires_at: basketQuote.expires_at }) };
    await expect(transport.checkout({ ...input, quote: { ...basketQuote, delivery: { ...delivery, address: '另外的地址' } } })).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(transport.checkout({ ...input, quote: { ...basketQuote, items: basketQuote.items!.slice(0, 1) } })).rejects.toMatchObject({ code: 'protocol_error' });
    expect(checkoutCalls).toBe(0);
    expect((await transport.checkout(input)).status).toBe('confirmed');
    expect(checkoutCalls).toBe(1);
  });
});
