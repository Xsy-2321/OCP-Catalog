import { describe, expect, test } from 'bun:test';
import {
  CHECKOUT_ACTION_ID,
  CHECKOUT_ACTION_TYPE,
  COFFEE_FILTER_MAP,
  COFFEE_QUERY_FILTER_KEYS,
  EXPECTED_FILTERABLE_FIELD_REFS,
  IMPLEMENTED_QUERY_FILTER_KEYS,
  coffeeEntryAttributesSchema,
  coffeePriceInconsistency,
  unimplementableFilterKeys,
  type CoffeeEntryAttributes,
} from './catalog';
import { yuanToMinor } from './money';
import { fulfillmentMethodSchema } from './terms';

/** A latte at ¥25.00, in stock, pickup only. */
const latte: CoffeeEntryAttributes = {
  brand: '演示咖啡',
  category: 'coffee',
  price: { currency: 'CNY', amount: 25 },
  price_minor: 2500,
  inventory: { availability_status: 'in_stock', quantity: 12 },
  fulfillment: { methods: ['pickup'] },
};

describe('fulfillmentMethodSchema', () => {
  test('accepts pickup and delivery', () => {
    // Arrange / Act / Assert
    expect(fulfillmentMethodSchema.parse('pickup')).toBe('pickup');
    expect(fulfillmentMethodSchema.parse('delivery')).toBe('delivery');
  });

  test('rejects anything else', () => {
    // Arrange / Act / Assert
    expect(() => fulfillmentMethodSchema.parse('dine_in')).toThrow();
  });
});

describe('checkout binding constants', () => {
  test('publish the checkout action under a stable type and id', () => {
    // Arrange / Act / Assert: A reads these out of Resolve to find the endpoint,
    // so a change here would silently send A looking for a binding that moved.
    expect(CHECKOUT_ACTION_TYPE).toBe('api');
    expect(CHECKOUT_ACTION_ID).toBe('checkout');
  });
});

describe('coffeeEntryAttributesSchema', () => {
  test('accepts a well-formed entry', () => {
    // Arrange / Act / Assert
    expect(coffeeEntryAttributesSchema.parse(latte)).toEqual(latte);
  });

  test('rejects an unknown attribute', () => {
    // Arrange: a field nobody agreed to would be dropped without complaint.
    const withExtra = { ...latte, secret_sauce: 'yes' };

    // Act / Assert
    expect(() => coffeeEntryAttributesSchema.parse(withExtra)).toThrow();
  });

  test('rejects an entry with no fulfillment method', () => {
    // Arrange
    const unreachable = { ...latte, fulfillment: { methods: [] } };

    // Act / Assert: an item nobody can receive is not sellable.
    expect(() => coffeeEntryAttributesSchema.parse(unreachable)).toThrow();
  });

  test('rejects a non-integer price_minor', () => {
    // Arrange
    const fractional = { ...latte, price_minor: 2500.5 };

    // Act / Assert
    expect(() => coffeeEntryAttributesSchema.parse(fractional)).toThrow();
  });

  test('rejects a negative price_minor', () => {
    // Arrange / Act / Assert
    expect(() => coffeeEntryAttributesSchema.parse({ ...latte, price_minor: -1 })).toThrow();
  });

  test('rejects a decimal price whose currency is lowercase', () => {
    // Arrange: the OCP price pack requires an uppercase code.
    const lowercase = { ...latte, price: { currency: 'cny', amount: 25 } };

    // Act / Assert
    expect(() => coffeeEntryAttributesSchema.parse(lowercase)).toThrow();
  });

  test('accepts a delivery-fee-bearing entry', () => {
    // Arrange
    const deliverable = {
      ...latte,
      fulfillment: { methods: ['pickup', 'delivery'], delivery_fee_minor: 500 },
    };

    // Act / Assert
    expect(coffeeEntryAttributesSchema.parse(deliverable)).toEqual(deliverable);
  });

  test('accepts an entry with no quantity reported', () => {
    // Arrange: availability is stated but the count is unknown.
    const uncounted = { ...latte, inventory: { availability_status: 'low_stock' } };

    // Act / Assert
    expect(coffeeEntryAttributesSchema.parse(uncounted)).toEqual(uncounted);
  });
});

describe('coffeePriceInconsistency', () => {
  test('returns null when the two representations agree', () => {
    // Arrange / Act / Assert
    expect(coffeePriceInconsistency(latte)).toBeNull();
  });

  test('reports a price_minor that disagrees with the decimal price', () => {
    // Arrange: ¥25.00 shown, 2600 fen charged.
    const mismatched = { ...latte, price_minor: 2600 };

    // Act
    const problem = coffeePriceInconsistency(mismatched);

    // Assert
    expect(problem).not.toBeNull();
    expect(problem).toMatch(/2600/);
  });

  test('agrees with yuanToMinor for a two-decimal amount', () => {
    // Arrange: the ingestion path uses yuanToMinor; this check must not disagree.
    const entry: CoffeeEntryAttributes = {
      ...latte,
      price: { currency: 'CNY', amount: 25.5 },
      price_minor: yuanToMinor(25.5),
    };

    // Act / Assert
    expect(entry.price_minor).toBe(2550);
    expect(coffeePriceInconsistency(entry)).toBeNull();
  });

  test('tolerates a floating-point artifact rather than reporting a false mismatch', () => {
    // Arrange: ¥0.29 scaled is 28.999999999999996; 29 fen is correct.
    const cheap: CoffeeEntryAttributes = {
      ...latte,
      price: { currency: 'CNY', amount: 0.29 },
      price_minor: 29,
    };

    // Act / Assert: a naive equality on `amount * 100` would fail here.
    expect(coffeePriceInconsistency(cheap)).toBeNull();
  });

  test('reports a zero-priced item quoted as free but listed with a price', () => {
    // Arrange: price_minor says free, price.amount says ¥25.
    const freeButPriced = { ...latte, price_minor: 0 };

    // Act / Assert
    expect(coffeePriceInconsistency(freeButPriced)).not.toBeNull();
  });
});

describe('COFFEE_FILTER_MAP', () => {
  test('every declared filter key is a real key of the protocol filter schema', () => {
    // Arrange / Act: the merchant picks from a closed set; it does not invent
    // filters. A renamed upstream key must break here, not at runtime.
    const unimplementable = unimplementableFilterKeys();

    // Assert
    expect(unimplementable).toEqual([]);
  });

  test('declares price#/amount, without which max_amount is unbacked', () => {
    // Arrange: AGENT_B.md §3 requires max_amount to really work. The manifest
    // speaks field paths, so `max_amount` needs `price#/amount` declared or the
    // declaration and the implementation disagree.
    const refs = EXPECTED_FILTERABLE_FIELD_REFS;
    const filters = COFFEE_FILTER_MAP['price#/amount'];

    // Act / Assert
    expect(refs).toContain('price#/amount');
    expect(filters).toContain('max_amount');
    expect(filters).toContain('min_amount');
  });

  test('declares the fields AGENT_B.md asks for: currency and in_stock_only', () => {
    // Arrange / Act
    const implemented = IMPLEMENTED_QUERY_FILTER_KEYS;

    // Assert: dropping either of these would silently narrow the demo.
    expect(implemented.has('currency')).toBe(true);
    expect(implemented.has('in_stock_only')).toBe(true);
    expect(implemented.has('availability_status')).toBe(true);
  });

  test('maps every filter key under at least one field ref, with no orphans', () => {
    // Arrange: a key in COFFEE_QUERY_FILTER_KEYS that the map never mentions
    // would be implemented but undeclared — the same defect from the other side.
    const mapped = IMPLEMENTED_QUERY_FILTER_KEYS;

    // Act
    const orphans = COFFEE_QUERY_FILTER_KEYS.filter((key) => !mapped.has(key));

    // Assert
    expect(orphans).toEqual([]);
  });

  test('uses field references the protocol fieldRef regex accepts', () => {
    // Arrange: the refs are validated by OCP, so a malformed one cannot ship.
    const fieldRefPattern = /^[a-z0-9][a-z0-9._-]*#\/[A-Za-z0-9_.~/-]+$/;

    // Act / Assert
    for (const ref of EXPECTED_FILTERABLE_FIELD_REFS) {
      expect(ref).toMatch(fieldRefPattern);
    }
  });

  test('values are not empty', () => {
    // Arrange / Act / Assert: an empty array would declare a field ref that
    // implements nothing, which is exactly the failure this map exists to stop.
    for (const [ref, keys] of Object.entries(COFFEE_FILTER_MAP)) {
      expect(keys.length).toBeGreaterThan(0);
      expect(ref).toBeTruthy();
    }
  });
});
