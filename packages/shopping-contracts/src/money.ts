/**
 * Money helpers for the demo commerce contracts.
 *
 * New commerce amounts are ALWAYS integer minor units, carried in fields named
 * `*_minor`. For CNY the minor unit is the fen, so 30 yuan is `3000`.
 *
 * The existing OCP catalog price keeps its own contract: `price.amount` stays a
 * decimal major-unit number so the protocol packages are unaffected. The two
 * representations meet only at the catalog boundary, and that conversion is
 * deliberately strict — a value carrying more precision than the minor unit can
 * express is an error, never a silent rounding. Rounding quietly would let the
 * displayed price and the quoted price drift apart with nothing to catch it.
 */

/** Minor units per major unit for the demo currencies (CNY: 1 yuan = 100 fen). */
export const MINOR_UNITS_PER_MAJOR = 100;

/** Currencies this demo supports. */
export const SUPPORTED_CURRENCIES = ['CNY'] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** Raised when a decimal amount cannot be represented exactly in minor units. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Upper bound on the representation error tolerated when scaling by 100.
 *
 * IEEE-754 cannot represent most decimal fractions exactly, so `0.29 * 100` is
 * `28.999999999999996` rather than `29`. That is a representation artifact, not
 * a precision loss, and must not be rejected. A genuine third decimal place,
 * however, is always orders of magnitude larger than this bound.
 */
const SCALING_EPSILON = 1e-6;

/** Asserts a value is a non-negative safe integer, returning it unchanged. */
export function assertMinorAmount(value: number, label = 'amount'): number {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of minor units, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} is outside the safe integer range: ${value}`);
  }
  if (value < 0) {
    throw new MoneyError(`${label} must not be negative, got ${value}`);
  }
  return value;
}

/**
 * Converts a decimal major-unit amount (yuan) to integer minor units (fen).
 *
 * Throws rather than rounding when the input carries more than two decimal
 * places, so a price of `25.005` fails loudly instead of silently becoming
 * either `2500` or `2501`.
 */
export function yuanToMinor(amount: number, label = 'amount'): number {
  if (!Number.isFinite(amount)) {
    throw new MoneyError(`${label} must be a finite number, got ${amount}`);
  }
  if (amount < 0) {
    throw new MoneyError(`${label} must not be negative, got ${amount}`);
  }
  const scaled = amount * MINOR_UNITS_PER_MAJOR;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > SCALING_EPSILON) {
    throw new MoneyError(
      `${label} ${amount} has more precision than ${MINOR_UNITS_PER_MAJOR} minor units can express`,
    );
  }
  return assertMinorAmount(rounded, label);
}

/** Converts integer minor units (fen) back to a decimal major-unit amount (yuan). */
export function minorToYuan(minor: number, label = 'amount_minor'): number {
  return assertMinorAmount(minor, label) / MINOR_UNITS_PER_MAJOR;
}

/** Sums minor amounts, rejecting anything that is not a safe integer. */
export function sumMinor(values: readonly number[], label = 'amount_minor'): number {
  let total = 0;
  for (const value of values) {
    total += assertMinorAmount(value, label);
  }
  return total;
}
