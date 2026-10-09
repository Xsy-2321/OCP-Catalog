import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createHandler } from '../../apps/shopping-agent-api/src/server';
import { startCoffeeMerchantServer } from '../../apps/coffee-merchant-api/src/server';
import { createHttpRuntime, type PublicSession } from '../../packages/agent-runtime/src';
import { createMerchantDemoReader, type MerchantFault } from '../../packages/merchant-core/src';
import { makeTestConfig, testPrivateKey } from '../../packages/merchant-core/src/test-support';

const scratch = resolve(import.meta.dir, '../../.codex-tmp');
const delivery = { recipient: '双端验收收件人', phone: '13800000000', address: '测试大学一号楼101室' };
let directory: string, origin: string, buyerCookie: string, operatorCookie: string;
let merchant: ReturnType<typeof startCoffeeMerchantServer> | undefined;
let api: ReturnType<typeof Bun.serve> | undefined;
let merchantPort = 0, apiPort = 0;

async function start(faults: MerchantFault[] = []) {
  const config = { ...makeTestConfig({ databasePath: join(directory, 'merchant.sqlite'), faults }), port: merchantPort };
  merchant = startCoffeeMerchantServer({ config });
  merchantPort = merchant.server.port!;
  config.publicBaseUrl = `http://127.0.0.1:${merchantPort}`;
  const coordinator = await createHttpRuntime(join(directory, 'agent'), {
    origin: config.publicBaseUrl, merchantId: config.merchantId, catalogId: config.catalogId,
    keyId: 'agent_a_test', issuer: 'agent_a_demo', privateKey: testPrivateKey(),
  });
  api = Bun.serve({ hostname: '127.0.0.1', port: apiPort,
    fetch: createHandler(coordinator, { merchantDemo: createMerchantDemoReader(merchant.ctx) }) });
  apiPort = api.port!; origin = `http://127.0.0.1:${apiPort}`;
  if (!buyerCookie) {
    const response = await fetch(`${origin}/api/config`);
    buyerCookie = response.headers.get('set-cookie')!.split(';')[0]!;
  }
  await enterMerchant();
}
async function enterMerchant() {
  const response = await fetch(`${origin}/merchant`, { headers: { cookie: buyerCookie, origin } });
  expect(response.status).toBe(200);
  operatorCookie = response.headers.get('set-cookie')!.split(';')[0]!;
  expect(operatorCookie).not.toContain('ocp_shopping_session=');
}
async function stop() {
  await api?.stop(true); api = undefined;
  await merchant?.stop(); merchant = undefined;
}
async function call(path: string, body?: unknown, cookie = buyerCookie) {
  return fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function session(path: string, body?: unknown): Promise<PublicSession> {
  const response = await call(path, body); expect(response.status).toBeLessThan(400); return response.json();
}
async function read(path = '/api/merchant-demo/overview') {
  const response = await call(path, undefined, operatorCookie); expect(response.status).toBe(200); return response.json() as Promise<any>;
}
function snapshot() {
  const db = new Database(join(directory, 'merchant.sqlite'), { readonly: true });
  try {
    return {
      orders: db.query<{ n: number }, []>('SELECT COUNT(*) n FROM orders').get()!.n,
      payments: db.query<{ n: number }, []>('SELECT COUNT(*) n FROM payments').get()!.n,
      attempts: db.query<{ n: number }, []>('SELECT COUNT(*) n FROM attempts').get()!.n,
      events: db.query<{ n: number }, []>('SELECT COUNT(*) n FROM purchase_events').get()!.n,
      stock: db.query('SELECT entry_id,availability_status,available_quantity FROM inventory ORDER BY entry_id').all(),
      reservations: db.query('SELECT purchase_attempt_id,entry_id,quantity,state FROM inventory_reservations ORDER BY purchase_attempt_id,entry_id').all(),
      attemptStates: db.query('SELECT purchase_attempt_id,status,order_id,pending_settlement FROM attempts ORDER BY purchase_attempt_id').all(),
    };
  } finally { db.close(); }
}
async function readyBasket(budget = 4000) {
  const created = await session('/api/sessions', { query: '拿铁、美式', quantity: 2,
    items: [{ query: '拿铁', quantity: 1 }, { query: '美式', quantity: 1 }],
    max_total_minor: budget, currency: 'CNY', merchant_id: 'merchant_coffee_demo', fulfillment: 'delivery', delivery });
  await session(`/api/sessions/${created.id}/search`, {});
  return session(`/api/sessions/${created.id}/quote`, { entry_ids: ['entry_latte', 'entry_americano'] });
}
function confirmation(session: PublicSession) {
  return { quote_id: session.quote!.quote_id, terms_hash: session.quote!.terms_hash, revision: session.revision };
}
beforeEach(async () => {
  await mkdir(scratch, { recursive: true }); directory = await mkdtemp(join(scratch, 'merchant-dual-http-'));
  merchantPort = 0; apiPort = 0; buyerCookie = ''; operatorCookie = ''; await start();
});
afterEach(async () => {
  await stop(); Bun.gc(true);
  const suffix = relative(scratch, directory);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('unsafe test directory cleanup');
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe('isolated buyer and read-only merchant preview over real HTTP', () => {
  test('quote creates no order; explicit concurrent confirmation appears once with complete lines, address and real stock', async () => {
    const initial = await read();
    expect(initial.orders.items).toEqual([]); expect(initial.read_only).toBe(true);
    const quoted = await readyBasket();
    expect(quoted.quote!.total_minor).toBe(3990);
    expect((await read()).orders.items).toEqual([]); expect(snapshot().payments).toBe(0);
    for (const id of ['entry_latte', 'entry_americano']) {
      expect((await read()).products.items.find((p: any) => p.entry_id === id).inventory)
        .toEqual(initial.products.items.find((p: any) => p.entry_id === id).inventory);
    }
    const bought = await Promise.all(Array.from({ length: 3 }, () => session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))));
    expect(new Set(bought.map(s => s.order!.order_id)).size).toBe(1);
    const view = await read(); expect(view.orders.total).toBe(1);
    const order = view.orders.items[0]; expect(order.order_id).toBe(bought[0]!.order!.order_id);
    expect(order.items.map((i: any) => [i.entry_id, i.quantity])).toEqual([['entry_latte', 1], ['entry_americano', 1]]);
    expect(order.total_minor).toBe(3990); expect(order.fees).toHaveLength(1);
    expect(order.payment.status).toBe('paid'); expect(order.fulfillment_status.status).toBe('pending');
    expect(order.fulfillment).not.toHaveProperty('delivery');
    const detail = await read(`/api/merchant-demo/orders/${order.order_id}`);
    expect(detail.fulfillment.delivery).toEqual(delivery);
    for (const id of ['entry_latte', 'entry_americano']) {
      expect(view.products.items.find((p: any) => p.entry_id === id).inventory.available_quantity)
        .toBe(initial.products.items.find((p: any) => p.entry_id === id).inventory.available_quantity - 1);
    }
    const after = snapshot();
    for (let i = 0; i < 3; i++) { await read(); await read(`/api/merchant-demo/orders/${order.order_id}`); }
    expect(snapshot()).toEqual(after); expect(after.orders).toBe(1); expect(after.payments).toBe(1);
    expect(JSON.stringify(view)).not.toContain(delivery.address); expect(JSON.stringify(view)).not.toContain(delivery.phone);
    for (const secret of ['authorization_proof', 'private_key', 'signature', 'idempotency_key', 'payment_reference', 'caller_id'])
      expect(JSON.stringify(detail)).not.toContain(secret);
  });

  test('buyer cookie is not merchant access, and merchant entry leaves buyer ownership unchanged', async () => {
    const quoted = await readyBasket();
    expect((await call('/api/merchant-demo/orders')).status).toBe(401);
    await enterMerchant(); expect((await session(`/api/sessions/${quoted.id}`)).id).toBe(quoted.id);
    expect((await call(`/api/sessions/${quoted.id}`, undefined, operatorCookie)).status).toBe(404);
    const original = snapshot();
    expect((await call('/api/merchant-demo/overview', {}, operatorCookie)).status).toBe(405);
    expect((await call('/api/merchant-demo/orders?merchant_id=foreign', undefined, operatorCookie)).status).toBe(400);
    expect(snapshot()).toEqual(original);
  });

  test('pending merchant reads never settle payment or release reservations; user recovery remains explicit', async () => {
    await stop(); await start(['payment_timeout_then_succeed']);
    const quoted = await readyBasket(); const pending = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(pending.phase).toBe('unknown');
    const before = snapshot(); expect(before.orders).toBe(0); expect(before.payments).toBe(0);
    expect(before.reservations).toHaveLength(2);
    for (let i = 0; i < 5; i++) { expect((await read()).orders.items).toEqual([]); await read('/api/merchant-demo/products'); }
    expect(snapshot()).toEqual(before);
    const created = await call('/api/sessions', { query: '拿铁', quantity: 1, max_total_minor: 3000,
      currency: 'CNY', merchant_id: 'merchant_coffee_demo', fulfillment: 'pickup' });
    expect(created.status).toBe(409);
    const recovered = await session(`/api/sessions/${quoted.id}/recover`, {});
    expect(recovered.phase).toBe('confirmed'); expect((await read()).orders.items[0].order_id).toBe(recovered.order!.order_id);
    expect(snapshot().orders).toBe(1); expect(snapshot().payments).toBe(1);
  });

  test('a declined payment leaves no merchant order and releases both products', async () => {
    await stop(); await start(['payment_declined']);
    const initial = await read(); const quoted = await readyBasket();
    expect((await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).error!.code).toBe('payment_failed');
    const view = await read(); expect(view.orders.items).toEqual([]);
    expect(view.products.items).toEqual(initial.products.items);
    const before = snapshot(); await read(); expect(snapshot()).toEqual(before);
    expect(before.payments).toBe(1); expect(before.orders).toBe(0);
  });

  test('lost response is visible to the merchant while the buyer remains unknown; same-port restart retains the original purchase', async () => {
    await stop(); await start(['response_dropped_after_settlement']);
    const quoted = await readyBasket(); const unknown = await session(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted));
    expect(unknown.phase).toBe('unknown'); const view = await read(); expect(view.orders.total).toBe(1);
    const id = view.orders.items[0].order_id; const before = snapshot();
    const staleRole = operatorCookie; await stop(); await start();
    expect((await call('/api/merchant-demo/orders', undefined, staleRole)).status).toBe(401);
    expect(snapshot()).toEqual(before); expect((await read()).orders.items[0].order_id).toBe(id);
    const recovered = await session(`/api/sessions/${quoted.id}/recover`, {});
    expect(recovered.order!.order_id).toBe(id); expect(snapshot().orders).toBe(1); expect(snapshot().payments).toBe(1);
  });

  test('over-budget basket cannot create a merchant order or change either inventory line', async () => {
    const before = await read(); const quoted = await readyBasket(3900);
    expect(quoted.error!.code).toBe('budget_exceeded');
    expect((await call(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).status).toBe(409);
    expect((await read()).products.items).toEqual(before.products.items); expect((await read()).orders.total).toBe(0);
    expect(snapshot().payments).toBe(0); expect(snapshot().attempts).toBe(0);
  });
});
