/** Order field validation shared by server and browser boundaries. */
import { z } from 'zod';
import { quoteFeeLineSchema, quoteLineItemSchema } from './quote-schema';
import { quoteFulfillmentSchema } from './terms-schema';

export const paymentStatusSchema = z.enum(['pending', 'paid', 'failed', 'unknown']);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const fulfillmentStatusSchema = z.enum(['pending', 'ready', 'completed', 'cancelled']);
export type FulfillmentStatus = z.infer<typeof fulfillmentStatusSchema>;

export const orderPaymentSchema = z.object({
  status: paymentStatusSchema,
  updated_at: z.string().datetime(),
}).strict();

export const orderFulfillmentSchema = z.object({
  status: fulfillmentStatusSchema,
  updated_at: z.string().datetime(),
}).strict();

export const orderSchema = z.object({
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
}).strict();

export type Order = z.infer<typeof orderSchema>;
