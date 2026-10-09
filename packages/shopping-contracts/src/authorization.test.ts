import { describe, expect, test } from 'bun:test';
import {
  authorizationProofSchema,
  authorizationSignedPayloadSchema,
  authorizationSigningBytes,
  isAuthorizationExpired,
  isAuthorizationWindowInvalid,
  type AuthorizationProof,
  type AuthorizationSignedPayload,
} from './authorization';
import { AUTH_DOMAIN, AUTH_SCHEME } from './version';

const basePayload: AuthorizationSignedPayload = {
  v: AUTH_DOMAIN,
  issuer: 'agent_a_demo',
  user_id: 'user_demo_1',
  merchant_id: 'merchant_coffee_demo',
  quote_id: 'quote_0001',
  terms_hash: 'a'.repeat(64),
  currency: 'CNY',
  max_total_minor: 3000,
  purchase_attempt_id: 'att_0001',
  issued_at: 1_760_000_000,
  expires_at: 1_760_000_300,
  jti: 'jti_0001',
};

const baseProof: AuthorizationProof = {
  scheme: AUTH_SCHEME,
  key_id: 'agent_a_key_1',
  signature: 'c2lnbmF0dXJl',
  payload: basePayload,
};

describe('authorizationSigningBytes', () => {
  test('produces identical bytes on repeated calls', () => {
    // Arrange / Act
    const first = authorizationSigningBytes(basePayload);
    const second = authorizationSigningBytes(basePayload);

    // Assert
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  test('does not depend on the order the payload keys were written in', () => {
    // Arrange: the same payload, declared back to front.
    const rekeyed = Object.fromEntries(
      Object.entries(basePayload).reverse(),
    ) as AuthorizationSignedPayload;

    // Act / Assert: otherwise a valid signature would fail to verify.
    expect(Array.from(authorizationSigningBytes(rekeyed))).toEqual(
      Array.from(authorizationSigningBytes(basePayload)),
    );
  });

  test('changes when the purchase attempt id changes', () => {
    // Arrange: the replay case — a valid proof re-presented under a new attempt.
    const replay = { ...basePayload, purchase_attempt_id: 'att_0002' };

    // Act / Assert: this inequality is what scopes a proof to one attempt.
    expect(Array.from(authorizationSigningBytes(replay))).not.toEqual(
      Array.from(authorizationSigningBytes(basePayload)),
    );
  });

  test.each([
    ['terms_hash', { terms_hash: 'b'.repeat(64) }],
    ['merchant_id', { merchant_id: 'merchant_other' }],
    ['user_id', { user_id: 'user_demo_2' }],
    ['quote_id', { quote_id: 'quote_0009' }],
    ['max_total_minor', { max_total_minor: 3001 }],
    ['currency', { currency: 'USD' }],
    ['expires_at', { expires_at: 1_760_000_301 }],
    ['jti', { jti: 'jti_0002' }],
    ['issuer', { issuer: 'agent_a_other' }],
  ])('changes when %s changes', (_label, patch) => {
    // Arrange
    const changed = { ...basePayload, ...patch } as AuthorizationSignedPayload;

    // Act / Assert: every field in the payload must actually be covered.
    expect(Array.from(authorizationSigningBytes(changed))).not.toEqual(
      Array.from(authorizationSigningBytes(basePayload)),
    );
  });
});

describe('isAuthorizationExpired', () => {
  test('is false one second before expiry', () => {
    // Arrange / Act / Assert
    expect(isAuthorizationExpired(basePayload, basePayload.expires_at - 1)).toBe(false);
  });

  test('is true exactly at expiry', () => {
    // Arrange / Act / Assert: the window closes inclusively.
    expect(isAuthorizationExpired(basePayload, basePayload.expires_at)).toBe(true);
  });

  test('is true well after expiry', () => {
    // Arrange / Act / Assert
    expect(isAuthorizationExpired(basePayload, basePayload.expires_at + 86_400)).toBe(true);
  });
});

describe('isAuthorizationWindowInvalid', () => {
  test('is false for a normal forward window', () => {
    // Arrange / Act / Assert
    expect(isAuthorizationWindowInvalid(basePayload)).toBe(false);
  });

  test('is true when expiry equals issue time', () => {
    // Arrange: a zero-length window authorizes nothing.
    const zeroLength = { ...basePayload, expires_at: basePayload.issued_at };

    // Act / Assert
    expect(isAuthorizationWindowInvalid(zeroLength)).toBe(true);
  });

  test('is true when expiry precedes issue time', () => {
    // Arrange
    const backwards = { ...basePayload, expires_at: basePayload.issued_at - 1 };

    // Act / Assert
    expect(isAuthorizationWindowInvalid(backwards)).toBe(true);
  });
});

describe('authorizationSignedPayloadSchema', () => {
  test('accepts the baseline payload', () => {
    // Arrange / Act / Assert
    expect(authorizationSignedPayloadSchema.parse(basePayload)).toEqual(basePayload);
  });

  test('rejects a terms_hash of the wrong length', () => {
    // Arrange
    const short = { ...basePayload, terms_hash: 'abc' };

    // Act / Assert
    expect(() => authorizationSignedPayloadSchema.parse(short)).toThrow();
  });

  test('rejects an uppercase currency', () => {
    // Arrange
    const lowercase = { ...basePayload, currency: 'cny' };

    // Act / Assert: mixing cases would give two spellings of one currency.
    expect(() => authorizationSignedPayloadSchema.parse(lowercase)).toThrow();
  });

  test('rejects a fractional timestamp', () => {
    // Arrange: a float can serialize differently across runtimes.
    const fractional = { ...basePayload, issued_at: 1_760_000_000.5 };

    // Act / Assert
    expect(() => authorizationSignedPayloadSchema.parse(fractional)).toThrow();
  });

  test('rejects an unknown field', () => {
    // Arrange
    const withExtra = { ...basePayload, approved: true };

    // Act / Assert: this is the exact shape the docs forbid as an authorization.
    expect(() => authorizationSignedPayloadSchema.parse(withExtra)).toThrow();
  });

  test('rejects a payload carrying its own public key', () => {
    // Arrange: a self-supplied key would let any caller sign its own permission.
    const selfKeyed = { ...basePayload, public_key: 'AAAA' };

    // Act / Assert
    expect(() => authorizationSignedPayloadSchema.parse(selfKeyed)).toThrow();
  });
});

describe('authorizationProofSchema', () => {
  test('accepts the baseline proof', () => {
    // Arrange / Act / Assert
    expect(authorizationProofSchema.parse(baseProof)).toEqual(baseProof);
  });

  test('rejects an unsupported scheme', () => {
    // Arrange
    const hmac = { ...baseProof, scheme: 'hmac-sha256' };

    // Act / Assert: a shared-secret scheme would let the verifier forge proofs.
    expect(() => authorizationProofSchema.parse(hmac)).toThrow();
  });

  test('rejects an empty signature', () => {
    // Arrange
    const unsigned = { ...baseProof, signature: '' };

    // Act / Assert
    expect(() => authorizationProofSchema.parse(unsigned)).toThrow();
  });

  test('rejects an empty key id', () => {
    // Arrange: without a key id the verifier cannot choose which key to trust.
    const unnamed = { ...baseProof, key_id: '' };

    // Act / Assert
    expect(() => authorizationProofSchema.parse(unnamed)).toThrow();
  });

  test('rejects a proof missing its payload', () => {
    // Arrange
    const { payload, ...withoutPayload } = baseProof;
    expect(payload).toBeDefined();

    // Act / Assert
    expect(() => authorizationProofSchema.parse(withoutPayload)).toThrow();
  });
});
