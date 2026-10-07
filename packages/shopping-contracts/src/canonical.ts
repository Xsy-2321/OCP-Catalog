/**
 * Canonical JSON serialization, shared by the terms hash and the authorization
 * signing payload.
 *
 * Two independently written implementations of "the bytes we hash" will drift,
 * and the drift is invisible until a signature or a hash mysteriously fails to
 * verify. So the rule lives here once and both sides call it. The rule is
 * deliberately boring:
 *
 *   - object keys sorted lexicographically by code unit
 *   - no insignificant whitespace
 *   - arrays keep the order they were given
 *   - `undefined` properties are dropped
 *   - encoded as UTF-8 at the byte boundary
 *
 * This is NOT RFC 8785. Numbers are serialized by the host's `JSON.stringify`,
 * which is stable for the integers this contract uses — and that is exactly why
 * every signed or hashed structure here forbids non-integer numbers. A float
 * could serialize as `0.1` on one runtime and `0.10000000000000001` on another.
 */

/** Returns `value` with every object level key-sorted, leaving arrays in order. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      sorted[key] = sortValue(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * Serializes a value to canonical JSON.
 *
 * Throws for values that JSON cannot represent at the top level (such as a bare
 * `undefined`), because silently returning `undefined` from a function typed as
 * `string` would push the failure somewhere far away from the cause.
 */
export function canonicalJson(value: unknown): string {
  const json: string | undefined = JSON.stringify(sortValue(value));
  if (json === undefined) {
    throw new TypeError('canonicalJson requires a JSON-serializable value');
  }
  return json;
}

/** Canonical JSON encoded as UTF-8 bytes — the exact bytes to hash or sign. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
