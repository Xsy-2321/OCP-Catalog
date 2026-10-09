import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { computeQuoteTermsHash, type Order } from '@ocp-catalog/shopping-contracts';
import { runCheckout } from './checkout';
import type { MerchantContext } from './context';
import { createMerchantDemoReader } from './merchant-read';
import { buildOrder, getAttempt, insertOrder } from './orders';
import { buildQuote, insertQuote } from './quote';
import { authorizationFor, makeTempDatabasePath, makeTestContext, openTestDb, TEST_NOW_MS } from './test-support';

const DELIVERY = { recipient: '测试收件人', phone: '13800138000', address: '杭州市西湖区测试路1号' };
const CALLER = 'user_demo_1';

function withDb(work: (ctx: MerchantContext, db: Database) => void): void {
  const temporary = makeTempDatabasePath();
  const db = openTestDb(temporary.path);
  try { work(makeTestContext({ db }), db); }
  finally { db.close(); temporary.cleanup(); }
}

function storedOrder(ctx: MerchantContext, id: string, createdAt = TEST_NOW_MS, scope: Partial<Order> = {}, caller = CALLER): Order {
  const quote = buildQuote(ctx.catalog, {
    items: [{ entry_id: 'entry_latte', quantity: 1 }, { entry_id: 'entry_americano', quantity: 2 }],
    fulfillment: { method: 'delivery', delivery: DELIVERY },
  }, { config: ctx.config, nowMs: createdAt });
  const order = { ...buildOrder({ quote, purchaseAttemptId: `attempt_${id}`, paymentStatus: 'succeeded',
    fulfillmentStatus: 'pending', nowMs: createdAt }), order_id: id, ...scope };
  insertOrder(ctx.db, order, caller);
  return order;
}

function changes(db: Database): number {
  return db.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
}

describe('local merchant demo read capability', () => {
  test('existing databases gain the scoped order page index and use it for first and cursor pages', () => {
    const temporary = makeTempDatabasePath();
    let db = openTestDb(temporary.path);
    try {
      db.exec('DROP INDEX orders_merchant_catalog_page_idx');
      db.close();
      db = openTestDb(temporary.path);
      const columns = db.query<{ name: string; desc: number }, []>('PRAGMA index_xinfo(orders_merchant_catalog_page_idx)').all();
      expect(columns.filter(column => column.name !== null).map(column => [column.name, column.desc]))
        .toEqual([['merchant_id', 0], ['catalog_id', 0], ['created_at_ms', 1], ['order_id', 1]]);
      for (const predicate of ['', 'AND (created_at_ms, order_id) < (1000, \'order_z\')']) {
        const plans = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN
          SELECT order_id, created_at_ms, order_json FROM orders
          WHERE merchant_id = 'merchant_demo' AND catalog_id = 'catalog_demo' ${predicate}
          ORDER BY created_at_ms DESC, order_id DESC LIMIT 21`).all().map(row => row.detail);
        expect(plans.some(plan => plan.includes('USING INDEX orders_merchant_catalog_page_idx'))).toBe(true);
        expect(plans.some(plan => plan.includes('TEMP B-TREE'))).toBe(false);
      }
    } finally { db.close(); temporary.cleanup(); }
  });

  test('reads scoped SQLite orders across callers and redacts delivery details from summaries', () => {
    withDb((ctx, db) => {
      const own = storedOrder(ctx, 'order_own', TEST_NOW_MS);
      storedOrder(ctx, 'order_other_caller', TEST_NOW_MS + 1, {}, 'another_customer');
      storedOrder(ctx, 'order_foreign_merchant', TEST_NOW_MS + 2, { merchant_id: 'other_merchant' });
      storedOrder(ctx, 'order_foreign_catalog', TEST_NOW_MS + 3, { catalog_id: 'other_catalog' });
      const reader = createMerchantDemoReader(ctx);
      const before = changes(db);
      const page = reader.orders();
      expect(page.total).toBe(2);
      expect(page.items.map(order => order.order_id)).toEqual(['order_other_caller', 'order_own']);
      expect(page.items[1]!.items).toEqual(own.items);
      expect(page.items[1]!.fees).toEqual(own.fees);
      expect(page.items[1]!.total_minor).toBe(4980);
      expect(page.items[1]!.fulfillment).toEqual({ method: 'delivery' });
      for (const secret of [DELIVERY.recipient, DELIVERY.phone, DELIVERY.address, 'caller_id', 'payment_key', 'reference']) {
        expect(JSON.stringify(page)).not.toContain(secret);
      }
      expect(reader.order(own.order_id)).toEqual(own);
      expect(() => reader.order('order_foreign_merchant')).toThrow();
      expect(() => reader.order('order_foreign_catalog')).toThrow();
      expect(() => reader.order('order_missing')).toThrow();
      expect(changes(db)).toBe(before);
      expect(Object.keys(reader).sort()).toEqual(['order', 'orders', 'overview', 'products']);
    });
  });

  test('shows fresh available and reserved stock, keeps sold-out products and preserves null quantities', () => {
    withDb((ctx, db) => {
      const quote = buildQuote(ctx.catalog, { entry_id: 'entry_latte', quantity: 2,
        fulfillment: { method: 'pickup' } }, { config: ctx.config, nowMs: TEST_NOW_MS });
      insertQuote(db, quote, CALLER);
      const pending = makeTestContext({ db, faults: ['payment_timeout_then_succeed'] });
      runCheckout(pending, { purchase_attempt_id: 'attempt_read_pending', quote_id: quote.quote_id,
        terms_hash: quote.terms_hash, authorization: authorizationFor(quote, { purchaseAttemptId: 'attempt_read_pending' }) },
      { callerId: CALLER, idempotencyKey: 'key_read_pending' });
      db.query('UPDATE inventory SET available_quantity = NULL WHERE merchant_id = ? AND entry_id = ?')
        .run(ctx.config.merchantId, 'entry_americano');
      const reader = createMerchantDemoReader(ctx);
      const before = changes(db);
      const products = reader.products();
      expect(products.total).toBe(5);
      expect(products.items.find(product => product.entry_id === 'entry_latte')!.inventory)
        .toEqual({ availability_status: 'in_stock', available_quantity: 10, reserved_quantity: 2 });
      expect(products.items.find(product => product.entry_id === 'entry_soldout')!.inventory)
        .toEqual({ availability_status: 'out_of_stock', available_quantity: 0, reserved_quantity: 0 });
      expect(products.items.find(product => product.entry_id === 'entry_americano')!.inventory.available_quantity).toBeNull();
      const overview = reader.overview();
      expect(overview).toMatchObject({ read_only: true, merchant_id: ctx.config.merchantId, catalog_id: ctx.config.catalogId,
        payment_mode: 'local_simulated', fulfillment_mode: 'local_simulated', checked_at: new Date(TEST_NOW_MS).toISOString() });
      expect(overview.orders.total).toBe(0);
      expect(getAttempt(db, 'attempt_read_pending')!.status).toBe('processing');
      expect(getAttempt(db, 'attempt_read_pending')!.pending_settlement).toBe(1);
      expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM payments').get()!.n).toBe(0);
      expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM orders').get()!.n).toBe(0);
      expect(changes(db)).toBe(before);
    });
  });

  test('orders retain their stored snapshot after the current catalog changes', () => {
    withDb((ctx, db) => {
      const order = storedOrder(ctx, 'order_snapshot');
      const changed = { ...ctx, catalog: ctx.catalog.map(record => ({ ...record,
        entry: { ...record.entry, title: '已改名的商品' }, attributes: { ...record.attributes, price_minor: 123 } })) };
      const reader = createMerchantDemoReader(changed);
      expect(reader.order(order.order_id)).toEqual(order);
      expect(reader.orders().items[0]!.items).toEqual(order.items);
      expect(reader.orders().items[0]!.total_minor).toBe(order.total_minor);
      expect(reader.products().items[0]!.price_minor).toBe(123);
    });
  });

  test('stable product and order cursors paginate without duplication and preserve total', () => {
    withDb((ctx, db) => {
      storedOrder(ctx, 'order_a'); storedOrder(ctx, 'order_b'); storedOrder(ctx, 'order_c', TEST_NOW_MS + 1);
      const reader = createMerchantDemoReader(ctx);
      const first = reader.products({ limit: 2 });
      const second = reader.products({ limit: 2, cursor: first.next_cursor! });
      const third = reader.products({ limit: 2, cursor: second.next_cursor! });
      expect(first.total).toBe(5); expect(second.total).toBe(5); expect(third.total).toBe(5);
      expect([...first.items, ...second.items, ...third.items].map(product => product.entry_id))
        .toEqual(['entry_americano', 'entry_cold_brew', 'entry_gift_box', 'entry_latte', 'entry_soldout']);
      expect(third.has_more).toBe(false); expect(third.next_cursor).toBeNull();
      const orders = reader.orders({ limit: 1 });
      const next = reader.orders({ limit: 1, cursor: orders.next_cursor! });
      const final = reader.orders({ limit: 1, cursor: next.next_cursor! });
      expect([orders.items[0]!.order_id, next.items[0]!.order_id, final.items[0]!.order_id]).toEqual(['order_c', 'order_b', 'order_a']);
      expect(final.total).toBe(3); expect(final.has_more).toBe(false); expect(final.next_cursor).toBeNull();
      expect(reader.products({ query: '拿铁' }).items.map(product => product.entry_id)).toEqual(['entry_latte']);
    });
  });

  test('rejects invalid parameters, crossed cursors and client-controlled scope', () => {
    withDb(ctx => {
      const reader = createMerchantDemoReader(ctx);
      for (const limit of [0, -1, 1.5, 51, Infinity, NaN]) {
        expect(() => reader.products({ limit })).toThrow();
        expect(() => reader.orders({ limit })).toThrow();
      }
      for (const cursor of ['', 'not+base64', 'a'.repeat(2049), Buffer.from('{}').toString('base64url')]) {
        expect(() => reader.products({ cursor })).toThrow();
        expect(() => reader.orders({ cursor })).toThrow();
      }
      const productCursor = reader.products({ limit: 1 }).next_cursor!;
      expect(() => reader.orders({ cursor: productCursor })).toThrow();
      expect(() => reader.products({ query: '拿铁', cursor: productCursor })).toThrow();
      expect(() => reader.products({ query: 'a'.repeat(121) })).toThrow();
      expect(() => reader.products({ merchant_id: 'other' } as never)).toThrow();
      expect(() => reader.orders({ caller_id: 'other' } as never)).toThrow();
      expect(() => reader.order('')).toThrow();
      expect(() => reader.order('order_\n')).toThrow();
      const cursor = JSON.parse(Buffer.from(productCursor, 'base64url').toString('utf8'));
      cursor.merchant = 'other_merchant';
      expect(() => reader.products({ cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') })).toThrow();
    });
  });

  test('a catalog entry from another catalog is excluded and corrupt stored scope is refused', () => {
    withDb((ctx, db) => {
      const foreignRecord = { ...ctx.catalog[0]!, entry: { ...ctx.catalog[0]!.entry, entry_id: 'entry_foreign', catalog_id: 'other_catalog' } };
      const reader = createMerchantDemoReader({ ...ctx, catalog: [...ctx.catalog, foreignRecord] });
      expect(reader.products().total).toBe(ctx.catalog.length);
      const order = storedOrder(ctx, 'order_corrupt');
      db.query('UPDATE orders SET order_json = ? WHERE order_id = ?')
        .run(JSON.stringify({ ...order, merchant_id: 'other_merchant' }), order.order_id);
      expect(() => reader.orders()).toThrow('stored merchant order does not match');
      expect(() => reader.order(order.order_id)).toThrow('stored merchant order does not match');
    });
  });

  test('corrupt saved amounts or terms are refused without repairing stored data', () => {
    withDb((ctx, db) => {
      const order = storedOrder(ctx, 'order_amounts');
      const reader = createMerchantDemoReader(ctx);
      const mutations = [
        { ...order, items: order.items.map((item, index) => index === 0 ? { ...item, line_total_minor: item.line_total_minor + 1 } : item) },
        { ...order, subtotal_minor: order.subtotal_minor + 1 },
        { ...order, total_minor: order.total_minor + 1 },
        { ...order, terms_hash: '0'.repeat(64) },
        { ...order, fulfillment: { ...order.fulfillment, delivery: { ...DELIVERY, address: '已改变但未确认的配送地址' } } },
      ];
      for (const changed of mutations) {
        db.query('UPDATE orders SET order_json = ? WHERE order_id = ?').run(JSON.stringify(changed), order.order_id);
        const before = changes(db);
        expect(() => reader.order(order.order_id)).toThrow('inconsistent amounts or terms');
        expect(() => reader.overview()).toThrow('inconsistent amounts or terms');
        expect(changes(db)).toBe(before);
      }
      const inconsistent = { ...order, total_minor: order.total_minor + 1 };
      inconsistent.terms_hash = computeQuoteTermsHash(inconsistent);
      db.query('UPDATE orders SET order_json = ? WHERE order_id = ?').run(JSON.stringify(inconsistent), order.order_id);
      expect(() => reader.orders()).toThrow('inconsistent amounts or terms');
    });
  });
});
