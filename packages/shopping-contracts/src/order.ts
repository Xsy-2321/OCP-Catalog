/**
 * An order, and the events recorded around it.
 *
 * Payment and fulfillment are two separate status fields rather than one. A
 * single `status` invites exactly one bug, and it is the expensive one: showing
 * "completed" the moment the card clears, so the customer walks to the counter
 * for a coffee nobody has started making. Money and coffee are tracked apart.
 *
 * The order carries a snapshot of what was bought. If the catalog changes later,
 * the order must still say what it was.
 *
 * Note what is NOT here: no payment reference, no authorization proof. A
 * payment handle is a credential-shaped value and a query endpoint that returns
 * it is a query endpoint that leaks it. The reference stays server-side.
 */
import { z } from 'zod';
import { quoteFeeLineSchema, quoteLineItemSchema } from './quote';
import { quoteFulfillmentSchema } from './terms';

export const paymentStatusSchema = z.enum(['pending', 'paid', 'failed', 'unknown']);

export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const fulfillmentStatusSchema = z.enum(['pending', 'ready', 'completed', 'cancelled']);

export type FulfillmentStatus = z.infer<typeof fulfillmentStatusSchema>;

export const orderPaymentSchema = z
  .object({
    status: paymentStatusSchema,
    updated_at: z.string().datetime(),
  })
  .strict();

export const orderFulfillmentSchema = z
  .object({
    status: fulfillmentStatusSchema,
    updated_at: z.string().datetime(),
  })
  .strict();

export const orderSchema = z
  .object({
    order_id: z.string().min(1),
    merchant_id: z.string().min(1),
    catalog_id: z.string().min(1),
    purchase_attempt_id: z.string().min(1),
    quote_id: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** Snapshot of the purchased selection, frozen at order time. */
    items: z.array(quoteLineItemSchema).min(1),
    fees: z.array(quoteFeeLineSchema),
    subtotal_minor: z.number().int().nonnegative(),
    total_minor: z.number().int().nonnegative(),
    terms_hash: z.string().regex(/^[0-9a-f]{64}$/),
    fulfillment: quoteFulfillmentSchema,
    payment: orderPaymentSchema,
    fulfillment_status: orderFulfillmentSchema,
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export type Order = z.infer<typeof orderSchema>;

export const purchaseEventSubjectTypeSchema = z.enum(['quote', 'attempt', 'order']);

export const purchaseEventTypeSchema = z.enum([
  'quote.created',
  'attempt.created',
  'attempt.confirmed',
  'attempt.failed',
  'payment.succeeded',
  'payment.failed',
  'order.created',
  'order.fulfillment_changed',
]);

export type PurchaseEventType = z.infer<typeof purchaseEventTypeSchema>;

/**
 * An appended record of something that happened.
 *
 * These are application process records, not a tamper-evident ledger: nothing
 * here is hash-chained or signed, so a claim of immutability would be false.
 * `data` must be redacted before it is stored — no signatures, no keys, no
 * payment handles.
 */
export const purchaseEventSchema = z
  .object({
    event_id: z.string().min(1),
    subject_type: purchaseEventSubjectTypeSchema,
    subject_id: z.string().min(1),
    type: purchaseEventTypeSchema,
    occurred_at: z.string().datetime(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type PurchaseEvent = z.infer<typeof purchaseEventSchema>;
