import { CommerceError, orderInconsistency, orderSchema, projectMerchantOrderDetail, projectMerchantOrderSummary,
  type MerchantOrderDetail, type MerchantOrderSummary, type MerchantOverviewView,
  type MerchantProductsPage, type MerchantProductView, type Order } from '@ocp-catalog/shopping-contracts';
import type { MerchantContext } from './context';
import { catalogWithInventory } from './inventory';

export type MerchantDemoPage<T> = Pick<MerchantProductsPage, 'next_cursor' | 'has_more' | 'total'> & { items: T[] };
export type MerchantDemoProduct = MerchantProductView;
export type MerchantDemoOrderSummary = MerchantOrderSummary;
export interface MerchantDemoProductQuery { query?: string; limit?: number; cursor?: string }
export interface MerchantDemoOrderQuery { limit?: number; cursor?: string }
export type MerchantDemoOverview = MerchantOverviewView;
export interface MerchantDemoReader {
  overview(): MerchantDemoOverview;
  products(options?: MerchantDemoProductQuery): MerchantDemoPage<MerchantDemoProduct>;
  orders(options?: MerchantDemoOrderQuery): MerchantDemoPage<MerchantDemoOrderSummary>;
  order(id: string): MerchantOrderDetail;
}

type ProductCursor = { type: 'products'; merchant: string; catalog: string; query: string; entry: string };
type OrderCursor = { type: 'orders'; merchant: string; catalog: string; created: number; order: string };
type Cursor = ProductCursor | OrderCursor;
interface OrderRow { order_id: string; created_at_ms: number; order_json: string }

function invalid(): never { throw new CommerceError('invalid_request', 'invalid merchant read pagination or identifier'); }
function pageLimit(value: unknown): number {
  if (value === undefined) return 20;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 50) invalid();
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}
function keyword(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value.trim().toLowerCase();
}
function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decodeCursor(value: unknown, type: Cursor['type'], merchant: string, catalog: string, query?: string): Cursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const cursor = parsed as Record<string, unknown>;
  if (cursor.type !== type || cursor.merchant !== merchant || cursor.catalog !== catalog) invalid();
  if (type === 'products') {
    if (Object.keys(cursor).sort().join(',') !== 'catalog,entry,merchant,query,type' || cursor.query !== query) invalid();
    identifier(cursor.entry);
  } else {
    if (Object.keys(cursor).sort().join(',') !== 'catalog,created,merchant,order,type'
      || typeof cursor.created !== 'number' || !Number.isSafeInteger(cursor.created) || cursor.created < 0) invalid();
    identifier(cursor.order);
  }
  return cursor as unknown as Cursor;
}

/** A local demo capability over the merchant's already-open SQLite connection.
 * Every database statement is SELECT. It never initializes, migrates, settles,
 * reserves or repairs data, and it does not expose the connection to its caller. */
export function createMerchantDemoReader(ctx: MerchantContext): MerchantDemoReader {
  const merchant = ctx.config.merchantId;
  const catalog = ctx.config.catalogId;
  const scopedContext = { ...ctx, catalog: ctx.catalog.filter(record => record.entry.catalog_id === catalog) };

  function products(options: MerchantDemoProductQuery = {}): MerchantDemoPage<MerchantDemoProduct> {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['query', 'limit', 'cursor'].includes(key))) invalid();
    const limit = pageLimit(options.limit);
    const query = keyword(options.query);
    const cursor = decodeCursor(options.cursor, 'products', merchant, catalog, query) as ProductCursor | undefined;
    const reservations = new Map(ctx.db.query<{ entry_id: string; reserved_quantity: number }, [string, string, string]>(
      `SELECT r.entry_id, SUM(r.quantity) AS reserved_quantity FROM inventory_reservations r
       JOIN attempts a ON a.purchase_attempt_id = r.purchase_attempt_id
       WHERE r.merchant_id = ? AND a.merchant_id = ? AND a.catalog_id = ? AND r.state = 'reserved'
       GROUP BY r.entry_id`,
    ).all(merchant, merchant, catalog).map(row => [row.entry_id, row.reserved_quantity]));
    const matches = catalogWithInventory(scopedContext).filter(record => !query ||
      [record.entry.entry_id, record.entry.title, record.entry.summary ?? '', record.attributes.brand ?? '', record.attributes.category ?? '']
        .some(value => value.toLowerCase().includes(query)))
      .sort((left, right) => left.entry.entry_id < right.entry.entry_id ? -1 : left.entry.entry_id > right.entry.entry_id ? 1 : 0);
    const remaining = cursor ? matches.filter(record => record.entry.entry_id > cursor.entry) : matches;
    const selected = remaining.slice(0, limit);
    const hasMore = remaining.length > selected.length;
    return {
      items: selected.map(record => ({
        entry_id: record.entry.entry_id, title: record.entry.title,
        price_minor: record.attributes.price_minor, currency: record.attributes.price.currency,
        inventory: { availability_status: record.attributes.inventory.availability_status,
          available_quantity: record.attributes.inventory.quantity ?? null,
          reserved_quantity: reservations.get(record.entry.entry_id) ?? 0 },
        fulfillment: { methods: [...record.attributes.fulfillment.methods],
          delivery_fee_minor: record.attributes.fulfillment.delivery_fee_minor ?? null },
      })),
      has_more: hasMore, total: matches.length,
      next_cursor: hasMore ? encodeCursor({ type: 'products', merchant, catalog, query, entry: selected.at(-1)!.entry.entry_id }) : null,
    };
  }

  function parseStoredOrder(row: OrderRow): Order {
    const order = orderSchema.parse(JSON.parse(row.order_json));
    if (order.order_id !== row.order_id || order.merchant_id !== merchant || order.catalog_id !== catalog) {
      throw new Error('stored merchant order does not match its indexed scope');
    }
    const problem = orderInconsistency(order);
    if (problem !== null) throw new Error(`stored merchant order contains inconsistent amounts or terms: ${problem}`);
    return order;
  }

  function orders(options: MerchantDemoOrderQuery = {}): MerchantDemoPage<MerchantDemoOrderSummary> {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['limit', 'cursor'].includes(key))) invalid();
    const limit = pageLimit(options.limit);
    const cursor = decodeCursor(options.cursor, 'orders', merchant, catalog) as OrderCursor | undefined;
    const total = ctx.db.query<{ total: number }, [string, string]>(
      'SELECT COUNT(*) AS total FROM orders WHERE merchant_id = ? AND catalog_id = ?',
    ).get(merchant, catalog)!.total;
    const rows = cursor
      ? ctx.db.query<OrderRow, [string, string, number, string, number]>(
        `SELECT order_id, created_at_ms, order_json FROM orders WHERE merchant_id = ? AND catalog_id = ?
         AND (created_at_ms, order_id) < (?, ?)
         ORDER BY created_at_ms DESC, order_id DESC LIMIT ?`,
      ).all(merchant, catalog, cursor.created, cursor.order, limit + 1)
      : ctx.db.query<OrderRow, [string, string, number]>(
        `SELECT order_id, created_at_ms, order_json FROM orders WHERE merchant_id = ? AND catalog_id = ?
         ORDER BY created_at_ms DESC, order_id DESC LIMIT ?`,
      ).all(merchant, catalog, limit + 1);
    const selected = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = selected.at(-1);
    return { items: selected.map(row => projectMerchantOrderSummary(parseStoredOrder(row))), total, has_more: hasMore,
      next_cursor: hasMore ? encodeCursor({ type: 'orders', merchant, catalog, created: last!.created_at_ms, order: last!.order_id }) : null };
  }

  function order(id: string): MerchantOrderDetail {
    identifier(id);
    const row = ctx.db.query<OrderRow, [string, string, string]>(
      'SELECT order_id, created_at_ms, order_json FROM orders WHERE order_id = ? AND merchant_id = ? AND catalog_id = ?',
    ).get(id, merchant, catalog);
    if (row === null) throw new CommerceError('not_found', 'no order in this merchant demo');
    return projectMerchantOrderDetail(parseStoredOrder(row));
  }

  function overview(): MerchantDemoOverview {
    // The default SQLite transaction is a deferred read transaction. The first
    // SELECT establishes one snapshot for both panels without a write lock.
    return ctx.db.transaction(() => ({
      read_only: true as const, merchant_id: merchant, catalog_id: catalog,
      checked_at: new Date(ctx.clock.nowMs()).toISOString(),
      payment_mode: 'local_simulated' as const, fulfillment_mode: 'local_simulated' as const,
      products: products(), orders: orders(),
    }))();
  }
  return Object.freeze({ overview, products, orders, order });
}
