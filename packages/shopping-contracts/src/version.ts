/**
 * Identity constants for the shopping demo contracts.
 *
 * Everything in this package is a **demo application extension**. It is NOT
 * part of the OCP Catalog standard, and none of it may be presented as a
 * protocol capability. The existing OCP packages stay untouched; this package
 * only describes the extra contract that the shopping agent (A) and the coffee
 * merchant (B) agree on for the local demo purchase flow.
 */

/**
 * Version of the shared shopping contract.
 *
 * Bump the minor version for additive changes, the major version for any
 * breaking change. Both sides must agree on this value before integrating.
 */
export const SHOPPING_CONTRACT_VERSION = '0.1.0';

/** Domain separator mixed into the canonical terms serialization. */
export const TERMS_DOMAIN = 'ocp.demo.terms.v1';

/** Domain separator mixed into the authorization signing payload. */
export const AUTH_DOMAIN = 'ocp.demo.auth.v1';

/**
 * Authorization scheme.
 *
 * The proof is asymmetric on purpose: A holds the private key and signs, B only
 * ever holds public keys and verifies. A shared-secret scheme would let B mint
 * its own authorizations, which defeats the point of the proof.
 */
export const AUTH_SCHEME = 'ed25519';

/** Signature encoding used on the wire. */
export const SIGNATURE_ENCODING = 'base64url';
