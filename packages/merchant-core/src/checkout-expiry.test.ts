import { expect, test } from 'bun:test';
import { CommerceError, type CheckoutRequest } from '@ocp-catalog/shopping-contracts';
import { runCheckout } from './checkout';
import { countOrders } from './orders';
import { countPayments } from './payment';
import { buildQuote, insertQuote } from './quote';
import { authorizationFor, makeTestContext, TEST_NOW_MS } from './test-support';

const callerId = 'user_demo_1';

for (const expires of ['quote', 'authorization'] as const) {
  test(`rejects ${expires} that expires between entering checkout and acquiring the write lock`, () => {
    const ctx = makeTestContext({ quoteTtlSeconds: expires === 'quote' ? 1 : 60 });
    try {
      const quote = buildQuote(ctx.catalog, { entry_id: 'entry_latte', quantity: 1, fulfillment: { method: 'pickup' } },
        { config: ctx.config, nowMs: TEST_NOW_MS });
      insertQuote(ctx.db, quote, callerId);
      const body: CheckoutRequest = { purchase_attempt_id: `attempt_expiring_${expires}`, quote_id: quote.quote_id,
        terms_hash: quote.terms_hash, authorization: authorizationFor(quote, {
          purchaseAttemptId: `attempt_expiring_${expires}`, expiresAt: Math.floor(TEST_NOW_MS / 1000) + 1,
        }) };
      let readings = 0;
      const delayed = { ...ctx, clock: { nowMs: () => {
        // Script the lock wait without sleeps. The first read is before BEGIN
        // IMMEDIATE; the second must be taken before any first-purchase effect.
        readings++;
        return readings === 1 ? TEST_NOW_MS : TEST_NOW_MS + 2_000;
      } } };
      let failure: unknown;
      try { runCheckout(delayed, body, { callerId, idempotencyKey: `key_expiring_${expires}` }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(CommerceError);
      expect((failure as CommerceError).code).toBe(expires === 'quote' ? 'quote_expired' : 'authorization_invalid');
      if (expires === 'authorization') expect((failure as CommerceError).details?.reason).toBe('expired');
      expect(readings).toBe(2);
      expect(countOrders(ctx.db)).toBe(0);
      expect(countPayments(ctx.db)).toBe(0);
      expect(ctx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM attempts').get()!.n).toBe(0);
      expect(ctx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM idempotency_records').get()!.n).toBe(0);
      expect(ctx.db.query<{ available_quantity: number }, [string]>('SELECT available_quantity FROM inventory WHERE entry_id = ?').get('entry_latte')!.available_quantity).toBe(12);
    } finally { ctx.db.close(); }
  });
}

test('a settled checkout still replays after both quote and authorization expire', () => {
  const ctx = makeTestContext({ quoteTtlSeconds: 1 });
  try {
    const quote = buildQuote(ctx.catalog, { entry_id: 'entry_latte', quantity: 1, fulfillment: { method: 'pickup' } },
      { config: ctx.config, nowMs: TEST_NOW_MS });
    insertQuote(ctx.db, quote, callerId);
    const body: CheckoutRequest = { purchase_attempt_id: 'attempt_expired_replay', quote_id: quote.quote_id,
      terms_hash: quote.terms_hash, authorization: authorizationFor(quote, {
        purchaseAttemptId: 'attempt_expired_replay', expiresAt: Math.floor(TEST_NOW_MS / 1000) + 1,
      }) };
    const options = { callerId, idempotencyKey: 'key_expired_replay' };
    const original = runCheckout(ctx, body, options);
    expect(original.kind).toBe('confirmed');
    const delayed = { ...ctx, clock: { nowMs: () => TEST_NOW_MS + 10_000 } };
    expect(runCheckout(delayed, body, options)).toEqual(original);
    expect(countOrders(ctx.db)).toBe(1);
    expect(countPayments(ctx.db)).toBe(1);
  } finally { ctx.db.close(); }
});
