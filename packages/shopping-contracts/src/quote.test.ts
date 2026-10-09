import { describe, expect, test } from 'bun:test';
import {
  buildQuoteTerms,
  computeQuoteTermsHash,
  isQuoteExpired,
  quoteInconsistency,
  quoteSchema,
  type Quote,
} from './quote';
import { TERMS_DOMAIN } from './version';

/** A quote that adds up: 2 x 2500 = 5000, plus 500 delivery = 5500. */
function makeQuote(overrides: Partial<Quote> = {}): Quote {
  const draft: Omit<Quote, 'terms_hash'> = {
    quote_id: 'quote_0001',
    merchant_id: 'merchant_coffee_demo',
    catalog_id: 'catalog_coffee_demo',
    currency: 'CNY',
    items: [
      {
        entry_id: 'entry_latte',
        title: '拿铁',
        quantity: 2,
        unit_minor: 2500,
        line_total_minor: 5000,
      },
    ],
    fees: [{ code: 'delivery', label: '配送费', amount_minor: 500 }],
    subtotal_minor: 5000,
    total_minor: 5500,
    fulfillment: { method: 'pickup', location_id: 'store_zjg' },
    created_at: '2026-10-07T10:00:00.000Z',
    expires_at: '2026-10-07T10:15:00.000Z',
  };
  const merged = { ...draft, ...overrides } as Omit<Quote, 'terms_hash'>;
  return { ...merged, terms_hash: computeQuoteTermsHash(merged) };
}

describe('buildQuoteTerms', () => {
  test('projects only the signed fields', () => {
    // Arrange
    const quote = makeQuote();

    // Act
    const terms = buildQuoteTerms(quote);

    // Assert
    expect(terms).toEqual({
      v: TERMS_DOMAIN,
      merchant_id: 'merchant_coffee_demo',
      quote_id: 'quote_0001',
      currency: 'CNY',
      total_minor: 5500,
      items: [{ entry_id: 'entry_latte', quantity: 2, unit_minor: 2500 }],
      fees: [{ code: 'delivery', amount_minor: 500 }],
      fulfillment: { method: 'pickup', location_id: 'store_zjg' },
    });
  });

  test('omits display-only fields from the projection', () => {
    // Arrange
    const quote = makeQuote();

    // Act
    const terms = buildQuoteTerms(quote) as Record<string, unknown>;

    // Assert: these are shown to the user but are not part of the agreement.
    expect(terms).not.toHaveProperty('subtotal_minor');
    expect(terms).not.toHaveProperty('catalog_id');
    expect(terms).not.toHaveProperty('created_at');
    expect(terms).not.toHaveProperty('expires_at');
    expect(terms).not.toHaveProperty('terms_hash');
    expect((terms.items as Record<string, unknown>[])[0]).not.toHaveProperty('title');
    expect((terms.items as Record<string, unknown>[])[0]).not.toHaveProperty('line_total_minor');
    expect((terms.fees as Record<string, unknown>[])[0]).not.toHaveProperty('label');
  });

  test('turns a title change into no change at all', () => {
    // Arrange: fix a typo in the display name only.
    const original = makeQuote();
    const retitled = makeQuote({
      items: [
        {
          entry_id: 'entry_latte',
          title: '拿铁咖啡',
          quantity: 2,
          unit_minor: 2500,
          line_total_minor: 5000,
        },
      ],
    });

    // Act / Assert: otherwise every outstanding authorization would be voided.
    expect(buildQuoteTerms(retitled)).toEqual(buildQuoteTerms(original));
  });

  test('turns a fee label change into no change at all', () => {
    // Arrange
    const original = makeQuote();
    const relabelled = makeQuote({
      fees: [{ code: 'delivery', label: '外送费', amount_minor: 500 }],
    });

    // Act / Assert
    expect(computeQuoteTermsHash(relabelled)).toBe(computeQuoteTermsHash(original));
  });

  test('still moves when a signed value moves', () => {
    // Arrange: the same field the label test used, but the amount this time.
    const original = makeQuote();
    const repriced = makeQuote({
      fees: [{ code: 'delivery', label: '配送费', amount_minor: 501 }],
      total_minor: 5501,
    });

    // Act / Assert: the exclusion must be per-field, not per-object.
    expect(computeQuoteTermsHash(repriced)).not.toBe(computeQuoteTermsHash(original));
  });
});

describe('quoteInconsistency', () => {
  test('returns null for a quote that adds up', () => {
    // Arrange / Act / Assert
    expect(quoteInconsistency(makeQuote())).toBeNull();
  });

  test('catches a line total that is not unit price times quantity', () => {
    // Arrange
    const quote = makeQuote({
      items: [
        {
          entry_id: 'entry_latte',
          title: '拿铁',
          quantity: 2,
          unit_minor: 2500,
          line_total_minor: 5001,
        },
      ],
    });

    // Act
    const problem = quoteInconsistency(quote);

    // Assert
    expect(problem).not.toBeNull();
    expect(problem).toMatch(/entry_latte/);
  });

  test('catches a subtotal that does not match the line totals', () => {
    // Arrange
    const quote = makeQuote({ subtotal_minor: 4900 });

    // Act / Assert
    expect(quoteInconsistency(quote)).toMatch(/subtotal_minor 4900/);
  });

  test('catches a total that does not match subtotal plus fees', () => {
    // Arrange
    const quote = makeQuote({ total_minor: 5400 });

    // Act / Assert
    expect(quoteInconsistency(quote)).toMatch(/total_minor 5400/);
  });

  test('catches a terms_hash that does not describe the quote', () => {
    // Arrange: a well-formed quote whose hash was computed over other contents.
    const honest = makeQuote();
    const forged: Quote = {
      ...honest,
      terms_hash: computeQuoteTermsHash({ ...honest, total_minor: 999 } as Omit<Quote, 'terms_hash'>),
    };

    // Act / Assert: this is the check that makes a client-reported hash useless.
    expect(quoteInconsistency(forged)).toMatch(/terms_hash/);
  });

  test('checks the arithmetic before the hash, so a bad total is named as such', () => {
    // Arrange: both the total and therefore the hash are wrong.
    const quote = makeQuote({ total_minor: 5400 });

    // Act
    const problem = quoteInconsistency(quote);

    // Assert: reporting "hash mismatch" here would send the reader to the wrong file.
    expect(problem).toMatch(/total_minor/);
    expect(problem).not.toMatch(/terms_hash/);
  });
});

describe('isQuoteExpired', () => {
  const quote = makeQuote();

  test('is false before the expiry instant', () => {
    // Arrange / Act / Assert
    expect(isQuoteExpired(quote, Date.parse('2026-10-07T10:14:59.999Z'))).toBe(false);
  });

  test('is true exactly at the expiry instant', () => {
    // Arrange / Act / Assert: an inclusive boundary, not exclusive.
    expect(isQuoteExpired(quote, Date.parse('2026-10-07T10:15:00.000Z'))).toBe(true);
  });

  test('is true after the expiry instant', () => {
    // Arrange / Act / Assert
    expect(isQuoteExpired(quote, Date.parse('2026-10-07T11:00:00.000Z'))).toBe(true);
  });

  test('accepts a Date as well as a millisecond number', () => {
    // Arrange
    const before = new Date('2026-10-07T10:00:00.000Z');
    const after = new Date('2026-10-07T12:00:00.000Z');

    // Act / Assert
    expect(isQuoteExpired(quote, before)).toBe(false);
    expect(isQuoteExpired(quote, after)).toBe(true);
  });
});

describe('quoteSchema', () => {
  test('accepts a well-formed quote', () => {
    // Arrange / Act / Assert
    const quote = makeQuote();
    expect(quoteSchema.parse(quote)).toEqual(quote);
  });

  test('rejects a quote with no line items', () => {
    // Arrange
    const quote = makeQuote();
    const empty = { ...quote, items: [] };

    // Act / Assert: a quote for nothing is not a quote.
    expect(() => quoteSchema.parse(empty)).toThrow();
  });

  test('rejects a terms_hash that is not a 64-character lowercase hex string', () => {
    // Arrange
    const quote = makeQuote();
    const shortHash = { ...quote, terms_hash: 'abc' };

    // Act / Assert
    expect(() => quoteSchema.parse(shortHash)).toThrow();
  });

  test('rejects an unknown field', () => {
    // Arrange
    const quote = makeQuote();
    const withExtra = { ...quote, approved: true };

    // Act / Assert
    expect(() => quoteSchema.parse(withExtra)).toThrow();
  });

  test('rejects a timestamp that is not ISO-8601', () => {
    // Arrange
    const quote = makeQuote();
    const loose = { ...quote, expires_at: '2026-10-07 10:15:00' };

    // Act / Assert
    expect(() => quoteSchema.parse(loose)).toThrow();
  });
});
