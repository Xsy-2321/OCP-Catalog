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
import { canonicalJson } from './canonical';

import type { QuoteTerms } from './terms-schema';
export * from './terms-schema';

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
