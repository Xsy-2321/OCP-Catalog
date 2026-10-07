/**
 * The failure-injection catalogue (contract §10 D9).
 *
 * These exist because the interesting paths in a purchase flow are the ones a
 * happy-path demo never reaches: a payment that timed out, a price that moved
 * between the quote and the till, a response that never arrived after the money
 * did. Without a way to force them, those branches are written once and never
 * executed.
 *
 * Every name here is reachable ONLY when `MERCHANT_TEST_MODE=1`. In any other
 * configuration a fault name is a configuration error, not a silently ignored
 * key — a demo that quietly ignored `MERCHANT_FAULTS` would let someone believe
 * a fault was exercised when the code path never ran.
 *
 * The names are mirrored by `fixtures/shopping/faults.json`; a test asserts the
 * two sets are equal so the fixture cannot document a fault that does not exist.
 */

export const MERCHANT_FAULTS = [
  'payment_timeout_then_succeed',
  'payment_declined',
  'price_raised_after_quote',
  'stock_exhausted_after_quote',
  'response_dropped_after_settlement',
] as const;

export type MerchantFault = (typeof MERCHANT_FAULTS)[number];

const KNOWN_FAULTS: ReadonlySet<string> = new Set<string>(MERCHANT_FAULTS);

export interface ParsedFaultList {
  /** Faults the caller asked for, in the order given, deduplicated. */
  readonly faults: readonly MerchantFault[];
  /** Names that are not part of the catalogue. Never ignored. */
  readonly unknown: readonly string[];
}

/**
 * Parses a comma-separated fault list.
 *
 * Returns unknown names rather than throwing so the caller can report all of
 * them at once alongside its other configuration problems, instead of failing
 * on whichever one happened to be first.
 */
export function parseFaultList(raw: string | undefined): ParsedFaultList {
  const faults: MerchantFault[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const name = part.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    if (KNOWN_FAULTS.has(name)) {
      faults.push(name as MerchantFault);
    } else {
      unknown.push(name);
    }
  }
  return { faults, unknown };
}

/** True when `name` is enabled in this configuration. */
export function faultEnabled(faults: ReadonlySet<MerchantFault>, name: MerchantFault): boolean {
  return faults.has(name);
}
