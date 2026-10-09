/**
 * Catalog behaviour, tested as the three claims the handoff makes:
 *
 *   1. A bad catalog fails at startup, naming the entry — not at the till.
 *   2. Every filter the manifest declares actually changes the result set.
 *      "Declared filters actually work" is the acceptance line that is easiest to
 *      fake, so each one is exercised on its own rather than through a combined
 *      query that would pass with any one of them wired up.
 *   3. A protocol filter this merchant does not implement is reported, not
 *      silently dropped.
 */
import { describe, expect, test } from 'bun:test';
import { catalogQueryRequestSchema, type CatalogQueryRequest } from '@ocp-catalog/ocp-schema';
import {
  CHECKOUT_ACTION_ID,
  CHECKOUT_ACTION_TYPE,
  CommerceError,
  EXPECTED_FILTERABLE_FIELD_REFS,
  IMPLEMENTED_QUERY_FILTER_KEYS,
  coffeeEntryAttributesSchema,
  type CoffeeQueryFilterKey,
} from '@ocp-catalog/shopping-contracts';
import {
  UNIMPLEMENTED_QUERY_FILTER_KEYS,
  buildResolvableReference,
  catalogStockInconsistency,
  explainEntry,
  findEntry,
  isPurchasable,
  loadCatalog,
  runCatalogQuery,
  scoreEntry,
  type CatalogEntryRecord,
} from './catalog';
import { CATALOG_SEED } from './data/catalog';
import { TEST_NOW_MS, makeTestConfig } from './test-support';

/* ------------------------------------------------------------------ fixtures */

interface MutableAttributes {
  price: { currency: string; amount: number; price_type?: string };
  price_minor: number;
  inventory: { availability_status: string; quantity?: number };
  [key: string]: unknown;
}

interface MutableEntry {
  entry_id: string;
  attributes: MutableAttributes;
  [key: string]: unknown;
}

/** A deep copy of the seed that the test may write to. */
function seedCopy(): MutableEntry[] {
  return JSON.parse(JSON.stringify(CATALOG_SEED)) as MutableEntry[];
}

function entryById(seed: MutableEntry[], entryId: string): MutableEntry {
  const found = seed.find((item) => item.entry_id === entryId);
  if (found === undefined) throw new Error(`no seed entry ${entryId}`);
  return found;
}

const CATALOG: readonly CatalogEntryRecord[] = loadCatalog(CATALOG_SEED);

/** Runs a query the way the HTTP layer does: through the protocol schema first. */
function query(raw: Record<string, unknown> = {}): ReturnType<typeof runCatalogQuery> {
  const request: CatalogQueryRequest = catalogQueryRequestSchema.parse({ query: '', ...raw });
  return runCatalogQuery(CATALOG, request);
}

function ids(outcome: ReturnType<typeof runCatalogQuery>): string[] {
  return outcome.matches.map((record) => record.entry.entry_id);
}

/* ----------------------------------------------------------------- ingestion */

describe('loadCatalog', () => {
  test('accepts the committed seed', () => {
    expect(CATALOG).toHaveLength(5);
  });

  test('rejects a duplicate entry_id', () => {
    const seed = seedCopy();
    seed.push(JSON.parse(JSON.stringify(entryById(seed, 'entry_latte'))) as MutableEntry);

    // A duplicate id means one of the two is unreachable by `findEntry`, and the
    // one that wins depends on array order — a silent difference between what is
    // quoted and what is sold.
    expect(() => loadCatalog(seed)).toThrow(/duplicate catalog entry_id: entry_latte/);
  });

  test('rejects a price whose decimal and minor forms disagree', () => {
    const seed = seedCopy();
    entryById(seed, 'entry_latte').attributes.price.amount = 26;

    expect(() => loadCatalog(seed)).toThrow(/entry_latte: price\.amount 26 \(2600 minor\) != price_minor 2500/);
  });

  test('rejects stock that contradicts itself in either direction', () => {
    const zeroButInStock = seedCopy();
    entryById(zeroButInStock, 'entry_latte').attributes.inventory.quantity = 0;
    expect(() => loadCatalog(zeroButInStock)).toThrow(
      /entry_latte: availability_status is in_stock but quantity is 0/,
    );

    const stockLeftButSoldOut = seedCopy();
    entryById(stockLeftButSoldOut, 'entry_soldout').attributes.inventory.quantity = 3;
    expect(() => loadCatalog(stockLeftButSoldOut)).toThrow(
      /entry_soldout: availability_status is out_of_stock but quantity is 3/,
    );
  });

  test('rejects attributes that are not the demo pack, naming the entry', () => {
    const seed = seedCopy();
    // The OCP price pack is a closed set: a lowercase currency is a mistake, not
    // a variant to normalise away.
    entryById(seed, 'entry_latte').attributes.price.currency = 'cny';

    expect(() => loadCatalog(seed)).toThrow(/entry_latte: invalid demo attributes/);
  });

  test('rejects an entry missing a required pack', () => {
    const seed = seedCopy();
    delete entryById(seed, 'entry_americano').attributes.inventory;

    expect(() => loadCatalog(seed)).toThrow(/entry_americano: invalid demo attributes/);
  });

  test('catches a mismatch between the two price fields it would otherwise serve', () => {
    // The guard is called for every entry at ingestion; this pins the rule itself.
    const attributes = coffeeEntryAttributesSchema.parse(
      JSON.parse(JSON.stringify(entryById(seedCopy(), 'entry_latte').attributes)),
    );

    expect(catalogStockInconsistency(attributes)).toBeNull();
    expect(isPurchasable({ entry: CATALOG_SEED[0]!, attributes })).toBe(true);
  });
});

/* -------------------------------------------------------------------- lookup */

describe('findEntry', () => {
  test('returns the record for a known id', () => {
    expect(findEntry(CATALOG, 'entry_americano')?.attributes.price_minor).toBe(990);
  });

  test('returns null for an unknown id rather than throwing', () => {
    expect(findEntry(CATALOG, 'entry_nope')).toBeNull();
  });
});

/* ------------------------------------------------------------------- filters */

describe('runCatalogQuery filters', () => {
  test('returns the whole catalog when nothing is filtered', () => {
    const outcome = query();

    expect(ids(outcome)).toHaveLength(5);
    expect(outcome.acceptedFilters).toEqual([]);
    expect(outcome.rejectedFilters).toEqual([]);
    expect(outcome.hasMore).toBe(false);
  });

  /**
   * One case per declared filter, each with an expectation that differs from the
   * unfiltered result. A filter that is declared but not wired up would return
   * all five and fail here.
   */
  const cases: ReadonlyArray<{
    readonly key: CoffeeQueryFilterKey;
    readonly filters: Record<string, unknown>;
    readonly expected: readonly string[];
  }> = [
    { key: 'category', filters: { category: 'merchandise' }, expected: ['entry_gift_box'] },
    // Every seed entry shares one brand and one currency, so the honest probe is
    // a value nothing matches: a filter that is ignored returns five, not zero.
    { key: 'brand', filters: { brand: '别的品牌' }, expected: [] },
    { key: 'currency', filters: { currency: 'USD' }, expected: [] },
    {
      key: 'min_amount',
      filters: { min_amount: 30 },
      expected: ['entry_gift_box', 'entry_cold_brew'],
    },
    {
      key: 'max_amount',
      filters: { max_amount: 25 },
      expected: ['entry_latte', 'entry_americano'],
    },
    { key: 'availability_status', filters: { availability_status: 'out_of_stock' }, expected: ['entry_soldout'] },
    { key: 'in_stock_only', filters: { in_stock_only: true }, expected: ['entry_latte', 'entry_americano', 'entry_gift_box', 'entry_cold_brew'] },
  ];

  for (const testCase of cases) {
    test(`${testCase.key} changes the result set`, () => {
      const outcome = query({ filters: testCase.filters });

      expect([...ids(outcome)].sort()).toEqual([...testCase.expected].sort());
      expect(outcome.acceptedFilters).toEqual([testCase.key]);
    });
  }

  test('covers every key the manifest maps to a filter', () => {
    // If the map gains a key, this fails rather than leaving it untested.
    expect(cases.map((entry) => entry.key).sort()).toEqual([...IMPLEMENTED_QUERY_FILTER_KEYS].sort());
  });

  test('in_stock_only=false is not the same as omitting it', () => {
    // The predicate is added only when true. Adding `isPurchasable` on false
    // would hide the sold-out entry from a caller who explicitly asked to see
    // everything — a filter that inverts is worse than one that is missing.
    expect(ids(query({ filters: { in_stock_only: false } }))).toHaveLength(5);
    expect(ids(query({ filters: { in_stock_only: true } }))).not.toContain('entry_soldout');
  });

  test('combines filters as a conjunction', () => {
    const outcome = query({ filters: { category: 'coffee', in_stock_only: true } });

    expect([...ids(outcome)].sort()).toEqual(['entry_americano', 'entry_cold_brew', 'entry_latte']);
  });

  test('compares amounts in minor units, not major', () => {
    // 9.9 yuan is 990 minor. Compared as decimals this still works, but the
    // boundary is where the two representations can disagree.
    expect(ids(query({ filters: { max_amount: 9.9 } }))).toEqual(['entry_americano']);
  });

  test('rejects an amount filter with more precision than the currency has', () => {
    // Silently rounding 9.999 to 10.00 would quote a price the catalog does not
    // have; the caller is told instead.
    let thrown: unknown;
    try {
      query({ filters: { min_amount: 9.999 } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CommerceError);
    expect((thrown as CommerceError).code).toBe('invalid_request');
    expect((thrown as CommerceError).message).toContain('min_amount');
  });
});

describe('runCatalogQuery unimplemented filters', () => {
  test('reports the protocol filters this merchant does not implement', () => {
    // Derived from the protocol schema, so an upstream release that adds a filter
    // shows up here rather than as a key that is quietly ignored.
    expect([...UNIMPLEMENTED_QUERY_FILTER_KEYS].sort()).toEqual(['has_image', 'provider_id', 'sku']);
  });

  test('names a rejected filter and leaves the results unfiltered', () => {
    const outcome = query({ filters: { has_image: true } });

    expect(outcome.rejectedFilters).toEqual(['has_image']);
    expect(outcome.acceptedFilters).toEqual([]);
    // Unfiltered, not empty: rejecting a filter is a policy note, not a failure.
    expect(ids(outcome)).toHaveLength(5);
  });

  test('separates accepted from rejected in a mixed request', () => {
    const outcome = query({ filters: { category: 'coffee', sku: 'SKU-1' } });

    expect(outcome.acceptedFilters).toEqual(['category']);
    expect(outcome.rejectedFilters).toEqual(['sku']);
    expect(ids(outcome)).toHaveLength(4);
  });

  test('every declared field ref maps to at least one implemented key', () => {
    // The manifest declares these refs; a ref with no key behind it would be a
    // filter advertised and never honoured.
    for (const ref of EXPECTED_FILTERABLE_FIELD_REFS) {
      expect(ref.length).toBeGreaterThan(0);
    }
    expect(IMPLEMENTED_QUERY_FILTER_KEYS.size).toBe(7);
  });
});

/* ---------------------------------------------------------------- keyword + paging */

describe('runCatalogQuery keyword', () => {
  test('matches the title', () => {
    expect(ids(query({ query: '拿铁' }))).toEqual(['entry_latte']);
  });

  test('matches the summary as well as the title', () => {
    // "冷萃" appears in both, so use a word that is only in the summary.
    expect(ids(query({ query: '滤杯' }))).toEqual(['entry_gift_box']);
  });

  test('trims the term', () => {
    expect(ids(query({ query: '  拿铁  ' }))).toEqual(['entry_latte']);
  });

  test('is case-insensitive', () => {
    // No seed title contains latin text, so the case rule is exercised on a
    // title that does — otherwise this test would pass for the wrong reason.
    const latin = seedCopy();
    entryById(latin, 'entry_latte').title = 'Latte';
    const request = catalogQueryRequestSchema.parse({ query: 'LATTE' });

    expect(runCatalogQuery(loadCatalog(latin), request).matches).toHaveLength(1);
  });

  test('returns nothing for a term no entry contains', () => {
    expect(ids(query({ query: '披萨' }))).toEqual([]);
  });

  test('applies the keyword on top of the filters, not instead of them', () => {
    // "演示咖啡" is the brand on all five entries, so the keyword alone matches
    // everything; the stock filter is what has to remove one of them.
    expect(ids(query({ query: '演示咖啡' }))).toHaveLength(5);
    expect(ids(query({ query: '演示咖啡', filters: { in_stock_only: true } }))).not.toContain('entry_soldout');
    expect(ids(query({ query: '拿铁', filters: { category: 'merchandise' } }))).toEqual([]);
  });
});

describe('runCatalogQuery paging', () => {
  test('pages with a cursor because the protocol forbids an offset', () => {
    // `page.offset` is `z.literal(0)` in the protocol, so position can only be
    // carried by `next_cursor`. The handler's own offset is still computed.
    const first = query({ limit: 2 });

    expect(first.matches).toHaveLength(2);
    expect(first.offset).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe('2');
  });

  test('returns the next page and then stops', () => {
    const second = query({ limit: 2, cursor: '2' });

    expect(ids(second)).toEqual(['entry_gift_box', 'entry_soldout']);
    expect(second.hasMore).toBe(true);
    expect(second.nextCursor).toBe('4');

    const third = query({ limit: 2, cursor: '4' });
    expect(ids(third)).toEqual(['entry_cold_brew']);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeUndefined();
  });

  test('reports no more pages when the last page is exactly full', () => {
    const outcome = query({ limit: 5 });

    expect(outcome.matches).toHaveLength(5);
    expect(outcome.hasMore).toBe(false);
  });

  test('rejects a cursor that is not a decimal offset', () => {
    let thrown: unknown;
    try {
      query({ cursor: 'abc' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CommerceError);
    expect((thrown as CommerceError).code).toBe('invalid_request');
    expect((thrown as CommerceError).message).toContain('cursor');
  });

  test('a cursor past the end is an empty page, not an error', () => {
    const outcome = query({ cursor: '99' });

    expect(outcome.matches).toEqual([]);
    expect(outcome.hasMore).toBe(false);
  });
});

/* -------------------------------------------------------------------- scoring */

describe('scoreEntry', () => {
  test('ranks a title hit above a body hit', () => {
    const latte = findEntry(CATALOG, 'entry_latte');

    expect(scoreEntry(latte!, '拿铁')).toBe(1);
    expect(scoreEntry(latte!, '拼配豆')).toBe(0.5);
  });

  test('scores every entry the same when there is no keyword', () => {
    expect(scoreEntry(CATALOG[0]!, '')).toBe(1);
  });
});

describe('explainEntry', () => {
  test('says so when there was no keyword', () => {
    expect(explainEntry(CATALOG[0]!, '')).toEqual(['No keyword given; every catalog entry matches.']);
  });

  test('names the field the keyword matched', () => {
    expect(explainEntry(findEntry(CATALOG, 'entry_latte')!, '拿铁')[0]).toContain('拿铁');
  });
});

/* -------------------------------------------------------------------- resolve */

describe('buildResolvableReference', () => {
  const config = makeTestConfig();
  const reference = buildResolvableReference(findEntry(CATALOG, 'entry_latte')!, {
    config,
    nowMs: TEST_NOW_MS,
  });

  test('gives A the checkout endpoint rather than letting it build one', () => {
    const checkout = reference.action_bindings.find((binding) => binding.action_id === CHECKOUT_ACTION_ID);

    expect(checkout?.action_type).toBe(CHECKOUT_ACTION_TYPE);
    expect(checkout?.entrypoint.url).toBe(`${config.publicBaseUrl}/commerce/v1/checkouts`);
    expect(checkout?.entrypoint.method).toBe('POST');
    expect(checkout?.requires_user_confirmation).toBe(true);
  });

  test('states the headers the checkout call needs', () => {
    const checkout = reference.action_bindings.find((binding) => binding.action_id === CHECKOUT_ACTION_ID);
    const schema = checkout?.input_schema as { required?: string[]; headers?: Record<string, string> };

    expect(schema.required).toEqual(['purchase_attempt_id', 'quote_id', 'terms_hash', 'authorization']);
    expect(schema.headers?.['idempotency-key']).toBeDefined();
    expect(schema.headers?.['x-dev-caller-id']).toBeDefined();
  });

  test('advertises the key it will actually verify against', () => {
    const checkout = reference.action_bindings.find((binding) => binding.action_id === CHECKOUT_ACTION_ID);

    expect(checkout?.auth_requirements).toEqual({ scheme: 'ed25519', key_id: 'agent_a_test' });
  });

  test('advertises no key when none is trusted', () => {
    // Promising a scheme the merchant cannot verify would invite A to start a
    // purchase that is guaranteed to be refused.
    const keyless = buildResolvableReference(findEntry(CATALOG, 'entry_latte')!, {
      config: makeTestConfig({ trustedKeys: new Map() }),
      nowMs: TEST_NOW_MS,
    });
    const checkout = keyless.action_bindings.find((binding) => binding.action_id === CHECKOUT_ACTION_ID);

    expect(checkout?.auth_requirements).toEqual({});
  });

  test('expires with the quote window it promises', () => {
    expect(reference.expires_at).toBe(new Date(TEST_NOW_MS + config.quoteTtlSeconds * 1000).toISOString());
    expect(reference.action_bindings[1]?.expires_at).toBe(reference.expires_at);
  });

  test('carries the price in both representations', () => {
    expect(reference.visible_attributes.price).toEqual({ currency: 'CNY', amount: 25 });
    expect(reference.visible_attributes.price_minor).toBe(2500);
  });
});
