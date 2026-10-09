/**
 * The mock payment.
 *
 * ============================ LOCAL SIMULATION ONLY ========================
 * This module does not call a payment provider, does not open a socket, and
 * must never be pointed at a real one. It decides an outcome and writes a row.
 * A real integration belongs behind the same interface — `takePayment` returns
 * an outcome and records it — but it is not what is here.
 * ==========================================================================
 *
 * The important property is that the decision is made ONCE per logical purchase.
 * `payment_key` is unique, so a retry of the same attempt reads the original row
 * instead of deciding again. A declined payment therefore stays declined,
 * instead of becoming a coin flip that a retry might win.
 *
 * The `reference` is a credential-shaped value — the thing a real provider would
 * let you use to look up or reverse the charge. It stays in this table. It is
 * not returned by any endpoint and not written into any event, because a query
 * endpoint that hands out payment handles is a query endpoint that leaks them.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';

export type PaymentStatus = 'succeeded' | 'failed';

export interface PaymentOutcome {
  readonly paymentId: string;
  readonly status: PaymentStatus;
  readonly failureReason: string | null;
}

export interface TakePaymentParams {
  readonly merchantId: string;
  readonly purchaseAttemptId: string;
  readonly callerId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly nowMs: number;
  /** Forces a decline. Reached only through the `payment_declined` fault. */
  readonly decline: boolean;
}

/** Server-side record, including the reference that never leaves the server. */
export interface PaymentRecord {
  readonly paymentId: string;
  readonly purchaseAttemptId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly reference: string;
  readonly failureReason: string | null;
}

interface PaymentRow {
  payment_id: string;
  purchase_attempt_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  reference: string;
  failure_reason: string | null;
}

function toRecord(row: PaymentRow): PaymentRecord {
  return {
    paymentId: row.payment_id,
    purchaseAttemptId: row.purchase_attempt_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status === 'succeeded' ? 'succeeded' : 'failed',
    reference: row.reference,
    failureReason: row.failure_reason,
  };
}

function paymentKey(merchantId: string, purchaseAttemptId: string): string {
  return `${merchantId}:${purchaseAttemptId}`;
}

/**
 * Decides and records the payment for one attempt.
 *
 * Safe to call more than once for the same attempt: the second call returns the
 * first call's outcome.
 */
export function takePayment(db: Database, params: TakePaymentParams): PaymentOutcome {
  const key = paymentKey(params.merchantId, params.purchaseAttemptId);
  const existing = findByKey(db, key);
  if (existing !== null) {
    return { paymentId: existing.paymentId, status: existing.status, failureReason: existing.failureReason };
  }

  const status: PaymentStatus = params.decline ? 'failed' : 'succeeded';
  const paymentId = `pay_${randomUUID()}`;
  const reference = `mockref_${randomUUID()}`;
  const failureReason = params.decline ? '本地模拟支付被拒绝。' : null;

  db.query(
    `INSERT INTO payments
       (payment_id, payment_key, purchase_attempt_id, caller_id, amount_minor, currency, status, reference, failure_reason, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    paymentId,
    key,
    params.purchaseAttemptId,
    params.callerId,
    params.amountMinor,
    params.currency,
    status,
    reference,
    failureReason,
    params.nowMs,
  );

  return { paymentId, status, failureReason };
}

function findByKey(db: Database, key: string): PaymentRecord | null {
  const row = db
    .query<PaymentRow, [string]>(
      `SELECT payment_id, purchase_attempt_id, amount_minor, currency, status, reference, failure_reason
         FROM payments WHERE payment_key = ?`,
    )
    .get(key);
  return row === null ? null : toRecord(row);
}

/**
 * Reads the payment recorded for an attempt, reference included.
 *
 * Server-side only. Callers must not place the result on the wire — the
 * reference is exactly the value the redaction rule exists to keep in.
 */
export function readPaymentRecord(db: Database, merchantId: string, purchaseAttemptId: string): PaymentRecord | null {
  return findByKey(db, paymentKey(merchantId, purchaseAttemptId));
}

export function countPayments(db: Database): number {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM payments').get();
  return row?.n ?? 0;
}
