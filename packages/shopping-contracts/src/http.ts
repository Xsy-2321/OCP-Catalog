/**
 * Request and response shapes for the four demo commerce endpoints.
 *
 * The status code carries meaning here, so it is part of the contract rather
 * than an implementation detail:
 *
 *   POST /commerce/v1/quotes                    -> 200  Quote
 *   POST /commerce/v1/checkouts                 -> 200  confirmed   (order exists)
 *                                               -> 202  processing  (outcome unknown)
 *   GET  /commerce/v1/purchase-attempts/:id     -> 200  PurchaseAttempt
 *   GET  /commerce/v1/orders/:id                -> 200  Order
 *
 * `202 processing` is the important one. When checkout does not finish inside
 * the merchant's own timeout, the truthful answer is "not known yet" — so it is
 * a success response carrying an attempt id, NOT an error. An endpoint that
 * reported a timeout as a failure would push the caller toward retrying a
 * purchase that may already have gone through.
 *
 * Every genuine failure is a non-2xx status carrying the error envelope from
 * `errors.ts`. A rejection that the caller must act on by re-quoting
 * (`quote_expired`, `requote_required`, `budget_exceeded`, `out_of_stock`) is
 * never smuggled into a 200 body, because the caller branches on status first.
 */
import { z } from 'zod';
import { authorizationProofSchema } from './authorization';
import { purchaseAttemptSchema } from './attempt';
import { orderSchema } from './order';
import { quoteSchema } from './quote';
import { quoteFulfillmentSchema } from './terms';

/** Header carrying the caller's idempotency key. Stable across retries. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Header carrying the local development caller identity.
 *
 * This is a demo stand-in for an authenticated account, nothing more. It is
 * trivially forgeable and must never be described as an account system.
 */
export const DEV_CALLER_HEADER = 'x-dev-caller-id';

export const quoteRequestItemSchema = z.object({
  entry_id: z.string().min(1).max(256),
  quantity: z.number().int().positive().max(20),
}).strict();

/** Legacy single-item pickup requests and the additive whole-basket request. */
export const createQuoteRequestSchema = z.union([
  z.object({
    entry_id: z.string().min(1),
    quantity: z.number().int().positive().max(20),
    fulfillment: quoteFulfillmentSchema,
  }).strict(),
  z.object({
    items: z.array(quoteRequestItemSchema).min(1).max(10),
    fulfillment: quoteFulfillmentSchema,
  }).strict(),
]).superRefine((request, context) => {
  const items = 'items' in request ? request.items : [{ entry_id: request.entry_id, quantity: request.quantity }];
  if (new Set(items.map(item => item.entry_id)).size !== items.length) {
    context.addIssue({ code: 'custom', message: 'duplicate entries must be merged before quoting', path: ['items'] });
  }
  if (items.reduce((sum, item) => sum + item.quantity, 0) > 20) {
    context.addIssue({ code: 'custom', message: 'a basket may contain at most 20 cups', path: ['items'] });
  }
  if (request.fulfillment.method === 'delivery' && !request.fulfillment.delivery) {
    context.addIssue({ code: 'custom', message: 'delivery requires recipient, phone and address', path: ['fulfillment', 'delivery'] });
  }
});

export type CreateQuoteRequest = z.infer<typeof createQuoteRequestSchema>;
export function quoteRequestItems(request: CreateQuoteRequest) {
  return 'items' in request ? request.items : [{ entry_id: request.entry_id, quantity: request.quantity }];
}

/** `200` body for `POST /commerce/v1/quotes`. */
export const createQuoteResponseSchema = quoteSchema;

/**
 * Request body for `POST /commerce/v1/checkouts`.
 *
 * The `Idempotency-Key` travels in the header, not here, so a retry that
 * re-serializes the body still presents the same key.
 */
export const checkoutRequestSchema = z
  .object({
    purchase_attempt_id: z.string().min(1),
    quote_id: z.string().min(1),
    terms_hash: z.string().regex(/^[0-9a-f]{64}$/),
    authorization: authorizationProofSchema,
  })
  .strict();

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/** `200` body: the payment settled and an order exists. */
export const checkoutConfirmedResponseSchema = z
  .object({
    status: z.literal('confirmed'),
    purchase_attempt: purchaseAttemptSchema,
    order: orderSchema,
  })
  .strict();

/** `202` body: the outcome is not yet known. Poll the attempt. */
export const checkoutProcessingResponseSchema = z
  .object({
    status: z.literal('processing'),
    purchase_attempt: purchaseAttemptSchema,
  })
  .strict();

export const checkoutResponseSchema = z.discriminatedUnion('status', [
  checkoutConfirmedResponseSchema,
  checkoutProcessingResponseSchema,
]);

export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

/** `200` body for `GET /commerce/v1/purchase-attempts/:id`. */
export const purchaseAttemptResponseSchema = purchaseAttemptSchema;

/** `200` body for `GET /commerce/v1/orders/:id`. */
export const orderResponseSchema = orderSchema;
