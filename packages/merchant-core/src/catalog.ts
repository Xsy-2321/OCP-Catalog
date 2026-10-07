/**
 * Reading the catalog: ingestion checks, keyword search, filters, and the
 * resolution that hands A the checkout entry point.
 *
 * The filters implemented here are exactly the ones the manifest declares, and
 * the manifest derives its `filterable_field_refs` from
 * `COFFEE_FILTER_MAP` in `@ocp-catalog/shopping-contracts`. That mapping is what
 * makes "the declared filters actually work" a checkable claim rather than a
 * promise: there is one object, and both the declaration and this handler read
 * it.
 *
 * A filter key that is valid in the protocol but not implemented here is NOT an
 * error. It is reported in `policy_summary.rejected_filters`, which is the
 * mechanism the protocol already provides for exactly this. Silently dropping
 * it would let a caller believe a filter was applied; rejecting the whole
 * request would break clients that send filters the merchant merely has not got
 * round to.
 */
import {
  catalogEntrySchema,
  catalogQueryFiltersSchema,
  type CatalogEntry,
  type CatalogQueryRequest,
  type ResolvableReference,
} from '@ocp-catalog/ocp-schema';
import {
  AUTH_SCHEME,
  CHECKOUT_ACTION_ID,
  CHECKOUT_ACTION_TYPE,
  CommerceError,
  IMPLEMENTED_QUERY_FILTER_KEYS,
  MoneyError,
  coffeeEntryAttributesSchema,
  coffeePriceInconsistency,
  yuanToMinor,
  type CoffeeEntryAttributes,
  type CoffeeQueryFilterKey,
} from '@ocp-catalog/shopping-contracts';
import { toIso } from './clock';
import type { MerchantConfig } from './config';

/** A catalog entry together with its validated demo attribute pack. */
export interface CatalogEntryRecord {
  readonly entry: CatalogEntry;
  readonly attributes: CoffeeEntryAttributes;
}

/**
 * Filter keys the protocol defines but this merchant does not implement,
 * derived from the schema rather than listed by hand — a hand-written list
 * would silently go stale the next time the protocol adds a filter.
 */
export const UNIMPLEMENTED_QUERY_FILTER_KEYS: readonly string[] = Object.keys(
  catalogQueryFiltersSchema.shape,
).filter((key) => !IMPLEMENTED_QUERY_FILTER_KEYS.has(key as CoffeeQueryFilterKey));

/**
 * Returns the reason a stock level contradicts itself, or `null`.
 *
 * `availability_status` and `quantity` are two statements about the same fact
 * and the demo relies on reading only the status. That is safe as long as the
 * two cannot disagree; `entry` claiming `in_stock` with a quantity of zero is
 * an ingestion bug of the same family as a price that does not match its minor
 * representation, and it is caught where the data is loaded rather than where a
 * customer is told the coffee is available.
 */
export function catalogStockInconsistency(attributes: CoffeeEntryAttributes): string | null {
  const { availability_status: status, quantity } = attributes.inventory;
  if (quantity === undefined) return null;
  if (status === 'out_of_stock' && quantity !== 0) {
    return `availability_status is out_of_stock but quantity is ${quantity}`;
  }
  if (status !== 'out_of_stock' && quantity === 0) {
    return `availability_status is ${status} but quantity is 0`;
  }
  return null;
}

/** True when the entry can be bought right now. */
export function isPurchasable(record: CatalogEntryRecord): boolean {
  return record.attributes.inventory.availability_status !== 'out_of_stock';
}

/**
 * Validates the raw catalog at startup.
 *
 * Throws rather than skipping a bad record: a catalog that quietly drops an
 * entry looks exactly like an entry that is out of stock, and the difference
 * matters to whoever is wondering why their drink disappeared from the menu.
 */
export function loadCatalog(raw: readonly unknown[]): readonly CatalogEntryRecord[] {
  const records = raw.map((item) => {
    const entry = catalogEntrySchema.parse(item);
    const parsed = coffeeEntryAttributesSchema.safeParse(entry.attributes);
    if (!parsed.success) {
      throw new Error(`catalog entry ${entry.entry_id}: invalid demo attributes: ${parsed.error.message}`);
    }
    const priceProblem = coffeePriceInconsistency(parsed.data);
    if (priceProblem !== null) {
      throw new Error(`catalog entry ${entry.entry_id}: ${priceProblem}`);
    }
    const stockProblem = catalogStockInconsistency(parsed.data);
    if (stockProblem !== null) {
      throw new Error(`catalog entry ${entry.entry_id}: ${stockProblem}`);
    }
    return { entry, attributes: parsed.data };
  });

  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.entry.entry_id)) {
      throw new Error(`duplicate catalog entry_id: ${record.entry.entry_id}`);
    }
    ids.add(record.entry.entry_id);
  }
  return records;
}

export function findEntry(
  catalog: readonly CatalogEntryRecord[],
  entryId: string,
): CatalogEntryRecord | null {
  return catalog.find((record) => record.entry.entry_id === entryId) ?? null;
}

/** Converts a decimal major-unit filter bound to minor units, as a 400 on failure. */
function filterBoundToMinor(value: number, key: string): number {
  try {
    return yuanToMinor(value, key);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new CommerceError('invalid_request', `filter ${key}: ${error.message}`, { filter: key });
    }
    throw error;
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new CommerceError('invalid_request', `cursor must be a decimal offset, got ${JSON.stringify(cursor)}`);
  }
  return Number(cursor);
}

export interface CatalogQueryOutcome {
  readonly matches: readonly CatalogEntryRecord[];
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | undefined;
  readonly acceptedFilters: readonly string[];
  readonly rejectedFilters: readonly string[];
}

export function runCatalogQuery(
  catalog: readonly CatalogEntryRecord[],
  request: CatalogQueryRequest,
): CatalogQueryOutcome {
  const filters = request.filters;
  const predicates: Array<(record: CatalogEntryRecord) => boolean> = [];
  const acceptedFilters: string[] = [];

  if (filters.category !== undefined) {
    const wanted = filters.category;
    acceptedFilters.push('category');
    predicates.push((record) => record.attributes.category === wanted);
  }
  if (filters.brand !== undefined) {
    const wanted = filters.brand;
    acceptedFilters.push('brand');
    predicates.push((record) => record.attributes.brand === wanted);
  }
  if (filters.currency !== undefined) {
    const wanted = filters.currency;
    acceptedFilters.push('currency');
    predicates.push((record) => record.attributes.price.currency === wanted);
  }
  if (filters.min_amount !== undefined) {
    // Compared in minor units so that "9.9" and 990 fen cannot disagree by a
    // rounding step somewhere in the middle.
    const min = filterBoundToMinor(filters.min_amount, 'min_amount');
    acceptedFilters.push('min_amount');
    predicates.push((record) => record.attributes.price_minor >= min);
  }
  if (filters.max_amount !== undefined) {
    const max = filterBoundToMinor(filters.max_amount, 'max_amount');
    acceptedFilters.push('max_amount');
    predicates.push((record) => record.attributes.price_minor <= max);
  }
  if (filters.availability_status !== undefined) {
    const wanted = filters.availability_status;
    acceptedFilters.push('availability_status');
    predicates.push((record) => record.attributes.inventory.availability_status === wanted);
  }
  if (filters.in_stock_only !== undefined) {
    acceptedFilters.push('in_stock_only');
    if (filters.in_stock_only) predicates.push(isPurchasable);
  }

  const rejectedFilters: string[] = [];
  for (const key of UNIMPLEMENTED_QUERY_FILTER_KEYS) {
    if ((filters as Record<string, unknown>)[key] !== undefined) rejectedFilters.push(key);
  }

  const term = request.query.trim().toLowerCase();
  const matches = catalog.filter((record) => predicates.every((predicate) => predicate(record)));
  const filtered = term === ''
    ? matches
    : matches.filter((record) => searchableText(record).some((field) => field.toLowerCase().includes(term)));

  const offset = parseCursor(request.cursor);
  const limit = request.limit;
  const page = filtered.slice(offset, offset + limit);
  const hasMore = offset + page.length < filtered.length;

  return {
    matches: page,
    limit,
    offset,
    hasMore,
    nextCursor: hasMore ? String(offset + page.length) : undefined,
    acceptedFilters,
    rejectedFilters,
  };
}

/** The fields a keyword search looks at, mirroring the declared searchable refs. */
function searchableText(record: CatalogEntryRecord): string[] {
  const fields = [record.entry.title, record.entry.summary ?? '', record.attributes.brand ?? '', record.attributes.category ?? ''];
  return fields.filter((field) => field !== '');
}

/** Relevance for one entry. Title hits outrank body hits; there is no other scale. */
export function scoreEntry(record: CatalogEntryRecord, query: string): number {
  const term = query.trim().toLowerCase();
  if (term === '') return 1;
  return record.entry.title.toLowerCase().includes(term) ? 1 : 0.5;
}

export function explainEntry(record: CatalogEntryRecord, query: string): string[] {
  const term = query.trim().toLowerCase();
  if (term === '') return ['No keyword given; every catalog entry matches.'];
  const fields = searchableText(record);
  const hits = fields.filter((field) => field.toLowerCase().includes(term));
  return hits.length === 0
    ? ['Matched a filter without a keyword hit.']
    : [`Keyword "${query.trim()}" matched: ${hits.join(', ')}.`];
}

export interface ResolveOptions {
  readonly config: MerchantConfig;
  readonly nowMs: number;
}

/**
 * Builds the resolution A reads the checkout entry point out of.
 *
 * A never constructs the checkout URL. It takes it from here, which is what
 * lets it accept an action only from a merchant whose origin it already trusts
 * — a URL assembled by the caller could point anywhere.
 */
export function buildResolvableReference(
  record: CatalogEntryRecord,
  options: ResolveOptions,
): ResolvableReference {
  const { config, nowMs } = options;
  const { entry, attributes } = record;
  const now = toIso(nowMs);
  const expiresAt = toIso(nowMs + config.quoteTtlSeconds * 1000);
  const keyIds = [...config.trustedKeys.keys()].sort();

  return {
    ocp_version: '1.0',
    kind: 'ResolvableReference',
    id: `res_${entry.entry_id}`,
    catalog_id: config.catalogId,
    entry_id: entry.entry_id,
    commercial_object_id: `co_${entry.entry_id}`,
    object_id: entry.object_id,
    object_type: entry.object_type ?? 'ocp.commerce.product',
    provider_id: entry.provider_id,
    title: entry.title,
    visible_attributes: {
      brand: attributes.brand ?? null,
      category: attributes.category ?? null,
      price: { currency: attributes.price.currency, amount: attributes.price.amount },
      price_minor: attributes.price_minor,
      availability_status: attributes.inventory.availability_status,
      fulfillment: attributes.fulfillment,
    },
    access: {
      visibility: 'public',
      permission_state: 'granted',
      redacted_fields: [],
      policy_notes: [],
    },
    live_checks: [
      {
        check_id: `lc_${entry.entry_id}`,
        status: 'passed',
        checked_at: now,
        summary: 'Price and stock read from the merchant catalog.',
        details: {},
      },
    ],
    action_bindings: [
      {
        action_id: 'view',
        action_type: 'url',
        label: '打开商品页',
        entrypoint: { url: `${config.publicBaseUrl}/products/${entry.entry_id}`, method: 'GET' },
        auth_requirements: {},
        requires_user_confirmation: false,
      },
      {
        action_id: CHECKOUT_ACTION_ID,
        action_type: CHECKOUT_ACTION_TYPE,
        label: '结账',
        description: '提交报价与用户授权证明，发起一次购买尝试。',
        entrypoint: { url: `${config.publicBaseUrl}/commerce/v1/checkouts`, method: 'POST' },
        input_schema: {
          required: ['purchase_attempt_id', 'quote_id', 'terms_hash', 'authorization'],
          headers: {
            'idempotency-key': 'stable across retries of the same logical purchase',
            'x-dev-caller-id': 'local development caller identity — not an account system',
          },
        },
        // With no trusted key configured the merchant advertises none: it would
        // reject every proof anyway, and saying otherwise would invite A to
        // start a purchase it cannot finish.
        auth_requirements: keyIds.length === 0 ? {} : { scheme: AUTH_SCHEME, key_id: keyIds[0] },
        requires_user_confirmation: true,
        expires_at: expiresAt,
      },
    ],
    freshness: { object_updated_at: now, resolved_at: now },
    expires_at: expiresAt,
  };
}
