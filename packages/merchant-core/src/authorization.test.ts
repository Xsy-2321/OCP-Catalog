/**
 * The authorization verifier, one test per rule.
 *
 * The property under test is not "a bad proof is rejected" — it is that a bad
 * proof is rejected *for the reason it is bad*. A verifier that answers
 * `authorization_invalid` to everything passes every negative test ever written
 * against it and tells the caller nothing about what to fix. So each case
 * asserts the machine-readable `reason`, and several assert that a proof broken
 * in two ways reports the specific rule rather than whichever check happened to
 * be convenient.
 *
 * The other property is fail-closed: with no trusted key configured, or with a
 * key the merchant does not know, nothing verifies. The one thing that must
 * never happen is trusting a key that arrived in the request.
 */
import { describe, expect, test } from 'bun:test';
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  authorizationProofSchema,
  authorizationSigningBytes,
  quoteSchema,
  type AuthorizationProof,
  type AuthorizationSignedPayload,
  type Quote,
} from '@ocp-catalog/shopping-contracts';
import {
  verifyAuthorization,
  type AuthorizationExpectation,
  type AuthorizationVerdict,
} from './authorization';
import {
  TEST_KEY_ID,
  TEST_NOW_MS,
  authorizationFor,
  makeTestConfig,
  signPayload,
  signedPayloadFor,
  tamperSignature,
  testPrivateKey,
  testPublicKey,
} from './test-support';
import { buildQuote } from './quote';
import { findEntry, loadCatalog } from './catalog';
import { CATALOG_SEED } from './data/catalog';

const CATALOG = loadCatalog(CATALOG_SEED);
const CONFIG = makeTestConfig();
const NOW_SECONDS = Math.floor(TEST_NOW_MS / 1000);

function latteQuote(): Quote {
  const record = findEntry(CATALOG, 'entry_latte');
  if (record === null) throw new Error('no latte');
  return buildQuote(record, { entry_id: 'entry_latte', quantity: 1, fulfillment: { method: 'pickup' } }, {
    config: CONFIG,
    nowMs: TEST_NOW_MS,
  });
}

const QUOTE = latteQuote();

function expectations(overrides: Partial<AuthorizationExpectation> = {}): AuthorizationExpectation {
  return {
    merchantId: CONFIG.merchantId,
    termsHash: QUOTE.terms_hash,
    quoteId: QUOTE.quote_id,
    currency: QUOTE.currency,
    purchaseAttemptId: 'att_test_0001',
    userId: 'user_demo_1',
    nowSeconds: NOW_SECONDS,
    ...overrides,
  };
}

function trusted(): ReadonlyMap<string, KeyObject> {
  return new Map<string, KeyObject>([[TEST_KEY_ID, testPublicKey()]]);
}

function check(
  proof: AuthorizationProof,
  overrides: Partial<AuthorizationExpectation> = {},
  keys: ReadonlyMap<string, KeyObject> = trusted(),
): AuthorizationVerdict {
  return verifyAuthorization(proof, expectations(overrides), keys, CONFIG.trustedIssuers);
}

/** The rule that fired, or `ACCEPTED`. Never a bare "it failed". */
function ruleOf(verdict: AuthorizationVerdict): string {
  if (verdict.ok) return 'ACCEPTED';
  return String((verdict.error.details as { reason?: string } | undefined)?.reason ?? 'NO_REASON');
}

function proofWith(payload: Partial<AuthorizationSignedPayload>): AuthorizationProof {
  return signPayload({ ...signedPayloadFor(QUOTE), ...payload });
}

/* ---------------------------------------------------------------- accepting */

describe('verifyAuthorization accepts', () => {
  test('a genuine proof over the stored quote', () => {
    const verdict = check(authorizationFor(QUOTE));

    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.payload.purchase_attempt_id).toBe('att_test_0001');
  });

  test('a proof that expires one second from now', () => {
    // `isAuthorizationExpired` is `now >= expires_at`, so the last valid second
    // is the one before expiry. Off by one here and a proof is honoured after
    // it has lapsed, or refused while it is still good.
    const proof = proofWith({ issued_at: NOW_SECONDS - 10, expires_at: NOW_SECONDS + 1 });

    expect(ruleOf(check(proof))).toBe('ACCEPTED');
  });
});

/* ------------------------------------------------------------------ refusals */

describe('verifyAuthorization refuses', () => {
  test('a correct signature naming the wrong user', () => {
    expect(ruleOf(check(proofWith({ user_id: 'different_signed_user' })))).toBe('user');
  });

  test('a correct signature naming an arbitrary issuer', () => {
    expect(ruleOf(check(proofWith({ issuer: 'untrusted_issuer' })))).toBe('issuer');
  });

  test('a key without an issuer restriction fails closed', () => {
    const verdict = verifyAuthorization(authorizationFor(QUOTE), expectations(), trusted(), new Map());
    expect(ruleOf(verdict)).toBe('issuer');
  });
  test('a key the merchant does not know', () => {
    expect(ruleOf(check(signPayload(signedPayloadFor(QUOTE), 'agent_stranger')))).toBe('unknown_key');
  });

  test('anything at all when no trusted key is configured', () => {
    // Fail-closed. A merchant with no configured key cannot verify, and must
    // refuse rather than fall back to a key from the request.
    expect(ruleOf(check(authorizationFor(QUOTE), {}, new Map()))).toBe('unknown_key');
    expect(ruleOf(check(authorizationFor(QUOTE), {}, new Map()))).not.toBe('ACCEPTED');
  });

  test('a signature that does not verify', () => {
    expect(ruleOf(check(tamperSignature(authorizationFor(QUOTE))))).toBe('signature');
  });

  test('a proof signed by someone else, wearing a trusted key id', () => {
    // The whole point of the scheme. An attacker holds a key, signs a perfect
    // payload, and labels it with the key id the merchant trusts. If the
    // verifier ever resolved the key from the request instead of its own
    // configuration, this would pass.
    const attacker = generateKeyPairSync('ed25519');
    const payload = signedPayloadFor(QUOTE);
    const forged: AuthorizationProof = {
      scheme: 'ed25519',
      key_id: TEST_KEY_ID,
      signature: sign(null, authorizationSigningBytes(payload), attacker.privateKey).toString('base64url'),
      payload,
    };

    expect(ruleOf(check(forged))).toBe('signature');
    expect(ruleOf(check(forged))).not.toBe('ACCEPTED');
  });

  test('a proof whose window has closed', () => {
    const proof = proofWith({ issued_at: NOW_SECONDS - 600, expires_at: NOW_SECONDS - 1 });

    expect(ruleOf(check(proof))).toBe('expired');
  });

  test('a proof that expires exactly now', () => {
    // The boundary is closed: at `now === expires_at` the proof is spent.
    expect(ruleOf(check(proofWith({ issued_at: NOW_SECONDS - 600, expires_at: NOW_SECONDS })))).toBe('expired');
  });

  test('a proof whose window is malformed', () => {
    const proof = proofWith({ issued_at: NOW_SECONDS, expires_at: NOW_SECONDS });

    expect(ruleOf(check(proof))).toBe('window');
  });

  test('a proof addressed to another merchant', () => {
    expect(ruleOf(check(proofWith({ merchant_id: 'merchant_other_demo' })))).toBe('merchant');
  });

  test('a proof bound to a different attempt', () => {
    // The replay case. A proof genuinely signed for attempt 0001 presented in a
    // request that names attempt 0002 must not authorize the second purchase.
    const proof = proofWith({ purchase_attempt_id: 'att_test_0009' });

    expect(ruleOf(check(proof, { purchaseAttemptId: 'att_test_0001' }))).toBe('attempt');
  });

  test('a proof for another quote', () => {
    expect(ruleOf(check(proofWith({ quote_id: 'quote_other' })))).toBe('quote');
  });

  test('a proof in another currency', () => {
    expect(ruleOf(check(proofWith({ currency: 'USD' })))).toBe('currency');
  });

  test('a genuine proof signed over different terms', () => {
    // The signature is good; the ground under it moved. That is a re-quote, not
    // a forged permission, and the caller is told which one it is.
    const verdict = check(proofWith({ terms_hash: 'f'.repeat(64) }));

    expect(ruleOf(verdict)).toBe('terms_changed');
    if (!verdict.ok) {
      expect(verdict.error.code).toBe('requote_required');
      expect(verdict.error.status).toBe(409);
    }
  });

  test('every other refusal is a 401', () => {
    const proofs: Array<[string, AuthorizationProof, Partial<AuthorizationExpectation>]> = [
      ['unknown_key', signPayload(signedPayloadFor(QUOTE), 'agent_stranger'), {}],
      ['signature', tamperSignature(authorizationFor(QUOTE)), {}],
      ['expired', proofWith({ issued_at: NOW_SECONDS - 600, expires_at: NOW_SECONDS - 1 }), {}],
      ['merchant', proofWith({ merchant_id: 'merchant_other_demo' }), {}],
      ['attempt', proofWith({ purchase_attempt_id: 'att_test_0009' }), {}],
      ['quote', proofWith({ quote_id: 'quote_other' }), {}],
      ['currency', proofWith({ currency: 'USD' }), {}],
    ];

    for (const [expectedRule, proof, overrides] of proofs) {
      const verdict = check(proof, overrides);
      expect(ruleOf(verdict)).toBe(expectedRule);
      if (!verdict.ok) expect(verdict.error.status).toBe(401);
    }
  });
});

/* ----------------------------------------------------------------- ordering */

describe('check ordering', () => {
  test('reports the unknown key rather than the merchant it also gets wrong', () => {
    const proof = signPayload({ ...signedPayloadFor(QUOTE), merchant_id: 'merchant_other_demo' }, 'agent_stranger');

    expect(ruleOf(check(proof))).toBe('unknown_key');
  });

  test('reports the broken signature rather than the merchant it also gets wrong', () => {
    // If the merchant check ran first, this proof would be reported as a
    // routing mistake and someone would go looking for the wrong bug.
    const proof = tamperSignature(
      signPayload({ ...signedPayloadFor(QUOTE), merchant_id: 'merchant_other_demo' }),
    );

    expect(ruleOf(check(proof))).toBe('signature');
  });

  test('reports expiry rather than the attempt it also gets wrong', () => {
    const proof = proofWith({
      issued_at: NOW_SECONDS - 600,
      expires_at: NOW_SECONDS - 1,
      purchase_attempt_id: 'att_test_0009',
    });

    expect(ruleOf(check(proof))).toBe('expired');
  });

  test('reports the attempt before the quote', () => {
    const proof = proofWith({ purchase_attempt_id: 'att_test_0009', quote_id: 'quote_other' });

    expect(ruleOf(check(proof))).toBe('attempt');
  });
});

/* ------------------------------------------- the committed A-side fixtures */

describe('the fixtures A will sign with', () => {
  const authDir = join(import.meta.dir, '../../../fixtures/shopping/authorization');
  const quoteDir = join(import.meta.dir, '../../../fixtures/shopping/quotes');

  function loadProof(name: string): AuthorizationProof {
    return authorizationProofSchema.parse(JSON.parse(readFileSync(join(authDir, `${name}.json`), 'utf8')));
  }

  function loadQuote(name: string): Quote {
    return quoteSchema.parse(JSON.parse(readFileSync(join(quoteDir, `${name}.json`), 'utf8')));
  }

  /** Expectations taken from the fixture quote the proof was issued against. */
  function fixtureExpectations(proof: AuthorizationProof): AuthorizationExpectation {
    const quote = loadQuote('valid');
    return {
      merchantId: 'merchant_coffee_demo',
      // Recomputed from the fixture quote by the merchant's own canonicaliser.
      termsHash: quote.terms_hash,
      quoteId: quote.quote_id,
      currency: quote.currency,
      purchaseAttemptId: proof.payload.purchase_attempt_id,
      userId: 'user_demo_1',
      nowSeconds: 1_791_367_500,
    };
  }

  test('the valid fixture verifies against the merchant verifier', () => {
    // The cross-side check that matters: A signs with the committed test key,
    // the merchant verifies with the committed public key, and both compute the
    // same canonical bytes. A one-byte disagreement in the canonical form shows
    // up here rather than at integration.
    const proof = loadProof('valid');
    const verdict = verifyAuthorization(proof, fixtureExpectations(proof), trusted(), CONFIG.trustedIssuers);

    expect(ruleOf(verdict)).toBe('ACCEPTED');
  });

  test('each negative fixture fails for the rule it was built to fail for', () => {
    const expected: Record<string, string> = {
      expired: 'expired',
      'wrong-merchant': 'merchant',
      'wrong-terms-hash': 'terms_changed',
      // Both of these were edited after signing, so the signature is what
      // catches them — `tampered-signature` by corrupting the signature,
      // `replayed-other-attempt` by rewriting `purchase_attempt_id` inside the
      // signed payload. The README documents this pairing; asserting it here
      // stops either fixture from quietly becoming a test of something else.
      'tampered-signature': 'signature',
      'replayed-other-attempt': 'signature',
    };

    for (const [name, rule] of Object.entries(expected)) {
      const proof = loadProof(name);
      expect(ruleOf(verifyAuthorization(proof, fixtureExpectations(proof), trusted(), CONFIG.trustedIssuers))).toBe(rule);
    }
  });

  test('the fixture public key is the one the test key derives', () => {
    // If this fails, every signature above is being checked against a key that
    // does not match the secret, and the whole cross-side check is theatre.
    const committed = createPublicKey(
      readFileSync(join(import.meta.dir, '../../../fixtures/shopping/keys/agent_a_test.public.pem'), 'utf8'),
    );

    expect(committed.export({ format: 'pem', type: 'spki' })).toBe(
      testPublicKey().export({ format: 'pem', type: 'spki' }),
    );
    expect(testPrivateKey().asymmetricKeyType).toBe('ed25519');
  });
});
