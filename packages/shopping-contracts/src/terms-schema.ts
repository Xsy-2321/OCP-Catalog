import { z } from 'zod';
import { TERMS_DOMAIN } from './version';

export const quoteTermsItemSchema = z
  .object({
    entry_id: z.string().min(1),
    quantity: z.number().int().positive(),
    unit_minor: z.number().int().nonnegative(),
  })
  .strict();

export const quoteTermsFeeSchema = z
  .object({
    code: z.string().min(1),
    amount_minor: z.number().int(),
  })
  .strict();

/**
 * How the merchant can hand over an order.
 *
 * This lives here, next to the terms it appears in, rather than beside the
 * catalog attributes that also use it. A signed field must not accept a value
 * the merchant has no way to fulfil: with a free string, A and B would happily
 * hash and sign an agreement for `"teleport"`, and the disagreement would only
 * surface at the counter. The catalog imports this enum rather than declaring a
 * second one, so there is exactly one vocabulary.
 */
export const fulfillmentMethodSchema = z.enum(['pickup', 'delivery']);

export type FulfillmentMethod = z.infer<typeof fulfillmentMethodSchema>;

/** Customer supplied details, carried in signed terms and never invented by a model. */
export const deliveryAddressSchema = z.object({
  recipient: z.string().trim().min(1).max(60),
  phone: z.string().trim().max(20).transform(value => value.replace(/[ -]/g, ''))
    .pipe(z.string().regex(/^\+?[0-9]{6,15}$/)),
  address: z.string().trim().min(5).max(300),
}).strict();

export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>;

export const quoteFulfillmentSchema = z
  .object({
    method: fulfillmentMethodSchema,
    location_id: z.string().min(1).optional(),
    // Optional here so existing saved delivery records remain readable. New
    // delivery quote requests require details at the commerce request boundary.
    delivery: deliveryAddressSchema.optional(),
  })
  .strict()
  .refine(value => value.method !== 'pickup' || value.delivery === undefined,
    { message: 'pickup must not contain delivery details', path: ['delivery'] });

export type QuoteFulfillment = z.infer<typeof quoteFulfillmentSchema>;

export const quoteTermsSchema = z
  .object({
    v: z.literal(TERMS_DOMAIN),
    merchant_id: z.string().min(1),
    quote_id: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    total_minor: z.number().int().nonnegative(),
    items: z.array(quoteTermsItemSchema).min(1),
    fees: z.array(quoteTermsFeeSchema),
    fulfillment: quoteFulfillmentSchema,
  })
  .strict();

export type QuoteTerms = z.infer<typeof quoteTermsSchema>;
