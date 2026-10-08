/**
 * Clearing the store — for a store that says out loud that it is a test store.
 *
 * Contract §11 D10: *"清空数据工具只作用于显式测试存储，默认不自动清空"* — the
 * tool acts only on explicit test storage, and never clears by itself. Both
 * halves of that sentence are enforced here rather than left to the caller, so
 * there is no path to the deletes that skips either one:
 *
 *   - **Explicit test storage** is `MERCHANT_TEST_MODE=1`, the same flag that
 *     arms fault injection. Refusing beats guessing: a database whose path
 *     happens to point at something a person cares about is cleared only if that
 *     environment variable was set on purpose.
 *   - **Never automatic** is that nothing in the merchant calls this. It is
 *     reachable only through the app's `--clear` flag — and the test-mode check
 *     runs *before* the file is opened, because `openMerchantDb` creates what it
 *     cannot find, so a refused clear must not leave a new database behind as a
 *     side effect of the refusal.
 *
 * The table list is read from `sqlite_master` instead of written out here. A
 * hand-maintained list is a list that can fall behind the schema, and this
 * particular drift is quiet: one surviving `idempotency_records` row means a
 * replay after the clear returns the order from before the clear, which is
 * indistinguishable from "the clear worked and the row was recreated".
 *
 * This deletes rows. It is **not a secure erase**: SQLite keeps freed pages in
 * the file, and the write-ahead log holds recent pages until it is checkpointed.
 * Bytes of cleared rows may survive until they are overwritten. A cleared
 * database is empty, not shredded.
 */
import type { Database } from 'bun:sqlite';
import { inTransaction, openMerchantDb } from './db';

/**
 * Schema bookkeeping, not data. It survives a clear on purpose: the next
 * `openMerchantDb` would rewrite it anyway, and a clear that also dropped the
 * recorded schema version would be a migration bug wearing a cleanup's clothes.
 */
const SCHEMA_META_TABLE = 'schema_meta';

/**
 * Table names are interpolated into the `DELETE` below, so they are checked
 * against this first. They come from `sqlite_master` and not from a request, so
 * this is not a defence against a caller — it is a refusal to build a statement
 * out of a name this file does not understand.
 */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ClearStoreOptions {
  readonly databasePath: string;
  /** `MERCHANT_TEST_MODE`. A false value refuses the clear. */
  readonly testMode: boolean;
}

export interface ClearedTable {
  readonly table: string;
  /** Rows deleted. Zero is a real answer and means the store was already empty. */
  readonly rows: number;
}

export interface ClearResult {
  readonly databasePath: string;
  readonly cleared: readonly ClearedTable[];
  readonly totalRows: number;
}

/** Raised instead of a `SQLiteError` when the store is not declared as a test store. */
export class ClearRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClearRefusedError';
  }
}

/** Every table that holds data, in a stable order. Exported so a test can name the set. */
export function dataTableNames(db: Database): string[] {
  const rows = db
    .query(
      `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name <> ?
         ORDER BY name`,
    )
    .all(SCHEMA_META_TABLE) as { name: string }[];

  const names = rows.map((row) => row.name);
  for (const name of names) {
    if (!PLAIN_IDENTIFIER.test(name)) {
      throw new Error(
        `refusing to clear table ${JSON.stringify(name)}: this tool builds a DELETE statement out of a table name and will not do so for a name that is not a plain SQL identifier`,
      );
    }
  }
  return names;
}

/**
 * Deletes every row from every data table, in one transaction.
 *
 * One transaction so the store cannot be observed half-cleared — a reader between
 * two `DELETE`s would see orders with no payments, which is a state the schema
 * deliberately makes impossible. Takes an open database rather than a path so it
 * composes with a caller that already has one; `clearMerchantStore` is the form
 * that enforces the gate.
 */
export function clearMerchantData(db: Database, databasePath = ':unknown:'): ClearResult {
  // Collected before the transaction opens: a name this file refuses to quote
  // must fail an empty-handed call, not a call that has already deleted rows.
  const tables = dataTableNames(db);
  const cleared = inTransaction(db, () =>
    tables.map((table) => ({ table, rows: db.query(`DELETE FROM "${table}"`).run().changes })),
  );
  return {
    databasePath,
    cleared,
    totalRows: cleared.reduce((sum, entry) => sum + entry.rows, 0),
  };
}

/**
 * The whole operation: refuse unless declared test storage, open, clear, close.
 *
 * Opening and closing are inside so that the refusal is provably ahead of the
 * open — the file is not created for a clear that is not going to happen. Closing
 * also checkpoints the write-ahead log, which is the most that can be said about
 * removing the old bytes from disk.
 */
export function clearMerchantStore(options: ClearStoreOptions): ClearResult {
  if (!options.testMode) {
    throw new ClearRefusedError(
      'refusing to clear: this tool only acts on explicit test storage, and MERCHANT_TEST_MODE is not enabled. ' +
        'If this database really is a test database, set MERCHANT_TEST_MODE=1 for this command.',
    );
  }

  const db = openMerchantDb(options.databasePath);
  try {
    return clearMerchantData(db, options.databasePath);
  } finally {
    db.close();
  }
}
