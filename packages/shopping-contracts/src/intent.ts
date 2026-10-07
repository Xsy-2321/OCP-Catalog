/**
 * A purchase intent: what the user wants, before any merchant has priced it.
 *
 * The intent is defined here because both sides need the same shape, but it is
 * **created and persisted by A**, not by the merchant. It describes the user's
 * side of the transaction — the request in natural language, the budget, and the
 * fulfillment constraint — and it is deliberately not authoritative about
 * anything the merchant owns. The merchant never reads a price or a stock level
 * out of a purchase intent.
 *
 * `max_total_minor` is a ceiling on the **final total including fees**, matching
 * how the budget is checked. A budget that excluded fees would pass at quote
 * time and fail at the till.
 */
import { z } from 'zod';
import { quoteFulfillmentSchema } from './terms';

export const purchaseIntentSchema = z
  .object({
    purchase_intent_id: z.string().min(1),
    user_id: z.string().min(1),
    /** The user's own words. Never parsed into prices or availability. */
    query_text: z.string().min(1),
    quantity: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** Ceiling on the final total, fees included. */
    max_total_minor: z.number().int().nonnegative(),
    /** Merchants the user is willing to buy from. */
    allowed_merchant_ids: z.array(z.string().min(1)).min(1),
    fulfillment: quoteFulfillmentSchema,
    created_at: z.string().datetime(),
  })
  .strict();

export type PurchaseIntent = z.infer<typeof purchaseIntentSchema>;
