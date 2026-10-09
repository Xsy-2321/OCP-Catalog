/**
 * The socket's timeout budget, as arithmetic rather than as policy.
 *
 * These live apart from `server.ts` for one reason: the numbers decide whether a
 * slow checkout can answer `202` or gets hung up on first, and that is a
 * cross-file invariant. `config.ts` bounds the deadline but cannot know how long
 * a socket may stay open; only the pair together says whether the contract holds.
 * Keeping it here as plain numbers with no imports also makes the boundary
 * testable without opening a port or resolving another package — which matters,
 * because this package is not in the root workspace yet.
 */

/**
 * Headroom added on top of the settlement deadline before the socket gives up.
 *
 * A checkout may legitimately spend the whole `checkoutDeadlineMs` settling and
 * then answer `202 processing` — an unknown outcome, not a failure (contract §8
 * D6). If the socket timed out first the caller would see a dropped connection
 * instead, which is exactly the "looks like failure, is not failure" confusion
 * the contract exists to prevent.
 */
export const IDLE_TIMEOUT_HEADROOM_S = 30;

/** Bun rejects an idle timeout above this. */
export const IDLE_TIMEOUT_MAX_S = 255;

/**
 * The longest settlement deadline that still gets the full headroom above.
 *
 * The deadline only has to exceed the *ceiling* to break the contract, since
 * `idleTimeoutSeconds` would then clamp below it. But anything past this value
 * has already lost part of the headroom, and a demo whose settlement deadline is
 * measured in minutes is a misconfiguration rather than a use case worth serving
 * with a narrower margin — so the check refuses the whole band instead of
 * tracking the exact break point.
 */
export const MAX_DEADLINE_WITH_HEADROOM_MS =
  (IDLE_TIMEOUT_MAX_S - IDLE_TIMEOUT_HEADROOM_S) * 1000;

/**
 * How long the socket waits, in seconds, for a checkout that may settle for
 * `deadlineMs`.
 *
 * Callers should establish `deadlineProblem(deadlineMs) === null` first; the
 * `Math.min` is the ceiling being enforced, not a silent adjustment that keeps a
 * refused deadline working.
 */
export function idleTimeoutSeconds(deadlineMs: number): number {
  return Math.min(IDLE_TIMEOUT_MAX_S, Math.ceil(deadlineMs / 1000) + IDLE_TIMEOUT_HEADROOM_S);
}

/**
 * Why `deadlineMs` cannot be served, or `null` when it can.
 *
 * Returns a message rather than exiting, so the one place that ends the process
 * stays in `server.ts` and this stays callable from a test.
 */
export function deadlineProblem(deadlineMs: number): string | null {
  if (deadlineMs <= MAX_DEADLINE_WITH_HEADROOM_MS) return null;
  return (
    `MERCHANT_CHECKOUT_DEADLINE_MS is ${deadlineMs}ms, above the ` +
    `${MAX_DEADLINE_WITH_HEADROOM_MS}ms this server can serve.\n\n` +
    `Bun caps a socket's idle timeout at ${IDLE_TIMEOUT_MAX_S}s, so a settlement allowed to ` +
    'run longer would be hung up on before it could answer: the caller would see a dropped ' +
    'connection where the contract promises 202 processing.'
  );
}
