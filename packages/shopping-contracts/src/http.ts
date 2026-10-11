/**
 * Request and response shapes for the seven demo commerce endpoints.
 *
 * The status code carries meaning here, so it is part of the contract rather
 * than an implementation detail:
 *
 *   POST /commerce/v1/quotes                    -> 200  Quote
 *   POST /commerce/v1/checkouts                 -> 200  confirmed   (order exists)
 *                                               -> 202  processing  (outcome unknown)
 *   GET  /commerce/v1/purchase-attempts/:id     -> 200  PurchaseAttempt
 *   GET  /commerce/v1/purchase-attempts/:id/events -> 200  AttemptEvents
 *   GET  /commerce/v1/orders/:id                -> 200  Order
 *   GET  /commerce/v1/orders/:id/events         -> 200  OrderEvents
 *   POST /commerce/v1/orders/:id/fulfillment    -> 200  Order  (test mode only)
 *
 * The last one is not part of the buyer's surface: it is how the merchant
 * operator advances fulfilment, and it exists only under `MERCHANT_TEST_MODE`.
 * See its schema below for why it is gated rather than authenticated.
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
import { orderSchema, purchaseEventSchema } from './order';
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

/**
 * `200` body for `GET /commerce/v1/orders/:id/events`.
 *
 * The history spans three subjects, because one purchase does. The
 * `attempt.*` and `payment.*` records sit under the purchase attempt, and the
 * `quote.created` record under the quote that was priced — neither of which is
 * the order, and neither of which the order row can reach on its own. The order
 * does not exist until that attempt settles, so its story begins before its own
 * subject id does. Returning only the `order` subject would answer "what
 * happened to my order?" with a single `order.created` line and hide both the
 * price the buyer agreed to and the payment that produced the order.
 *
 * The events are the stored records, verbatim: redaction is enforced once, at
 * write time (`assertRedacted`), and a second, different filter here would be
 * exactly the "remember not to pass that field" decay that gate exists to
 * prevent. See `docs/coffee-merchant/CONTRACT.md` §11 D10 for why that is the
 * only enforcement point.
 */
export const orderEventsResponseSchema = z
  .object({
    order_id: z.string().min(1),
    events: z.array(purchaseEventSchema),
  })
  .strict();

export type OrderEventsResponse = z.infer<typeof orderEventsResponseSchema>;

/**
 * `200` body for `GET /commerce/v1/purchase-attempts/:id/events`.
 *
 * This is the read surface for the *failure* path, and it exists because the
 * order route cannot cover it. That route begins at an order, so an attempt that
 * was declined, ran past its deadline, or is still `processing` has no order to
 * hang its records off — and those are exactly the attempts an agent that lost a
 * response most needs to read back. Without this route an attempt's events are
 * write-only.
 *
 * It spans the attempt and its quote for the same reason the order route spans
 * three subjects: the story starts before the attempt exists.
 */
export const attemptEventsResponseSchema = z
  .object({
    purchase_attempt_id: z.string().min(1),
    events: z.array(purchaseEventSchema),
  })
  .strict();

export type AttemptEventsResponse = z.infer<typeof attemptEventsResponseSchema>;

/**
 * Request body for `POST /commerce/v1/orders/:id/fulfillment`.
 *
 * Only the three states an order can be *moved to* are accepted; `pending` is
 * where every order starts and is deliberately absent. An operator endpoint that
 * accepted it would be a way to walk a finished order backwards, and the
 * merchant's real answer to "the coffee was already handed over" is a refund —
 * a different fact that this row must not be able to fake. The stored enum is
 * wider than this request on purpose.
 *
 * There is no merchant-operator identity in this demo (`x-dev-caller-id` names
 * the *buyer*), so the route that accepts this body is gated on
 * `MERCHANT_TEST_MODE` rather than pretending to authenticate. A real deployment
 * needs a merchant credential here; a second forgeable header would be a worse
 * answer than an honest gap.
 */
export const updateFulfillmentRequestSchema = z
  .object({ status: z.enum(['ready', 'completed', 'cancelled']) })
  .strict();

export type UpdateFulfillmentRequest = z.infer<typeof updateFulfillmentRequestSchema>;

/** `200` body for `POST /commerce/v1/orders/:id/fulfillment`: the updated order. */
export const updateFulfillmentResponseSchema = orderSchema;

export type UpdateFulfillmentResponse = z.infer<typeof updateFulfillmentResponseSchema>;
