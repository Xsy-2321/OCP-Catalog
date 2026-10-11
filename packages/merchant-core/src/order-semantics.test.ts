import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CommerceError, type Order } from '@ocp-catalog/shopping-contracts';
import { createMerchantDemoReader } from './merchant-read';
import { advanceFulfillment, canAdvanceFulfillment, insertOrder, requireOwnedOrder } from './orders';
import { TEST_NOW_MS, makeTestContext } from './test-support';

const fixture: { cases: { name: string; valid: boolean; order: Order }[] } = JSON.parse(
  readFileSync(new URL('../../../fixtures/shopping/order-conformance.json', import.meta.url), 'utf8'),
);
const caller = 'user_demo_1';

function changes(db: ReturnType<typeof makeTestContext>['db']): number {
  return db.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
}

describe('consumer-facing and merchant reads use the same order snapshot matrix', () => {
  for (const example of fixture.cases) {
    test(example.name, () => {
      const ctx = makeTestContext();
      try {
        insertOrder(ctx.db, example.order, caller);
        const reader = createMerchantDemoReader(ctx);
        const before = changes(ctx.db);
        if (example.valid) {
          expect(requireOwnedOrder(ctx.db, example.order.order_id, caller)).toEqual(example.order);
          expect(reader.order(example.order.order_id)).toEqual(example.order);
          const page = reader.orders();
          expect(page.total).toBe(1);
          expect(page.items[0]!.total_minor).toBe(example.order.total_minor);
          expect(page.items[0]!.items).toEqual(example.order.items);
          expect(page.items[0]!.fees).toEqual(example.order.fees);
          expect(page.items[0]!.fulfillment).not.toHaveProperty('delivery');
        } else {
          expect(() => requireOwnedOrder(ctx.db, example.order.order_id, caller)).toThrow();
          expect(() => reader.order(example.order.order_id)).toThrow();
          expect(() => reader.orders()).toThrow();
        }
        expect(changes(ctx.db)).toBe(before);
      } finally { ctx.db.close(); }
    });
  }

  test('indexed identity and merchant scope are checked independently of valid terms', () => {
    const ctx = makeTestContext();
    try {
      const order = fixture.cases.find(example => example.valid)!.order;
      insertOrder(ctx.db, order, caller);
      const reader = createMerchantDemoReader(ctx);
      ctx.db.query('UPDATE orders SET order_json = ? WHERE order_id = ?').run(
        JSON.stringify({ ...order, order_id: 'ord_other_identity' }), order.order_id,
      );
      expect(() => requireOwnedOrder(ctx.db, order.order_id, caller)).toThrow('indexed identity');
      expect(() => reader.order(order.order_id)).toThrow('indexed scope');
      expect(() => reader.orders()).toThrow('indexed scope');
      ctx.db.query('UPDATE orders SET order_json = ?, merchant_id = ? WHERE order_id = ?').run(
        JSON.stringify(order), 'merchant_other', order.order_id,
      );
      expect(() => requireOwnedOrder(ctx.db, order.order_id, caller)).toThrow('indexed identity');
      expect(() => reader.order(order.order_id)).toThrow();
      expect(reader.orders().items).toEqual([]);
      expect(() => requireOwnedOrder(ctx.db, order.order_id, 'other_caller')).toThrow();
    } finally { ctx.db.close(); }
  });
});

describe('the fulfilment state machine', () => {
  const order = (): Order => structuredClone(
    fixture.cases.find(example => example.valid)!.order,
  );

  test('moves forward through the states it allows, and stamps the time', () => {
    const start = order();
    const ready = advanceFulfillment(start, 'ready', TEST_NOW_MS);
    expect(ready.fulfillment_status.status).toBe('ready');
    expect(ready.fulfillment_status.updated_at).toBe(new Date(TEST_NOW_MS).toISOString());
    expect(advanceFulfillment(ready, 'completed', TEST_NOW_MS).fulfillment_status.status).toBe('completed');
    // A cancellation is reachable from both live states, not only from `pending`.
    expect(advanceFulfillment(start, 'cancelled', TEST_NOW_MS).fulfillment_status.status).toBe('cancelled');
    expect(advanceFulfillment(ready, 'cancelled', TEST_NOW_MS).fulfillment_status.status).toBe('cancelled');
  });

  test('leaves the order it was given untouched', () => {
    // Immutability is the point, not a style preference: a rejected transition
    // must not be able to leave a half-updated record behind, and a caller that
    // kept a reference to the old order must not find it silently rewritten.
    const start = order();
    const before = structuredClone(start);
    const ready = advanceFulfillment(start, 'ready', TEST_NOW_MS);
    expect(ready).not.toBe(start);
    expect(start).toEqual(before);
    // The payment half of the row is copied through, never re-derived.
    expect(ready.payment).toEqual(start.payment);
    expect(ready.terms_hash).toBe(start.terms_hash);
  });

  test('refuses every move that is not a transition', () => {
    const start = order();
    const ready = advanceFulfillment(start, 'ready', TEST_NOW_MS);
    const completed = advanceFulfillment(ready, 'completed', TEST_NOW_MS);

    // Restating a state is not a transition.
    expect(canAdvanceFulfillment('ready', 'ready')).toBe(false);
    // Both terminal states are terminal: a handed-over coffee cannot be un-made
    // by an edit, and the merchant's answer to that is a refund.
    for (const terminal of [completed, advanceFulfillment(start, 'cancelled', TEST_NOW_MS)]) {
      expect(canAdvanceFulfillment(terminal.fulfillment_status.status, 'ready')).toBe(false);
      expect(canAdvanceFulfillment(terminal.fulfillment_status.status, 'completed')).toBe(false);
    }
    // `pending` is a start, never a destination.
    expect(canAdvanceFulfillment('ready', 'pending')).toBe(false);

    expect(() => advanceFulfillment(completed, 'ready', TEST_NOW_MS)).toThrow(CommerceError);
    expect(() => advanceFulfillment(completed, 'ready', TEST_NOW_MS)).toThrow('cannot move from completed to ready');
  });
});
