/**
 * A purchase attempt: one logical purchase, from the moment A starts checkout.
 *
 * The state machine is `processing -> confirmed | failed`, and it only ever
 * moves forward. The reason it exists as a first-class object is the timeout
 * case: when checkout does not finish in time, the honest answer is "we do not
 * know yet", which is neither success nor failure. A caller that cannot ask
 * "what happened to attempt X?" is forced to guess, and guessing at a payment
 * outcome is how duplicate purchases get made.
 *
 * Note what is NOT here: no caller identity and no authorization proof. The
 * caller id is stored server-side for ownership checks but is not part of the
 * response, and a stored proof would be a replayable credential sitting in a
 * table that a query endpoint reads from.
 */
import { z } from 'zod';
import { commerceErrorSchema } from './errors';

export const purchaseAttemptStatusSchema = z.enum(['processing', 'confirmed', 'failed']);

export type PurchaseAttemptStatus = z.infer<typeof purchaseAttemptStatusSchema>;

export const purchaseAttemptSchema = z
  .object({
    purchase_attempt_id: z.string().min(1),
    merchant_id: z.string().min(1),
    quote_id: z.string().min(1),
    catalog_id: z.string().min(1),
    status: purchaseAttemptStatusSchema,
    /** Present only once `status` is `confirmed`. */
    order_id: z.string().min(1).optional(),
    /** Present only once `status` is `failed`. Public-safe reason only. */
    error: commerceErrorSchema.optional(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export type PurchaseAttempt = z.infer<typeof purchaseAttemptSchema>;

/** True once the attempt has reached a terminal state. */
export function isAttemptSettled(status: PurchaseAttemptStatus): boolean {
  return status !== 'processing';
}
