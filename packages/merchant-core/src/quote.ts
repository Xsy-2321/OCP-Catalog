/**
 * Building and storing quotes.
 *
 * A quote is the merchant's final, all-in price. Two properties carry more
 * weight than the field list:
 *
 *   - `total_minor` includes every fee, and it is what the budget check runs
 *     against. A ¥25 latte that looks affordable plus a ¥5 delivery fee that
 *     does not is still over budget; checking the item price instead of the
 *     total is how a purchase fails at the till.
 *   - `terms_hash` is computed here and stored here. The client echoes it back
 *     at checkout and B recomputes it from its own record. A client-reported
 *     total is an input to be checked, never a fact.
 *
 * A quote does not reserve stock. Reserving would make an abandoned quote hold
 * a cup of coffee hostage until it expired, and the concurrency case the demo
 * cares about — the last unit selling between quote and checkout — is exactly
 * the one a reservation would hide.
 */
import type { Database } from 'bun:sqlite';
import {
  CommerceError,
  buildQuoteTerms,
  computeQuoteTermsHash,
  newQuoteId,
  quoteInconsistency,
  quoteSchema,
  assertMinorAmount,
  createQuoteRequestSchema,
  quoteRequestItems,
  type CreateQuoteRequest,
  type Quote,
} from '@ocp-catalog/shopping-contracts';
import { toIso } from './clock';
import type { MerchantConfig } from './config';
import { isPurchasable, type CatalogEntryRecord } from './catalog';

export interface BuildQuoteOptions {
  readonly config: MerchantConfig;
  readonly nowMs: number;
}

/**
 * Prices one selection and freezes it into a quote.
 *
 * Every rejection here happens before a hash is computed, because a quote that
 * cannot be fulfilled must not exist: A holds `terms_hash` from the moment it
 * receives one, and an unusable quote that produced a hash is an invitation to
 * sign an authorization over nothing.
 */
export function buildQuote(
  record: CatalogEntryRecord | readonly CatalogEntryRecord[],
  request: CreateQuoteRequest,
  options: BuildQuoteOptions,
): Quote {
  const { config, nowMs } = options;
  const parsed = createQuoteRequestSchema.safeParse(request);
  if (!parsed.success) throw new CommerceError('invalid_request', 'invalid quote items or fulfillment');
  request = parsed.data;
  const records = Array.isArray(record) ? record : [record as CatalogEntryRecord];
  const selections = quoteRequestItems(request).map(item => {
    const selected = records.find(value => value.entry.entry_id === item.entry_id);
    if (!selected) throw new CommerceError('not_found', `unknown entry_id: ${item.entry_id}`);
    return { record: selected, quantity: item.quantity };
  });
  const requestedLocation = request.fulfillment.location_id;
  if (requestedLocation !== undefined && requestedLocation !== config.locationId) {
    throw new CommerceError('invalid_request', `unknown fulfillment location ${requestedLocation}`, {
      location_id: requestedLocation,
    });
  }

  const currency = selections[0]!.record.attributes.price.currency;
  const items = selections.map(({ record: selected, quantity }) => {
    const { attributes } = selected;
    if (attributes.price.currency !== currency) throw new CommerceError('invalid_request', 'all quote items must use the same currency');
    if (!attributes.fulfillment.methods.includes(request.fulfillment.method)) {
      throw new CommerceError('invalid_request', `entry ${selected.entry.entry_id} does not offer ${request.fulfillment.method}`,
        { entry_id: selected.entry.entry_id, supported: attributes.fulfillment.methods });
    }
    const available = attributes.inventory.quantity;
    if (!isPurchasable(selected) || (available !== undefined && available < quantity)) {
      throw new CommerceError('out_of_stock', `entry ${selected.entry.entry_id} has ${available ?? 'no'} units left, ${quantity} requested`,
        { entry_id: selected.entry.entry_id, available: available ?? 0, requested: quantity });
    }
    const lineTotalMinor = attributes.price_minor * quantity;
    if (!Number.isSafeInteger(lineTotalMinor)) throw new CommerceError('invalid_request', 'quote total exceeds the safe integer minor-unit range');
    return { entry_id: selected.entry.entry_id, title: selected.entry.title, quantity,
      unit_minor: attributes.price_minor, line_total_minor: lineTotalMinor };
  });
  const deliveryFees = selections.flatMap(({ record: selected }) => selected.attributes.fulfillment.delivery_fee_minor === undefined
    ? [] : [selected.attributes.fulfillment.delivery_fee_minor]);
  const fees =
    request.fulfillment.method === 'delivery' && deliveryFees.length > 0
      ? [
          {
            code: 'delivery',
            label: '配送费',
            amount_minor: Math.max(...deliveryFees),
          },
        ]
      : [];
  const subtotalMinor = items.reduce((sum, item) => sum + item.line_total_minor, 0);
  const totalMinor = subtotalMinor + fees.reduce((sum, fee) => sum + fee.amount_minor, 0);

  if (!Number.isSafeInteger(subtotalMinor) || !Number.isSafeInteger(totalMinor)) {
    throw new CommerceError('invalid_request', 'quote total exceeds the safe integer minor-unit range');
  }
  assertMinorAmount(totalMinor, 'total_minor');

  const draft: Omit<Quote, 'terms_hash'> = {
    quote_id: newQuoteId(),
    merchant_id: config.merchantId,
    catalog_id: config.catalogId,
    currency,
    items,
    fees,
    subtotal_minor: subtotalMinor,
    total_minor: totalMinor,
    fulfillment: request.fulfillment,
    created_at: toIso(nowMs),
    expires_at: toIso(nowMs + config.quoteTtlSeconds * 1000),
  };

  const quote: Quote = { ...draft, terms_hash: computeQuoteTermsHash(draft) };

  // A self-check, not a validation of client input. If this ever fires the bug
  // is in the arithmetic above, and a wrong total is the kind of defect that is
  // invisible until money has moved.
  const problem = quoteInconsistency(quote);
  if (problem !== null) {
    throw new Error(`internal: built an inconsistent quote: ${problem}`);
  }
  if (buildQuoteTerms(quote).total_minor !== quote.total_minor) {
    throw new Error('internal: terms and quote disagree about the total');
  }

  return quote;
}

export interface StoredQuote {
  readonly quote: Quote;
  readonly callerId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export function insertQuote(db: Database, quote: Quote, callerId: string): void {
  db.query(
    `INSERT INTO quotes (quote_id, caller_id, merchant_id, catalog_id, currency, terms_hash, quote_json, created_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    quote.quote_id,
    callerId,
    quote.merchant_id,
    quote.catalog_id,
    quote.currency,
    quote.terms_hash,
    JSON.stringify(quote),
    Date.parse(quote.created_at),
    Date.parse(quote.expires_at),
  );
}

interface QuoteRow {
  quote_id: string;
  caller_id: string;
  quote_json: string;
}

export function getStoredQuote(db: Database, quoteId: string): StoredQuote | null {
  const row = db
    .query<QuoteRow, [string]>('SELECT quote_id, caller_id, quote_json FROM quotes WHERE quote_id = ?')
    .get(quoteId);
  if (row === null) return null;
  const quote = quoteSchema.parse(JSON.parse(row.quote_json));
  const problem = quoteInconsistency(quote);
  if (problem !== null) throw new Error(`stored quote ${row.quote_id} is inconsistent: ${problem}`);
  return {
    quote,
    callerId: row.caller_id,
    createdAtMs: Date.parse(quote.created_at),
    expiresAtMs: Date.parse(quote.expires_at),
  };
}
