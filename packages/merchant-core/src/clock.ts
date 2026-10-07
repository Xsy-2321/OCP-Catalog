/**
 * Time is injected rather than read from `Date.now()` at each call site.
 *
 * Two reasons, and only the second one is about testing. The first is that a
 * quote's expiry, an authorization's expiry and an order's timestamps must all
 * agree about what "now" is; scattering `Date.now()` through the call graph
 * means a long request can produce a quote that was already expired when it was
 * created. The second is that fault scenarios like "the quote expires between
 * quoting and checkout" are otherwise only reachable by sleeping.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

export interface ManualClock extends Clock {
  /** Moves the clock to an absolute instant. */
  set(ms: number): void;
  /** Moves the clock forward by `ms`. */
  advance(ms: number): void;
}

export function manualClock(startMs: number): ManualClock {
  let current = startMs;
  return {
    nowMs: () => current,
    set: (ms) => {
      current = ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

/**
 * ISO-8601 UTC, the format every timestamp field in the contract uses.
 *
 * `Date.prototype.toISOString` is the only producer, so a stored timestamp and
 * the one a caller echoes back are comparable as strings.
 */
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Whole seconds for a millisecond timestamp.
 *
 * The signed authorization payload uses Unix seconds because every field in a
 * signed structure must be an integer — see `canonical.ts` for why a float in a
 * signed payload is a portability bug rather than a style question.
 */
export function toSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}
