import { describe, expect, test } from 'bun:test';
import { authorizationProofSchema, type AuthorizationProof } from './authorization';
import type { PurchaseAttempt } from './attempt';
import {
  DEV_CALLER_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  checkoutProcessingResponseSchema,
  checkoutRequestSchema,
  checkoutResponseSchema,
  createQuoteRequestSchema,
  createQuoteResponseSchema,
  orderResponseSchema,
  purchaseAttemptResponseSchema,
} from './http';
import type { Order } from './order';
import { quoteSchema } from './quote';
import { AUTH_DOMAIN, AUTH_SCHEME } from './version';
import { computeQuoteTermsHash, type Quote } from './quote';

const TERMS_HASH = 'a'.repeat(64);

const proof: AuthorizationProof = {
  scheme: AUTH_SCHEME,
  key_id: 'agent_a_key_1',
  signature: 'c2lnbmF0dXJl',
  payload: {
    v: AUTH_DOMAIN,
    issuer: 'agent_a_demo',
    user_id: 'user_demo_1',
    merchant_id: 'merchant_coffee_demo',
    quote_id: 'quote_0001',
    terms_hash: TERMS_HASH,
    currency: 'CNY',
    max_total_minor: 3000,
    purchase_attempt_id: 'att_0001',
    issued_at: 1_760_000_000,
    expires_at: 1_760_000_300,
    jti: 'jti_0001',
  },
};

const attempt: PurchaseAttempt = {
  purchase_attempt_id: 'att_0001',
  merchant_id: 'merchant_coffee_demo',
  quote_id: 'quote_0001',
  catalog_id: 'catalog_coffee_demo',
  status: 'processing',
  created_at: '2026-10-07T10:00:00.000Z',
  updated_at: '2026-10-07T10:00:00.000Z',
};

function makeOrder(): Order {
  return {
    order_id: 'ord_0001',
    merchant_id: 'merchant_coffee_demo',
    catalog_id: 'catalog_coffee_demo',
    purchase_attempt_id: 'att_0001',
    quote_id: 'quote_0001',
    currency: 'CNY',
    items: [
      {
        entry_id: 'entry_latte',
        title: '拿铁',
        quantity: 2,
        unit_minor: 2500,
        line_total_minor: 5000,
      },
    ],
    fees: [],
    subtotal_minor: 5000,
    total_minor: 5000,
    terms_hash: TERMS_HASH,
    fulfillment: { method: 'pickup', location_id: 'store_zjg' },
    payment_status: { status: 'paid', updated_at: '2026-10-07T10:00:05.000Z' },
    fulfillment_status: { status: 'pending', updated_at: '2026-10-07T10:00:05.000Z' },
    created_at: '2026-10-07T10:00:05.000Z',
    updated_at: '2026-10-07T10:00:05.000Z',
  };
}

function makeQuote(): Quote {
  const draft: Omit<Quote, 'terms_hash'> = {
    quote_id: 'quote_0001',
    merchant_id: 'merchant_coffee_demo',
    catalog_id: 'catalog_coffee_demo',
    currency: 'CNY',
    items: [
      {
        entry_id: 'entry_latte',
        title: '拿铁',
        quantity: 2,
        unit_minor: 2500,
        line_total_minor: 5000,
      },
    ],
    fees: [],
    subtotal_minor: 5000,
    total_minor: 5000,
    fulfillment: { method: 'pickup', location_id: 'store_zjg' },
    created_at: '2026-10-07T10:00:00.000Z',
    expires_at: '2026-10-07T10:15:00.000Z',
  };
  return { ...draft, terms_hash: computeQuoteTermsHash(draft) };
}

describe('headers', () => {
  test('names the idempotency header the caller must send', () => {
    // Arrange / Act / Assert: the exact spelling is part of the wire contract.
    expect(IDEMPOTENCY_KEY_HEADER).toBe('idempotency-key');
  });

  test('names the development caller header explicitly as a dev stand-in', () => {
    // Arrange / Act / Assert
    expect(DEV_CALLER_HEADER).toBe('x-dev-caller-id');
  });
});

describe('createQuoteRequestSchema', () => {
  test('accepts a well-formed request', () => {
    // Arrange
    const request = { entry_id: 'entry_latte', quantity: 2, fulfillment: { method: 'pickup' } };

    // Act / Assert
    expect(createQuoteRequestSchema.parse(request)).toEqual(request);
  });

  test('rejects a zero quantity', () => {
    // Arrange / Act / Assert: quoting for nothing is not a request.
    expect(() =>
      createQuoteRequestSchema.parse({
        entry_id: 'entry_latte',
        quantity: 0,
        fulfillment: { method: 'pickup' },
      }),
    ).toThrow();
  });

  test('rejects a fractional quantity', () => {
    // Arrange / Act / Assert
    expect(() =>
      createQuoteRequestSchema.parse({
        entry_id: 'entry_latte',
        quantity: 1.5,
        fulfillment: { method: 'pickup' },
      }),
    ).toThrow();
  });

  test('rejects a client-supplied price field', () => {
    // Arrange: a client telling the merchant what things cost.
    const withPrice = {
      entry_id: 'entry_latte',
      quantity: 2,
      fulfillment: { method: 'pickup' },
      unit_minor: 1,
    };

    // Act / Assert: prices are the merchant's to set, so this must not be accepted.
    expect(() => createQuoteRequestSchema.parse(withPrice)).toThrow();
  });

  test('rejects an unknown fulfillment method', () => {
    // Arrange / Act / Assert
    expect(() =>
      createQuoteRequestSchema.parse({
        entry_id: 'entry_latte',
        quantity: 2,
        fulfillment: { method: 'teleport' },
      }),
    ).toThrow();
  });
});

describe('createQuoteResponseSchema', () => {
  test('is the quote schema itself', () => {
    // Arrange / Act / Assert: the quote is returned whole, not wrapped.
    expect(createQuoteResponseSchema).toBe(quoteSchema);
  });
});

describe('checkoutRequestSchema', () => {
  test('accepts a well-formed request', () => {
    // Arrange
    const request = {
      purchase_attempt_id: 'att_0001',
      quote_id: 'quote_0001',
      terms_hash: TERMS_HASH,
      authorization: proof,
    };

    // Act / Assert
    expect(checkoutRequestSchema.parse(request)).toEqual(request);
  });

  test('rejects a request with no authorization proof', () => {
    // Arrange / Act / Assert: there is no fallback path that authorizes a purchase.
    expect(() =>
      checkoutRequestSchema.parse({
        purchase_attempt_id: 'att_0001',
        quote_id: 'quote_0001',
        terms_hash: TERMS_HASH,
      }),
    ).toThrow();
  });

  test('rejects `approved: true` offered in place of a proof', () => {
    // Arrange: the exact shortcut the contract forbids.
    const withApproval = {
      purchase_attempt_id: 'att_0001',
      quote_id: 'quote_0001',
      terms_hash: TERMS_HASH,
      approved: true,
    };

    // Act / Assert
    expect(() => checkoutRequestSchema.parse(withApproval)).toThrow();
  });

  test('rejects an idempotency key placed in the body', () => {
    // Arrange: the key belongs in the header so a re-serialized body still matches.
    const withKeyInBody = {
      purchase_attempt_id: 'att_0001',
      quote_id: 'quote_0001',
      terms_hash: TERMS_HASH,
      authorization: proof,
      idempotency_key: 'key_1',
    };

    // Act / Assert
    expect(() => checkoutRequestSchema.parse(withKeyInBody)).toThrow();
  });

  test('rejects a malformed terms_hash', () => {
    // Arrange / Act / Assert
    expect(() =>
      checkoutRequestSchema.parse({
        purchase_attempt_id: 'att_0001',
        quote_id: 'quote_0001',
        terms_hash: 'not-a-hash',
        authorization: proof,
      }),
    ).toThrow();
  });

  test('carries the authorization payload through unmodified', () => {
    // Arrange
    const request = {
      purchase_attempt_id: 'att_0001',
      quote_id: 'quote_0001',
      terms_hash: TERMS_HASH,
      authorization: proof,
    };

    // Act
    const parsed = checkoutRequestSchema.parse(request);

    // Assert: a normalization step here would break the signature.
    expect(parsed.authorization).toEqual(proof);
    expect(authorizationProofSchema.parse(parsed.authorization)).toEqual(proof);
  });
});

describe('checkoutResponseSchema', () => {
  test('accepts the confirmed form, which carries an order', () => {
    // Arrange
    const confirmed = { status: 'confirmed', purchase_attempt: attempt, order: makeOrder() };

    // Act / Assert
    expect(checkoutResponseSchema.parse(confirmed)).toEqual(confirmed);
  });

  test('accepts the processing form, which carries no order', () => {
    // Arrange: the timeout case — the outcome is genuinely unknown.
    const processing = { status: 'processing', purchase_attempt: attempt };

    // Act / Assert
    expect(checkoutResponseSchema.parse(processing)).toEqual(processing);
  });

  test('rejects a confirmed response with no order', () => {
    // Arrange: "confirmed" without an order would be a claim with nothing behind it.
    const hollowConfirmed = { status: 'confirmed', purchase_attempt: attempt };

    // Act / Assert
    expect(() => checkoutResponseSchema.parse(hollowConfirmed)).toThrow();
  });

  test('rejects a processing response that carries an order', () => {
    // Arrange: if the order exists the answer is "confirmed", not "unknown".
    const confusing = {
      status: 'processing',
      purchase_attempt: attempt,
      order: makeOrder(),
    };

    // Act / Assert
    expect(() => checkoutResponseSchema.parse(confusing)).toThrow();
  });

  test('rejects a status that is neither confirmed nor processing', () => {
    // Arrange: notably, `failed` is not a checkout status — failure arrives as an
    // error envelope with a non-2xx status instead.
    const failed = { status: 'failed', purchase_attempt: attempt };

    // Act / Assert
    expect(() => checkoutResponseSchema.parse(failed)).toThrow();
  });

  test('routes on the discriminant rather than on shape', () => {
    // Arrange
    const processing = { status: 'processing', purchase_attempt: attempt };

    // Act
    const parsed = checkoutResponseSchema.parse(processing);

    // Assert: narrowing on `status` must reach the processing branch.
    expect(parsed.status).toBe('processing');
    expect('order' in parsed).toBe(false);
  });
});

describe('permissive schema identity', () => {
  test('purchaseAttemptResponseSchema is the attempt schema itself', () => {
    // Arrange / Act / Assert
    expect(purchaseAttemptResponseSchema.parse(attempt)).toEqual(attempt);
  });

  test('orderResponseSchema accepts an order and rejects an attempt', () => {
    // Arrange / Act / Assert
    const order = makeOrder();
    expect(orderResponseSchema.parse(order)).toEqual(order);
    expect(() => orderResponseSchema.parse(attempt)).toThrow();
  });
});

describe('query response envelope', () => {
  test('a quote response validates as a quote', () => {
    // Arrange / Act / Assert
    const quote = makeQuote();
    expect(createQuoteResponseSchema.parse(quote)).toEqual(quote);
  });
});

describe('checkoutConfirmedResponseSchema and checkoutProcessingResponseSchema', () => {
  test('agree with the union they belong to', () => {
    // Arrange
    const confirmed = { status: 'confirmed', purchase_attempt: attempt, order: makeOrder() };
    const processing = { status: 'processing', purchase_attempt: attempt };

    // Act / Assert: both branches must be parseable on their own and via the union.
    expect(checkoutResponseSchema.parse(confirmed)).toEqual(confirmed);
    expect(checkoutResponseSchema.parse(processing)).toEqual(processing);
    expect(checkoutProcessingResponseSchema.parse(processing)).toEqual(processing);
  });
});
