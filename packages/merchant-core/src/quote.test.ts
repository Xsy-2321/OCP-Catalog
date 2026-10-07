/**
 * Quotes are the merchant's final price, so the tests are about the two things
 * that make one wrong: a total that omits a fee, and a `terms_hash` that does
 * not actually cover the terms.
 *
 * The committed quote fixtures are also re-checked here, through this
 * implementation, rather than only through the contracts package that generated
 * them. A hash both sides compute is a shared fact; a hash only one side
 * computes is a fixture that will diverge the first time either side edits the
 * canonical form.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CommerceError,
  buildQuoteTerms,
  computeQuoteTermsHash,
  quoteInconsistency,
  quoteSchema,
  isQuoteExpired,
  type CreateQuoteRequest,
  type Quote,
} from '@ocp-catalog/shopping-contracts';
import { findEntry, loadCatalog, type CatalogEntryRecord } from './catalog';
import { CATALOG_SEED } from './data/catalog';
import { buildQuote, getStoredQuote, insertQuote } from './quote';
import { TEST_NOW_MS, makeTempDatabasePath, makeTestConfig, openTestDb } from './test-support';

const CATALOG = loadCatalog(CATALOG_SEED);
const CONFIG = makeTestConfig();

function record(entryId: string): CatalogEntryRecord {
  const found = findEntry(CATALOG, entryId);
  if (found === null) throw new Error(`no entry ${entryId}`);
  return found;
}

function price(
  entryId: string,
  overrides: Partial<CreateQuoteRequest> = {},
  nowMs = TEST_NOW_MS,
): Quote {
  const request: CreateQuoteRequest = {
    entry_id: entryId,
    quantity: 1,
    fulfillment: { method: 'pickup', location_id: 'store_zjg' },
    ...overrides,
  };
  return buildQuote(record(entryId), request, { config: CONFIG, nowMs });
}

function commerceErrorFrom(work: () => unknown): CommerceError {
  try {
    work();
  } catch (error) {
    if (error instanceof CommerceError) return error;
    throw error;
  }
  throw new Error('expected a CommerceError, none was thrown');
}

describe('buildQuote', () => {
  test('prices a pickup latte at the catalog price with no fees', () => {
    const quote = price('entry_latte');

    expect(quote.total_minor).toBe(2500);
    expect(quote.subtotal_minor).toBe(2500);
    expect(quote.fees).toEqual([]);
    expect(quote.currency).toBe('CNY');
    expect(quote.merchant_id).toBe(CONFIG.merchantId);
    expect(quote.items).toHaveLength(1);
    expect(quote.items[0]?.line_total_minor).toBe(2500);
  });

  test('adds the delivery fee to the total, not beside it', () => {
    // ¥25 + ¥5 delivery is ¥30. A budget check against the item price would call
    // this affordable and then charge more at the till.
    const quote = price('entry_latte', { fulfillment: { method: 'delivery' } });

    expect(quote.subtotal_minor).toBe(2500);
    expect(quote.fees).toEqual([{ code: 'delivery', label: '配送费', amount_minor: 500 }]);
    expect(quote.total_minor).toBe(3000);
  });

  test('multiplies quantity into the line and the total', () => {
    const quote = price('entry_americano', { quantity: 3 });

    expect(quote.items[0]?.line_total_minor).toBe(2970);
    expect(quote.total_minor).toBe(2970);
  });

  test('produces a quote that adds up', () => {
    for (const entryId of ['entry_latte', 'entry_americano', 'entry_gift_box', 'entry_cold_brew']) {
      const quote = price(entryId);
      expect(quoteInconsistency(quote)).toBeNull();
      expect(computeQuoteTermsHash(quote)).toBe(quote.terms_hash);
    }
  });

  test('refuses a fulfillment method the entry does not offer', () => {
    // The americano is pickup-only. Offering delivery would be a price the
    // merchant cannot honour.
    const error = commerceErrorFrom(() =>
      price('entry_americano', { fulfillment: { method: 'delivery' } }),
    );

    expect(error.code).toBe('invalid_request');
    expect(error.details?.entry_id).toBe('entry_americano');
  });

  test('refuses a fulfillment location the merchant does not run', () => {
    const error = commerceErrorFrom(() =>
      price('entry_latte', { fulfillment: { method: 'pickup', location_id: 'store_shanghai' } }),
    );

    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('store_shanghai');
  });

  test('accepts the location it does run', () => {
    expect(price('entry_latte', { fulfillment: { method: 'pickup', location_id: 'store_zjg' } }).total_minor).toBe(2500);
  });

  test('refuses an out-of-stock entry', () => {
    const error = commerceErrorFrom(() => price('entry_soldout'));

    expect(error.code).toBe('out_of_stock');
    expect(error.details?.available).toBe(0);
  });

  test('refuses more units than are left', () => {
    // The cold brew has exactly one. A quote for two is a promise the merchant
    // cannot keep.
    const error = commerceErrorFrom(() => price('entry_cold_brew', { quantity: 2 }));

    expect(error.code).toBe('out_of_stock');
    expect(error.details).toEqual({ entry_id: 'entry_cold_brew', available: 1, requested: 2 });
  });

  test('quotes the last unit, because quantity equal to what is left is allowed', () => {
    // The boundary matters: refusing `available <= requested` instead of
    // `available < requested` would make the demo's concurrency scenario
    // unreachable.
    expect(price('entry_cold_brew', { quantity: 1 }).total_minor).toBe(3000);
  });

  test('does not reserve stock', () => {
    // Two quotes for the last unit both succeed. Reserving would make an
    // abandoned quote hold the cup until it expired, and would hide the very
    // race the demo exists to show.
    expect(price('entry_cold_brew').total_minor).toBe(3000);
    expect(price('entry_cold_brew').total_minor).toBe(3000);
  });

  test('sets its expiry from the configured window', () => {
    const quote = price('entry_latte');

    expect(quote.created_at).toBe(new Date(TEST_NOW_MS).toISOString());
    expect(quote.expires_at).toBe(new Date(TEST_NOW_MS + CONFIG.quoteTtlSeconds * 1000).toISOString());
    expect(isQuoteExpired(quote, TEST_NOW_MS)).toBe(false);
    expect(isQuoteExpired(quote, TEST_NOW_MS + CONFIG.quoteTtlSeconds * 1000)).toBe(true);
  });
});

describe('terms_hash', () => {
  test('is 32 bytes of lowercase hex', () => {
    expect(price('entry_latte').terms_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changes when the total changes', () => {
    const pickup = price('entry_latte');
    const delivery = price('entry_latte', { fulfillment: { method: 'delivery' } });

    expect(delivery.terms_hash).not.toBe(pickup.terms_hash);
  });

  test('changes when the quote id changes', () => {
    // Every quote gets a fresh id, so two identical selections still hash
    // differently — a signature over one is not a signature over the other.
    expect(price('entry_latte').terms_hash).not.toBe(price('entry_latte').terms_hash);
  });

  test('ignores display-only fields', () => {
    // `title` is in the quote but not in the terms. If it were signed, renaming
    // a drink on the menu would invalidate every authorization already issued.
    const quote = price('entry_latte');
    const renamed: Quote = {
      ...quote,
      items: [{ ...quote.items[0]!, title: '拿铁（大杯）' }],
    };

    expect(computeQuoteTermsHash(renamed)).toBe(quote.terms_hash);
  });

  test('covers the fees, not just the items', () => {
    const quote = price('entry_latte', { fulfillment: { method: 'delivery' } });
    const withoutFee = { ...quote, fees: [], total_minor: quote.subtotal_minor };

    // Same total-minus-fee, but a different set of charges: the hash must move,
    // or a proof could be signed over "¥30 with a delivery fee" and honoured as
    // "¥30 with no fee".
    expect(computeQuoteTermsHash(withoutFee)).not.toBe(quote.terms_hash);
  });

  test('is stable for the same input', () => {
    const quote = price('entry_latte');
    const terms = buildQuoteTerms(quote);

    expect(computeQuoteTermsHash(quote)).toBe(computeQuoteTermsHash({ ...quote, terms_hash: 'x'.repeat(64) }));
    expect(buildQuoteTerms(quote)).toEqual(terms);
  });
});

describe('the committed quote fixtures', () => {
  const dir = join(import.meta.dir, '../../../fixtures/shopping/quotes');

  test('every one adds up and matches its own terms_hash', () => {
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      const quote = quoteSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      // Recomputed here, by the merchant's own copy of the canonical form. If
      // the two sides disagree by a byte, this is where it shows up.
      expect(computeQuoteTermsHash(quote)).toBe(quote.terms_hash);
      expect(quoteInconsistency(quote)).toBeNull();
    }
  });
});

describe('quote storage', () => {
  test('round-trips through the database', () => {
    const { path, cleanup } = makeTempDatabasePath();
    const db = openTestDb(path);
    try {
      const quote = price('entry_latte');
      insertQuote(db, quote, 'caller_a');

      const stored = getStoredQuote(db, quote.quote_id);
      expect(stored?.quote).toEqual(quote);
      expect(stored?.callerId).toBe('caller_a');
      expect(stored?.expiresAtMs).toBe(Date.parse(quote.expires_at));
    } finally {
      db.close();
      cleanup();
    }
  });

  test('returns null for a quote it never stored', () => {
    const { path, cleanup } = makeTempDatabasePath();
    const db = openTestDb(path);
    try {
      // Not an error: a caller asking about an unknown quote gets a 404 later.
      expect(getStoredQuote(db, 'quote_nope')).toBeNull();
    } finally {
      db.close();
      cleanup();
    }
  });
});
