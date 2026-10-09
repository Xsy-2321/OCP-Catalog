import { z } from 'zod';
import { quoteFulfillmentSchema } from './terms-schema';

/** A priced line on a quote. Display fields are not part of `terms_hash`. */
export const quoteLineItemSchema = z
  .object({
    entry_id: z.string().min(1),
    title: z.string().min(1),
    quantity: z.number().int().positive(),
    unit_minor: z.number().int().nonnegative(),
    line_total_minor: z.number().int().nonnegative(),
  })
  .strict();

export type QuoteLineItem = z.infer<typeof quoteLineItemSchema>;

/** A charge or discount added on top of the item subtotal. */
export const quoteFeeLineSchema = z
  .object({
    code: z.string().min(1),
    label: z.string().min(1),
    /** Negative for a discount. */
    amount_minor: z.number().int(),
  })
  .strict();

export type QuoteFeeLine = z.infer<typeof quoteFeeLineSchema>;

export const quoteSchema = z
  .object({
    quote_id: z.string().min(1),
    merchant_id: z.string().min(1),
    catalog_id: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    items: z.array(quoteLineItemSchema).min(1),
    fees: z.array(quoteFeeLineSchema),
    subtotal_minor: z.number().int().nonnegative(),
    total_minor: z.number().int().nonnegative(),
    /** Server-computed. The client echoes it back at checkout; it is never trusted. */
    terms_hash: z.string().regex(/^[0-9a-f]{64}$/),
    fulfillment: quoteFulfillmentSchema,
    created_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  })
  .strict();

export type Quote = z.infer<typeof quoteSchema>;
