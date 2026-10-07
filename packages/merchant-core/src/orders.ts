/**
 * Reading and writing attempts and orders.
 *
 * Two state machines, kept apart on purpose (contract §5 D5):
 *
 *   attempt:  processing -> confirmed | failed          (and never back)
 *   order:    payment_status  ⊥  fulfillment_status
 *
 * The separation is not tidiness. A single order status invites one specific
 * mistake — reporting "completed" the moment the card clears, so the customer
 * walks to the counter for a coffee nobody has started making. Money and coffee
 * are separate facts and they are stored as separate columns.
 *
 * `paid` is only ever written from a verified payment result. It is never
 * inferred from the fact that a checkout request arrived: the request is a
 * claim, the payment row is the evidence.
 *
 * Rows store the domain object as JSON and the fields the database needs to
 * index alongside it. Reads re-parse through the schema rather than casting, so
 * a row written by an older version surfaces as a parse error instead of as a
 * half-shaped object that fails somewhere far away.
 */
import type { Database } from 'bun:sqlite';
import {
  CommerceError,
  commerceErrorSchema,
  newOrderId,
  orderSchema,
  purchaseAttemptSchema,
  type CommerceErrorPayload,
  type FulfillmentStatus,
  type Order,
  type PaymentStatus as OrderPaymentStatus,
  type PurchaseAttempt,
  type Quote,
} from '@ocp-catalog/shopping-contracts';
import type { PaymentStatus } from './payment';
import { toIso } from './clock';

/* ------------------------------------------------------------------ attempts */

export interface AttemptRow {
  readonly purchase_attempt_id: string;
  readonly caller_id: string;
  readonly merchant_id: string;
  readonly quote_id: string;
  readonly catalog_id: string;
  readonly status: string;
  readonly order_id: string | null;
  readonly error_json: string | null;
  readonly pending_settlement: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

const ATTEMPT_COLUMNS =
  'purchase_attempt_id, caller_id, merchant_id, quote_id, catalog_id, status, order_id, error_json, pending_settlement, created_at_ms, updated_at_ms';

export function getAttempt(db: Database, attemptId: string): AttemptRow | null {
  return db
    .query<AttemptRow, [string]>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE purchase_attempt_id = ?`)
    .get(attemptId);
}

export function toPurchaseAttempt(row: AttemptRow): PurchaseAttempt {
  const error: CommerceErrorPayload | undefined =
    row.error_json === null ? undefined : commerceErrorSchema.parse(JSON.parse(row.error_json));

  return purchaseAttemptSchema.parse({
    purchase_attempt_id: row.purchase_attempt_id,
    merchant_id: row.merchant_id,
    quote_id: row.quote_id,
    catalog_id: row.catalog_id,
    status: row.status,
    ...(row.order_id === null ? {} : { order_id: row.order_id }),
    ...(error === undefined ? {} : { error }),
    // Rows store milliseconds because that is what SQLite sorts and compares
    // cheaply; the contract speaks ISO-8601. Rendering here keeps the two
    // representations from drifting apart at each call site.
    created_at: toIso(row.created_at_ms),
    updated_at: toIso(row.updated_at_ms),
  });
}

/**
 * Creates the attempt A asked for, using the id A supplied.
 *
 * The id is A's, not the merchant's: A mints it once and reuses it across every
 * retry of the same logical purchase, which is what lets a lost response be
 * recovered by asking about *this* attempt rather than by guessing.
 */
export function insertProcessingAttempt(
  db: Database,
  params: {
    readonly attemptId: string;
    readonly callerId: string;
    readonly merchantId: string;
    readonly quoteId: string;
    readonly catalogId: string;
    readonly pendingSettlement: boolean;
    readonly nowMs: number;
  },
): void {
  db.query(
    `INSERT INTO attempts (${ATTEMPT_COLUMNS})
     VALUES (?, ?, ?, ?, ?, 'processing', NULL, NULL, ?, ?, ?)`,
  ).run(
    params.attemptId,
    params.callerId,
    params.merchantId,
    params.quoteId,
    params.catalogId,
    params.pendingSettlement ? 1 : 0,
    params.nowMs,
    params.nowMs,
  );
}

/**
 * Marks an attempt as one the merchant still owes an answer for.
 *
 * Used when checkout ran past its own deadline after the payment already
 * succeeded: the honest reply is "unknown, ask me again", and the outstanding
 * flag is what makes the next poll finish the job instead of reporting a
 * `processing` attempt forever.
 */
export function setPendingSettlement(db: Database, attemptId: string, nowMs: number): void {
  db.query('UPDATE attempts SET pending_settlement = 1, updated_at_ms = ? WHERE purchase_attempt_id = ?').run(
    nowMs,
    attemptId,
  );
}

export function markAttemptConfirmed(
  db: Database,
  params: { readonly attemptId: string; readonly orderId: string; readonly nowMs: number },
): void {
  db.query(
    `UPDATE attempts
        SET status = 'confirmed', order_id = ?, pending_settlement = 0, updated_at_ms = ?
      WHERE purchase_attempt_id = ?`,
  ).run(params.orderId, params.nowMs, params.attemptId);
}

export function markAttemptFailed(
  db: Database,
  params: { readonly attemptId: string; readonly error: CommerceErrorPayload; readonly nowMs: number },
): void {
  db.query(
    `UPDATE attempts
        SET status = 'failed', error_json = ?, pending_settlement = 0, updated_at_ms = ?
      WHERE purchase_attempt_id = ?`,
  ).run(JSON.stringify(params.error), params.nowMs, params.attemptId);
}

/**
 * A `processing` attempt is one the merchant has not answered for yet.
 *
 * Two different situations produce `processing`, and conflating them would
 * hang forever: an attempt whose settlement is genuinely outstanding (this
 * flag), and one that is merely mid-flight inside a request. Only the first is
 * ever observable — the second cannot be, because the transaction that creates
 * it also finishes it.
 */
export function isAwaitingSettlement(row: AttemptRow): boolean {
  return row.status === 'processing' && row.pending_settlement === 1;
}

/**
 * A `processing` row that is not awaiting settlement cannot exist.
 *
 * Reaching this means the attempt was created outside the checkout transaction
 * or the flag was cleared early, and the honest consequence is that the caller
 * would poll forever. Crash rather than pretend.
 */
export function assertProcessingIsResolvable(row: AttemptRow): void {
  if (row.status === 'processing' && row.pending_settlement !== 1) {
    throw new Error(
      `internal: attempt ${row.purchase_attempt_id} is processing but awaits no settlement; nothing would ever resolve it`,
    );
  }
}

/* -------------------------------------------------------------------- orders */

/** Maps the payment module's outcome onto the order's payment status. */
function toOrderPaymentStatus(status: PaymentStatus): OrderPaymentStatus {
  return status === 'succeeded' ? 'paid' : 'failed';
}

export interface BuildOrderParams {
  readonly quote: Quote;
  readonly purchaseAttemptId: string;
  readonly paymentStatus: PaymentStatus;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly nowMs: number;
}

/**
 * Freezes the purchase into an order.
 *
 * The quote's items and fees are copied, not referenced. If the catalog changes
 * tomorrow the order must still say what was bought and for how much — an order
 * that re-reads today's prices is not a record of anything.
 */
export function buildOrder(params: BuildOrderParams): Order {
  const { quote } = params;
  const now = new Date(params.nowMs).toISOString();
  const paymentStatus = toOrderPaymentStatus(params.paymentStatus);

  return orderSchema.parse({
    order_id: newOrderId(),
    merchant_id: quote.merchant_id,
    catalog_id: quote.catalog_id,
    purchase_attempt_id: params.purchaseAttemptId,
    quote_id: quote.quote_id,
    currency: quote.currency,
    items: quote.items,
    fees: quote.fees,
    subtotal_minor: quote.subtotal_minor,
    total_minor: quote.total_minor,
    terms_hash: quote.terms_hash,
    fulfillment: quote.fulfillment,
    payment: { status: paymentStatus, updated_at: now },
    fulfillment_status: { status: params.fulfillmentStatus, updated_at: now },
    created_at: now,
    updated_at: now,
  });
}

export function insertOrder(db: Database, order: Order, callerId: string): void {
  db.query(
    `INSERT INTO orders
       (order_id, caller_id, merchant_id, catalog_id, purchase_attempt_id, quote_id, total_minor, order_json, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    order.order_id,
    callerId,
    order.merchant_id,
    order.catalog_id,
    order.purchase_attempt_id,
    order.quote_id,
    order.total_minor,
    JSON.stringify(order),
    Date.parse(order.created_at),
    Date.parse(order.updated_at),
  );
}

interface OrderRow {
  order_id: string;
  caller_id: string;
  order_json: string;
}

export function getOrderRow(db: Database, orderId: string): OrderRow | null {
  return db
    .query<OrderRow, [string]>('SELECT order_id, caller_id, order_json FROM orders WHERE order_id = ?')
    .get(orderId);
}

export function parseOrderRow(row: OrderRow): Order {
  return orderSchema.parse(JSON.parse(row.order_json));
}

/** Rewrites a status after a verified change. The order's own fields are authoritative. */
export function saveOrderStatuses(db: Database, order: Order): void {
  db.query('UPDATE orders SET order_json = ?, updated_at_ms = ? WHERE order_id = ?').run(
    JSON.stringify(order),
    Date.parse(order.updated_at),
    order.order_id,
  );
}

export function countOrders(db: Database): number {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM orders').get();
  return row?.n ?? 0;
}

/**
 * Loads an owned attempt, or throws `not_found`.
 *
 * Ownership failure and non-existence produce the same answer on purpose: a 403
 * for someone else's resource confirms that the resource exists, which turns the
 * id space into an oracle. `forbidden` is reserved for cases where existence is
 * already legitimately known.
 */
export function requireOwnedAttempt(db: Database, attemptId: string, callerId: string): AttemptRow {
  const row = getAttempt(db, attemptId);
  if (row === null || row.caller_id !== callerId) {
    throw new CommerceError('not_found', `no purchase attempt ${attemptId} for this caller`);
  }
  return row;
}

export function requireOwnedOrder(db: Database, orderId: string, callerId: string): Order {
  const row = getOrderRow(db, orderId);
  if (row === null || row.caller_id !== callerId) {
    throw new CommerceError('not_found', `no order ${orderId} for this caller`);
  }
  return parseOrderRow(row);
}
