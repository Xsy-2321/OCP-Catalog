/**
 * The property worth testing here is not any single number but the *pairing* of
 * the two: a deadline is accepted only if the socket is configured to outlive it
 * by the full headroom. Get that wrong in the accepting direction and a slow
 * checkout is hung up on where the contract promises `202` — a failure that
 * looks like the network rather than like configuration, which is why the
 * boundary is swept rather than spot-checked.
 */
import { describe, expect, test } from 'bun:test';

import {
  IDLE_TIMEOUT_HEADROOM_S,
  IDLE_TIMEOUT_MAX_S,
  MAX_DEADLINE_WITH_HEADROOM_MS,
  deadlineProblem,
  idleTimeoutSeconds,
} from './deadline';

describe('deadline tolerance', () => {
  test('accepts exactly up to the limit and refuses one millisecond past it', () => {
    expect(deadlineProblem(MAX_DEADLINE_WITH_HEADROOM_MS)).toBeNull();
    expect(deadlineProblem(MAX_DEADLINE_WITH_HEADROOM_MS + 1)).not.toBeNull();
  });

  test('every accepted deadline is outlived by the socket, with the full headroom', () => {
    // 997 is prime, so the sweep does not land on the same residues as the
    // second-boundaries the arithmetic rounds on.
    let accepted = 0;
    for (let deadlineMs = 1; deadlineMs <= 400_000; deadlineMs += 997) {
      if (deadlineProblem(deadlineMs) !== null) continue;
      accepted += 1;
      const waitedMs = idleTimeoutSeconds(deadlineMs) * 1000;
      expect(waitedMs).toBeGreaterThan(deadlineMs);
      expect(waitedMs - deadlineMs).toBeGreaterThanOrEqual(IDLE_TIMEOUT_HEADROOM_S * 1000);
    }
    expect(accepted).toBeGreaterThan(200);
  });

  test('refuses every deadline past the limit', () => {
    for (let deadlineMs = MAX_DEADLINE_WITH_HEADROOM_MS + 1; deadlineMs <= 400_000; deadlineMs += 997) {
      expect(deadlineProblem(deadlineMs)).not.toBeNull();
    }
  });

  test('never asks for more time than Bun allows', () => {
    for (const deadlineMs of [1, 5_000, 100_000, MAX_DEADLINE_WITH_HEADROOM_MS, 400_000]) {
      expect(idleTimeoutSeconds(deadlineMs)).toBeLessThanOrEqual(IDLE_TIMEOUT_MAX_S);
    }
  });

  test('the shipped default keeps 30s of headroom over a 5s settlement', () => {
    expect(idleTimeoutSeconds(5_000)).toBe(35);
    expect(deadlineProblem(5_000)).toBeNull();
  });

  test('the refusal names both the value and the limit it broke', () => {
    const message = deadlineProblem(MAX_DEADLINE_WITH_HEADROOM_MS + 1);
    expect(message).toContain(String(MAX_DEADLINE_WITH_HEADROOM_MS + 1));
    expect(message).toContain(String(MAX_DEADLINE_WITH_HEADROOM_MS));
  });
});
