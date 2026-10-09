/**
 * The things every merchant operation needs, passed as one object.
 *
 * Grouping them means a route handler takes a single argument instead of three,
 * and — more usefully — that a test can build a whole merchant with one call
 * (`createMerchantContext`) rather than reconstructing the wiring by hand and
 * gradually drifting from what production does.
 */
import type { Database } from 'bun:sqlite';
import type { Clock } from './clock';
import type { MerchantConfig } from './config';
import type { CatalogEntryRecord } from './catalog';

export interface MerchantContext {
  readonly config: MerchantConfig;
  readonly db: Database;
  readonly clock: Clock;
  readonly catalog: readonly CatalogEntryRecord[];
}
