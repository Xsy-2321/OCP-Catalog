import { describe, expect, test } from 'bun:test';
import {
  computeTermsHash,
  normalizeTerms,
  quoteTermsSchema,
  termsFeesTotalMinor,
  termsInconsistency,
  termsItemsSubtotalMinor,
  type QuoteTerms,
} from './terms';
import { TERMS_DOMAIN } from './version';

/** A well-formed two-item quote with one fee; the baseline for the hash tests. */
const baseTerms: QuoteTerms = {
  v: TERMS_DOMAIN,
  merchant_id: 'merchant_coffee_demo',
  quote_id: 'quote_0001',
  currency: 'CNY',
  total_minor: 5500,
  items: [
    { entry_id: 'entry_latte', quantity: 2, unit_minor: 2500 },
    { entry_id: 'entry_americano', quantity: 1, unit_minor: 400 },
  ],
  fees: [{ code: 'delivery', amount_minor: 100 }],
  fulfillment: { method: 'pickup', location_id: 'store_zjg' },
};

describe('computeTermsHash', () => {
  test('is stable across repeated calls on the same terms', () => {
    // Arrange / Act
    const first = computeTermsHash(baseTerms);
    const second = computeTermsHash(baseTerms);

    // Assert
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not depend on the order items were listed in', () => {
    // Arrange: the same two items, listed the other way round.
    const reordered: QuoteTerms = { ...baseTerms, items: [...baseTerms.items].reverse() };

    // Act
    const original = computeTermsHash(baseTerms);
    const permuted = computeTermsHash(reordered);

    // Assert: array order is an accident of construction, not part of the terms.
    expect(permuted).toBe(original);
  });

  test('does not depend on the order fees were listed in', () => {
    // Arrange: three fees, shuffled.
    const many: QuoteTerms = {
      ...baseTerms,
      fees: [
        { code: 'service', amount_minor: 50 },
        { code: 'delivery', amount_minor: 100 },
        { code: 'discount', amount_minor: -20 },
      ],
    };
    const shuffled: QuoteTerms = {
      ...many,
      fees: [many.fees[2], many.fees[0], many.fees[1]],
    };

    // Act / Assert
    expect(computeTermsHash(shuffled)).toBe(computeTermsHash(many));
  });

  test('does not depend on the order keys were written in', () => {
    // Arrange: identical values, declared in a different order.
    const rekeyed = {
      fulfillment: baseTerms.fulfillment,
      fees: baseTerms.fees,
      items: baseTerms.items,
      total_minor: baseTerms.total_minor,
      currency: baseTerms.currency,
      quote_id: baseTerms.quote_id,
      merchant_id: baseTerms.merchant_id,
      v: baseTerms.v,
    } as QuoteTerms;

    // Act / Assert
    expect(computeTermsHash(rekeyed)).toBe(computeTermsHash(baseTerms));
  });

  test('changes when the total changes', () => {
    // Arrange
    const tampered: QuoteTerms = { ...baseTerms, total_minor: baseTerms.total_minor + 1 };

    // Act / Assert: this is the case the whole mechanism exists to catch.
    expect(computeTermsHash(tampered)).not.toBe(computeTermsHash(baseTerms));
  });

  test.each([
    ['quantity', { items: [{ entry_id: 'entry_latte', quantity: 3, unit_minor: 2500 }] }],
    ['unit price', { items: [{ entry_id: 'entry_latte', quantity: 2, unit_minor: 2501 }] }],
    ['entry id', { items: [{ entry_id: 'entry_latte_x', quantity: 2, unit_minor: 2500 }] }],
    ['currency', { currency: 'USD' }],
    ['quote id', { quote_id: 'quote_0002' }],
    ['merchant id', { merchant_id: 'merchant_other' }],
    ['fulfillment method', { fulfillment: { method: 'delivery' } }],
    ['fulfillment location', { fulfillment: { method: 'pickup', location_id: 'store_x' } }],
    ['fee amount', { fees: [{ code: 'delivery', amount_minor: 101 }] }],
    ['fee code', { fees: [{ code: 'shipping', amount_minor: 100 }] }],
  ])('changes when %s changes', (_label, patch) => {
    // Arrange: apply one single-field change on top of the baseline.
    const changed: QuoteTerms = { ...baseTerms, ...patch } as QuoteTerms;

    // Act / Assert: every signed field must move the hash.
    expect(computeTermsHash(changed)).not.toBe(computeTermsHash(baseTerms));
  });

  test('reacts to a reordering that is not a pure permutation', () => {
    // Arrange: same multiset of items, but one has a different entry id pairing.
    const swapped: QuoteTerms = {
      ...baseTerms,
      items: [
        { entry_id: 'entry_latte', quantity: 1, unit_minor: 400 },
        { entry_id: 'entry_americano', quantity: 2, unit_minor: 2500 },
      ],
      total_minor: 5400,
    };

    // Act / Assert: sorting must not make two different quotes collide.
    expect(computeTermsHash(swapped)).not.toBe(computeTermsHash(baseTerms));
  });

  test('treats an absent optional location as different from a present one', () => {
    // Arrange
    const noLocation: QuoteTerms = { ...baseTerms, fulfillment: { method: 'pickup' } };

    // Act / Assert: dropping `undefined` must not silently equate these.
    expect(computeTermsHash(noLocation)).not.toBe(computeTermsHash(baseTerms));
  });
});

describe('normalizeTerms', () => {
  test('sorts items and fees without touching the other fields', () => {
    // Arrange
    const unsorted: QuoteTerms = {
      ...baseTerms,
      items: [...baseTerms.items].reverse(),
      fees: [{ code: 'z', amount_minor: 1 }, { code: 'a', amount_minor: 2 }],
    };

    // Act
    const normalized = normalizeTerms(unsorted);

    // Assert
    expect(normalized.items.map((i) => i.entry_id)).toEqual(['entry_americano', 'entry_latte']);
    expect(normalized.fees.map((f) => f.code)).toEqual(['a', 'z']);
    expect(normalized.total_minor).toBe(unsorted.total_minor);
    expect(normalized.quote_id).toBe(unsorted.quote_id);
  });

  test('does not mutate the input terms', () => {
    // Arrange
    const unsorted: QuoteTerms = { ...baseTerms, items: [...baseTerms.items].reverse() };
    const snapshot = JSON.parse(JSON.stringify(unsorted));

    // Act
    normalizeTerms(unsorted);

    // Assert: in-place sorting here would corrupt a caller's live quote object.
    expect(unsorted).toEqual(snapshot);
  });
});

describe('totals', () => {
  test('sums unit price times quantity across items', () => {
    // Arrange / Act / Assert: 2 x 2500 + 1 x 400.
    expect(termsItemsSubtotalMinor(baseTerms)).toBe(5400);
  });

  test('sums fees including negative discounts', () => {
    // Arrange
    const withDiscount: QuoteTerms = {
      ...baseTerms,
      fees: [
        { code: 'delivery', amount_minor: 100 },
        { code: 'discount', amount_minor: -30 },
      ],
    };

    // Act / Assert
    expect(termsFeesTotalMinor(withDiscount)).toBe(70);
  });
});

describe('termsInconsistency', () => {
  test('returns null when the total matches items plus fees', () => {
    // Arrange / Act / Assert
    expect(termsInconsistency(baseTerms)).toBeNull();
  });

  test('reports a total that does not match its own line items', () => {
    // Arrange: the classic till-time surprise.
    const wrong: QuoteTerms = { ...baseTerms, total_minor: 5400 };

    // Act
    const problem = termsInconsistency(wrong);

    // Assert
    expect(problem).not.toBeNull();
    expect(problem).toMatch(/total_minor 5400/);
  });

  test('accepts a zero total when everything nets to zero', () => {
    // Arrange: a fully discounted item.
    const free: QuoteTerms = {
      ...baseTerms,
      total_minor: 0,
      items: [{ entry_id: 'entry_latte', quantity: 1, unit_minor: 0 }],
      fees: [],
    };

    // Act / Assert: zero is a valid total, not a falsy bug.
    expect(termsInconsistency(free)).toBeNull();
  });
});

describe('quoteTermsSchema', () => {
  test('accepts the baseline terms', () => {
    // Arrange / Act / Assert
    expect(quoteTermsSchema.parse(baseTerms)).toEqual(baseTerms);
  });

  test('rejects an unknown field rather than ignoring it', () => {
    // Arrange: a field that is not part of the signed terms.
    const withExtra = { ...baseTerms, approved: true };

    // Act / Assert: silently dropping it would hide a contract mismatch.
    expect(() => quoteTermsSchema.parse(withExtra)).toThrow();
  });

  test('rejects a non-integer quantity', () => {
    // Arrange
    const fractional = {
      ...baseTerms,
      items: [{ entry_id: 'entry_latte', quantity: 1.5, unit_minor: 2500 }],
    };

    // Act / Assert
    expect(() => quoteTermsSchema.parse(fractional)).toThrow();
  });

  test('rejects a version domain that is not the agreed one', () => {
    // Arrange
    const wrongDomain = { ...baseTerms, v: 'ocp.demo.terms.v2' };

    // Act / Assert: a version change must be a deliberate breaking change.
    expect(() => quoteTermsSchema.parse(wrongDomain)).toThrow();
  });
});
