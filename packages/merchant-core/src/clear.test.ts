/**
 * Clearing a test store.
 *
 * The contract sentence this implements has two clauses — *explicit test
 * storage* and *never automatic* — and each is a gate, so each gets a test that
 * fails if the gate is taken out. That matters more here than elsewhere in this
 * package: almost every other defect in it produces a wrong answer, while this
 * one produces a missing database. So the refusal tests assert what was **not**
 * touched, not merely that something was thrown.
 *
 * The list of tables below is written out on purpose. It is the *test's* idea of
 * what the schema holds, kept independent of the production list, which is
 * derived from `sqlite_master`. If both read the same source, a table the
 * production list forgot would be forgotten by the check as well.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { MERCHANT_SCHEMA_VERSION, openMerchantDb } from './db';
import {
  ClearRefusedError,
  clearMerchantData,
  clearMerchantStore,
  dataTableNames,
} from './clear';
import { makeTempDatabasePath } from './test-support';

/** Every table that holds data, as the schema in `db.ts` defines it. */
const DATA_TABLES = [
  'attempts',
  'idempotency_records',
  'orders',
  'payments',
  'purchase_events',
  'quotes',
] as const;

const TERMS_HASH = 'a'.repeat(64);

/** One row in every data table, so that "cleared" has something to be true about. */
function seedEveryDataTable(db: Database): void {
  db.exec(`
    INSERT INTO quotes (quote_id, caller_id, merchant_id, catalog_id, currency, terms_hash, quote_json, created_at_ms, expires_at_ms)
      VALUES ('quote_1', 'caller_1', 'merchant_coffee_demo', 'catalog_coffee_demo', 'CNY', '${TERMS_HASH}', '{}', 1, 2);

    INSERT INTO attempts (purchase_attempt_id, caller_id, merchant_id, quote_id, catalog_id, status, created_at_ms, updated_at_ms)
      VALUES ('att_1', 'caller_1', 'merchant_coffee_demo', 'quote_1', 'catalog_coffee_demo', 'processing', 1, 1);

    INSERT INTO orders (order_id, caller_id, merchant_id, catalog_id, purchase_attempt_id, quote_id, total_minor, order_json, created_at_ms, updated_at_ms)
      VALUES ('ord_1', 'caller_1', 'merchant_coffee_demo', 'catalog_coffee_demo', 'att_1', 'quote_1', 5000, '{}', 1, 1);

    INSERT INTO payments (payment_id, payment_key, purchase_attempt_id, caller_id, amount_minor, currency, status, reference, created_at_ms)
      VALUES ('pay_1', 'att_1', 'att_1', 'caller_1', 5000, 'CNY', 'succeeded', 'ref_1', 1);

    INSERT INTO idempotency_records (caller_id, merchant_id, idem_key, request_digest, purchase_attempt_id, state, created_at_ms, updated_at_ms)
      VALUES ('caller_1', 'merchant_coffee_demo', 'key_1', 'digest_1', 'att_1', 'settled', 1, 1);

    INSERT INTO purchase_events (event_id, subject_type, subject_id, type, occurred_at_ms, data_json)
      VALUES ('evt_1', 'order', 'ord_1', 'order.created', 1, '{}');
  `);
}

function rowCount(db: Database, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
  return row.n;
}

/** Opens a seeded store, hands it to `body`, and removes the directory either way. */
function withSeededStore(body: (db: Database, path: string) => void): void {
  const { path, cleanup } = makeTempDatabasePath();
  const db = openMerchantDb(path);
  try {
    seedEveryDataTable(db);
    body(db, path);
  } finally {
    db.close();
    cleanup();
  }
}

describe('the test-store gate', () => {
  test('refuses without MERCHANT_TEST_MODE, and does not create what it refused to clear', () => {
    // Arrange
    const { path, cleanup } = makeTempDatabasePath();

    try {
      // Act / Assert
      expect(() => clearMerchantStore({ databasePath: path, testMode: false })).toThrow(
        ClearRefusedError,
      );
      // The refusal has to land *before* the open: `openMerchantDb` creates the
      // file when it is missing, so a gate checked after opening would leave a
      // brand-new database behind as the trace of a clear that never ran.
      expect(existsSync(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('a refusal leaves an existing store exactly as it was', () => {
    // Arrange: this is the destructive-defect guard. A gate that threw *after*
    // deleting would pass a test that only asserted the throw.
    withSeededStore((db, path) => {
      // Act / Assert
      expect(() => clearMerchantStore({ databasePath: path, testMode: false })).toThrow(
        ClearRefusedError,
      );
      for (const table of DATA_TABLES) expect(rowCount(db, table)).toBe(1);
    });
  });

  test('clears once the store is declared test storage', () => {
    // Arrange: without this, "always refuse" would pass every other test here.
    withSeededStore((db, path) => {
      // Act
      const result = clearMerchantStore({ databasePath: path, testMode: true });

      // Assert
      expect(result.databasePath).toBe(path);
      expect(result.totalRows).toBe(DATA_TABLES.length);
      for (const table of DATA_TABLES) expect(rowCount(db, table)).toBe(0);
    });
  });
});

describe('what a clear removes', () => {
  test('empties every data table the schema defines', () => {
    withSeededStore((db) => {
      // Arrange
      for (const table of DATA_TABLES) expect(rowCount(db, table)).toBe(1);

      // Act
      clearMerchantData(db);

      // Assert
      for (const table of DATA_TABLES) expect(rowCount(db, table)).toBe(0);
    });
  });

  test('reports the rows it removed, per table and in total', () => {
    withSeededStore((db) => {
      // Arrange: two extra quotes so the counts cannot all be the same number,
      // which is what an off-by-one in the per-table accounting would look like.
      db.exec(`
        INSERT INTO quotes (quote_id, caller_id, merchant_id, catalog_id, currency, terms_hash, quote_json, created_at_ms, expires_at_ms)
          VALUES ('quote_2', 'caller_1', 'merchant_coffee_demo', 'catalog_coffee_demo', 'CNY', '${TERMS_HASH}', '{}', 1, 2),
                 ('quote_3', 'caller_1', 'merchant_coffee_demo', 'catalog_coffee_demo', 'CNY', '${TERMS_HASH}', '{}', 1, 2);
      `);

      // Act
      const result = clearMerchantData(db);
      const byTable = new Map(result.cleared.map((entry) => [entry.table, entry.rows]));

      // Assert: every table is accounted for, so a table that was skipped shows
      // up as a missing name rather than as a slightly smaller total.
      expect([...byTable.keys()].sort()).toEqual([...DATA_TABLES]);
      expect(byTable.get('quotes')).toBe(3);
      expect(byTable.get('payments')).toBe(1);
      expect(result.totalRows).toBe(DATA_TABLES.length + 2);
    });
  });

  test('keeps the schema bookkeeping row', () => {
    // Arrange: `schema_meta` is not data, and a clear that dropped the recorded
    // schema version would be a migration bug wearing a cleanup's clothes.
    withSeededStore((db) => {
      // Act
      clearMerchantData(db);

      // Assert
      const row = db.query(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
        value: string;
      } | null;
      expect(row?.value).toBe(String(MERCHANT_SCHEMA_VERSION));
    });
  });

  test('empties a table added after this file was written', () => {
    // Arrange: the regression test for a hardcoded table list. A surviving
    // `idempotency_records` row would make a replay after the clear return the
    // order from before the clear — which looks exactly like the clear worked.
    withSeededStore((db) => {
      db.exec(`CREATE TABLE later_migration (id TEXT PRIMARY KEY); INSERT INTO later_migration VALUES ('x');`);

      // Act
      const result = clearMerchantData(db);

      // Assert
      expect(result.cleared.map((entry) => entry.table)).toContain('later_migration');
      expect(rowCount(db, 'later_migration')).toBe(0);
    });
  });

  test('is safe to run against a store it has already emptied', () => {
    withSeededStore((db) => {
      // Arrange
      clearMerchantData(db);

      // Act
      const second = clearMerchantData(db);

      // Assert: zero is the honest answer, not an error and not a repeat of the
      // first run's numbers.
      expect(second.totalRows).toBe(0);
      expect(second.cleared.map((entry) => entry.rows)).toEqual(DATA_TABLES.map(() => 0));
    });
  });
});

describe('the table list', () => {
  test('rejects an unquotable table name without emptying anything', () => {
    // Arrange: table names are interpolated into the DELETE, so a name this file
    // will not quote has to stop the whole clear rather than skip one table.
    //
    // Note what this does *not* prove: the names are collected before the
    // transaction opens, so the failure lands without a write transaction ever
    // starting — but if that collection ever moved inside, the transaction's
    // rollback would produce the same untouched store. The assertion below is
    // therefore about the store being left whole, not about which of the two
    // mechanisms kept it whole.
    withSeededStore((db) => {
      db.exec(`CREATE TABLE "odd""name" (a TEXT)`);

      // Act / Assert
      expect(() => clearMerchantData(db)).toThrow(/plain SQL identifier/);
      for (const table of DATA_TABLES) expect(rowCount(db, table)).toBe(1);
    });
  });

  test('derives the table list from the schema rather than from a literal', () => {
    // Arrange
    withSeededStore((db) => {
      // Act / Assert: the list must equal the schema's data tables — sorted, so
      // that this stays a statement about membership rather than about order.
      expect(dataTableNames(db)).toEqual([...DATA_TABLES]);
    });
  });
});
