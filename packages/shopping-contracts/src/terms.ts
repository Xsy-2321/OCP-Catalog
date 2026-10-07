/**
 * The terms of a quote — the exact structure that `terms_hash` covers.
 *
 * This is the one thing both sides must compute identically. If A signs an
 * authorization over terms X and B hashes a slightly different X', the
 * signature will not verify, and the debugging is miserable. Hence: B generates
 * the terms, both sides hash using the function in this file, and nothing else
 * hashes terms on its own.
 *
 * Only the fields below are covered. Display-only fields (product titles, fee
 * labels) are deliberately excluded — if they were included, fixing a typo in a
 * label would invalidate every outstanding authorization.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical';
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

export const quoteFulfillmentSchema = z
  .object({
    method: fulfillmentMethodSchema,
    location_id: z.string().min(1).optional(),
  })
  .strict();

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

const compareByEntryId = (a: QuoteTerms['items'][number], b: QuoteTerms['items'][number]): number =>
  a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0;

const compareByCode = (a: QuoteTerms['fees'][number], b: QuoteTerms['fees'][number]): number =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

/**
 * Puts items and fees into the canonical order before hashing.
 *
 * Canonical JSON already sorts object keys, but arrays keep their order — and
 * an order that depends on how a caller happened to build the array is not a
 * property of the terms. Sorting here makes the hash depend on the *content* of
 * the quote and nothing else.
 */
export function normalizeTerms(terms: QuoteTerms): QuoteTerms {
  return {
    ...terms,
    items: [...terms.items].sort(compareByEntryId),
    fees: [...terms.fees].sort(compareByCode),
  };
}

/** Lowercase hex SHA-256 over the canonical form of the normalized terms. */
export function computeTermsHash(terms: QuoteTerms): string {
  return createHash('sha256').update(canonicalJson(normalizeTerms(terms)), 'utf8').digest('hex');
}

/** Sum of `unit_minor * quantity` across all items. */
export function termsItemsSubtotalMinor(terms: QuoteTerms): number {
  return terms.items.reduce((total, item) => total + item.unit_minor * item.quantity, 0);
}

/** Sum of every fee, which may be negative for a discount. */
export function termsFeesTotalMinor(terms: QuoteTerms): number {
  return terms.fees.reduce((total, fee) => total + fee.amount_minor, 0);
}

/**
 * Returns the reason the terms are internally inconsistent, or `null` if they
 * are fine.
 *
 * A quote whose stated total does not equal its own line items is the kind of
 * defect that a customer only discovers at the till, so it is checked rather
 * than assumed.
 */
export function termsInconsistency(terms: QuoteTerms): string | null {
  const subtotal = termsItemsSubtotalMinor(terms);
  const fees = termsFeesTotalMinor(terms);
  const expected = subtotal + fees;
  if (expected !== terms.total_minor) {
    return `total_minor ${terms.total_minor} does not equal items ${subtotal} plus fees ${fees}`;
  }
  return null;
}
