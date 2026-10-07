/**
 * Checkout: the one operation that spends money.
 *
 * Everything below happens inside a single `BEGIN IMMEDIATE` transaction — the
 * idempotency claim, every validation, the payment, the order, the events and
 * the settlement of the claim. That is not a performance choice. It is what
 * makes the guarantees true rather than likely:
 *
 *   - Two requests racing on one `Idempotency-Key` cannot both create an order,
 *     because the second cannot even begin until the first has committed, and
 *     will then read a settled record instead of an empty table.
 *   - A rejection that happens before any money moves leaves no trace at all, so
 *     a corrected retry with the same key is judged afresh rather than pinned to
 *     an error that no longer applies.
 *   - A rejection that *did* move money (a declined payment) is committed and
 *     cached, because the decision cost something and re-deciding it on a retry
 *     is precisely what idempotency exists to forbid.
 *
 * That asymmetry is the design. `throw` = nothing was recorded; returning a
 * `declined` result = a payment row exists and the answer is now history.
 *
 * The other thing worth reading twice is the timeout. When the merchant cannot
 * finish inside its own deadline, the answer is `202 processing` — a success
 * response carrying an attempt id, NOT an error. Reporting "unknown" as a
 * failure pushes the caller to retry a purchase that may already have gone
 * through, which is how one coffee gets bought twice.
 */
import type { Database } from 'bun:sqlite';
import {
  CommerceError,
  checkoutConfirmedResponseSchema,
  checkoutProcessingResponseSchema,
  commerceErrorSchema,
  isQuoteExpired,
  type CheckoutRequest,
  type CheckoutResponse,
  type CommerceErrorResponse,
  type Order,
  type PurchaseAttempt,
  type Quote,
} from '@ocp-catalog/shopping-contracts';
import { findEntry, isPurchasable } from './catalog';
import { beginIdempotentRequest, computeCheckoutDigest, settleIdempotentRequest } from './idempotency';
import type { MerchantContext } from './context';
import { inTransaction } from './db';
import { recordEvent } from './events';
import { faultEnabled } from './faults';
import {
  assertProcessingIsResolvable,
  buildOrder,
  getAttempt,
  insertOrder,
  insertProcessingAttempt,
  isAwaitingSettlement,
  markAttemptConfirmed,
  markAttemptFailed,
  requireOwnedAttempt,
  setPendingSettlement,
  toPurchaseAttempt,
} from './orders';
import { takePayment, type PaymentOutcome } from './payment';
import { getStoredQuote } from './quote';
import { verifyAuthorization } from './authorization';

/**
 * How much the injected "price moved" fault moves the price by.
 *
 * Any non-zero amount would do; a round ¥5 makes the resulting quote obviously
 * different from the original in a test failure message.
 */
const FAULT_PRICE_RAISE_MINOR = 500;

export interface CheckoutOptions {
  readonly callerId: string;
  /** From the `Idempotency-Key` header. Stable across retries of one purchase. */
  readonly idempotencyKey: string;
}

export type CheckoutResult =
  /** Payment settled; an order exists. */
  | { readonly kind: 'confirmed'; readonly body: Extract<CheckoutResponse, { status: 'confirmed' }> }
  /** Not known yet; poll the attempt. */
  | { readonly kind: 'processing'; readonly body: Extract<CheckoutResponse, { status: 'processing' }> }
  /** A payment was attempted, declined, and recorded. Re-deciding is not allowed. */
  | { readonly kind: 'declined'; readonly error: CommerceError };

/**
 * Thrown after a successful settlement when the `response_dropped_after_settlement`
 * fault is active.
 *
 * It is not a `CommerceError` on purpose: a `CommerceError` renders as a
 * structured envelope, and a structured envelope is exactly what the caller must
 * NOT receive here. The whole scenario is that the money moved and the answer
 * never arrived, so the caller has to go and ask. Delivering a tidy error body
 * would tell it the purchase failed, which is the opposite of the truth.
 */
export class SimulatedResponseLoss extends Error {
  readonly purchaseAttemptId: string;
  readonly orderId: string;

  constructor(purchaseAttemptId: string, orderId: string) {
    super(
      `simulated response loss after settlement: attempt ${purchaseAttemptId} settled as order ${orderId}`,
    );
    this.name = 'SimulatedResponseLoss';
    this.purchaseAttemptId = purchaseAttemptId;
    this.orderId = orderId;
  }
}

/* ------------------------------------------------------------------ caching */

interface CacheParams {
  readonly db: Database;
  readonly options: CheckoutOptions;
  readonly merchantId: string;
  readonly digest: string;
  readonly attemptId: string;
  readonly nowMs: number;
}

function cacheResponse(params: CacheParams, status: number, body: unknown): void {
  settleIdempotentRequest(params.db, {
    callerId: params.options.callerId,
    merchantId: params.merchantId,
    idemKey: params.options.idempotencyKey,
    requestDigest: params.digest,
    purchaseAttemptId: params.attemptId,
    nowMs: params.nowMs,
    responseStatus: status,
    responseJson: JSON.stringify(body),
  });
}

/** Rebuilds a result from a cached idempotent answer. */
function resultFromCached(status: number, responseJson: string): CheckoutResult {
  const body: unknown = JSON.parse(responseJson);
  if (status === 202) return { kind: 'processing', body: checkoutProcessingResponseSchema.parse(body) };
  if (status === 200) return { kind: 'confirmed', body: checkoutConfirmedResponseSchema.parse(body) };

  // A cached error. Rebuilt through `CommerceError` so the caller sees the same
  // code and status it saw the first time — including the status, which is
  // derived from the code rather than stored beside it.
  const envelope: CommerceErrorResponse = {
    error: commerceErrorSchema.parse((body as CommerceErrorResponse).error),
  };
  return {
    kind: 'declined',
    error: new CommerceError(envelope.error.code, envelope.error.message, envelope.error.details),
  };
}

/* ------------------------------------------------------------------- events */

interface SettlementParams {
  readonly ctx: MerchantContext;
  readonly attemptId: string;
  readonly callerId: string;
  readonly quote: Quote;
  readonly payment: PaymentOutcome;
  readonly nowMs: number;
}

/**
 * Records the settlement and returns the order it created.
 *
 * Extracted because the poll path runs exactly the same sequence as the inline
 * path, and two copies of "what a settled payment writes" is how one of them
 * quietly stops writing the payment event.
 */
function recordSettlement(params: SettlementParams): Order {
  const { ctx, attemptId, callerId, quote, payment, nowMs } = params;
  const { db } = ctx;

  const order = buildOrder({
    quote,
    purchaseAttemptId: attemptId,
    paymentStatus: payment.status,
    fulfillmentStatus: 'pending',
    nowMs,
  });
  insertOrder(db, order, callerId);

  // Payment events hang off the attempt, because that is the only subject type
  // the contract defines. A `payment` subject would be inventing protocol.
  recordEvent(db, {
    subjectType: 'attempt',
    subjectId: attemptId,
    type: 'payment.succeeded',
    nowMs,
    data: { payment_id: payment.paymentId, amount_minor: order.total_minor, currency: order.currency },
  });
  recordEvent(db, {
    subjectType: 'order',
    subjectId: order.order_id,
    type: 'order.created',
    nowMs,
    data: {
      purchase_attempt_id: order.purchase_attempt_id,
      quote_id: order.quote_id,
      total_minor: order.total_minor,
    },
  });
  markAttemptConfirmed(db, { attemptId, orderId: order.order_id, nowMs });
  recordEvent(db, {
    subjectType: 'attempt',
    subjectId: attemptId,
    type: 'attempt.confirmed',
    nowMs,
    data: { order_id: order.order_id },
  });

  return order;
}

function recordDecline(params: SettlementParams): CommerceError {
  const { ctx, attemptId, quote, payment, nowMs } = params;
  const { db } = ctx;

  const error = new CommerceError('payment_failed', payment.failureReason ?? 'the payment did not succeed', {
    payment_id: payment.paymentId,
  });
  markAttemptFailed(db, { attemptId, error: error.toResponse().error, nowMs });
  recordEvent(db, {
    subjectType: 'attempt',
    subjectId: attemptId,
    type: 'payment.failed',
    nowMs,
    data: { payment_id: payment.paymentId, amount_minor: quote.total_minor, currency: quote.currency },
  });
  recordEvent(db, {
    subjectType: 'attempt',
    subjectId: attemptId,
    type: 'attempt.failed',
    nowMs,
    data: { code: error.code },
  });

  return error;
}

/* ----------------------------------------------------------------- checkout */

export function runCheckout(
  ctx: MerchantContext,
  request: CheckoutRequest,
  options: CheckoutOptions,
): CheckoutResult {
  const { config, db, clock } = ctx;
  const startedAtMs = clock.nowMs();
  const digest = computeCheckoutDigest({
    purchaseAttemptId: request.purchase_attempt_id,
    quoteId: request.quote_id,
    termsHash: request.terms_hash,
  });

  const result = inTransaction(db, () => checkoutInTransaction(ctx, request, options, digest, startedAtMs));

  // The drop is simulated outside the transaction, after the commit. Doing it
  // inside would roll the order back, and a rollback is a *refund* — the exact
  // opposite of "the customer was charged and never heard back".
  if (result.kind === 'confirmed' && faultEnabled(config.faults, 'response_dropped_after_settlement')) {
    throw new SimulatedResponseLoss(
      result.body.purchase_attempt.purchase_attempt_id,
      result.body.order.order_id,
    );
  }
  return result;
}

function checkoutInTransaction(
  ctx: MerchantContext,
  request: CheckoutRequest,
  options: CheckoutOptions,
  digest: string,
  startedAtMs: number,
): CheckoutResult {
  const { config, db, clock } = ctx;
  const { callerId, idempotencyKey } = options;
  const nowMs = startedAtMs;
  const cache = (status: number, body: unknown): void =>
    cacheResponse({ db, options, merchantId: config.merchantId, digest, attemptId: request.purchase_attempt_id, nowMs }, status, body);

  // 1. Claim the key, or find out what it already means.
  const lookup = beginIdempotentRequest(db, {
    callerId,
    merchantId: config.merchantId,
    idemKey: idempotencyKey,
    requestDigest: digest,
    purchaseAttemptId: request.purchase_attempt_id,
    nowMs,
  });
  if (lookup.kind === 'conflict') {
    throw new CommerceError(
      'idempotency_conflict',
      `Idempotency-Key ${JSON.stringify(idempotencyKey)} was already used for a different purchase`,
    );
  }
  if (lookup.kind === 'replay') return resultFromCached(lookup.responseStatus, lookup.responseJson);

  // 2. The quote must exist and belong to this caller. A quote owned by someone
  //    else is reported as missing: distinguishing the two would turn the quote
  //    id space into an oracle for what other callers have been quoted.
  const stored = getStoredQuote(db, request.quote_id);
  if (stored === null || stored.callerId !== callerId) {
    throw new CommerceError('not_found', `no quote ${request.quote_id} for this caller`);
  }
  const quote = stored.quote;

  // 3. A closed window is a re-quote, not a retry. Checked against the merchant's
  //    own stored expiry, never against a client-supplied timestamp.
  if (isQuoteExpired(quote, nowMs)) {
    throw new CommerceError('quote_expired', `quote ${quote.quote_id} expired at ${quote.expires_at}`);
  }

  // 4. The echoed hash is a claim about which terms the caller thinks it is
  //    buying. It is compared against the merchant's stored hash, never taken as
  //    the value to compare against.
  if (request.terms_hash !== quote.terms_hash) {
    throw new CommerceError(
      'requote_required',
      'the submitted terms_hash does not match the stored quote; request a new quote',
      { reason: 'terms_changed' },
    );
  }

  // 5. The authorization is the permission gate, so it runs before any business
  //    rejection. A caller with no valid proof must not learn whether the item
  //    is in stock, what it costs today, or how much budget it has left.
  const verdict = verifyAuthorization(
    request.authorization,
    {
      merchantId: config.merchantId,
      termsHash: quote.terms_hash,
      quoteId: quote.quote_id,
      currency: quote.currency,
      purchaseAttemptId: request.purchase_attempt_id,
      nowSeconds: Math.floor(nowMs / 1000),
    },
    config.trustedKeys,
  );
  if (!verdict.ok) throw verdict.error;

  // 6. The catalog entry behind the quote. It can vanish only if the catalog was
  //    replaced under a live quote, which is a re-quote rather than a crash.
  const line = quote.items[0];
  const record = findEntry(ctx.catalog, line.entry_id);
  if (record === null) {
    throw new CommerceError('requote_required', `entry ${line.entry_id} is no longer in the catalog`, {
      reason: 'entry_gone',
    });
  }

  // 7. Re-price from today's catalog. This is a real check that catches a price
  //    change between quote and till; the `price_raised_after_quote` fault just
  //    makes such a change happen on demand so the branch is reachable.
  const currentUnitMinor =
    record.attributes.price_minor +
    (faultEnabled(config.faults, 'price_raised_after_quote') ? FAULT_PRICE_RAISE_MINOR : 0);
  if (currentUnitMinor !== line.unit_minor) {
    throw new CommerceError(
      'requote_required',
      `entry ${line.entry_id} is now ${currentUnitMinor} minor per unit, quoted at ${line.unit_minor}`,
      { reason: 'price_changed', quoted_unit_minor: line.unit_minor, current_unit_minor: currentUnitMinor },
    );
  }

  // 8. Budget, against the ceiling the user actually signed. The merchant may not
  //    widen it to make a demo succeed — a ceiling that moves when it is
  //    inconvenient is not a ceiling.
  if (quote.total_minor > verdict.payload.max_total_minor) {
    throw new CommerceError(
      'budget_exceeded',
      `total ${quote.total_minor} exceeds the authorized maximum ${verdict.payload.max_total_minor}`,
      { total_minor: quote.total_minor, max_total_minor: verdict.payload.max_total_minor },
    );
  }

  // 9. Stock, re-read at the till. The catalog is static in this demo, so the
  //    only way to reach a rejection here is the injected fault — which is the
  //    point of having it: the last unit selling between quote and checkout is
  //    the concurrency case the demo is meant to show.
  const available = record.attributes.inventory.quantity;
  const requestedQuantity = line.quantity;
  const soldOut =
    faultEnabled(config.faults, 'stock_exhausted_after_quote') ||
    !isPurchasable(record) ||
    (available !== undefined && available < requestedQuantity);
  if (soldOut) {
    throw new CommerceError(
      'out_of_stock',
      `entry ${line.entry_id} has ${available ?? 'no'} units left, ${requestedQuantity} requested`,
      { entry_id: line.entry_id, available: available ?? 0, requested: requestedQuantity },
    );
  }

  // 10. An attempt id may belong to exactly one logical purchase. Reusing it for
  //     a second one means the caller is confused about which purchase it is
  //     making, and guessing on its behalf would be worse than refusing.
  if (getAttempt(db, request.purchase_attempt_id) !== null) {
    throw new CommerceError(
      'invalid_request',
      `purchase_attempt_id ${request.purchase_attempt_id} was already used for a different checkout`,
    );
  }

  // 11. The injected payment timeout. Nothing is charged: the payment genuinely
  //     has not been attempted yet, and the poll is what attempts it. Modelling
  //     it the other way — charge now, report unknown — would make the timeout
  //     a lie about the merchant's own state.
  const timeoutFault = faultEnabled(config.faults, 'payment_timeout_then_succeed');
  insertProcessingAttempt(db, {
    attemptId: request.purchase_attempt_id,
    callerId,
    merchantId: config.merchantId,
    quoteId: quote.quote_id,
    catalogId: config.catalogId,
    pendingSettlement: timeoutFault,
    nowMs,
  });
  recordEvent(db, {
    subjectType: 'attempt',
    subjectId: request.purchase_attempt_id,
    type: 'attempt.created',
    nowMs,
    data: {
      quote_id: quote.quote_id,
      total_minor: quote.total_minor,
      currency: quote.currency,
      awaiting_settlement: timeoutFault,
    },
  });

  if (timeoutFault) {
    const body = processingBody(db, request.purchase_attempt_id);
    cache(202, body);
    return { kind: 'processing', body };
  }

  // 12. The money. Idempotent on `merchant:purchase_attempt`, so this cannot
  //     create a second charge for the same attempt however often it is reached.
  const payment = takePayment(db, {
    merchantId: config.merchantId,
    purchaseAttemptId: request.purchase_attempt_id,
    callerId,
    amountMinor: quote.total_minor,
    currency: quote.currency,
    nowMs,
    decline: faultEnabled(config.faults, 'payment_declined'),
  });

  // 13. A decline is recorded and cached, not thrown. Throwing would roll the
  //     payment row back, and the next retry would re-decide a charge that has
  //     already been decided.
  if (payment.status === 'failed') {
    const error = recordDecline({ ctx, attemptId: request.purchase_attempt_id, callerId, quote, payment, nowMs });
    cache(error.status, error.toResponse());
    return { kind: 'declined', error };
  }

  // 14. The deadline. If settling took longer than the merchant promised, the
  //     truthful answer is "unknown" even though the payment succeeded — the
  //     caller cannot be told an outcome it did not wait for. The attempt is
  //     flagged, and the next poll finishes the job; because `takePayment` is
  //     idempotent, settling finds the existing charge rather than making a
  //     second one.
  if (clock.nowMs() - startedAtMs > config.checkoutDeadlineMs) {
    setPendingSettlement(db, request.purchase_attempt_id, nowMs);
    const body = processingBody(db, request.purchase_attempt_id);
    cache(202, body);
    return { kind: 'processing', body };
  }

  // 15. Settled. The order is built from the quote's own numbers, and the attempt
  //     is confirmed only now that a verified payment result exists — never
  //     because a checkout request arrived.
  const order = recordSettlement({
    ctx,
    attemptId: request.purchase_attempt_id,
    callerId,
    quote,
    payment,
    nowMs,
  });
  const body = checkoutConfirmedResponseSchema.parse({
    status: 'confirmed',
    purchase_attempt: toPurchaseAttempt(getAttempt(db, request.purchase_attempt_id)!),
    order,
  });
  cache(200, body);
  return { kind: 'confirmed', body };
}

function processingBody(db: Database, attemptId: string): Extract<CheckoutResponse, { status: 'processing' }> {
  return checkoutProcessingResponseSchema.parse({
    status: 'processing',
    purchase_attempt: toPurchaseAttempt(getAttempt(db, attemptId)!),
  });
}

/**
 * Finishes a checkout the merchant reported as unknown.
 *
 * Deliberately does NOT re-check the quote window. The quote was valid when the
 * checkout was accepted and the terms were agreed then; failing the settlement
 * because the window closed while it was pending would convert "we will tell you
 * later" into a permanent failure fifteen minutes later.
 */
export function settlePendingAttempt(
  ctx: MerchantContext,
  attemptId: string,
  callerId: string,
): PurchaseAttempt {
  const { config, db, clock } = ctx;
  const nowMs = clock.nowMs();

  return inTransaction(db, () => {
    const row = requireOwnedAttempt(db, attemptId, callerId);
    if (!isAwaitingSettlement(row)) {
      assertProcessingIsResolvable(row);
      return toPurchaseAttempt(row);
    }

    const stored = getStoredQuote(db, row.quote_id);
    if (stored === null) {
      throw new Error(
        `internal: attempt ${attemptId} awaits settlement but its quote ${row.quote_id} is gone`,
      );
    }

    const payment = takePayment(db, {
      merchantId: config.merchantId,
      purchaseAttemptId: attemptId,
      callerId,
      amountMinor: stored.quote.total_minor,
      currency: stored.quote.currency,
      nowMs,
      decline: faultEnabled(config.faults, 'payment_declined'),
    });

    const params = { ctx, attemptId, callerId, quote: stored.quote, payment, nowMs };
    if (payment.status === 'failed') recordDecline(params);
    else recordSettlement(params);

    return toPurchaseAttempt(getAttempt(db, attemptId)!);
  });
}
