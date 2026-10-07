/**
 * The SQLite store: schema and connection setup.
 *
 * `bun:sqlite` and not an in-memory Map, because contract §5 D4 requires that a
 * repeated request after a restart still finds the original result. A Map loses
 * that the moment the process exits, and "the process did not exit" is not a
 * property a payment flow is allowed to depend on.
 *
 * The uniqueness that enforces idempotency lives in the schema itself rather
 * than in application bookkeeping. A UNIQUE constraint is checked by the
 * database inside the write, so two callers racing on the same
 * `Idempotency-Key` cannot both observe "no existing row" and both proceed — a
 * read-then-write in application code can, and that is the classic way a
 * duplicate order is created.
 */
import { Database } from 'bun:sqlite';

export const MERCHANT_SCHEMA_VERSION = 2;

/**
 * All statements are `IF NOT EXISTS`: opening an existing database must be a
 * no-op, because the demo restarts constantly and a migration that fails on the
 * second run is worse than no migration.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  quote_id      TEXT PRIMARY KEY,
  caller_id     TEXT NOT NULL,
  merchant_id   TEXT NOT NULL,
  catalog_id    TEXT NOT NULL,
  currency      TEXT NOT NULL,
  terms_hash    TEXT NOT NULL,
  quote_json    TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_caller_idx ON quotes (caller_id);

CREATE TABLE IF NOT EXISTS attempts (
  purchase_attempt_id TEXT PRIMARY KEY,
  caller_id           TEXT NOT NULL,
  merchant_id         TEXT NOT NULL,
  quote_id            TEXT NOT NULL,
  catalog_id          TEXT NOT NULL,
  status              TEXT NOT NULL,
  order_id            TEXT,
  error_json          TEXT,
  pending_settlement  INTEGER NOT NULL DEFAULT 0,
  created_at_ms       INTEGER NOT NULL,
  updated_at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_caller_idx ON attempts (caller_id);

CREATE TABLE IF NOT EXISTS orders (
  order_id            TEXT PRIMARY KEY,
  caller_id           TEXT NOT NULL,
  merchant_id         TEXT NOT NULL,
  catalog_id          TEXT NOT NULL,
  purchase_attempt_id TEXT NOT NULL,
  quote_id            TEXT NOT NULL,
  total_minor         INTEGER NOT NULL,
  order_json          TEXT NOT NULL,
  created_at_ms       INTEGER NOT NULL,
  updated_at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_caller_idx ON orders (caller_id);
CREATE INDEX IF NOT EXISTS orders_attempt_idx ON orders (purchase_attempt_id);

-- One row per logical purchase. The UNIQUE key is what makes a retry of the
-- same attempt id return the original decision instead of charging twice.
CREATE TABLE IF NOT EXISTS payments (
  payment_id          TEXT PRIMARY KEY,
  payment_key         TEXT NOT NULL UNIQUE,
  purchase_attempt_id TEXT NOT NULL,
  caller_id           TEXT NOT NULL,
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL,
  reference           TEXT NOT NULL,
  failure_reason      TEXT,
  created_at_ms       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  caller_id           TEXT NOT NULL,
  merchant_id         TEXT NOT NULL,
  idem_key            TEXT NOT NULL,
  request_digest      TEXT NOT NULL,
  purchase_attempt_id TEXT NOT NULL,
  state               TEXT NOT NULL,
  response_status     INTEGER,
  response_json       TEXT,
  created_at_ms       INTEGER NOT NULL,
  updated_at_ms       INTEGER NOT NULL,
  PRIMARY KEY (caller_id, merchant_id, idem_key)
);

CREATE TABLE IF NOT EXISTS purchase_events (
  event_id       TEXT PRIMARY KEY,
  subject_type   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  type           TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  data_json      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS purchase_events_subject_idx ON purchase_events (subject_type, subject_id);

-- Available stock is persistent and seeded only when an entry first appears.
-- NULL means the catalog explicitly has no finite quantity limit.
CREATE TABLE IF NOT EXISTS inventory (
  merchant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  availability_status TEXT NOT NULL,
  available_quantity INTEGER CHECK (available_quantity IS NULL OR available_quantity >= 0),
  PRIMARY KEY (merchant_id, entry_id)
);
CREATE TABLE IF NOT EXISTS inventory_reservations (
  purchase_attempt_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed', 'released')),
  FOREIGN KEY (merchant_id, entry_id) REFERENCES inventory (merchant_id, entry_id)
);
-- A v1 store could already have promised more than its seed stock. Keep that
-- shortage separate so releasing an old pending attempt cannot invent stock.
CREATE TABLE IF NOT EXISTS inventory_debts (
  merchant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (merchant_id, entry_id),
  FOREIGN KEY (merchant_id, entry_id) REFERENCES inventory (merchant_id, entry_id)
);
`;

export function openMerchantDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // WAL keeps a reader from blocking the writer; irrelevant for :memory:, where
  // SQLite reports "memory" and moves on.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  db.query('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(MERCHANT_SCHEMA_VERSION),
  );
  return db;
}

/**
 * Runs `work` inside a single `BEGIN IMMEDIATE` transaction.
 *
 * Immediate rather than deferred so the write lock is taken up front: a deferred
 * transaction can read, decide, and only discover on its first write that
 * someone else got there first, which is exactly the race the idempotency claim
 * must not lose.
 *
 * `work` must be synchronous. `bun:sqlite` transactions cannot span an `await`,
 * and a transaction that silently committed early would be worse than one that
 * refused to compile.
 */
export function inTransaction<T>(db: Database, work: () => T): T {
  return db.transaction(work).immediate();
}
