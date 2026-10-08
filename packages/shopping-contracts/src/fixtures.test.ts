/**
 * Verifies the committed fixtures under `fixtures/shopping/`.
 *
 * A fixture that nothing checks is a claim, not a contract — and a fixture with
 * a wrong hash or a signature that does not verify is worse than none, because
 * A would develop against it and only find out when B's server disagreed. So
 * every fixture here is parsed through the schema it claims to satisfy, and
 * every authorization fixture is checked against the actual implementation,
 * including that the negative ones fail for the reason they are named after.
 */
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  authorizationProofSchema,
  authorizationSigningBytes,
  isAuthorizationExpired,
  isAuthorizationWindowInvalid,
  type AuthorizationProof,
} from './authorization';
import { purchaseAttemptSchema } from './attempt';
import { coffeeEntryAttributesSchema, coffeePriceInconsistency, COFFEE_FILTER_MAP, EXPECTED_FILTERABLE_FIELD_REFS } from './catalog';
import { checkoutRequestSchema } from './http';
import { orderSchema } from './order';
import { computeQuoteTermsHash, quoteInconsistency, quoteSchema, type Quote } from './quote';
import { fulfillmentMethodSchema } from './terms';
import {
  catalogEntrySchema,
  catalogHealthResponseSchema,
  catalogManifestSchema,
  catalogQueryResultSchema,
  resolvableReferenceSchema,
} from '@ocp-catalog/ocp-schema';

const FIXTURES = join(import.meta.dir, '..', '..', '..', 'fixtures', 'shopping');

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, relativePath), 'utf8')) as T;

const MERCHANT_ID = 'merchant_coffee_demo';
const CATALOG_ID = 'catalog_coffee_demo';
/** The instant the fixtures call "now". Past it, the valid quote has expired. */
const NOW_SECONDS = Math.floor(Date.parse('2026-10-07T10:05:00.000Z') / 1000);
const NOW_MS = Date.parse('2026-10-07T10:05:00.000Z');

const trustedPublicKey = createPublicKey(
  readFileSync(join(FIXTURES, 'keys', 'agent_a_test.public.pem'), 'utf8'),
);

const proofFrom = (relativePath: string): AuthorizationProof =>
  authorizationProofSchema.parse(readJson(relativePath));

/** True when the detached signature verifies over the proof's own payload. */
function signatureVerifies(proof: AuthorizationProof): boolean {
  return verify(
    null,
    authorizationSigningBytes(proof.payload),
    trustedPublicKey,
    Buffer.from(proof.signature, 'base64url'),
  );
}

describe('OCP read fixtures conform to the existing protocol schemas', () => {
  test('the catalog entries parse as OCP CatalogEntry objects', () => {
    // Arrange
    const entries = readJson<unknown[]>('catalog.coffee.json');

    // Act / Assert
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const entry of entries) {
      expect(() => catalogEntrySchema.parse(entry)).not.toThrow();
    }
  });

  test('every catalog entry carries the demo attribute pack in the agreed shape', () => {
    // Arrange
    const entries = readJson<{ entry_id: string; attributes: unknown }[]>('catalog.coffee.json');

    // Act / Assert
    for (const entry of entries) {
      expect(() => coffeeEntryAttributesSchema.parse(entry.attributes)).not.toThrow();
    }
  });

  test('every catalog entry has decimal and minor prices that agree', () => {
    // Arrange
    const entries = readJson<{ entry_id: string; attributes: never }[]>('catalog.coffee.json');

    // Act / Assert: a mismatch here would quote a price the catalog does not show.
    for (const entry of entries) {
      const attributes = coffeeEntryAttributesSchema.parse(entry.attributes);
      expect(coffeePriceInconsistency(attributes)).toBeNull();
    }
  });

  test('the catalog covers the four cases A has to handle', () => {
    // Arrange
    const entries = readJson<{ entry_id: string; attributes: never }[]>('catalog.coffee.json');
    const byId = new Map(
      entries.map((e) => [e.entry_id, coffeeEntryAttributesSchema.parse(e.attributes)]),
    );

    // Act / Assert: an affordable item, an over-budget one, a sold-out one, a
    // low-stock one. Without all four, the acceptance tests cannot be written.
    expect(byId.get('entry_latte')?.price_minor).toBe(2500);
    expect(byId.get('entry_gift_box')?.price_minor).toBeGreaterThan(3000);
    expect(byId.get('entry_soldout')?.inventory.availability_status).toBe('out_of_stock');
    expect(byId.get('entry_cold_brew')?.inventory.availability_status).toBe('low_stock');
    expect(byId.get('entry_cold_brew')?.inventory.quantity).toBe(1);
  });

  test('every declared fulfillment method is one the schema allows', () => {
    // Arrange
    const entries = readJson<{ attributes: never }[]>('catalog.coffee.json');

    // Act / Assert
    for (const entry of entries) {
      const attributes = coffeeEntryAttributesSchema.parse(entry.attributes);
      for (const method of attributes.fulfillment.methods) {
        expect(fulfillmentMethodSchema.parse(method)).toBe(method);
      }
    }
  });

  test('the manifest parses and declares only capabilities it names a pack for', () => {
    // Arrange
    const manifest = catalogManifestSchema.parse(readJson('manifest.json'));

    // Act / Assert
    expect(manifest.catalog_id).toBe(CATALOG_ID);
    expect(manifest.endpoints.query.method).toBe('POST');
    expect(manifest.endpoints.resolve.method).toBe('POST');
    expect(manifest.query_capabilities.length).toBeGreaterThan(0);
  });

  test('the manifest declares exactly the filters the merchant implements', () => {
    // Arrange: set equality, not a subset check. Under-declaring hides a working
    // filter from A; over-declaring promises one that does nothing. Both are
    // failures of the acceptance criterion "declared filters actually work".
    const manifest = catalogManifestSchema.parse(readJson('manifest.json'));
    const declared = manifest.query_capabilities.flatMap((c) => c.filterable_field_refs);

    // Act
    const expected = [...EXPECTED_FILTERABLE_FIELD_REFS].sort();

    // Assert
    expect([...declared].sort()).toEqual(expected);
  });

  test('every declared filter maps to at least one wire filter key', () => {
    // Arrange: the manifest speaks field paths and the query speaks flat keys;
    // this is the only thing tying the two vocabularies together.
    const manifest = catalogManifestSchema.parse(readJson('manifest.json'));
    const declared = manifest.query_capabilities.flatMap((c) => c.filterable_field_refs);

    // Act / Assert
    for (const ref of declared) {
      expect(COFFEE_FILTER_MAP[ref]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('the health document parses', () => {
    // Arrange / Act
    const health = catalogHealthResponseSchema.parse(readJson('health.json'));

    // Assert
    expect(health.status).toBe('healthy');
    expect(health.ready).toBe(true);
  });

  test('the query result parses and its page offset is the only permitted one', () => {
    // Arrange / Act
    const result = catalogQueryResultSchema.parse(readJson('query-result.json'));

    // Assert: `offset` is `z.literal(0)` in the OCP schema — cursor paging only.
    expect(result.page.offset).toBe(0);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.entry.entry_id).toBe('entry_latte');
  });

  test('the resolve document parses and publishes the checkout binding A needs', () => {
    // Arrange / Act
    const resolved = resolvableReferenceSchema.parse(readJson('resolve.json'));

    // Assert
    const checkout = resolved.action_bindings.find((b) => b.action_id === 'checkout');
    expect(checkout).toBeDefined();
    expect(checkout?.action_type).toBe('api');
    expect(checkout?.entrypoint.method).toBe('POST');
    expect(checkout?.entrypoint.url).toBe('http://127.0.0.1:8787/commerce/v1/checkouts');
  });

  test('the checkout binding asks for user confirmation', () => {
    // Arrange: A obtains approval before purchasing; the binding must say so.
    const resolved = resolvableReferenceSchema.parse(readJson('resolve.json'));

    // Act
    const checkout = resolved.action_bindings.find((b) => b.action_id === 'checkout');

    // Assert
    expect(checkout?.requires_user_confirmation).toBe(true);
  });
});

describe('quote fixtures', () => {
  test('the valid quote adds up and its hash matches its contents', () => {
    // Arrange / Act
    const quote = quoteSchema.parse(readJson('quotes/valid.json'));

    // Assert
    expect(quoteInconsistency(quote)).toBeNull();
    expect(quote.terms_hash).toBe(computeQuoteTermsHash(quote));
  });

  test('the valid quote is inside the demo budget and not yet expired', () => {
    // Arrange / Act
    const quote = quoteSchema.parse(readJson('quotes/valid.json'));

    // Assert
    expect(quote.total_minor).toBeLessThanOrEqual(3000);
    expect(Date.parse(quote.expires_at)).toBeGreaterThan(NOW_MS);
  });

  test('the delivery quote lands exactly on the budget, fees included', () => {
    // Arrange / Act
    const quote = quoteSchema.parse(readJson('quotes/valid-delivery.json'));

    // Assert: this is the boundary the budget check must treat as acceptable, and
    // it only passes because fees are counted.
    expect(quote.subtotal_minor).toBe(2500);
    expect(quote.fees[0]?.amount_minor).toBe(500);
    expect(quote.total_minor).toBe(3000);
    expect(quoteInconsistency(quote)).toBeNull();
  });

  test('the expired quote is well formed but past its window', () => {
    // Arrange / Act
    const quote = quoteSchema.parse(readJson('quotes/expired.json'));

    // Assert
    expect(quoteInconsistency(quote)).toBeNull();
    expect(Date.parse(quote.expires_at)).toBeLessThan(NOW_MS);
  });

  test('the over-budget quote is valid and consistent — only the budget rejects it', () => {
    // Arrange / Act
    const quote: Quote = quoteSchema.parse(readJson('quotes/over-budget.json'));

    // Assert: if this quote were malformed, a rejection would prove nothing about
    // the budget check, because something else could have caused it.
    expect(quoteInconsistency(quote)).toBeNull();
    expect(quote.total_minor).toBeGreaterThan(3000);
  });
});

describe('authorization fixtures', () => {
  test('the valid proof verifies against the committed public key', () => {
    // Arrange
    const proof = proofFrom('authorization/valid.json');

    // Act / Assert
    expect(proof.key_id).toBe('agent_a_test');
    expect(signatureVerifies(proof)).toBe(true);
  });

  test('the valid proof is in date and inside a well-formed window', () => {
    // Arrange / Act
    const proof = proofFrom('authorization/valid.json');

    // Assert
    expect(isAuthorizationExpired(proof.payload, NOW_SECONDS)).toBe(false);
    expect(isAuthorizationWindowInvalid(proof.payload)).toBe(false);
  });

  test('the valid proof is bound to the valid quote and the demo merchant', () => {
    // Arrange
    const proof = proofFrom('authorization/valid.json');
    const quote = quoteSchema.parse(readJson('quotes/valid.json'));

    // Act / Assert: a proof for a different quote would be meaningless.
    expect(proof.payload.quote_id).toBe(quote.quote_id);
    expect(proof.payload.terms_hash).toBe(quote.terms_hash);
    expect(proof.payload.merchant_id).toBe(MERCHANT_ID);
  });

  test('the expired proof still carries a genuine signature', () => {
    // Arrange
    const proof = proofFrom('authorization/expired.json');

    // Act / Assert: rejecting on the signature here would test the wrong rule.
    expect(signatureVerifies(proof)).toBe(true);
    expect(isAuthorizationExpired(proof.payload, NOW_SECONDS)).toBe(true);
  });

  test('the wrong-merchant proof is signed over its own payload, and only the id differs', () => {
    // Arrange
    const proof = proofFrom('authorization/wrong-merchant.json');

    // Act / Assert: only `merchant_id` can reject it, so the fixture is a real
    // test of the merchant binding rather than of signature verification.
    expect(signatureVerifies(proof)).toBe(true);
    expect(proof.payload.merchant_id).not.toBe(MERCHANT_ID);
  });

  test('the wrong-terms-hash proof is signed over its own payload, and only the hash differs', () => {
    // Arrange
    const proof = proofFrom('authorization/wrong-terms-hash.json');
    const quote = quoteSchema.parse(readJson('quotes/valid.json'));

    // Act / Assert
    expect(signatureVerifies(proof)).toBe(true);
    expect(proof.payload.terms_hash).not.toBe(quote.terms_hash);
  });

  test('the tampered signature does not verify', () => {
    // Arrange
    const proof = proofFrom('authorization/tampered-signature.json');

    // Act / Assert: this is the fixture that catches a verifier which checks the
    // signature's shape instead of its bytes.
    expect(signatureVerifies(proof)).toBe(false);
  });

  test('the replayed proof does not verify under its new attempt id', () => {
    // Arrange
    const proof = proofFrom('authorization/replayed-other-attempt.json');
    const valid = proofFrom('authorization/valid.json');

    // Act / Assert: the payload was edited after signing, so the bytes differ and
    // verification must fail. This is what stops a proof being reused elsewhere.
    expect(proof.payload.purchase_attempt_id).not.toBe(valid.payload.purchase_attempt_id);
    expect(signatureVerifies(proof)).toBe(false);
  });

  test('every negative proof fails for exactly one reason', () => {
    // Arrange: the six fixtures must not be negative for overlapping causes, or a
    // regression in one check would be masked by another.
    const cases: { path: string; signatureOk: boolean; inDate: boolean; merchantOk: boolean; termsOk: boolean }[] = [
      { path: 'authorization/valid.json', signatureOk: true, inDate: true, merchantOk: true, termsOk: true },
      { path: 'authorization/expired.json', signatureOk: true, inDate: false, merchantOk: true, termsOk: true },
      { path: 'authorization/wrong-merchant.json', signatureOk: true, inDate: true, merchantOk: false, termsOk: true },
      { path: 'authorization/wrong-terms-hash.json', signatureOk: true, inDate: true, merchantOk: true, termsOk: false },
      { path: 'authorization/tampered-signature.json', signatureOk: false, inDate: true, merchantOk: true, termsOk: true },
      { path: 'authorization/replayed-other-attempt.json', signatureOk: false, inDate: true, merchantOk: true, termsOk: true },
    ];
    const quote = quoteSchema.parse(readJson('quotes/valid.json'));

    // Act / Assert
    for (const expected of cases) {
      const proof = proofFrom(expected.path);
      expect(signatureVerifies(proof)).toBe(expected.signatureOk);
      expect(isAuthorizationExpired(proof.payload, NOW_SECONDS)).toBe(!expected.inDate);
      expect(proof.payload.merchant_id === MERCHANT_ID).toBe(expected.merchantOk);
      expect(proof.payload.terms_hash === quote.terms_hash).toBe(expected.termsOk);
    }
  });
});

describe('checkout request fixtures', () => {
  test('the valid checkout body parses and carries a verifying proof', () => {
    // Arrange
    const fixture = readJson<{ _headers: Record<string, string>; _body: unknown }>(
      'checkouts/request-valid.json',
    );

    // Act
    const request = checkoutRequestSchema.parse(fixture._body);

    // Assert
    expect(signatureVerifies(request.authorization)).toBe(true);
    expect(fixture._headers['idempotency-key']).toBeTruthy();
    expect(fixture._headers['x-dev-caller-id']).toBeTruthy();
  });

  test('the no-proof checkout body is rejected by the schema', () => {
    // Arrange
    const fixture = readJson<{ _body: unknown; _expected_error: { code: string } }>(
      'checkouts/request-without-proof.json',
    );

    // Act / Assert: `approved: true` is not authorization, and the schema says so.
    expect(() => checkoutRequestSchema.parse(fixture._body)).toThrow();
    expect(fixture._expected_error.code).toBe('invalid_request');
  });
});

describe('attempt and order fixtures', () => {
  test.each(['processing', 'confirmed', 'failed'])(
    'the %s attempt parses',
    (name) => {
      // Arrange / Act / Assert
      const attempt = purchaseAttemptSchema.parse(readJson(`attempts/${name}.json`));
      expect(attempt.status).toBe(name);
    },
  );

  test('a confirmed attempt names its order and a failed one carries an error', () => {
    // Arrange / Act
    const confirmed = purchaseAttemptSchema.parse(readJson('attempts/confirmed.json'));
    const failed = purchaseAttemptSchema.parse(readJson('attempts/failed.json'));

    // Assert
    expect(confirmed.order_id).toBeTruthy();
    expect(failed.error?.code).toBe('payment_failed');
    expect(failed.order_id).toBeUndefined();
  });

  test('a processing attempt claims neither an order nor an error', () => {
    // Arrange / Act
    const processing = purchaseAttemptSchema.parse(readJson('attempts/processing.json'));

    // Assert: claiming either while still processing is how a caller is misled.
    expect(processing.status).toBe('processing');
    expect(processing.order_id).toBeUndefined();
    expect(processing.error).toBeUndefined();
  });

  test.each(['confirmed', 'processing', 'failed'])('the %s order parses', (name) => {
    // Arrange / Act / Assert
    const order = orderSchema.parse(readJson(`orders/${name}.json`));
    expect(order.currency).toBe('CNY');
  });

  test('the confirmed order is paid but not yet made', () => {
    // Arrange / Act
    const order = orderSchema.parse(readJson('orders/confirmed.json'));

    // Assert: the two statuses are independent, and this pairing is the normal one.
    expect(order.payment_status.status).toBe('paid');
    expect(order.fulfillment_status.status).toBe('pending');
  });

  test('the processing order admits it does not know the payment outcome', () => {
    // Arrange / Act
    const order = orderSchema.parse(readJson('orders/processing.json'));

    // Assert: `unknown`, not `pending` — the difference is whether a retry is safe.
    expect(order.payment_status.status).toBe('unknown');
  });

  test('the failed order is neither paid nor fulfilled', () => {
    // Arrange / Act
    const order = orderSchema.parse(readJson('orders/failed.json'));

    // Assert
    expect(order.payment_status.status).toBe('failed');
    expect(order.fulfillment_status.status).toBe('cancelled');
  });

  test('the order fixtures snapshot the same terms the valid quote agreed', () => {
    // Arrange
    const quote = quoteSchema.parse(readJson('quotes/valid.json'));

    // Act
    const order = orderSchema.parse(readJson('orders/confirmed.json'));

    // Assert: the order must still describe the purchase after the catalog changes.
    expect(order.terms_hash).toBe(quote.terms_hash);
    expect(order.total_minor).toBe(quote.total_minor);
  });
});

describe('fault catalogue', () => {
  test('names the failure modes Phase 2 must implement', () => {
    // Arrange
    const fixture = readJson<{ faults: Record<string, unknown> }>('faults.json');

    // Act
    const names = Object.keys(fixture.faults);

    // Assert
    expect(names).toContain('payment_timeout_then_succeed');
    expect(names).toContain('payment_declined');
    expect(names).toContain('price_raised_after_quote');
    expect(names).toContain('stock_exhausted_after_quote');
    expect(names).toContain('response_dropped_after_settlement');
  });
});
