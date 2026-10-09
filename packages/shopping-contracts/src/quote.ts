/**
 * A quote: the merchant's final, all-in price for a specific selection.
 *
 * Two properties matter more than the field list.
 *
 * First, the quote carries every charge. `total_minor` is what the customer
 * actually pays, and the budget check is against this number, not against the
 * catalog price — a catalog price that looks affordable plus a delivery fee that
 * does not is still over budget.
 *
 * Second, `terms_hash` is computed and stored by the merchant, and only the
 * merchant. A client-reported total is an input to be checked, never a fact.
 */
import {
  quoteTermsSchema,
  type QuoteTerms,
  computeTermsHash,
  termsInconsistency,
} from './terms';
import { TERMS_DOMAIN } from './version';
import type { Quote } from './quote-schema';
export * from './quote-schema';

/**
 * Projects a quote onto the fields that `terms_hash` covers.
 *
 * Written out field by field rather than spread-and-delete: the set of signed
 * fields is a deliberate decision, and it should be readable at a glance rather
 * than inferable from what someone remembered to omit.
 */
export function buildQuoteTerms(quote: Pick<Quote, 'merchant_id' | 'quote_id' | 'currency' | 'total_minor' | 'items' | 'fees' | 'fulfillment'>): QuoteTerms {
  return quoteTermsSchema.parse({
    v: TERMS_DOMAIN,
    merchant_id: quote.merchant_id,
    quote_id: quote.quote_id,
    currency: quote.currency,
    total_minor: quote.total_minor,
    items: quote.items.map((item) => ({
      entry_id: item.entry_id,
      quantity: item.quantity,
      unit_minor: item.unit_minor,
    })),
    fees: quote.fees.map((fee) => ({ code: fee.code, amount_minor: fee.amount_minor })),
    fulfillment: quote.fulfillment,
  });
}

/** Recomputes `terms_hash` from a quote's own contents. */
export function computeQuoteTermsHash(quote: Parameters<typeof buildQuoteTerms>[0]): string {
  return computeTermsHash(buildQuoteTerms(quote));
}

/**
 * Returns the reason the quote does not add up, or `null` if it does.
 *
 * Checks each line's `unit * quantity`, the subtotal, and the total including
 * fees. A quote that fails this must never reach a customer.
 */
export function quoteInconsistency(quote: Quote): string | null {
  for (const item of quote.items) {
    const expected = item.unit_minor * item.quantity;
    if (item.line_total_minor !== expected) {
      return `line ${item.entry_id}: line_total_minor ${item.line_total_minor} != ${item.unit_minor} x ${item.quantity}`;
    }
  }
  const subtotal = quote.items.reduce((total, item) => total + item.line_total_minor, 0);
  if (subtotal !== quote.subtotal_minor) {
    return `subtotal_minor ${quote.subtotal_minor} != sum of line totals ${subtotal}`;
  }
  const expectedTotal = subtotal + quote.fees.reduce((total, fee) => total + fee.amount_minor, 0);
  if (expectedTotal !== quote.total_minor) {
    return `total_minor ${quote.total_minor} != subtotal ${subtotal} plus fees`;
  }
  const terms = buildQuoteTerms(quote);
  const termsProblem = termsInconsistency(terms);
  if (termsProblem !== null) return termsProblem;
  if (computeTermsHash(terms) !== quote.terms_hash) {
    return 'terms_hash does not match the quote contents';
  }
  return null;
}

/** True if the quote's validity window has closed at `now`. */
export function isQuoteExpired(quote: Quote, now: Date | number): boolean {
  const expiresAt = typeof now === 'number' ? now : now.getTime();
  return Date.parse(quote.expires_at) <= expiresAt;
}
