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
        const line = quote.items[0]!;
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
  const result = ctx.db.query(`UPDATE inventory
    SET available_quantity = CASE WHEN available_quantity IS NULL THEN NULL ELSE available_quantity - ? END
    WHERE merchant_id = ? AND entry_id = ? AND availability_status != 'out_of_stock'
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

/** A paid purchase consumes its existing reservation without deducting again. */
export function consumeInventory(db: Database, attemptId: string): void {
  const result = db.query("UPDATE inventory_reservations SET state = 'consumed' WHERE purchase_attempt_id = ? AND state = 'reserved'").run(attemptId);
  if (result.changes !== 1) throw new Error(`attempt ${attemptId} has no reserved inventory to consume`);
}

/** A definite decline returns stock once; pending/unknown attempts keep it. */
export function releaseInventory(db: Database, attemptId: string): void {
  const row = db.query<{ merchant_id: string; entry_id: string; quantity: number }, [string]>(
    "SELECT merchant_id, entry_id, quantity FROM inventory_reservations WHERE purchase_attempt_id = ? AND state = 'reserved'",
  ).get(attemptId);
  if (row === null) throw new Error(`attempt ${attemptId} has no reserved inventory to release`);
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
  db.query("UPDATE inventory_reservations SET state = 'released' WHERE purchase_attempt_id = ? AND state = 'reserved'").run(attemptId);
}
