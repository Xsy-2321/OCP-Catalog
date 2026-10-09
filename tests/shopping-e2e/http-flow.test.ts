import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHttpRuntime, type PublicSession } from '../../packages/agent-runtime/src';
import { createHandler } from '../../apps/shopping-agent-api/src/server';
import { startCoffeeMerchantServer } from '../../apps/coffee-merchant-api/src/server';
import { CATALOG_SEED, loadCatalog, manualClock, type Clock, type CatalogEntryRecord, type MerchantFault } from '../../packages/merchant-core/src';
import { makeTestConfig, testPrivateKey, testPublicKey } from '../../packages/merchant-core/src/test-support';
import { authorizationSigningBytes, buildQuoteTerms, computeTermsHash, type AuthorizationProof, type Quote as WireQuote } from '../../packages/shopping-contracts/src';

const MERCHANT = 'merchant_coffee_demo';
const CATALOG = 'catalog_coffee_demo';
const networkFetch = globalThis.fetch.bind(globalThis);
type MerchantServer = ReturnType<typeof startCoffeeMerchantServer>;
type Traffic = { path: string; headers: Headers; body?: Record<string, unknown>; status: number };
let directory: string;
let merchant: MerchantServer | undefined;
let api: ReturnType<typeof Bun.serve> | undefined;
let merchantBase: string;
let base: string;
let cookie: string;
let traffic: Traffic[];
let merchantInstance: string | null;
let responseTransform: ((response: Response, path: string) => Promise<Response>) | undefined;
let requestTransform: ((body: Record<string, unknown>, path: string) => void) | undefined;

async function startMerchant(faults: MerchantFault[] = [], catalog?: readonly CatalogEntryRecord[], port = 0, clock?: Clock) {
  const config = { ...makeTestConfig({ databasePath: join(directory, 'merchant.sqlite'), faults }), port };
  merchant = startCoffeeMerchantServer({ config, ...(catalog ? { catalog } : {}), ...(clock ? { clock } : {}) });
  merchantBase = `http://127.0.0.1:${merchant.server.port}`;
  // Port 0 is deliberate in tests. Set the advertised origin before any request.
  config.publicBaseUrl = merchantBase;
  const health = await networkFetch(`${merchantBase}/ocp/health`);
  await health.arrayBuffer();
  merchantInstance = health.headers.get('x-coffee-instance-id');
}
async function startApi(now: () => number = Date.now) {
  const observingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (body) requestTransform?.(body, path);
    const response = await networkFetch(input, { ...init, ...(body ? { body: JSON.stringify(body) } : {}) });
    traffic.push({ path, headers, body, status: response.status });
    return responseTransform ? responseTransform(response, path) : response;
  }) as typeof fetch;
  const coordinator = await createHttpRuntime(join(directory, 'agent'), {
    origin: merchantBase, merchantId: MERCHANT, catalogId: CATALOG,
    issuer: 'agent_a_demo', keyId: 'agent_a_test', privateKey: testPrivateKey(), fetch: observingFetch, now,
  });
  api = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createHandler(coordinator) });
  base = `http://127.0.0.1:${api.port}`;
  if (!cookie) {
    const response = await networkFetch(`${base}/api/config`);
    cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  }
}
beforeEach(async () => {
  const scratch = resolve(import.meta.dir, '../../.codex-tmp');
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(join(scratch, 'ocp-ab-http-'));
  cookie = ''; traffic = []; responseTransform = undefined; requestTransform = undefined;
  await startMerchant(); await startApi();
});
afterEach(async () => {
  await api?.stop(true); api = undefined;
  await merchant?.stop(); merchant = undefined;
  Bun.gc(true); // Release closed bun:sqlite statements before Windows removes the test directory.
  await rm(directory, { recursive: true, force: true });
});
async function call(path: string, body?: unknown, ownCookie = cookie): Promise<Response> {
  return networkFetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    cookie: ownCookie, origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function session(path: string, body?: unknown): Promise<PublicSession> {
  const response = await call(path, body);
  expect(response.status).toBeLessThan(400);
  return response.json();
}
async function ready(query = '拿铁', entry = 'entry_latte', quantity = 1, budget = 3000) {
  const created = await session('/api/sessions', { query, quantity, currency: 'CNY', max_total_minor: budget,
    merchant_id: MERCHANT, fulfillment: 'pickup' });
  await session(`/api/sessions/${created.id}/search`, {});
  return session(`/api/sessions/${created.id}/quote`, { entry_id: entry });
}
function confirmation(value: PublicSession) {
  return { quote_id: value.quote!.quote_id, terms_hash: value.quote!.terms_hash, revision: value.revision };
}
function snapshot() {
  const db = new Database(join(directory, 'merchant.sqlite'), { readonly: true });
  try {
    const count = (table: string) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
    const inventory = db.query<{ available_quantity: number }, [string]>(
      'SELECT available_quantity FROM inventory WHERE entry_id = ?').get('entry_latte')!.available_quantity;
    return { orders: count('orders'), payments: count('payments'), attempts: count('attempts'), inventory };
  } finally { db.close(); }
}
async function restartMerchant(faults: MerchantFault[] = []) {
  const port = merchant!.server.port!;
  const previousInstance = merchantInstance;
  await merchant!.stop(); merchant = undefined;
  await startMerchant(faults, undefined, port);
  expect(merchantInstance).not.toBe(previousInstance);
}
function checkoutCount() { return traffic.filter(value => value.path === '/commerce/v1/checkouts').length; }
const delivery = { recipient: '验收收件人', phone: '13800000000', address: '测试大学一号楼101室' };
async function readyBasket(fulfillment = 'pickup', budget = 5000, second = '美式', secondEntry = 'entry_americano') {
  const created = await session('/api/sessions', { query: `拿铁、${second}`, quantity: 2,
    items: [{ query: '拿铁', quantity: 1 }, { query: second, quantity: 1 }], currency: 'CNY',
    max_total_minor: budget, merchant_id: MERCHANT, fulfillment, ...(fulfillment === 'delivery' ? { delivery } : {}) });
  const searched = await session(`/api/sessions/${created.id}/search`, {});
  expect(searched.candidate_groups).toHaveLength(2);
  return session(`/api/sessions/${created.id}/quote`, { entry_ids: ['entry_latte', secondEntry] });
}
function assertRedacted(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of ['authorization_proof', 'signature', 'private_key', 'idempotency_key', 'payment_reference']) {
    expect(text).not.toContain(secret);
  }
}

describe('A API confirmation → B bootstrap HTTP → independent SQLite', () => {
  test('mixed delivery quotes all lines and one fee, concurrent confirmation and restart preserve the whole order', async () => {
    const quoted = await readyBasket('delivery');
    expect(quoted.phase).toBe('awaiting_confirmation');
    expect(quoted.quote!.items!.map(item => [item.entry_id, item.quantity])).toEqual([['entry_latte', 1], ['entry_americano', 1]]);
    expect(quoted.quote!.total_minor).toBe(3990); expect(quoted.quote!.fees).toHaveLength(1);
    expect(quoted.quote!.delivery).toEqual(delivery); expect(checkoutCount()).toBe(0);
    expect(snapshot().orders).toBe(0);
    const confirmed = await Promise.all(Array.from({ length: 4 }, () => session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))));
    expect(new Set(confirmed.map(value => value.order!.order_id)).size).toBe(1);
    expect(confirmed[0]!.order!.items).toEqual(quoted.quote!.items);
    expect(confirmed[0]!.order!.delivery).toEqual(delivery); expect(confirmed[0]!.order!.fulfillment).toBe('delivery');
    expect(checkoutCount()).toBe(1); expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
    await api!.stop(true); await restartMerchant(); await startApi();
    const recovered = await session(`/api/sessions/${quoted.id}/recover`, {});
    expect(recovered.order).toEqual(confirmed[0]!.order);
    expect((await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).order!.order_id).toBe(recovered.order!.order_id);
    expect(checkoutCount()).toBe(1);
  });
  test('one empty basket group never permits a partial selection or purchase', async () => {
    const created = await session('/api/sessions', { query: '拿铁、脏脏咖啡', quantity: 2,
      items: [{ query: '拿铁', quantity: 1 }, { query: '脏脏咖啡', quantity: 1 }], currency: 'CNY',
      max_total_minor: 10000, merchant_id: MERCHANT, fulfillment: 'pickup' });
    const searched = await session(`/api/sessions/${created.id}/search`, {});
    expect(searched.candidate_groups![0]!.candidates.length).toBeGreaterThan(0);
    expect(searched.candidate_groups![1]!.candidates).toEqual([]);
    expect((await call(`/api/sessions/${created.id}/quote`, { entry_id: 'entry_latte' })).status).toBe(400);
    expect((await call(`/api/sessions/${created.id}/quote`, { entry_ids: ['entry_latte'] })).status).toBe(400);
    expect(snapshot()).toEqual({ orders: 0, payments: 0, attempts: 0, inventory: 12 });
  });
  test('basket selections cannot inject quantities or choose outside their original group', async () => {
    const quoted = await readyBasket();
    for (const body of [{ entry_ids: ['entry_latte', 'entry_americano'], quantity: 99 },
      { entry_id: 'entry_latte', entry_ids: ['entry_latte', 'entry_americano'] },
      { entry_ids: ['entry_americano', 'entry_latte'] }, { entry_ids: [null, 'entry_americano'] }]) {
      expect((await call(`/api/sessions/${quoted.id}/quote`, body)).status).toBe(400);
    }
    expect(checkoutCount()).toBe(0);
  });
  test('whole basket budget includes delivery and cannot be confirmed when the fee pushes it over', async () => {
    const quoted = await readyBasket('delivery', 3900);
    expect(quoted.phase).toBe('failed'); expect(quoted.error!.code).toBe('budget_exceeded');
    expect(quoted.quote!.total_minor).toBe(3990);
    expect((await call(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).status).toBe(409);
    expect(checkoutCount()).toBe(0); expect(snapshot().orders).toBe(0);
  });
  test('a later basket line going out of stock leaves every other line unreserved', async () => {
    const quoted = await readyBasket('pickup', 6000, '冷萃', 'entry_cold_brew');
    merchant!.ctx.db.query("UPDATE inventory SET available_quantity = 0 WHERE entry_id = 'entry_cold_brew'").run();
    const rejected = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(rejected.error!.code).toBe('out_of_stock');
    expect(snapshot().inventory).toBe(12); expect(snapshot().payments).toBe(0); expect(snapshot().orders).toBe(0);
    expect(merchant!.ctx.db.query<{ n: number }, []>('SELECT COUNT(*) n FROM inventory_reservations').get()!.n).toBe(0);
  });
  test('declined payment releases every mixed basket line', async () => {
    await restartMerchant(['payment_declined']);
    const quoted = await readyBasket('delivery');
    const failed = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(failed.error!.code).toBe('payment_failed'); expect(snapshot().inventory).toBe(12); expect(snapshot().orders).toBe(0);
    const stock = merchant!.ctx.db.query<{ available_quantity: number }, []>("SELECT available_quantity FROM inventory WHERE entry_id = 'entry_americano'").get()!;
    expect(stock.available_quantity).toBe(30);
    const reservations = merchant!.ctx.db.query<{ state: string }, []>('SELECT state FROM inventory_reservations').all();
    expect(reservations).toHaveLength(2); expect(reservations.every(row => row.state === 'released')).toBe(true);
  });
  test('mixed delivery lost response recovers one order and blocks a new flow until recovery', async () => {
    await restartMerchant(['response_dropped_after_settlement']);
    const quoted = await readyBasket('delivery');
    const unknown = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(unknown.phase).toBe('unknown'); expect(snapshot().orders).toBe(1);
    expect((await call('/api/sessions', { query: '拿铁', quantity: 1, currency: 'CNY', max_total_minor: 3000,
      merchant_id: MERCHANT, fulfillment: 'pickup' })).status).toBe(409);
    const recovered = await session(`/api/sessions/${quoted.id}/recover`, {});
    expect(recovered.phase).toBe('confirmed'); expect(recovered.order!.delivery).toEqual(delivery);
    expect(recovered.order!.items).toEqual(quoted.quote!.items); expect(checkoutCount()).toBe(1);
  });
  test('changed delivery address invalidates the original authorization', async () => {
    const quoted = await readyBasket('delivery');
    const row = merchant!.ctx.db.query<{ quote_json: string }, [string]>('SELECT quote_json FROM quotes WHERE quote_id = ?').get(quoted.quote!.quote_id)!;
    const wire = JSON.parse(row.quote_json) as WireQuote;
    wire.fulfillment.delivery!.address = '测试大学二号楼202室';
    wire.terms_hash = computeTermsHash(buildQuoteTerms(wire));
    merchant!.ctx.db.query('UPDATE quotes SET quote_json = ?, terms_hash = ? WHERE quote_id = ?').run(JSON.stringify(wire), wire.terms_hash, wire.quote_id);
    const rejected = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(rejected.phase).toBe('requote_required'); expect(snapshot().orders).toBe(0); expect(snapshot().inventory).toBe(12);
  });
  test('delivery requires valid user details and filters pickup-only merchandise', async () => {
    for (const details of [undefined, { ...delivery, phone: 'bad-phone' }, { ...delivery, address: '' }]) {
      expect((await call('/api/sessions', { query: '拿铁', quantity: 1, currency: 'CNY', max_total_minor: 3000,
        merchant_id: MERCHANT, fulfillment: 'delivery', ...(details ? { delivery: details } : {}) })).status).toBe(400);
    }
    const pickup = await session('/api/sessions', { query: '手冲礼盒', quantity: 1, currency: 'CNY', max_total_minor: 10000,
      merchant_id: MERCHANT, fulfillment: 'pickup' });
    expect((await session(`/api/sessions/${pickup.id}/search`, {})).candidates.map(item => item.entry_id)).toEqual(['entry_gift_box']);
    const created = await session('/api/sessions', { query: '手冲礼盒', quantity: 1, currency: 'CNY', max_total_minor: 10000,
      merchant_id: MERCHANT, fulfillment: 'delivery', delivery });
    expect((await session(`/api/sessions/${created.id}/search`, {})).candidates).toEqual([]);
    expect(checkoutCount()).toBe(0);
  });
  test('requires user confirmation, carries header metadata, and concurrent clicks settle only once', async () => {
    const config = await (await call('/api/config')).json();
    expect(config.mode).toBe('http');
    const health = await networkFetch(`${merchantBase}/ocp/health`);
    await health.arrayBuffer();
    expect(health.headers.get('connection')).toBe('close');
    const quoted = await ready();
    expect(quoted.phase).toBe('awaiting_confirmation');
    expect(quoted.quote!.total_minor).toBe(2500);
    expect(snapshot()).toEqual({ orders: 0, payments: 0, attempts: 0, inventory: 12 });
    expect(checkoutCount()).toBe(0);
    // Model-like approval text does not satisfy the actual API confirmation.
    expect((await call(`/api/sessions/${quoted.id}/confirm`, { approved: true, message: '模型已批准' })).status).toBe(400);
    expect(checkoutCount()).toBe(0);
    const results = await Promise.all(Array.from({ length: 5 }, () => session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))));
    expect(new Set(results.map(value => value.order!.order_id)).size).toBe(1);
    expect(results[0]!.phase).toBe('confirmed');
    expect(results[0]!.order!.payment_status).toBe('paid');
    expect(results[0]!.order!.fulfillment_status).toBe('pending');
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
    const checkout = traffic.find(value => value.path === '/commerce/v1/checkouts')!;
    expect(checkout.status).toBe(200);
    expect(checkout.headers.get('idempotency-key')).toBeTruthy();
    expect(checkout.headers.get('x-dev-caller-id')).toBe(cookie.split('=')[1]!);
    expect(Object.keys(checkout.body!).sort()).toEqual(['authorization', 'purchase_attempt_id', 'quote_id', 'terms_hash']);
    expect((checkout.body!.authorization as AuthorizationProof).payload.user_id).toBe(cookie.split('=')[1]!);
    assertRedacted(results[0]);
  });
  test('cancel and two-cup over-budget search never checkout or reserve stock', async () => {
    const quoted = await ready();
    expect((await session(`/api/sessions/${quoted.id}/cancel`, {})).phase).toBe('cancelled');
    expect((await call(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).status).toBe(409);
    const created = await session('/api/sessions', { query: '拿铁', quantity: 2, currency: 'CNY', max_total_minor: 3000,
      merchant_id: MERCHANT, fulfillment: 'pickup' });
    expect((await session(`/api/sessions/${created.id}/search`, {})).candidates).toEqual([]);
    expect(checkoutCount()).toBe(0);
    expect(snapshot()).toEqual({ orders: 0, payments: 0, attempts: 0, inventory: 12 });
  });
  test('row 22 is found using actual keyword filters, whose names map back to field refs', async () => {
    const port = merchant!.server.port!;
    await merchant!.stop(); merchant = undefined;
    const raw = Array.from({ length: 22 }, (_, index) => ({
      ...structuredClone(CATALOG_SEED[0]!), entry_id: `latte_${index}`, object_id: `obj_latte_${index}`,
      attributes: { ...structuredClone(CATALOG_SEED[0]!.attributes),
        price: { currency: 'CNY', amount: index === 21 ? 25 : 88 }, price_minor: index === 21 ? 2500 : 8800 },
    }));
    await startMerchant([], loadCatalog(raw), port); await api!.stop(true); await startApi();
    const created = await session('/api/sessions', { query: '拿铁', quantity: 1, currency: 'CNY', max_total_minor: 3000,
      merchant_id: MERCHANT, fulfillment: 'pickup' });
    const searched = await session(`/api/sessions/${created.id}/search`, {});
    expect(searched.candidates.map(value => value.entry_id)).toEqual(['latte_21']);
    const query = traffic.find(value => value.path === '/ocp/query')!;
    expect(query.body!.query_mode).toBe('keyword');
    expect(query.body!.filters).toEqual({ currency: 'CNY', max_amount: 30, in_stock_only: true });
    const manifest = await (await networkFetch(`${merchantBase}/ocp/manifest`)).json();
    const inputs = manifest.query_capabilities[0].input_fields;
    expect(inputs).toContainEqual({ name: 'filters.max_amount', field_ref: 'price#/amount' });
    const quoted = await session(`/api/sessions/${created.id}/quote`, { entry_id: 'latte_21' });
    expect((await session(`/api/sessions/${created.id}/confirm`, confirmation(quoted))).phase).toBe('confirmed');
  });
  test('another session search does not erase an earlier session catalog-backed candidate', async () => {
    const intent = (query: string) => ({ query, quantity: 1, currency: 'CNY', max_total_minor: 3000,
      merchant_id: MERCHANT, fulfillment: 'pickup' });
    const first = await session('/api/sessions', intent('拿铁'));
    const second = await session('/api/sessions', intent('冷萃'));
    expect((await session(`/api/sessions/${first.id}/search`, {})).candidates.map(value => value.entry_id)).toEqual(['entry_latte']);
    expect((await session(`/api/sessions/${second.id}/search`, {})).candidates.map(value => value.entry_id)).toEqual(['entry_cold_brew']);
    const quoted = await session(`/api/sessions/${first.id}/quote`, { entry_id: 'entry_latte' });
    expect(quoted.phase).toBe('awaiting_confirmation');
    expect((await session(`/api/sessions/${first.id}/confirm`, confirmation(quoted))).phase).toBe('confirmed');
  });
  test.each(['wrong_user', 'wrong_issuer'])('a correct signature with %s is rejected before settlement', async kind => {
    requestTransform = (body, path) => {
      if (path !== '/commerce/v1/checkouts') return;
      const proof = body.authorization as AuthorizationProof;
      if (kind === 'wrong_user') proof.payload.user_id = 'another_signed_user';
      else proof.payload.issuer = 'another_signed_issuer';
      proof.signature = sign(null, authorizationSigningBytes(proof.payload), testPrivateKey()).toString('base64url');
    };
    const quoted = await ready();
    const result = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(result.error!.code).toBe('authorization_invalid');
    expect(snapshot()).toEqual({ orders: 0, payments: 0, attempts: 0, inventory: 12 });
  });
  test.each(['expired', 'wrong_merchant', 'wrong_quote', 'wrong_currency', 'wrong_terms', 'wrong_attempt', 'over_budget'])('B rejects a correctly signed %s authorization over the real wire', async kind => {
    requestTransform = (body, path) => {
      if (path !== '/commerce/v1/checkouts') return;
      const proof = body.authorization as AuthorizationProof;
      if (kind === 'expired') { proof.payload.issued_at -= 120; proof.payload.expires_at -= 120; }
      if (kind === 'wrong_merchant') proof.payload.merchant_id = 'different_merchant';
      if (kind === 'wrong_quote') proof.payload.quote_id = 'quote_other';
      if (kind === 'wrong_currency') proof.payload.currency = 'USD';
      if (kind === 'wrong_attempt') proof.payload.purchase_attempt_id = 'attempt_other';
      if (kind === 'wrong_terms') proof.payload.terms_hash = '0'.repeat(64);
      if (kind === 'over_budget') proof.payload.max_total_minor = 2400;
      proof.signature = sign(null, authorizationSigningBytes(proof.payload), testPrivateKey()).toString('base64url');
    };
    const quoted = await ready();
    const result = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(result.error!.code).toBe(kind === 'over_budget' ? 'budget_exceeded' : kind === 'wrong_terms' ? 'requote_required' : 'authorization_invalid');
    expect(snapshot()).toEqual({ orders: 0, payments: 0, attempts: 0, inventory: 12 });
  });
  test('a proof replayed under a different attempt is rejected without another signature or payment', async () => {
    requestTransform = (body, path) => {
      if (path === '/commerce/v1/checkouts') body.purchase_attempt_id = 'attempt_replayed';
    };
    const quoted = await ready();
    const result = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(result.error!.code).toBe('authorization_invalid');
    expect(snapshot()).toEqual({ orders: 0, payments: 0, attempts: 0, inventory: 12 });
  });
  test('the actual A checkout wire retries sequentially and concurrently with the same key, including after B restarts', async () => {
    const quoted = await ready();
    const first = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    const wire = traffic.find(value => value.path === '/commerce/v1/checkouts')!;
    const replay = () => networkFetch(`${merchantBase}/commerce/v1/checkouts`, {
      method: 'POST', headers: wire.headers, body: JSON.stringify(wire.body),
    });
    const sequential = await replay(); expect(sequential.status).toBe(200);
    expect((await sequential.json()).order.order_id).toBe(first.order!.order_id);
    const duplicates = await Promise.all(Array.from({ length: 6 }, replay));
    for (const duplicate of duplicates) {
      expect(duplicate.status).toBe(200);
      expect((await duplicate.json()).order.order_id).toBe(first.order!.order_id);
    }
    await restartMerchant();
    const afterRestart = await replay(); expect(afterRestart.status).toBe(200);
    expect((await afterRestart.json()).order.order_id).toBe(first.order!.order_id);
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
  });
  test.each(['quote_id', 'terms_hash', 'purchase_attempt_id'])('the same key with changed %s conflicts against the original A checkout wire', async field => {
    const quoted = await ready();
    const first = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    const wire = traffic.find(value => value.path === '/commerce/v1/checkouts')!;
    const changed = { ...wire.body, [field]: field === 'terms_hash' ? '0'.repeat(64) : 'another_id' };
    const response = await networkFetch(`${merchantBase}/commerce/v1/checkouts`, {
      method: 'POST', headers: wire.headers, body: JSON.stringify(changed),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('idempotency_conflict');
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
    expect((await session(`/api/sessions/${quoted.id}/recover`, {})).order!.order_id).toBe(first.order!.order_id);
  });
  test.each(['quantity', 'fulfillment'])('merchant changing stored %s terms invalidates the original confirmed quote', async field => {
    const quoted = await ready();
    const row = merchant!.ctx.db.query<{ quote_json: string }, [string]>('SELECT quote_json FROM quotes WHERE quote_id = ?').get(quoted.quote!.quote_id)!;
    const wire = JSON.parse(row.quote_json) as WireQuote;
    if (field === 'quantity') {
      wire.items[0]!.quantity = 2; wire.items[0]!.line_total_minor *= 2;
      wire.subtotal_minor *= 2; wire.total_minor *= 2;
    } else {
      wire.fulfillment.method = 'delivery';
      wire.fees = [{ code: 'delivery', label: '配送费', amount_minor: 500 }]; wire.total_minor += 500;
    }
    wire.terms_hash = computeTermsHash(buildQuoteTerms(wire));
    // This changes B's authoritative test-only quote, keeping its arithmetic
    // and hash consistent; the user's approval remains bound to the old terms.
    merchant!.ctx.db.query('UPDATE quotes SET quote_json = ?, terms_hash = ? WHERE quote_id = ?')
      .run(JSON.stringify(wire), wire.terms_hash, wire.quote_id);
    const result = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(result.phase).toBe('requote_required'); expect(result.error!.code).toBe('requote_required');
    expect(snapshot()).toEqual({ orders: 0, payments: 0, attempts: 0, inventory: 12 });
  });
  test('B checks quote expiry using an injected clock without waiting for the TTL', async () => {
    const clock = manualClock(Date.now());
    const port = merchant!.server.port!; await merchant!.stop(); merchant = undefined;
    await startMerchant([], undefined, port, clock);
    const quoted = await ready();
    clock.advance(901_000);
    const result = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(result.phase).toBe('requote_required'); expect(result.error!.code).toBe('quote_expired');
    expect(checkoutCount()).toBe(1);
    expect(snapshot()).toEqual({ orders: 0, payments: 0, attempts: 0, inventory: 12 });
  });
  test('a sub-second remaining authorization window requires a new quote before checkout', async () => {
    let current = Math.floor(Date.now() / 1000) * 1000 + 100;
    const port = merchant!.server.port!; await merchant!.stop(); merchant = undefined;
    await startMerchant([], undefined, port, manualClock(current));
    await api!.stop(true); await startApi(() => current);
    const quoted = await ready();
    current = Math.floor(Date.parse(quoted.quote!.expires_at) / 1000) * 1000;
    const result = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(result.phase).toBe('requote_required'); expect(result.error!.code).toBe('requote_required');
    expect(checkoutCount()).toBe(0);
    expect(snapshot()).toEqual({ orders: 0, payments: 0, attempts: 0, inventory: 12 });
  });
  test('requote archives a definite rejection and requires a new revision and confirmation', async () => {
    await restartMerchant(['price_raised_after_quote']);
    const quoted = await ready();
    const rejected = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(rejected.phase).toBe('requote_required');
    expect(rejected.error!.code).toBe('requote_required');
    await restartMerchant();
    const fresh = await session(`/api/sessions/${quoted.id}/quote`, { entry_id: 'entry_latte' });
    expect(fresh.phase).toBe('awaiting_confirmation');
    expect(fresh.quote!.quote_id).not.toBe(quoted.quote!.quote_id);
    expect(fresh.revision).toBeGreaterThan(quoted.revision);
    expect(fresh.attempt_history).toHaveLength(1);
    expect((await call(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).status).toBe(409);
    expect((await session(`/api/sessions/${quoted.id}/confirm`, confirmation(fresh))).phase).toBe('confirmed');
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
  });
  test('202 retains the same attempt and reservation across both services restarting', async () => {
    await restartMerchant(['payment_timeout_then_succeed']);
    const quoted = await ready();
    const unknown = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(unknown.phase).toBe('unknown');
    expect(traffic.find(value => value.path === '/commerce/v1/checkouts')!.status).toBe(202);
    expect(snapshot()).toEqual({ orders: 0, payments: 0, attempts: 1, inventory: 11 });
    for (const action of ['search', 'cancel', 'quote']) {
      expect((await call(`/api/sessions/${quoted.id}/${action}`, action === 'quote' ? { entry_id: 'entry_latte' } : {})).status).toBe(409);
    }
    await api!.stop(true); await restartMerchant(); await startApi();
    const recovered = await session(`/api/sessions/${quoted.id}/recover`, {});
    expect(recovered.phase).toBe('confirmed');
    expect(recovered.attempt!.purchase_attempt_id).toBe(unknown.attempt!.purchase_attempt_id);
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
    expect(checkoutCount()).toBe(1); assertRedacted(recovered);
  });
  test('unknown results cannot be bypassed by another same-user A session, even after A restarts', async () => {
    // Prepare two separate quoted sessions before the first becomes unknown.
    const first = await ready();
    const second = await ready();
    await restartMerchant(['payment_timeout_then_succeed']);
    const unknown = await session(`/api/sessions/${first.id}/confirm`, confirmation(first));
    expect(unknown.phase).toBe('unknown');
    const newIntent = { query: '拿铁', quantity: 1, currency: 'CNY', max_total_minor: 3000,
      merchant_id: MERCHANT, fulfillment: 'pickup' };
    for (const restarting of [false, true]) {
      if (restarting) { await api!.stop(true); await startApi(); }
      expect((await call('/api/sessions', newIntent)).status).toBe(409);
      expect((await call(`/api/sessions/${second.id}/search`, {})).status).toBe(409);
      expect((await call(`/api/sessions/${second.id}/quote`, { entry_id: 'entry_latte' })).status).toBe(409);
      expect((await call(`/api/sessions/${second.id}/confirm`, confirmation(second))).status).toBe(409);
      expect(checkoutCount()).toBe(1);
    }
    expect((await session(`/api/sessions/${first.id}/recover`, {})).phase).toBe('confirmed');
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
  });
  test('lost settlement response survives restart; duplicate confirmation cannot pay twice', async () => {
    await restartMerchant(['response_dropped_after_settlement']);
    const quoted = await ready();
    const unknown = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(unknown.phase).toBe('unknown');
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
    await api!.stop(true); await restartMerchant(); await startApi();
    const recovered = await session(`/api/sessions/${quoted.id}/recover`, {});
    expect(recovered.phase).toBe('confirmed');
    const duplicate = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(duplicate.order!.order_id).toBe(recovered.order!.order_id);
    expect(checkoutCount()).toBe(1);
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
  });
  test.each(['not_found', 'malformed_order'])('recovery %s preserves unknown and blocks a new purchase', async kind => {
    await restartMerchant(['response_dropped_after_settlement']);
    const quoted = await ready();
    const unknown = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    responseTransform = async (response, path) => {
      if (kind === 'not_found' && path.includes('/purchase-attempts/')) return Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
      if (kind === 'malformed_order' && path.includes('/orders/')) return Response.json({ order: { payment: 'paid' } });
      return response;
    };
    const result = await session(`/api/sessions/${quoted.id}/recover`, {});
    expect(result.phase).toBe('unknown');
    expect(result.diagnostic!.category).toBe(kind === 'not_found' ? 'not_found' : 'protocol');
    expect(result.attempt!.purchase_attempt_id).toBe(unknown.attempt!.purchase_attempt_id);
    expect((await call(`/api/sessions/${quoted.id}/cancel`, {})).status).toBe(409);
    expect((await call(`/api/sessions/${quoted.id}/quote`, { entry_id: 'entry_latte' })).status).toBe(409);
    expect(checkoutCount()).toBe(1);
    responseTransform = undefined;
    expect((await session(`/api/sessions/${quoted.id}/recover`, {})).phase).toBe('confirmed');
    assertRedacted(result);
  });
  test('malformed error after actual settlement stays unknown and recovers the original order', async () => {
    responseTransform = async (response, path) => path === '/commerce/v1/checkouts'
      ? Response.json({ error: { code: 403, message: { unsafe: 'malformed secret-like text' } } }, { status: 401 }) : response;
    const quoted = await ready();
    const result = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(result.phase).toBe('unknown'); expect(result.diagnostic!.category).toBe('protocol');
    expect(JSON.stringify(result)).not.toContain('malformed secret-like text');
    expect((await call(`/api/sessions/${quoted.id}/search`, {})).status).toBe(409);
    responseTransform = undefined;
    expect((await session(`/api/sessions/${quoted.id}/recover`, {})).phase).toBe('confirmed');
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
    expect(checkoutCount()).toBe(1);
  });
  test.each([
    ['amount', 'failed'], ['amount', 'processing'], ['hash', 'failed'], ['hash', 'processing'],
    ['shape', 'failed'], ['shape', 'processing'],
  ])('200 confirmed attempt with invalid order %s cannot regress to %s and unlock repurchase', async (invalid, later) => {
    responseTransform = async (response, path) => {
      if (path === '/commerce/v1/checkouts') {
        const value = await response.json();
        if (invalid === 'amount') value.order.total_minor += 1;
        else if (invalid === 'hash') value.order.terms_hash = '0'.repeat(64);
        else value.order.payment = 'paid';
        return Response.json(value, { status: 200 });
      }
      if (path.includes('/purchase-attempts/')) {
        const value = await response.json();
        value.status = later; delete value.order_id;
        if (later === 'failed') value.error = { code: 'payment_failed', message: 'declined' };
        else delete value.error;
        return Response.json(value);
      }
      return response;
    };
    const quoted = await ready();
    const unknown = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(unknown.phase).toBe('unknown'); expect(unknown.order).toBeUndefined();
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
    const recovered = await session(`/api/sessions/${quoted.id}/recover`, {});
    expect(recovered.phase).toBe('unknown'); expect(recovered.order).toBeUndefined();
    expect(recovered.attempt!.purchase_attempt_id).toBe(unknown.attempt!.purchase_attempt_id);
    for (const action of ['cancel', 'search', 'quote']) {
      expect((await call(`/api/sessions/${quoted.id}/${action}`, action === 'quote' ? { entry_id: 'entry_latte' } : {})).status).toBe(409);
    }
    expect(checkoutCount()).toBe(1);
    responseTransform = undefined;
    const original = await session(`/api/sessions/${quoted.id}/recover`, {});
    expect(original.phase).toBe('confirmed');
    expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
  });
  test('two independent sessions compete for the actual last item, and stock stays sold after restart', async () => {
    const [first, second] = await Promise.all([ready('冷萃', 'entry_cold_brew'), ready('冷萃', 'entry_cold_brew')]);
    const results = await Promise.all([session(`/api/sessions/${first.id}/confirm`, confirmation(first)),
      session(`/api/sessions/${second.id}/confirm`, confirmation(second))]);
    expect(results.filter(value => value.phase === 'confirmed')).toHaveLength(1);
    expect(results.filter(value => value.error?.code === 'out_of_stock')).toHaveLength(1);
    expect(snapshot().orders).toBe(1); expect(snapshot().payments).toBe(1);
    await restartMerchant();
    const created = await session('/api/sessions', { query: '冷萃', quantity: 1, currency: 'CNY', max_total_minor: 3000,
      merchant_id: MERCHANT, fulfillment: 'pickup' });
    expect((await session(`/api/sessions/${created.id}/search`, {})).candidates).toEqual([]);
  });
  test('a definite mock payment failure creates no order and returns reserved stock', async () => {
    await restartMerchant(['payment_declined']);
    const quoted = await ready();
    const failed = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(failed.phase).toBe('failed'); expect(failed.error!.code).toBe('payment_failed');
    expect(failed.order).toBeUndefined();
    expect(snapshot()).toEqual({ orders: 0, payments: 1, attempts: 1, inventory: 12 });
  });
  test('foreign callers cannot read A sessions or B attempt/order resources', async () => {
    const quoted = await ready();
    const result = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect((await call(`/api/sessions/${quoted.id}`, undefined, 'ocp_shopping_session=' + 'b'.repeat(64))).status).toBe(404);
    for (const path of [`/commerce/v1/purchase-attempts/${result.attempt!.purchase_attempt_id}`, `/commerce/v1/orders/${result.order!.order_id}`]) {
      expect((await networkFetch(`${merchantBase}${path}`, { headers: { 'x-dev-caller-id': 'foreign_user' } })).status).toBe(404);
    }
  });
  test('actual CLI forced termination recovers persisted payment/order/idempotency and inventory', async () => {
    const port = merchant!.server.port!;
    await merchant!.stop(); merchant = undefined;
    merchantBase = `http://127.0.0.1:${port}`;
    const keys = join(directory, 'trusted-keys.json');
    await writeFile(keys, JSON.stringify({ agent_a_test: { public_key_pem: testPublicKey().export({ type: 'spki', format: 'pem' }), issuer: 'agent_a_demo' } }));
    const root = resolve(import.meta.dir, '../..');
    const spawn = () => Bun.spawn([process.execPath, join(root, 'apps/coffee-merchant-api/src/server.ts')], {
      cwd: directory, env: { ...process.env, MERCHANT_HOST: '127.0.0.1', MERCHANT_PORT: String(port),
        MERCHANT_PUBLIC_BASE_URL: merchantBase, MERCHANT_DB_PATH: join(directory, 'merchant.sqlite'),
        MERCHANT_TRUSTED_KEYS_PATH: keys, MERCHANT_ALLOWED_ORIGINS: '', MERCHANT_TEST_MODE: '0', MERCHANT_FAULTS: '' },
      stdout: 'ignore', stderr: 'pipe',
    });
    let child = spawn();
    async function listening() {
      for (let i = 0; i < 60; i++) {
        try { if ((await networkFetch(`${merchantBase}/ocp/health`)).ok) return; } catch { /* process has not bound yet */ }
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        await Bun.sleep(25);
      }
      throw new Error('merchant CLI did not listen');
    }
    try {
      await listening(); await api!.stop(true); await startApi();
      const quoted = await ready();
      const settled = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
      expect(settled.phase).toBe('confirmed');
      child.kill('SIGKILL'); await child.exited;
      child = spawn(); await listening();
      await api!.stop(true); await startApi();
      const recovered = await session(`/api/sessions/${quoted.id}/recover`, {});
      expect(recovered.order!.order_id).toBe(settled.order!.order_id);
      expect((await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).order!.order_id).toBe(settled.order!.order_id);
      expect(snapshot()).toEqual({ orders: 1, payments: 1, attempts: 1, inventory: 11 });
    } finally { child.kill('SIGKILL'); await child.exited; }
  }, 15000);
});
