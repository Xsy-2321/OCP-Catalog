/**
 * Verifying the authorization proof.
 *
 * A holds the signing key; B holds only public keys, selected by `key_id` from
 * its own configuration. A public key that arrives in the request is never a
 * source of trust — accepting one would mean any caller could sign its own
 * permission, which is the same as having no permission check at all.
 *
 * Seven checks run, and each one is independent: a proof that fails the
 * signature check must not be reported as "merchant mismatch" merely because
 * the merchant field also happens to be wrong. The ordering below is therefore
 * not an optimisation — it is the reason the negative fixtures each prove
 * exactly one rule.
 *
 * Six failures are `authorization_invalid` (401). The seventh — the proof is
 * genuine but was signed over different terms than the merchant will charge — is
 * `requote_required` (409), because nothing is wrong with the proof; the quote
 * underneath it has moved.
 */
import { verify, type KeyObject } from 'node:crypto';
import {
  CommerceError,
  authorizationSigningBytes,
  isAuthorizationExpired,
  isAuthorizationWindowInvalid,
  type AuthorizationProof,
  type AuthorizationSignedPayload,
} from '@ocp-catalog/shopping-contracts';

export interface AuthorizationExpectation {
  readonly merchantId: string;
  /** Server-recomputed `terms_hash` of the stored quote. Never the client's copy. */
  readonly termsHash: string;
  readonly quoteId: string;
  readonly currency: string;
  readonly purchaseAttemptId: string;
  readonly nowSeconds: number;
}

export type AuthorizationVerdict =
  | { readonly ok: true; readonly payload: AuthorizationSignedPayload }
  | { readonly ok: false; readonly error: CommerceError };

function reject(reason: string, message: string): AuthorizationVerdict {
  // `reason` is a machine-readable tag so a test can assert *which* rule fired.
  // Prose alone would not distinguish "the signature failed" from "the
  // signature was fine and something else did" — the two need different fixes.
  return { ok: false, error: new CommerceError('authorization_invalid', message, { reason }) };
}

function signatureVerifies(key: KeyObject, proof: AuthorizationProof): boolean {
  try {
    return verify(
      null,
      authorizationSigningBytes(proof.payload),
      key,
      Buffer.from(proof.signature, 'base64url'),
    );
  } catch {
    // A malformed signature or an unusable key is a failed verification, not a
    // crash: the caller sent the bytes and the merchant must answer about them.
    return false;
  }
}

export function verifyAuthorization(
  proof: AuthorizationProof,
  expected: AuthorizationExpectation,
  trustedKeys: ReadonlyMap<string, KeyObject>,
): AuthorizationVerdict {
  // 1. Is this a key the merchant already trusts? An unknown key_id cannot be
  //    resolved to a public key, so nothing after this point can run.
  const key = trustedKeys.get(proof.key_id);
  if (key === undefined) {
    return reject(
      'unknown_key',
      `authorization key_id ${JSON.stringify(proof.key_id)} is not a configured trusted key`,
    );
  }

  // 2. Does the signature cover the payload as given?
  if (!signatureVerifies(key, proof)) {
    return reject('signature', 'authorization signature does not verify');
  }

  const { payload } = proof;

  // 3. Is the proof's own window well formed, and is it still open?
  if (isAuthorizationWindowInvalid(payload)) {
    return reject(
      'window',
      `authorization expires_at ${payload.expires_at} is not after issued_at ${payload.issued_at}`,
    );
  }
  if (isAuthorizationExpired(payload, expected.nowSeconds)) {
    return reject(
      'expired',
      `authorization expired at ${payload.expires_at}; the current time is ${expected.nowSeconds}`,
    );
  }

  // 4. Is it addressed to this merchant? A genuine proof for someone else is
  //    still not permission here.
  if (payload.merchant_id !== expected.merchantId) {
    return reject(
      'merchant',
      `authorization is for merchant ${payload.merchant_id}, not ${expected.merchantId}`,
    );
  }

  // 5. Does it name the attempt being created? This is what makes a proof
  //    single-use: reusing one under a new attempt id changes the signed bytes,
  //    so the signature check catches it — but a proof whose signature is valid
  //    and whose attempt id disagrees with the request would otherwise slip past
  //    and authorize a purchase it was never issued for.
  if (payload.purchase_attempt_id !== expected.purchaseAttemptId) {
    return reject(
      'attempt',
      `authorization is bound to attempt ${payload.purchase_attempt_id}, not ${expected.purchaseAttemptId}`,
    );
  }

  // 6. And the quote it was issued against.
  if (payload.quote_id !== expected.quoteId) {
    return reject('quote', `authorization is for quote ${payload.quote_id}, not ${expected.quoteId}`);
  }
  if (payload.currency !== expected.currency) {
    return reject(
      'currency',
      `authorization is in ${payload.currency}, but the quote is in ${expected.currency}`,
    );
  }

  // 7. Does the proof cover the terms the merchant is about to charge? Compared
  //    against the hash recomputed from the stored quote, never against the
  //    client's copy of it — a client-reported hash is an input to check, not a
  //    fact to compare against itself.
  if (payload.terms_hash !== expected.termsHash) {
    return {
      ok: false,
      error: new CommerceError(
        'requote_required',
        'the quote has changed since this authorization was signed; request a new quote',
        { reason: 'terms_changed' },
      ),
    };
  }

  return { ok: true, payload };
}
