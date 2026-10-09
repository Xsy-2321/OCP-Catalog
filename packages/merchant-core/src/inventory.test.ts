import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CommerceError, type CheckoutRequest, type Quote } from '@ocp-catalog/shopping-contracts';
import { loadCatalog, findEntry } from './catalog';
import { CATALOG_SEED } from './data/catalog';
import { runCheckout, settlePendingAttempt } from './checkout';
import { catalogWithInventory, consumeInventory, releaseInventory, reserveBasketInventory } from './inventory';
import { inTransaction, MERCHANT_SCHEMA_VERSION, openMerchantDb } from './db';
import { buildQuote, insertQuote } from './quote';
import { countOrders, insertProcessingAttempt, markAttemptFailed } from './orders';
import { countPayments } from './payment';
import type { MerchantContext } from './context';
import { authorizationFor, makeTestContext, makeTempDatabasePath, TEST_NOW_MS } from './test-support';

const CALLER = 'user_demo_1';

function oneCupCatalog() {
  return loadCatalog(CATALOG_SEED.filter((entry) => entry.entry_id === 'entry_latte').map((entry) => ({
    ...entry, attributes: { ...entry.attributes, inventory: { availability_status: 'in_stock', quantity: 1 } },
  })));
}

function quote(ctx: MerchantContext): Quote {
  const record = findEntry(catalogWithInventory(ctx), 'entry_latte')!;
  const value = buildQuote(record, { entry_id: 'entry_latte', quantity: 1, fulfillment: { method: 'pickup' } },
    { config: ctx.config, nowMs: ctx.clock.nowMs() });
  insertQuote(ctx.db, value, CALLER);
  return value;
}

function body(value: Quote, attemptId: string, userId = CALLER, issuer = 'agent_a_demo'): CheckoutRequest {
  return { purchase_attempt_id: attemptId, quote_id: value.quote_id, terms_hash: value.terms_hash,
    authorization: authorizationFor(value, { purchaseAttemptId: attemptId, userId, issuer }) };
}

function checkout(ctx: MerchantContext, value: Quote, attemptId: string) {
  return runCheckout(ctx, body(value, attemptId), { callerId: CALLER, idempotencyKey: `key_${attemptId}` });
}

function available(ctx: MerchantContext, entryId = 'entry_latte'): number | undefined {
  return findEntry(catalogWithInventory(ctx), entryId)!.attributes.inventory.quantity;
}

function basketCatalog(quantity = 1) {
  return loadCatalog(CATALOG_SEED.filter(entry => ['entry_latte', 'entry_americano'].includes(entry.entry_id)).map(entry => ({
    ...entry, attributes: { ...entry.attributes, inventory: { availability_status: 'in_stock', quantity } },
  })));
}
function basketQuote(ctx: MerchantContext): Quote {
  const value = buildQuote(catalogWithInventory(ctx), {
    items: [{ entry_id: 'entry_latte', quantity: 1 }, { entry_id: 'entry_americano', quantity: 1 }], fulfillment: { method: 'pickup' },
  }, { config: ctx.config, nowMs: ctx.clock.nowMs() });
  insertQuote(ctx.db, value, CALLER);
  return value;
}

describe('basket inventory and schema migration', () => {
  test('a second-item shortage rolls back the first reservation even when the outer checkout caches rejection', () => {
    const ctx = makeTestContext({ catalog: basketCatalog(2) });
    try {
      ctx.db.query('UPDATE inventory SET available_quantity = 0 WHERE entry_id = ?').run('entry_americano');
      inTransaction(ctx.db, () => {
        expect(() => reserveBasketInventory(ctx, 'att_partial_basket', [
          { entry_id: 'entry_latte', quantity: 1 }, { entry_id: 'entry_americano', quantity: 1 },
        ])).toThrow(CommerceError);
        // A caller may deliberately commit its cached rejection after catching
        // this error; the helper must have rolled back its own stock work.
        ctx.db.query('INSERT INTO purchase_events VALUES (?, ?, ?, ?, ?, ?)')
          .run('evt_cached_decline', 'attempt', 'att_partial_basket', 'attempt.failed', TEST_NOW_MS, '{}');
      });
      expect(available(ctx)).toBe(2);
      expect(available(ctx, 'entry_americano')).toBe(0);
      expect(ctx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM inventory_reservations').get()!.n).toBe(0);
      expect(ctx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM purchase_events').get()!.n).toBe(1);
      expect(countPayments(ctx.db)).toBe(0);
    } finally { ctx.db.close(); }
  });

  test('duplicate basket ids are rejected before deducting any stock', () => {
    const ctx = makeTestContext({ catalog: basketCatalog(2) });
    try {
      expect(() => reserveBasketInventory(ctx, 'att_duplicate_basket', [
        { entry_id: 'entry_latte', quantity: 1 }, { entry_id: 'entry_latte', quantity: 1 },
      ])).toThrow(CommerceError);
      expect(available(ctx)).toBe(2);
      expect(ctx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM inventory_reservations').get()!.n).toBe(0);
    } finally { ctx.db.close(); }
  });

  test('consumption marks every reserved basket row without a second stock deduction', () => {
    const ctx = makeTestContext({ catalog: basketCatalog(3) });
    try {
      inTransaction(ctx.db, () => {
        reserveBasketInventory(ctx, 'att_consume_basket', [{ entry_id: 'entry_latte', quantity: 1 }, { entry_id: 'entry_americano', quantity: 2 }]);
        consumeInventory(ctx.db, 'att_consume_basket');
      });
      expect(available(ctx)).toBe(2);
      expect(available(ctx, 'entry_americano')).toBe(1);
      expect(ctx.db.query<{ state: string }, []>('SELECT state FROM inventory_reservations ORDER BY entry_id').all()).toEqual([{ state: 'consumed' }, { state: 'consumed' }]);
      expect(() => consumeInventory(ctx.db, 'att_consume_basket')).toThrow();
      expect(available(ctx)).toBe(2);
    } finally { ctx.db.close(); }
  });

  test('a v2 migration preserves confirmed, pending and failed transactions and exact existing stock across two restarts', () => {
    const temp = makeTempDatabasePath();
    let ctx = makeTestContext({ databasePath: temp.path, catalog: basketCatalog(6) });
    try {
      checkout(ctx, quote(ctx), 'att_v2_confirmed');
      const pendingContext = makeTestContext({ databasePath: temp.path, catalog: basketCatalog(6), faults: ['payment_timeout_then_succeed'] });
      try { expect(checkout(pendingContext, quote(pendingContext), 'att_v2_pending').kind).toBe('processing'); }
      finally { pendingContext.db.close(); }
      const failedContext = makeTestContext({ databasePath: temp.path, catalog: basketCatalog(6), faults: ['payment_declined'] });
      try { expect(checkout(failedContext, quote(failedContext), 'att_v2_failed').kind).toBe('declined'); }
      finally { failedContext.db.close(); }
      const tables = ['quotes', 'attempts', 'orders', 'payments', 'idempotency_records', 'inventory', 'inventory_debts', 'inventory_reservations'] as const;
      const snapshot = () => Object.fromEntries(tables.map(table => [table, ctx.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      const before = snapshot();
      // Recreate the exact old single-attempt reservation primary key in this
      // isolated database, leaving every business row and stock count intact.
      ctx.db.exec(`CREATE TABLE inventory_reservations_v2 (
        purchase_attempt_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, entry_id TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0), state TEXT NOT NULL CHECK (state IN ('reserved','consumed','released')),
        FOREIGN KEY (merchant_id, entry_id) REFERENCES inventory (merchant_id, entry_id)
      );
      INSERT INTO inventory_reservations_v2 SELECT * FROM inventory_reservations;
      DROP TABLE inventory_reservations;
      ALTER TABLE inventory_reservations_v2 RENAME TO inventory_reservations;
      UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';`);
      ctx.db.close();
      ctx = makeTestContext({ databasePath: temp.path, catalog: basketCatalog(99) });
      expect(snapshot()).toEqual(before);
      expect(available(ctx)).toBe(4);
      expect(ctx.db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='schema_version'").get()!.value).toBe(String(MERCHANT_SCHEMA_VERSION));
      expect(ctx.db.query<{ name: string; pk: number }, []>('PRAGMA table_info(inventory_reservations)').all()
        .filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk).map(column => column.name)).toEqual(['purchase_attempt_id', 'entry_id']);
      expect(ctx.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      ctx.db.close(); ctx = makeTestContext({ databasePath: temp.path, catalog: basketCatalog(99) });
      expect(snapshot()).toEqual(before);
      expect(settlePendingAttempt(ctx, 'att_v2_pending', CALLER).status).toBe('confirmed');
      expect(available(ctx)).toBe(4);
      expect(countOrders(ctx.db)).toBe(2);
      expect(countPayments(ctx.db)).toBe(3);
    } finally { ctx.db.close(); temp.cleanup(); }
  });

  test('v1 history imports every basket item and declining a pending basket pays off each historical debt once', () => {
    const temp = makeTempDatabasePath();
    let ctx = makeTestContext({ databasePath: temp.path, catalog: basketCatalog(1) });
    try {
      const sold = basketQuote(ctx), pending = basketQuote(ctx), failed = basketQuote(ctx);
      expect(checkout(ctx, sold, 'att_v1_basket_sold').kind).toBe('confirmed');
      for (const [attemptId, value, isPending] of [
        ['att_v1_basket_pending', pending, true], ['att_v1_basket_failed', failed, false],
      ] as const) {
        insertProcessingAttempt(ctx.db, { attemptId, callerId: CALLER, merchantId: ctx.config.merchantId,
          quoteId: value.quote_id, catalogId: ctx.config.catalogId, pendingSettlement: isPending, nowMs: TEST_NOW_MS });
        if (!isPending) markAttemptFailed(ctx.db, { attemptId, error: { code: 'payment_failed', message: 'legacy declined' }, nowMs: TEST_NOW_MS });
      }
      ctx.db.exec("DROP TABLE inventory_debts; DROP TABLE inventory_reservations; DROP TABLE inventory; UPDATE schema_meta SET value='1' WHERE key='schema_version';");
      ctx.db.close();
      ctx = makeTestContext({ databasePath: temp.path, catalog: basketCatalog(1), faults: ['payment_declined'] });
      expect(available(ctx)).toBe(0);
      expect(available(ctx, 'entry_americano')).toBe(0);
      expect(ctx.db.query<{ state: string; quantity: number }, []>('SELECT state, quantity FROM inventory_reservations ORDER BY purchase_attempt_id,entry_id').all())
        .toEqual([{ state: 'released', quantity: 1 }, { state: 'released', quantity: 1 },
          { state: 'reserved', quantity: 1 }, { state: 'reserved', quantity: 1 }, { state: 'consumed', quantity: 1 }, { state: 'consumed', quantity: 1 }]);
      expect(ctx.db.query<{ quantity: number }, []>('SELECT quantity FROM inventory_debts ORDER BY entry_id').all()).toEqual([{ quantity: 1 }, { quantity: 1 }]);
      expect(settlePendingAttempt(ctx, 'att_v1_basket_pending', CALLER).status).toBe('failed');
      expect(available(ctx)).toBe(0);
      expect(available(ctx, 'entry_americano')).toBe(0);
      expect(ctx.db.query<{ quantity: number }, []>('SELECT quantity FROM inventory_debts ORDER BY entry_id').all()).toEqual([{ quantity: 0 }, { quantity: 0 }]);
      expect(() => releaseInventory(ctx.db, 'att_v1_basket_pending')).toThrow();
      expect(settlePendingAttempt(ctx, 'att_v1_basket_pending', CALLER).status).toBe('failed');
      expect(countOrders(ctx.db)).toBe(1);
      expect(countPayments(ctx.db)).toBe(2);
      ctx.db.close(); ctx = makeTestContext({ databasePath: temp.path, catalog: basketCatalog(1) });
      expect(available(ctx)).toBe(0); expect(available(ctx, 'entry_americano')).toBe(0);
    } finally { ctx.db.close(); temp.cleanup(); }
  });

  test('a newer schema version fails closed instead of being rewritten as this version', () => {
    const temp = makeTempDatabasePath(), db = openMerchantDb(temp.path);
    try {
      db.query("UPDATE schema_meta SET value='4' WHERE key='schema_version'").run(); db.close();
      expect(() => openMerchantDb(temp.path)).toThrow('unsupported schema version');
    } finally { db.close(); temp.cleanup(); }
  });
});

describe('persistent transaction inventory', () => {
  test('a declined legacy pending attempt resolves historical overcommit without recreating stock sold to another order', () => {
    const temp = makeTempDatabasePath();
    let ctx = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog() });
    try {
      const purchased = quote(ctx);
      const pending = quote(ctx);
      checkout(ctx, purchased, 'att_v1_sold');
      // Emulate the old v1 overcommit: it could accept a pending attempt after
      // another purchase sold the only cup because there was no stock write.
      insertProcessingAttempt(ctx.db, {
        attemptId: 'att_v1_overcommitted', callerId: CALLER, merchantId: ctx.config.merchantId,
        quoteId: pending.quote_id, catalogId: ctx.config.catalogId, pendingSettlement: true, nowMs: TEST_NOW_MS,
      });
      ctx.db.exec('DROP TABLE inventory_debts');
      ctx.db.exec('DROP TABLE inventory_reservations');
      ctx.db.exec('DROP TABLE inventory');
      ctx.db.close();
      ctx = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog(), faults: ['payment_declined'] });
      expect(available(ctx)).toBe(0);
      expect(settlePendingAttempt(ctx, 'att_v1_overcommitted', CALLER).status).toBe('failed');
      expect(available(ctx)).toBe(0);
      expect(settlePendingAttempt(ctx, 'att_v1_overcommitted', CALLER).status).toBe('failed');
      expect(countOrders(ctx.db)).toBe(1);
      expect(countPayments(ctx.db)).toBe(2);
      expect(ctx.db.query<{ quantity: number }, []>('SELECT quantity FROM inventory_debts').get()?.quantity).toBe(0);
    } finally { ctx.db.close(); temp.cleanup(); }
  });
  test('a v1 database upgrade imports sold and pending stock rather than replenishing or stranding it', () => {
    for (const pending of [false, true]) {
      const temp = makeTempDatabasePath();
      let ctx = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog(),
        ...(pending ? { faults: ['payment_timeout_then_succeed'] as const } : {}) });
      try {
        const value = quote(ctx);
        const attemptId = pending ? 'att_v1_pending' : 'att_v1_confirmed';
        checkout(ctx, value, attemptId);
        // Remove only the v2 additions from this explicitly isolated database.
        ctx.db.exec('DROP TABLE inventory_debts');
        ctx.db.exec('DROP TABLE inventory_reservations');
        ctx.db.exec('DROP TABLE inventory');
        ctx.db.close();
        ctx = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog() });
        expect(available(ctx)).toBe(0);
        expect(settlePendingAttempt(ctx, attemptId, CALLER).status).toBe('confirmed');
        expect(countPayments(ctx.db)).toBe(1);
        expect(countOrders(ctx.db)).toBe(1);
        expect(available(ctx)).toBe(0);
      } finally { ctx.db.close(); temp.cleanup(); }
    }
  });
  test('two connections buying the last unit create at most one payment/order; retry and restart do not deduct/reset', () => {
    const temp = makeTempDatabasePath();
    let first = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog() });
    const second = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog() });
    try {
      const firstQuote = quote(first);
      const secondQuote = quote(second);
      const purchased = checkout(first, firstQuote, 'att_stock_first');
      expect(purchased.kind).toBe('confirmed');
      expect(() => checkout(second, secondQuote, 'att_stock_second')).toThrow(CommerceError);
      expect(available(second)).toBe(0);
      expect(checkout(first, firstQuote, 'att_stock_first')).toEqual(purchased);
      first.db.close();
      first = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog() });
      expect(available(first)).toBe(0);
      expect(checkout(first, firstQuote, 'att_stock_first')).toEqual(purchased);
      expect(countPayments(first.db)).toBe(1);
      expect(countOrders(first.db)).toBe(1);
      expect(() => quote(first)).toThrow(CommerceError);
    } finally { first.db.close(); second.db.close(); temp.cleanup(); }
  });

  test('processing holds persistent stock; restart and repeated recovery settle the same reservation once', () => {
    const temp = makeTempDatabasePath();
    let ctx = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog(), faults: ['payment_timeout_then_succeed'] });
    try {
      const first = quote(ctx);
      const competing = quote(ctx);
      expect(checkout(ctx, first, 'att_stock_pending').kind).toBe('processing');
      expect(available(ctx)).toBe(0);
      expect(countPayments(ctx.db)).toBe(0);
      expect(() => checkout(ctx, competing, 'att_stock_competing')).toThrow(CommerceError);
      ctx.db.close();
      ctx = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog() });
      expect(available(ctx)).toBe(0);
      const recovered = settlePendingAttempt(ctx, 'att_stock_pending', CALLER);
      expect(recovered.status).toBe('confirmed');
      expect(settlePendingAttempt(ctx, 'att_stock_pending', CALLER)).toEqual(recovered);
      expect(available(ctx)).toBe(0);
      expect(countPayments(ctx.db)).toBe(1);
      expect(countOrders(ctx.db)).toBe(1);
    } finally { ctx.db.close(); temp.cleanup(); }
  });

  test('a definite decline releases the reservation once and a new confirmed purchase can consume it', () => {
    const temp = makeTempDatabasePath();
    const failing = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog(), faults: ['payment_declined'] });
    const succeeding = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog() });
    try {
      const value = quote(failing);
      expect(checkout(failing, value, 'att_stock_decline').kind).toBe('declined');
      expect(available(succeeding)).toBe(1);
      expect(checkout(succeeding, value, 'att_stock_decline').kind).toBe('declined');
      expect(available(succeeding)).toBe(1);
      expect(countOrders(failing.db)).toBe(0);
      expect(checkout(succeeding, quote(succeeding), 'att_stock_after_decline').kind).toBe('confirmed');
      expect(available(failing)).toBe(0);
      expect(countPayments(failing.db)).toBe(2);
      expect(countOrders(failing.db)).toBe(1);
    } finally { failing.db.close(); succeeding.db.close(); temp.cleanup(); }
  });

  test('correctly signed wrong user/issuer cannot spend or reserve the quote owner inventory', () => {
    const ctx = makeTestContext({ catalog: oneCupCatalog() });
    try {
      const value = quote(ctx);
      for (const [userId, issuer] of [['different_signed_user', 'agent_a_demo'], [CALLER, 'wrong_issuer']]) {
        try {
          runCheckout(ctx, body(value, 'att_identity', userId, issuer), { callerId: CALLER, idempotencyKey: 'key_identity' });
          throw new Error('wrong signed identity accepted');
        } catch (error) {
          expect(error).toBeInstanceOf(CommerceError);
          expect((error as CommerceError).code).toBe('authorization_invalid');
        }
        expect(available(ctx)).toBe(1);
        expect(countPayments(ctx.db)).toBe(0);
      }
      expect(checkout(ctx, value, 'att_identity_correct').kind).toBe('confirmed');
    } finally { ctx.db.close(); }
  });

  test('two independent processes race on a shared SQLite database without overselling', async () => {
    const temp = makeTempDatabasePath();
    const ctx = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog() });
    const dir = dirname(temp.path);
    const gate = join(dir, 'gate');
    const ready = [join(dir, 'ready_a'), join(dir, 'ready_b')];
    const quotes = [quote(ctx), quote(ctx)];
    const worker = join(import.meta.dir, '../test-support/inventory-race-worker.ts');
    const workers = quotes.map((value, i) => Bun.spawn([process.execPath, worker, temp.path, value.quote_id,
      `att_stock_process_${i}`, ready[i]!, gate], { stdout: 'pipe', stderr: 'pipe' }));
    try {
      const deadline = Date.now() + 10_000;
      while (!ready.every(existsSync)) {
        if (Date.now() > deadline) throw new Error('independent inventory workers failed to become ready');
        await Bun.sleep(5);
      }
      await Bun.write(gate, 'go');
      const results = await Promise.all(workers.map(async (worker) => ({
        code: await worker.exited, stdout: await new Response(worker.stdout).text(), stderr: await new Response(worker.stderr).text(),
      })));
      expect(results.map((result) => ({ code: result.code, stderr: result.stderr }))).toEqual([
        { code: 0, stderr: '' }, { code: 0, stderr: '' },
      ]);
      expect(results.map((result) => JSON.parse(result.stdout).kind).sort()).toEqual(['confirmed', 'out_of_stock']);
      expect(available(ctx)).toBe(0);
      expect(countPayments(ctx.db)).toBe(1);
      expect(countOrders(ctx.db)).toBe(1);
    } finally {
      for (const worker of workers) { if (worker.exitCode === null) worker.kill(); await worker.exited; }
      ctx.db.close(); temp.cleanup();
    }
  }, 20_000);

  test('an abruptly terminated process leaves committed stock/order/payment and the original key recoverable', async () => {
    const temp = makeTempDatabasePath();
    let ctx = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog() });
    const dir = dirname(temp.path);
    const value = quote(ctx);
    const ready = join(dir, 'crash_ready');
    const gate = join(dir, 'crash_gate');
    const attemptId = 'att_stock_crash';
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, '../test-support/inventory-race-worker.ts'),
      temp.path, value.quote_id, attemptId, ready, gate, 'wait-for-kill'], { stdout: 'pipe', stderr: 'pipe' });
    try {
      await Bun.write(gate, 'go');
      const reader = worker.stdout.getReader();
      let output = '';
      while (!output.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('crash worker exited before committing');
        output += new TextDecoder().decode(chunk.value);
      }
      expect(JSON.parse(output).kind).toBe('confirmed');
      worker.kill();
      await worker.exited;
      ctx.db.close();
      ctx = makeTestContext({ databasePath: temp.path, catalog: oneCupCatalog() });
      expect(available(ctx)).toBe(0);
      expect(checkout(ctx, value, attemptId).kind).toBe('confirmed');
      expect(countPayments(ctx.db)).toBe(1);
      expect(countOrders(ctx.db)).toBe(1);
    } finally {
      if (worker.exitCode === null) worker.kill();
      await worker.exited;
      ctx.db.close(); temp.cleanup();
    }
  }, 15_000);
});
