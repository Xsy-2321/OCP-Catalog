/**
 * The committed catalog and the served catalog must be the same menu.
 *
 * `fixtures/shopping/catalog.coffee.json` is what A develops against before this
 * server runs; `CATALOG_SEED` is what the server answers with. Two copies of the
 * same five drinks is exactly the shape of a bug that surfaces as "the demo
 * worked last week" — A quotes an entry the merchant no longer has, or the two
 * disagree about whether delivery costs ¥5.
 *
 * So the copy is asserted rather than trusted. If either side changes without
 * the other, this fails.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_SEED } from './data/catalog';
import { loadCatalog } from './catalog';

interface FixtureEntry {
  readonly _fixture_note?: string;
  readonly [key: string]: unknown;
}

function fixtureEntries(): unknown[] {
  const path = join(import.meta.dir, '../../../fixtures/shopping/catalog.coffee.json');
  const parsed: FixtureEntry[] = JSON.parse(readFileSync(path, 'utf8'));
  return parsed.map((entry) => {
    const { _fixture_note: _note, ...rest } = entry;
    return rest;
  });
}

describe('catalog data', () => {
  test('CATALOG_SEED equals the committed fixture, entry for entry', () => {
    expect(CATALOG_SEED).toEqual(fixtureEntries());
  });

  test('the fixture carries no entry id the seed does not', () => {
    const fixtureIds = fixtureEntries().map((entry) => (entry as { entry_id: string }).entry_id);
    const seedIds = CATALOG_SEED.map((entry) => entry.entry_id);

    expect(fixtureIds).toEqual(seedIds);
  });

  test('the seed survives its own ingestion guards', () => {
    // The same path startup takes. A seed that fails this would be a merchant
    // that cannot boot.
    expect(loadCatalog(CATALOG_SEED)).toHaveLength(5);
  });

  test('covers the four cases a caller has to handle', () => {
    const byId = new Map(CATALOG_SEED.map((entry) => [entry.entry_id, entry.attributes]));

    // Affordable, over budget, out of stock, and one unit left — the last of
    // which is the only way the concurrency boundary is reachable at all.
    expect(byId.get('entry_latte')?.price_minor).toBe(2500);
    expect(byId.get('entry_gift_box')?.price_minor).toBe(8800);
    expect(byId.get('entry_soldout')?.inventory.availability_status).toBe('out_of_stock');
    expect(byId.get('entry_cold_brew')?.inventory.quantity).toBe(1);
  });
});
