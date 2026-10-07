/**
 * `@ocp-catalog/shopping-contracts` — the shared contract between the shopping
 * agent (A) and the coffee merchant (B).
 *
 * EVERYTHING IN THIS PACKAGE IS A DEMO APPLICATION EXTENSION. It is not part of
 * the OCP Catalog standard, it is not a protocol capability, and it must not be
 * described as one. The OCP schema, client, CLI and examples are untouched; this
 * package only adds the extra contract the local demo purchase flow needs.
 *
 * Two functions in here are load-bearing in a way the rest are not:
 * `computeTermsHash` and `authorizationSigningBytes`. Both sides must produce
 * byte-identical output, so both sides call these rather than reimplementing the
 * serialization. A second implementation will disagree eventually, and the
 * failure will look like a mysterious signature error.
 *
 * See `docs/coffee-merchant/CONTRACT.md` for the frozen contract and the
 * rationale behind each decision.
 */

export * from './version';
export * from './canonical';
export * from './money';
export * from './ids';
export * from './errors';
export * from './terms';
export * from './authorization';
export * from './quote';
export * from './attempt';
export * from './order';
export * from './intent';
export * from './catalog';
export * from './http';
