/**
 * The authorization proof: how A proves the user approved *this* purchase.
 *
 * A holds the signing private key; B holds only public keys, selected by
 * `key_id` from B's own configuration. A public key arriving in the request is
 * never a source of trust — accepting one would let any caller sign its own
 * permission. Nothing else counts as authorization either: not `approved: true`,
 * not a model's prose, not an `approval_id` string.
 *
 * Timestamps are Unix **seconds**, integers, on purpose. Every signed structure
 * here must contain only integers, because a float can serialize differently
 * across runtimes and silently change the signed bytes (see canonical.ts).
 */
import { z } from 'zod';
import { canonicalBytes } from './canonical';
import { AUTH_DOMAIN, AUTH_SCHEME } from './version';

/**
 * The fields that are actually signed.
 *
 * `purchase_attempt_id` is inside the signed payload rather than beside it. That
 * is what scopes a proof to a single purchase attempt: replaying a valid proof
 * under a different attempt id changes the signed bytes, so verification fails.
 */
export const authorizationSignedPayloadSchema = z
  .object({
    v: z.literal(AUTH_DOMAIN),
    issuer: z.string().min(1),
    user_id: z.string().min(1),
    merchant_id: z.string().min(1),
    quote_id: z.string().min(1),
    terms_hash: z.string().regex(/^[0-9a-f]{64}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    max_total_minor: z.number().int().nonnegative(),
    purchase_attempt_id: z.string().min(1),
    issued_at: z.number().int().nonnegative(),
    expires_at: z.number().int().nonnegative(),
    jti: z.string().min(1),
  })
  .strict();

export type AuthorizationSignedPayload = z.infer<typeof authorizationSignedPayloadSchema>;

/**
 * The proof as it travels on the wire.
 *
 * `scheme`, `key_id` and `signature` sit outside `payload` deliberately: the
 * bytes signed are exactly `canonicalJson(payload)`, so there is no ambiguity
 * about which fields the signature covers.
 */
export const authorizationProofSchema = z
  .object({
    scheme: z.literal(AUTH_SCHEME),
    key_id: z.string().min(1),
    /** Detached Ed25519 signature over `canonicalJson(payload)`, base64url. */
    signature: z.string().min(1),
    payload: authorizationSignedPayloadSchema,
  })
  .strict();

export type AuthorizationProof = z.infer<typeof authorizationProofSchema>;

/** The exact bytes an issuer signs and a verifier checks. */
export function authorizationSigningBytes(payload: AuthorizationSignedPayload): Uint8Array {
  return canonicalBytes(payload);
}

/** True once the proof's own expiry has passed. */
export function isAuthorizationExpired(
  payload: AuthorizationSignedPayload,
  nowSeconds: number,
): boolean {
  return nowSeconds >= payload.expires_at;
}

/** True if the proof's window is malformed (expiry at or before issue time). */
export function isAuthorizationWindowInvalid(payload: AuthorizationSignedPayload): boolean {
  return payload.expires_at <= payload.issued_at;
}
