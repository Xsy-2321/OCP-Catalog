/**
 * Identifier helpers for the demo commerce contracts.
 *
 * Prefixes are part of the contract: they make an id self-describing in logs and
 * in fixtures, and they let a caller spot a copy-paste error (an order id handed
 * to an attempt endpoint) before it becomes a confusing 404.
 */

/** Prefixes for every identifier in the shopping demo contract. */
export const ID_PREFIXES = {
  purchaseIntent: 'pi',
  quote: 'quote',
  purchaseAttempt: 'att',
  order: 'ord',
  event: 'evt',
  authorizationJti: 'jti',
} as const;

const mint = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

/** A `pi_…` id. Created and persisted by A (the user side). */
export const newPurchaseIntentId = (): string => mint(ID_PREFIXES.purchaseIntent);

/** A `quote_…` id. Minted by B and returned from the quote endpoint. */
export const newQuoteId = (): string => mint(ID_PREFIXES.quote);

/**
 * An `att_…` id for one logical purchase attempt.
 *
 * A generates this before calling Checkout and reuses it across retries, so it
 * is stable for the life of a single logical purchase.
 */
export const newPurchaseAttemptId = (): string => mint(ID_PREFIXES.purchaseAttempt);

/** An `ord_…` id. Minted by B only after a verified payment result. */
export const newOrderId = (): string => mint(ID_PREFIXES.order);

/** An `evt_…` id for an appended purchase event. */
export const newPurchaseEventId = (): string => mint(ID_PREFIXES.event);

/** A `jti_…` id used to make each authorization proof single-use. */
export const newAuthorizationJti = (): string => mint(ID_PREFIXES.authorizationJti);
