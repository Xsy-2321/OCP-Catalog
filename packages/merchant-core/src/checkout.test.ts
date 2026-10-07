/**
 * Checkout, tested against the acceptance list in AGENT_B.md §5.
 *
 * The list is a set of claims about money, so each one is tested for the thing
 * that would actually cost or leak money rather than for the happy shape of a
 * response. Three habits run through the file:
 *
 *   - Every rejection asserts that **no order was created**, not merely that an
 *     error was returned. A checkout that answers `out_of_stock` and writes the
 *     order anyway satisfies "the error is correct" and is still broken.
 *   - Every idempotency claim counts **payments as well as orders**. Counting
 *     orders alone would pass if a second charge were recorded against an
 *     attempt whose order insert happened to be rejected, and the acceptance
 *     list calls this out explicitly: the mock has to be idempotent too.
 *   - Every fault asserts the state it leaves behind, because the interesting
 *     part of a fault is not the response but what the database says afterwards.
 *
 * The merchant is built with a real database file, not `:memory:`, so a test can
 * close it and reopen it. "A retry after a restart still finds the original
 * order" is a claim about durability, and an in-memory database cannot express
 * it — it would pass for the wrong reason.
 */
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  CommerceError,
  checkoutRequestSchema,
  type CatalogEntryRecord,
  type CheckoutRequest,
  type Order,
  type PurchaseAttempt,
  type Quote,
} from '@ocp-catalog/shopping-contracts';
import { findEntry, loadCatalog } from './catalog';
import { runCheckout, settlePendingAttempt, SimulatedResponseLoss, type CheckoutResult } from './checkout';
import type { MerchantContext } from './context';
import { CATALOG_SEED } from './data/catalog';
import { FORBIDDEN_EVENT_KEYS, listEvents } from './events';
import type { MerchantFault } from './faults';
import { requireOwnedOrder, countOrders } from './orders';
import { countPayments, readPaymentRecord } from './payment';
import { buildQuote, insertQuote } from './quote';
import {
  TEST_NOW_MS,
  authorizationFor,
  makeTempDatabasePath,
  makeTestContext,
  openTestDb,
  signedPayloadFor,
  signPayload,
  tamperSignature,
  type TestContextOptions,
} from './test-support';
import { manualClock, type Clock } from './clock';

const CALLER = 'user_demo_1';
const OTHER_CALLER = 'caller_b';
const TEST_DEADLINE_MS = 5_000;

/* ------------------------------------------------------------------ harness */

interface Merchant {
  readonly ctx: MerchantContext;
  readonly db: Database;
  readonly path: string;
  /** Closes and reopens the same file: the restart the durability claim is about. */
  restart(): void;
  dispose(): void;
}

/**
 * A merchant on a temporary database file.
 *
 * The file (rather than `:memory:`) is what makes `restart()` meaningful, and
 * `makeTestConfig` inside `makeTestContext` keeps the wiring identical to
 * production rather than hand-assembled here.
 */
function makeMerchant(options: TestContextOptions = {}): Merchant {
  const { path, cleanup } = makeTempDatabasePath();
  let db = openTestDb(path);
  let ctx = makeTestContext({ ...options, db });

  return {
    get ctx() {
      return ctx;
    },
    get db() {
      return db;
    },
    path,
    restart() {
      db.close();
      db = openTestDb(path);
      ctx = makeTestContext({ ...options, db });
    },
    dispose() {
      db.close();
      cleanup();
    },
  };
}

/**
 * Runs `work` against a merchant on a temp file, and always disposes of it.
 *
 * Waits for a promise before disposing. A plain `finally` would close the
 * database the moment an `async` callback returned its promise — that is, before
 * the test body ran — and the failure surfaces as "cannot use a closed database"
 * from a line that looks perfectly fine.
 */
function withMerchant<T>(options: TestContextOptions, work: (merchant: Merchant) => T): T {
  const merchant = makeMerchant(options);
  const dispose = (): void => merchant.dispose();

  let result: T;
  try {
    result = work(merchant);
  } catch (error) {
    dispose();
    throw error;
  }

  if (result instanceof Promise) return result.finally(dispose) as T;
  dispose();
  return result;
}

/* ------------------------------------------------------------------ helpers */

const FULL_CATALOG: readonly CatalogEntryRecord[] = loadCatalog(CATALOG_SEED);

interface QuoteOptions {
  readonly entryId?: string;
  readonly quantity?: number;
  readonly method?: 'pickup' | 'delivery';
  readonly callerId?: string;
  /** Overrides the clock, for tests where the clock itself is being scripted. */
  readonly nowMs?: number;
}

/** Builds a quote from the committed catalog and stores it for `callerId`. */
function freshQuote(ctx: MerchantContext, options: QuoteOptions = {}): Quote {
  const entryId = options.entryId ?? 'entry_latte';
  const record = findEntry(ctx.catalog, entryId);
  if (record === null) throw new Error(`no catalog entry ${entryId}`);

  const quote = buildQuote(
    record,
    {
      entry_id: entryId,
      quantity: options.quantity ?? 1,
      fulfillment: { method: options.method ?? 'pickup' },
    },
    { config: ctx.config, nowMs: options.nowMs ?? ctx.clock.nowMs() },
  );
  insertQuote(ctx.db, quote, options.callerId ?? CALLER);
  return quote;
}

/** The request body A would send, parsed the way the HTTP layer parses it. */
function checkoutBody(quote: Quote, attemptId: string, overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return checkoutRequestSchema.parse({
    purchase_attempt_id: attemptId,
    quote_id: quote.quote_id,
    terms_hash: quote.terms_hash,
    authorization: authorizationFor(quote, { purchaseAttemptId: attemptId }),
    ...overrides,
  });
}

interface CheckoutCallOptions {
  readonly callerId?: string;
  readonly idempotencyKey?: string;
}

function checkout(
  ctx: MerchantContext,
  body: CheckoutRequest,
  options: CheckoutCallOptions = {},
): CheckoutResult {
  return runCheckout(ctx, body, {
    callerId: options.callerId ?? CALLER,
    idempotencyKey: options.idempotencyKey ?? 'key_1',
  });
}

/** Runs `work`, requiring it to fail with a `CommerceError`, and returns it. */
function thrown(work: () => unknown): CommerceError {
  try {
    work();
  } catch (error) {
    if (error instanceof CommerceError) return error;
    throw error;
  }
  throw new Error('expected the call to reject with a CommerceError');
}

/** The machine-readable rule that fired, for assertions about *which* failure. */
function reasonOf(error: CommerceError): string | undefined {
  return (error.details as { reason?: string } | undefined)?.reason;
}

function confirmedOrder(result: CheckoutResult): Order {
  if (result.kind !== 'confirmed') throw new Error(`expected confirmed, got ${result.kind}`);
  return result.body.order;
}

/** Everything a caller could observe: not one of these may contain a secret. */
function observable(context: MerchantContext, result: CheckoutResult): unknown[] {
  const values: unknown[] = [result];
  if (result.kind === 'confirmed') {
    values.push(requireOwnedOrder(context.db, result.body.order.order_id, CALLER));
    values.push(settlePendingAttempt(context, result.body.purchase_attempt.purchase_attempt_id, CALLER));
    values.push(listEvents(context.db, result.body.order.order_id));
    values.push(listEvents(context.db, result.body.purchase_attempt.purchase_attempt_id));
  }
  return values;
}

/* -------------------------------------------------------------- the happy path */

describe('a checkout that should succeed', () => {
  test('settles into one order, one payment and a confirmed attempt', () => {
    withMerchant({}, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const thisAttempt = 'att_happy_1';

      const result = checkout(ctx, checkoutBody(quote, thisAttempt));
      const order = confirmedOrder(result);

      expect(order.total_minor).toBe(2500);
      expect(order.quote_id).toBe(quote.quote_id);
      expect(order.purchase_attempt_id).toBe(thisAttempt);
      expect(order.currency).toBe('CNY');
      expect(countOrders(db)).toBe(1);
      expect(countPayments(db)).toBe(1);

      const attempt: PurchaseAttempt = result.kind === 'confirmed' ? result.body.purchase_attempt : (null as never);
      expect(attempt.status).toBe('confirmed');
      expect(attempt.order_id).toBe(order.order_id);
    });
  });

  test('prices the latte inside the 30 yuan ceiling the handoff promises', () => {
    withMerchant({}, ({ ctx }) => {
      const pickup = freshQuote(ctx);
      expect(pickup.total_minor).toBe(2500);
      expect(pickup.total_minor).toBeLessThanOrEqual(3000);

      // Delivery adds a fee, and the budget is checked against the all-in total
      // rather than the catalog price — the difference is the whole point of
      // quoting a total at all.
      const delivery = freshQuote(ctx, { method: 'delivery' });
      expect(delivery.total_minor).toBe(3000);
      expect(delivery.fees.map((fee) => fee.code)).toEqual(['delivery']);

      const order = confirmedOrder(checkout(ctx, checkoutBody(delivery, 'att_happy_2')));
      expect(order.total_minor).toBe(3000);
      expect(order.fees).toEqual(delivery.fees);
    });
  });

  test('keeps "paid" and "ready" as separate facts', () => {
    withMerchant({}, ({ ctx }) => {
      const order = confirmedOrder(checkout(ctx, checkoutBody(freshQuote(ctx), 'att_happy_3')));

      // The card clearing is not the coffee being made. A single status field
      // invites exactly that conflation.
      expect(order.payment.status).toBe('paid');
      expect(order.fulfillment_status.status).toBe('pending');
    });
  });

  test('records the payment against the attempt and settles the attempt last', () => {
    withMerchant({}, ({ ctx, db }) => {
      const thisAttempt = 'att_happy_4';
      const order = confirmedOrder(checkout(ctx, checkoutBody(freshQuote(ctx), thisAttempt)));

      const payment = readPaymentRecord(db, ctx.config.merchantId, thisAttempt);
      expect(payment?.status).toBe('succeeded');
      expect(payment?.amountMinor).toBe(order.total_minor);
      // The payment handle a real provider would let you reverse the charge
      // with. It exists server-side and must not appear on the wire — asserted
      // in the redaction block below.
      expect(payment?.reference).toMatch(/^mockref_/);

      expect(listEvents(db, thisAttempt).map((event) => event.type)).toEqual([
        'attempt.created',
        'payment.succeeded',
        'attempt.confirmed',
      ]);
      expect(listEvents(db, order.order_id).map((event) => event.type)).toEqual(['order.created']);
    });
  });
});

/* ------------------------------------------ rejections that must leave no order */

describe('a checkout that must be refused', () => {
  test('requotes when currency, delivery charges or the offered fulfillment method change', () => {
    const changes: Array<{ method: 'pickup' | 'delivery'; change: (record: CatalogEntryRecord) => CatalogEntryRecord }> = [
      { method: 'pickup', change: (record) => ({ ...record, attributes: {
        ...record.attributes, price: { ...record.attributes.price, currency: 'USD' },
      } }) },
      { method: 'delivery', change: (record) => ({ ...record, attributes: {
        ...record.attributes, fulfillment: { ...record.attributes.fulfillment, delivery_fee_minor: 700 },
      } }) },
      { method: 'pickup', change: (record) => ({ ...record, attributes: {
        ...record.attributes, fulfillment: { ...record.attributes.fulfillment, methods: ['delivery'] },
      } }) },
    ];
    for (const [index, scenario] of changes.entries()) {
      withMerchant({}, ({ ctx, db }) => {
        const quote = freshQuote(ctx, { method: scenario.method });
        const changed = { ...ctx, catalog: ctx.catalog.map((record) =>
          record.entry.entry_id === 'entry_latte' ? scenario.change(record) : record) };
        const error = thrown(() => checkout(changed, checkoutBody(quote, `att_terms_change_${index}`)));
        expect(error.code).toBe('requote_required');
        expect(countPayments(db)).toBe(0);
        expect(countOrders(db)).toBe(0);
        expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM inventory_reservations').get()?.n).toBe(0);
      });
    }
  });
  test('refuses a total above the ceiling the user signed', () => {
    withMerchant({}, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      // The ceiling lives inside the proof, so lowering it means re-signing. The
      // merchant may not widen it to make its own demo succeed — a ceiling that
      // moves when it is inconvenient is not a ceiling.
      const revised = checkoutBody(quote, 'att_budget_1', {
        authorization: authorizationFor(quote, { purchaseAttemptId: 'att_budget_1', maxTotalMinor: 1000 }),
      });

      const error = thrown(() => checkout(ctx, revised));
      expect(error.code).toBe('budget_exceeded');
      expect(error.details).toEqual({ total_minor: 2500, max_total_minor: 1000 });

      expect(countOrders(db)).toBe(0);
      expect(countPayments(db)).toBe(0);
    });
  });

  test('refuses an expired quote', () => {
    const clock = manualClock(TEST_NOW_MS);
    withMerchant({ quoteTtlSeconds: 60, clock }, (merchant) => {
      const quote = freshQuote(merchant.ctx);
      const body = checkoutBody(quote, 'att_expired_1');

      // Walk the clock past the window the merchant itself stored. The check is
      // against that expiry, never against a time the caller supplied.
      clock.set(Date.parse(quote.expires_at) + 1);

      const error = thrown(() => checkout(merchant.ctx, body));
      expect(error.code).toBe('quote_expired');
      expect(countOrders(merchant.db)).toBe(0);
      expect(countPayments(merchant.db)).toBe(0);
    });
  });

  test('refuses terms the caller misremembers', () => {
    withMerchant({}, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const body = checkoutBody(quote, 'att_terms_1', { terms_hash: 'f'.repeat(64) });

      const error = thrown(() => checkout(ctx, body));
      expect(error.code).toBe('requote_required');
      expect(reasonOf(error)).toBe('terms_changed');
      expect(countOrders(db)).toBe(0);
    });
  });

  test('refuses a price that moved between quote and till', () => {
    withMerchant({}, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const body = checkoutBody(quote, 'att_price_1');

      const merchant = { ...ctx, config: { ...ctx.config, faults: new Set<MerchantFault>(['price_raised_after_quote']) } } as MerchantContext;
      const error = thrown(() => checkout(merchant, body));

      // A re-quote, not a forgery: the proof is genuine and the ground moved.
      expect(error.code).toBe('requote_required');
      expect(reasonOf(error)).toBe('price_changed');
      expect(error.status).toBe(409);
      expect(countOrders(db)).toBe(0);
      expect(countPayments(db)).toBe(0);
    });
  });

  test('refuses a unit that sold out between quote and till', () => {
    // Not the injected fault: the catalog handed to the merchant genuinely says
    // the last cold brew is gone, so this exercises the real re-read at step 9.
    const soldOut: readonly CatalogEntryRecord[] = loadCatalog(
      (JSON.parse(JSON.stringify(CATALOG_SEED)) as Array<{
        entry_id: string;
        attributes: { inventory: { availability_status: string; quantity?: number } };
      }>).map((entry) => {
        if (entry.entry_id !== 'entry_cold_brew') return entry;
        entry.attributes.inventory.availability_status = 'out_of_stock';
        entry.attributes.inventory.quantity = 0;
        return entry;
      }),
    );

    withMerchant({ catalog: soldOut }, ({ ctx, db }) => {
      // Quoted from the catalog as it was: one cold brew left.
      const record = findEntry(FULL_CATALOG, 'entry_cold_brew');
      if (record === null) throw new Error('no cold brew');
      const quote = buildQuote(
        record,
        { entry_id: 'entry_cold_brew', quantity: 1, fulfillment: { method: 'pickup' } },
        { config: ctx.config, nowMs: TEST_NOW_MS },
      );
      insertQuote(db, quote, CALLER);

      const error = thrown(() => checkout(ctx, checkoutBody(quote, 'att_stock_1')));
      expect(error.code).toBe('out_of_stock');
      expect(error.details).toEqual({ entry_id: 'entry_cold_brew', available: 0, requested: 1 });
      expect(countOrders(db)).toBe(0);
      expect(countPayments(db)).toBe(0);
    });
  });

  test('refuses an entry that left the catalog under a live quote', () => {
    const withoutLatte = loadCatalog(
      (JSON.parse(JSON.stringify(CATALOG_SEED)) as Array<{ entry_id: string }>).filter(
        (entry) => entry.entry_id !== 'entry_latte',
      ),
    );

    withMerchant({ catalog: withoutLatte }, ({ ctx, db }) => {
      const record = findEntry(FULL_CATALOG, 'entry_latte');
      if (record === null) throw new Error('no latte');
      const quote = buildQuote(
        record,
        { entry_id: 'entry_latte', quantity: 1, fulfillment: { method: 'pickup' } },
        { config: ctx.config, nowMs: TEST_NOW_MS },
      );
      insertQuote(db, quote, CALLER);

      const error = thrown(() => checkout(ctx, checkoutBody(quote, 'att_gone_1')));
      expect(error.code).toBe('requote_required');
      expect(reasonOf(error)).toBe('entry_gone');
      expect(countOrders(db)).toBe(0);
    });
  });

  test('refuses a proof that does not verify', () => {
    withMerchant({}, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const body = checkoutBody(quote, 'att_badsig_1', {
        authorization: tamperSignature(authorizationFor(quote, { purchaseAttemptId: 'att_badsig_1' })),
      });

      const error = thrown(() => checkout(ctx, body));
      expect(error.code).toBe('authorization_invalid');
      expect(reasonOf(error)).toBe('signature');
      expect(error.status).toBe(401);
      expect(countOrders(db)).toBe(0);
    });
  });

  test('refuses a proof signed for a different purchase attempt', () => {
    withMerchant({}, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      // The proof is genuine — for attempt 0001. Presenting it while claiming to
      // be attempt 0002 is the replay the `purchase_attempt_id` binding exists to
      // stop. A fresh Idempotency-Key is required to reach the check at all: the
      // digest covers the attempt id, so reusing the key would be reported as a
      // conflict first (asserted in the idempotency block).
      const replay = authorizationFor(quote, { purchaseAttemptId: 'att_other_1' });
      const body = checkoutBody(quote, 'att_attempt_1', { authorization: replay });

      const error = thrown(() => checkout(ctx, body));
      expect(error.code).toBe('authorization_invalid');
      expect(reasonOf(error)).toBe('attempt');
      expect(countOrders(db)).toBe(0);
    });
  });

  test('refuses an unsigned attempt to be someone else, even to itself', () => {
    withMerchant({}, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const stranger = signPayload(signedPayloadFor(quote, { purchaseAttemptId: 'att_key_1' }), 'agent_stranger');
      const body = checkoutBody(quote, 'att_key_1', { authorization: stranger });

      const error = thrown(() => checkout(ctx, body));
      expect(error.code).toBe('authorization_invalid');
      expect(reasonOf(error)).toBe('unknown_key');
      expect(countOrders(db)).toBe(0);
    });
  });

  test('refuses to reuse an attempt id for a second purchase', () => {
    withMerchant({}, ({ ctx, db }) => {
      const first = freshQuote(ctx);
      expect(checkout(ctx, checkoutBody(first, 'att_reuse_1'), { idempotencyKey: 'key_a' }).kind).toBe('confirmed');

      const second = freshQuote(ctx);
      const error = thrown(() =>
        checkout(ctx, checkoutBody(second, 'att_reuse_1'), { idempotencyKey: 'key_b' }),
      );

      expect(error.code).toBe('invalid_request');
      expect(error.message).toContain('att_reuse_1');
      // The first purchase is untouched and the second did not happen.
      expect(countOrders(db)).toBe(1);
      expect(countPayments(db)).toBe(1);
    });
  });

  test('refuses to spend a quote that belongs to another caller', () => {
    withMerchant({}, ({ ctx, db }) => {
      const quote = freshQuote(ctx, { callerId: OTHER_CALLER });
      // Ownership failure is reported as absence: a 403 would confirm the quote
      // exists, turning the id space into an oracle for other callers' quotes.
      const error = thrown(() => checkout(ctx, checkoutBody(quote, 'att_owner_1'), { callerId: CALLER }));

      expect(error.code).toBe('not_found');
      expect(error.status).toBe(404);
      expect(countOrders(db)).toBe(0);
    });
  });
});

/* -------------------------------------------------------------- idempotency */

describe('one purchase, however many times it is asked for', () => {
  test('a sequential retry replays the original order instead of buying again', () => {
    withMerchant({}, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const body = checkoutBody(quote, 'att_seq_1');

      const first = confirmedOrder(checkout(ctx, body));
      const second = confirmedOrder(checkout(ctx, body));

      expect(second.order_id).toBe(first.order_id);
      expect(countOrders(db)).toBe(1);
      expect(countPayments(db)).toBe(1);
    });
  });

  test('concurrent retries on one key produce exactly one order and one payment', async () => {
    await withMerchant({}, async ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const body = checkoutBody(quote, 'att_race_1');
      const options = { callerId: CALLER, idempotencyKey: 'key_race' };

      const results = await Promise.all([
        (async () => runCheckout(ctx, body, options))(),
        (async () => runCheckout(ctx, body, options))(),
        (async () => runCheckout(ctx, body, options))(),
      ]);

      // Counting orders alone would pass even if a second charge had been
      // recorded against the same attempt; the acceptance list requires the
      // payment table to be counted too.
      expect(countOrders(db)).toBe(1);
      expect(countPayments(db)).toBe(1);
      expect(new Set(results.map((result) => confirmedOrder(result).order_id)).size).toBe(1);
    });
  });

  test('a second connection racing on one key loses and replays', () => {
    // `bun:sqlite` is synchronous, so the `Promise.all` above cannot interleave
    // two transactions on one connection — it proves the replay path, not the
    // race. A second handle on the same file shares no in-process state with the
    // first, so it cannot be served from anything the first filled in memory;
    // this is the closest an in-process test gets to a second process, and it is
    // the path the UNIQUE constraint and `BEGIN IMMEDIATE` actually protect.
    withMerchant({}, (merchant) => {
      const quote = freshQuote(merchant.ctx);
      const body = checkoutBody(quote, 'att_twoconn_1');

      const first = confirmedOrder(
        checkout(merchant.ctx, body, { idempotencyKey: 'key_two_conn' }),
      );

      const other = openTestDb(merchant.path);
      try {
        const otherCtx = makeTestContext({ db: other });
        const replay = confirmedOrder(checkout(otherCtx, body, { idempotencyKey: 'key_two_conn' }));

        expect(replay.order_id).toBe(first.order_id);
        expect(countOrders(other)).toBe(1);
        expect(countPayments(other)).toBe(1);
      } finally {
        other.close();
      }
    });
  });

  test('the same key with a different purchase is a conflict, not a replay', () => {
    withMerchant({}, ({ ctx, db }) => {
      const first = freshQuote(ctx);
      checkout(ctx, checkoutBody(first, 'att_conflict_1'), { idempotencyKey: 'key_c' });

      const second = freshQuote(ctx);
      const error = thrown(() =>
        checkout(ctx, checkoutBody(second, 'att_conflict_2'), { idempotencyKey: 'key_c' }),
      );

      expect(error.code).toBe('idempotency_conflict');
      expect(countOrders(db)).toBe(1);
      expect(countPayments(db)).toBe(1);
    });
  });

  test('a retry after a restart still finds the original order', () => {
    withMerchant({}, (merchant) => {
      const quote = freshQuote(merchant.ctx);
      const body = checkoutBody(quote, 'att_restart_1');
      const first = confirmedOrder(checkout(merchant.ctx, body, { idempotencyKey: 'key_r' }));

      merchant.restart();

      const replay = confirmedOrder(checkout(merchant.ctx, body, { idempotencyKey: 'key_r' }));
      expect(replay.order_id).toBe(first.order_id);
      expect(countOrders(merchant.db)).toBe(1);
      expect(countPayments(merchant.db)).toBe(1);
    });
  });
});

/* -------------------------------------------------------------------- faults */

describe('injected faults', () => {
  test('payment_timeout_then_succeed answers "unknown" without charging, then settles on the poll', () => {
    withMerchant({ faults: ['payment_timeout_then_succeed'] }, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const thisAttempt = 'att_timeout_1';

      const result = checkout(ctx, checkoutBody(quote, thisAttempt));
      expect(result.kind).toBe('processing');
      if (result.kind === 'processing') {
        expect(result.body.status).toBe('processing');
        expect(result.body.purchase_attempt.status).toBe('processing');
      }

      // Nothing has been charged: the payment genuinely has not been attempted,
      // and modelling it as "charged but reported unknown" would make the
      // timeout a lie about the merchant's own state.
      expect(countPayments(db)).toBe(0);
      expect(countOrders(db)).toBe(0);

      const settled = settlePendingAttempt(ctx, thisAttempt, CALLER);
      expect(settled.status).toBe('confirmed');
      expect(settled.order_id).toBeDefined();
      expect(countPayments(db)).toBe(1);
      expect(countOrders(db)).toBe(1);

      // Polling again is a read, not a second settlement.
      const again = settlePendingAttempt(ctx, thisAttempt, CALLER);
      expect(again.order_id).toBe(settled.order_id);
      expect(countPayments(db)).toBe(1);
      expect(countOrders(db)).toBe(1);
    });
  });

  test('payment_declined fails the attempt and never reaches paid', () => {
    withMerchant({ faults: ['payment_declined'] }, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const thisAttempt = 'att_declined_1';

      const result = checkout(ctx, checkoutBody(quote, thisAttempt));
      expect(result.kind).toBe('declined');
      if (result.kind !== 'declined') throw new Error('unreachable');
      expect(result.error.code).toBe('payment_failed');

      expect(countOrders(db)).toBe(0);
      // The decline is recorded rather than rolled back: the decision cost
      // something, and re-deciding it on a retry is what idempotency forbids.
      expect(countPayments(db)).toBe(1);
      const payment = readPaymentRecord(db, ctx.config.merchantId, thisAttempt);
      expect(payment?.status).toBe('failed');
      expect(payment?.failureReason).not.toBeNull();

      const attempt = settlePendingAttempt(ctx, thisAttempt, CALLER);
      expect(attempt.status).toBe('failed');
      expect(attempt.order_id).toBeUndefined();

      const types = listEvents(db, thisAttempt).map((event) => event.type);
      expect(types).toContain('payment.failed');
      expect(types).toContain('attempt.failed');
      expect(types).not.toContain('payment.succeeded');
      expect(types).not.toContain('attempt.confirmed');
    });
  });

  test('a declined payment stays declined on retry instead of becoming a coin flip', () => {
    withMerchant({ faults: ['payment_declined'] }, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const body = checkoutBody(quote, 'att_declined_2');

      const first = checkout(ctx, body, { idempotencyKey: 'key_d' });
      const second = checkout(ctx, body, { idempotencyKey: 'key_d' });

      expect(first.kind).toBe('declined');
      expect(second.kind).toBe('declined');
      if (first.kind !== 'declined' || second.kind !== 'declined') throw new Error('unreachable');
      expect(second.error.code).toBe(first.error.code);
      expect(second.error.status).toBe(first.error.status);
      expect(countPayments(db)).toBe(1);
      expect(countOrders(db)).toBe(0);
    });
  });

  test('stock_exhausted_after_quote rejects at the till', () => {
    withMerchant({ faults: ['stock_exhausted_after_quote'] }, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const error = thrown(() => checkout(ctx, checkoutBody(quote, 'att_faultstock_1')));

      expect(error.code).toBe('out_of_stock');
      expect(countOrders(db)).toBe(0);
      expect(countPayments(db)).toBe(0);
    });
  });

  test('response_dropped_after_settlement loses the answer, not the order', () => {
    withMerchant({ faults: ['response_dropped_after_settlement'] }, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const body = checkoutBody(quote, 'att_drop_1');

      let loss: SimulatedResponseLoss | null = null;
      try {
        checkout(ctx, body);
      } catch (error) {
        if (!(error instanceof SimulatedResponseLoss)) throw error;
        loss = error;
      }
      if (loss === null) throw new Error('expected the response to be dropped');

      // The commit happened. A rollback here would be a refund — the exact
      // opposite of "the customer was charged and never heard back".
      expect(countOrders(db)).toBe(1);
      expect(countPayments(db)).toBe(1);

      // Asking about the attempt is how the caller recovers: the id it minted is
      // the only handle it has, which is why the attempt exists at all.
      const attempt = settlePendingAttempt(ctx, loss.purchaseAttemptId, CALLER);
      expect(attempt.status).toBe('confirmed');
      expect(attempt.order_id).toBe(loss.orderId);

      const order = requireOwnedOrder(db, loss.orderId, CALLER);
      expect(order.quote_id).toBe(quote.quote_id);
      expect(countPayments(db)).toBe(1);
    });
  });

  test('a dropped response replays the same order rather than a second purchase', () => {
    withMerchant({ faults: ['response_dropped_after_settlement'] }, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const body = checkoutBody(quote, 'att_drop_2');
      const options = { callerId: CALLER, idempotencyKey: 'key_drop' };

      const orderIds: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          checkout(ctx, body, options);
          throw new Error('expected the response to be dropped');
        } catch (error) {
          if (!(error instanceof SimulatedResponseLoss)) throw error;
          orderIds.push(error.orderId);
        }
      }

      // The second call is served from the cached answer, so it names the same
      // order. (It is dropped again: the fault models a network that keeps
      // eating this response, and the caller's recovery path is the poll above,
      // not the retry.)
      expect(new Set(orderIds).size).toBe(1);
      expect(countOrders(db)).toBe(1);
      expect(countPayments(db)).toBe(1);
    });
  });
});

/* ------------------------------------------------------------------ deadline */

describe('the checkout deadline', () => {
  /**
   * A clock that jumps forward after its first reading.
   *
   * `runCheckout` reads the clock exactly twice: once to stamp the start and once
   * to check its own deadline. So this makes an overrun happen on demand instead
   * of by being genuinely slow — the fault is otherwise only reachable by a stall
   * nobody can reproduce in a test.
   *
   * The quote is built with an explicit timestamp rather than through the clock,
   * because a quote taken through this one would spend the first reading and
   * leave `runCheckout` starting from the *already advanced* time, which is a
   * run that did not overrun anything.
   */
  function overrunningClock(overrunMs: number): Clock {
    let readings = 0;
    return {
      nowMs: () => {
        readings += 1;
        return readings === 1 ? TEST_NOW_MS : TEST_NOW_MS + overrunMs;
      },
    };
  }

  test('reports unknown rather than failure when settling overruns', () => {
    withMerchant(
      { checkoutDeadlineMs: TEST_DEADLINE_MS, clock: overrunningClock(TEST_DEADLINE_MS + 1) },
      (merchant) => {
        const quote = freshQuote(merchant.ctx, { nowMs: TEST_NOW_MS });
        const thisAttempt = 'att_deadline_1';
        const result = checkout(merchant.ctx, checkoutBody(quote, thisAttempt));

        // A success response carrying an attempt id, not an error: a caller told
        // "failed" would retry a purchase that may already have gone through.
        expect(result.kind).toBe('processing');
        if (result.kind === 'processing') {
          expect(result.body.purchase_attempt.status).toBe('processing');
        }

        // The money did move — which is why the answer has to be "unknown" rather
        // than "no" — and the next poll settles it without charging a second time.
        expect(countPayments(merchant.db)).toBe(1);
        expect(countOrders(merchant.db)).toBe(0);

        const settled = settlePendingAttempt(merchant.ctx, thisAttempt, CALLER);
        expect(settled.status).toBe('confirmed');
        expect(countPayments(merchant.db)).toBe(1);
        expect(countOrders(merchant.db)).toBe(1);
      },
    );
  });
});

/* ----------------------------------------------------------------- ownership */

describe('who may look at what', () => {
  test('another caller cannot read the attempt, the order or the payment', () => {
    withMerchant({}, ({ ctx, db }) => {
      const order = confirmedOrder(checkout(ctx, checkoutBody(freshQuote(ctx), 'att_own_1')));

      expect(thrown(() => settlePendingAttempt(ctx, 'att_own_1', OTHER_CALLER)).code).toBe('not_found');
      expect(thrown(() => requireOwnedOrder(db, order.order_id, OTHER_CALLER)).code).toBe('not_found');
      expect(requireOwnedOrder(db, order.order_id, CALLER).order_id).toBe(order.order_id);
    });
  });

  test('an unknown id is reported the same way as someone else\'s', () => {
    withMerchant({}, ({ ctx, db }) => {
      const order = confirmedOrder(checkout(ctx, checkoutBody(freshQuote(ctx), 'att_own_2')));

      const foreign = thrown(() => requireOwnedOrder(db, order.order_id, OTHER_CALLER));
      const missing = thrown(() => requireOwnedOrder(db, 'ord_does_not_exist', CALLER));

      // Identical answers, because distinguishing them would confirm that the
      // first one exists.
      expect(foreign.code).toBe(missing.code);
      expect(foreign.status).toBe(missing.status);
    });
  });
});

/* ----------------------------------------------------------------- redaction */

describe('redaction', () => {
  test('no response, event or order carries the signature or the payment handle', () => {
    withMerchant({}, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const thisAttempt = 'att_redact_1';
      const body = checkoutBody(quote, thisAttempt);
      const result = checkout(ctx, body);

      const payment = readPaymentRecord(db, ctx.config.merchantId, thisAttempt);
      if (payment === null) throw new Error('no payment recorded');
      const secrets = [body.authorization.signature, payment.reference, body.authorization.payload.jti];

      const serialized = JSON.stringify(observable(ctx, result));
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }

      // And no forbidden key at all, anywhere in what a caller can see — the
      // same list the event log enforces on write.
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (typeof value !== 'object' || value === null) return;
        for (const [key, nested] of Object.entries(value)) {
          expect(FORBIDDEN_EVENT_KEYS).not.toContain(key.toLowerCase());
          walk(nested);
        }
      };
      walk(observable(ctx, result));
    });
  });

  test('a failed payment reports the reason without its handle', () => {
    withMerchant({ faults: ['payment_declined'] }, ({ ctx, db }) => {
      const quote = freshQuote(ctx);
      const thisAttempt = 'att_redact_2';
      const result = checkout(ctx, checkoutBody(quote, thisAttempt));
      if (result.kind !== 'declined') throw new Error('expected a decline');

      const payment = readPaymentRecord(db, ctx.config.merchantId, thisAttempt);
      if (payment === null) throw new Error('no payment recorded');

      const attempt = settlePendingAttempt(ctx, thisAttempt, CALLER);
      expect(attempt.error?.message).toContain('拒绝');

      const serialized = JSON.stringify({ result, attempt });
      expect(serialized).not.toContain(payment.reference);

      // The boundary, pinned so it is a decision rather than an accident: the
      // error may name the server-side `payment_id`, which resolves to nothing
      // outside this database, but never the reference, which is the value a
      // real provider would let you reverse the charge with.
      expect(payment.reference).not.toBe(payment.paymentId);
      expect(attempt.error?.details).toEqual({ payment_id: payment.paymentId });
    });
  });
});
