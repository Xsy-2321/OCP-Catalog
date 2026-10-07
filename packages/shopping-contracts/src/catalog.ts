/**
 * The attribute pack the demo coffee merchant puts on its catalog entries.
 *
 * This is a demo extension, not an OCP object contract. It reuses the existing
 * OCP `price` and `inventory` packs verbatim so the customer side can read the
 * price and stock with the schemas it already has, and adds the demo's own
 * fields alongside them.
 *
 * The one field worth explaining is `price_minor`. The OCP pack keeps `amount`
 * as a decimal major-unit number, and that contract is not ours to change. But
 * every amount that flows through a quote is an integer minor unit, so the
 * catalog carries both: `price` for OCP compatibility, `price_minor` for the
 * commerce flow. They are converted once, at ingestion, by `yuanToMinor` — and
 * if the two ever disagree, that is a bug in ingestion, not a rounding question.
 */
import { catalogQueryFiltersSchema, inventoryPackSchema, pricePackSchema } from '@ocp-catalog/ocp-schema';
import { z } from 'zod';
import { fulfillmentMethodSchema } from './terms';

/**
 * The `action_type` on the Resolve binding that points at the checkout endpoint.
 *
 * A obtains the checkout URL from Resolve rather than building it, and only
 * talks to an origin it already trusts. `api` distinguishes this binding from a
 * plain `url` binding that just opens a product page.
 */
export const CHECKOUT_ACTION_TYPE = 'api';

/** The action id the checkout binding is published under. */
export const CHECKOUT_ACTION_ID = 'checkout';

export const coffeeEntryAttributesSchema = z
  .object({
    brand: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    /** Existing OCP price pack — decimal major units, unchanged. */
    price: pricePackSchema,
    /** The same price in integer minor units, for the commerce flow. */
    price_minor: z.number().int().nonnegative(),
    /** Existing OCP inventory pack. */
    inventory: inventoryPackSchema,
    fulfillment: z
      .object({
        methods: z.array(fulfillmentMethodSchema).min(1),
        /** Present when delivery is offered. */
        delivery_fee_minor: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

export type CoffeeEntryAttributes = z.infer<typeof coffeeEntryAttributesSchema>;

/**
 * Returns the reason the two price representations disagree, or `null`.
 *
 * Called at catalog ingestion so a mismatch surfaces when the data is loaded,
 * not when a customer is quoted a price the merchant will not honour.
 */
export function coffeePriceInconsistency(attributes: CoffeeEntryAttributes): string | null {
  const fromDecimal = Math.round(attributes.price.amount * 100);
  if (fromDecimal !== attributes.price_minor) {
    return `price.amount ${attributes.price.amount} (${fromDecimal} minor) != price_minor ${attributes.price_minor}`;
  }
  return null;
}

/**
 * The exact set of query filters the coffee merchant promises to honour.
 *
 * These are keys of `catalogQueryFiltersSchema`, which is a **closed, strict**
 * set defined by the OCP protocol — the merchant does not get to invent filter
 * names, and sending an undeclared one is a hard validation error rather than a
 * silently ignored key. So the merchant's job is not to define filters but to
 * choose a subset and implement it honestly.
 */
export const COFFEE_QUERY_FILTER_KEYS = [
  'category',
  'brand',
  'currency',
  'min_amount',
  'max_amount',
  'availability_status',
  'in_stock_only',
] as const;

export type CoffeeQueryFilterKey = (typeof COFFEE_QUERY_FILTER_KEYS)[number];

/**
 * Maps each declared `filterable_field_ref` to the wire filters that implement it.
 *
 * This exists because the manifest and the query request speak two different
 * vocabularies: the manifest declares field *paths* (`price#/amount`), while a
 * query sends flat *keys* (`max_amount`). Nothing derives one from the other,
 * so without an explicit table the manifest can declare a filter the server
 * never reads — and the acceptance criterion "declared filters actually work"
 * becomes unverifiable.
 *
 * Phase 2's query handler reads this map rather than listing filters a second
 * time, and the manifest fixture declares exactly its keys. That makes the
 * declaration and the implementation the same object.
 */
export const COFFEE_FILTER_MAP: Record<string, readonly CoffeeQueryFilterKey[]> = {
  'product.core#/category': ['category'],
  'product.core#/brand': ['brand'],
  'price#/currency': ['currency'],
  'price#/amount': ['min_amount', 'max_amount'],
  'inventory#/availability_status': ['availability_status', 'in_stock_only'],
};

/** Every wire filter key the merchant implements, derived from the map above. */
export const IMPLEMENTED_QUERY_FILTER_KEYS: ReadonlySet<CoffeeQueryFilterKey> = new Set(
  Object.values(COFFEE_FILTER_MAP).flat(),
);

/** The `filterable_field_refs` the manifest must declare — no more, no less. */
export const EXPECTED_FILTERABLE_FIELD_REFS: readonly string[] = Object.keys(COFFEE_FILTER_MAP);

/**
 * Guards against the map drifting away from the protocol schema.
 *
 * If an upstream OCP release renames or removes one of these keys, the merchant
 * must find out at the typecheck/test boundary rather than at runtime, where the
 * symptom would be a query filter that silently does nothing.
 */
export function unimplementableFilterKeys(): CoffeeQueryFilterKey[] {
  return COFFEE_QUERY_FILTER_KEYS.filter((key) => !(key in catalogQueryFiltersSchema.shape));
}
