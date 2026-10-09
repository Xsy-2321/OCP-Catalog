import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Order } from '@ocp-catalog/shopping-contracts';
import { createMerchantDemoReader } from './merchant-read';
import { insertOrder, requireOwnedOrder } from './orders';
import { makeTestContext } from './test-support';

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
