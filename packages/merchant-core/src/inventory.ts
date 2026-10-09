import type { Database } from 'bun:sqlite';
import { CommerceError, quoteInconsistency, quoteSchema } from '@ocp-catalog/shopping-contracts';
import type { CatalogEntryRecord } from './catalog';
import type { MerchantContext } from './context';
import { inTransaction } from './db';

interface InventoryRow {
  availability_status: CatalogEntryRecord['attributes']['inventory']['availability_status'];
  available_quantity: number | null;
}

/** Never resets an existing entry, including when two processes start together. */
export function initializeInventory(db: Database, merchantId: string, catalog: readonly CatalogEntryRecord[]): void {
  inTransaction(db, () => {
    const insert = db.query(`INSERT OR IGNORE INTO inventory
      (merchant_id, entry_id, availability_status, available_quantity) VALUES (?, ?, ?, ?)`);
    for (const record of catalog) {
      const { quantity, availability_status } = record.attributes.inventory;
      if (quantity !== undefined && !Number.isSafeInteger(quantity)) {
        throw new Error(`catalog entry ${record.entry.entry_id}: inventory.quantity must be a safe integer`);
      }
      const created = insert.run(merchantId, record.entry.entry_id, availability_status, quantity ?? null);
      if (created.changes === 0) continue;

      // Schema v1 had payments/orders but no stock table. Import its accepted
      // attempts when first seeding this entry, so upgrading cannot replenish
      // sold stock or strand a pending attempt without its reservation.
      const history = db.query<{ purchase_attempt_id: string; status: string; quote_json: string }, [string]>(
        `SELECT a.purchase_attempt_id, a.status, q.quote_json FROM attempts a
         JOIN quotes q ON q.quote_id = a.quote_id WHERE a.merchant_id = ?`,
      ).all(merchantId);
      let committedQuantity = 0;
      for (const attempt of history) {
        const quote = quoteSchema.parse(JSON.parse(attempt.quote_json));
        const problem = quoteInconsistency(quote);
        if (problem !== null) throw new Error(`legacy quote ${quote.quote_id} is inconsistent: ${problem}`);
        for (const line of quote.items) {
          if (line.entry_id !== record.entry.entry_id) continue;
          const state = attempt.status === 'confirmed' ? 'consumed' : attempt.status === 'failed' ? 'released' : 'reserved';
          db.query(`INSERT OR IGNORE INTO inventory_reservations
            (purchase_attempt_id, merchant_id, entry_id, quantity, state) VALUES (?, ?, ?, ?, ?)`)
            .run(attempt.purchase_attempt_id, merchantId, line.entry_id, line.quantity, state);
          if (state !== 'released') {
            committedQuantity += line.quantity;
            if (!Number.isSafeInteger(committedQuantity)) throw new Error('legacy committed stock exceeds the safe integer range');
          }
        }
      }
      if (quantity !== undefined && committedQuantity > 0) {
        db.query('UPDATE inventory SET available_quantity = ? WHERE merchant_id = ? AND entry_id = ?')
          .run(Math.max(0, quantity - committedQuantity), merchantId, record.entry.entry_id);
        if (committedQuantity > quantity) {
          db.query('INSERT INTO inventory_debts (merchant_id, entry_id, quantity) VALUES (?, ?, ?)')
            .run(merchantId, record.entry.entry_id, committedQuantity - quantity);
        }
      }
    }
  });
}

/** Fresh stock for quote, OCP query and Resolve; the catalog seed is not stock. */
export function catalogWithInventory(ctx: MerchantContext): CatalogEntryRecord[] {
  const select = ctx.db.query<InventoryRow, [string, string]>(
    'SELECT availability_status, available_quantity FROM inventory WHERE merchant_id = ? AND entry_id = ?',
  );
  return ctx.catalog.map((record) => {
    const row = select.get(ctx.config.merchantId, record.entry.entry_id);
    if (row === null) throw new Error(`missing persistent inventory for ${record.entry.entry_id}`);
    const inventory = {
      ...record.attributes.inventory,
      availability_status: row.available_quantity === 0 ? 'out_of_stock' as const : row.availability_status,
      quantity: row.available_quantity ?? undefined,
    };
    return {
      entry: { ...record.entry, attributes: { ...record.entry.attributes, inventory } },
      attributes: { ...record.attributes, inventory },
    };
  });
}

/** Must run in the checkout's BEGIN IMMEDIATE transaction before payment. */
export function reserveInventory(ctx: MerchantContext, attemptId: string, entryId: string, quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new CommerceError('invalid_request', 'inventory reservation quantity must be a positive safe integer');
  const result = ctx.db.query(`UPDATE inventory
    SET available_quantity = CASE WHEN available_quantity IS NULL THEN NULL ELSE available_quantity - ? END
    WHERE merchant_id = ? AND entry_id = ? AND availability_status IN ('in_stock', 'low_stock')
      AND (available_quantity IS NULL OR available_quantity >= ?)`)
    .run(quantity, ctx.config.merchantId, entryId, quantity);
  if (result.changes !== 1) {
    const row = ctx.db.query<InventoryRow, [string, string]>(
      'SELECT availability_status, available_quantity FROM inventory WHERE merchant_id = ? AND entry_id = ?',
    ).get(ctx.config.merchantId, entryId);
    throw new CommerceError('out_of_stock', `entry ${entryId} cannot reserve ${quantity} units`, {
      entry_id: entryId, available: row?.available_quantity ?? 0, requested: quantity,
    });
  }
  ctx.db.query(`INSERT INTO inventory_reservations
    (purchase_attempt_id, merchant_id, entry_id, quantity, state) VALUES (?, ?, ?, ?, 'reserved')`)
    .run(attemptId, ctx.config.merchantId, entryId, quantity);
}

/** A failed line must not leave earlier basket rows reserved, even when the
 * checkout catches the error and commits its cached rejection in the outer transaction. */
export function reserveBasketInventory(ctx: MerchantContext, attemptId: string, items: { entry_id: string; quantity: number }[]): void {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10
    || items.some(item => !item || typeof item.entry_id !== 'string' || !item.entry_id.trim()
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1)
    || new Set(items.map(item => item.entry_id)).size !== items.length
    || items.reduce((sum, item) => sum + item.quantity, 0) > 20) {
    throw new CommerceError('invalid_request', 'basket reservations require 1–10 unique entries and 1–20 total units');
  }
  inventorySavepoint(ctx.db, () => {
    for (const item of items) reserveInventory(ctx, attemptId, item.entry_id, item.quantity);
  });
}

function inventorySavepoint<T>(db: Database, operation: () => T): T {
  const name = `ocp_inventory_${crypto.randomUUID().replaceAll('-', '')}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

/** A paid purchase consumes its existing reservation without deducting again. */
export function consumeInventory(db: Database, attemptId: string): void {
  const result = db.query("UPDATE inventory_reservations SET state = 'consumed' WHERE purchase_attempt_id = ? AND state = 'reserved'").run(attemptId);
  if (result.changes < 1) throw new Error(`attempt ${attemptId} has no reserved inventory to consume`);
}

/** A definite decline returns stock once; pending/unknown attempts keep it. */
export function releaseInventory(db: Database, attemptId: string): void {
  inventorySavepoint(db, () => {
    const rows = db.query<{ merchant_id: string; entry_id: string; quantity: number }, [string]>(
      "SELECT merchant_id, entry_id, quantity FROM inventory_reservations WHERE purchase_attempt_id = ? AND state = 'reserved'",
    ).all(attemptId);
    if (!rows.length) throw new Error(`attempt ${attemptId} has no reserved inventory to release`);
    for (const row of rows) {
      const debt = db.query<{ quantity: number }, [string, string]>(
        'SELECT quantity FROM inventory_debts WHERE merchant_id = ? AND entry_id = ?',
      ).get(row.merchant_id, row.entry_id)?.quantity ?? 0;
      const debtReleased = Math.min(row.quantity, debt);
      if (debtReleased > 0) {
        db.query('UPDATE inventory_debts SET quantity = quantity - ? WHERE merchant_id = ? AND entry_id = ?')
          .run(debtReleased, row.merchant_id, row.entry_id);
      }
      db.query(`UPDATE inventory SET available_quantity = CASE WHEN available_quantity IS NULL THEN NULL ELSE available_quantity + ? END
        WHERE merchant_id = ? AND entry_id = ?`).run(row.quantity - debtReleased, row.merchant_id, row.entry_id);
    }
    const result = db.query("UPDATE inventory_reservations SET state = 'released' WHERE purchase_attempt_id = ? AND state = 'reserved'").run(attemptId);
    if (result.changes !== rows.length) throw new Error(`attempt ${attemptId} reservation changed while releasing inventory`);
  });
}
