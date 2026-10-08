import { describe, expect, test } from 'bun:test';
import {
  isAttemptSettled,
  purchaseAttemptSchema,
  purchaseAttemptStatusSchema,
  type PurchaseAttempt,
} from './attempt';
import {
  fulfillmentStatusSchema,
  orderSchema,
  paymentStatusSchema,
  purchaseEventSchema,
  purchaseEventTypeSchema,
  type Order,
} from './order';

const attempt: PurchaseAttempt = {
  purchase_attempt_id: 'att_0001',
  merchant_id: 'merchant_coffee_demo',
  quote_id: 'quote_0001',
  catalog_id: 'catalog_coffee_demo',
  status: 'processing',
  created_at: '2026-10-07T10:00:00.000Z',
  updated_at: '2026-10-07T10:00:00.000Z',
};

function makeOrder(overrides: Partial<Order> = {}): Order {
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
    terms_hash: 'a'.repeat(64),
    fulfillment: { method: 'pickup', location_id: 'store_zjg' },
    payment_status: { status: 'paid', updated_at: '2026-10-07T10:00:05.000Z' },
    fulfillment_status: { status: 'pending', updated_at: '2026-10-07T10:00:05.000Z' },
    created_at: '2026-10-07T10:00:05.000Z',
    updated_at: '2026-10-07T10:00:05.000Z',
    ...overrides,
  };
}

describe('purchaseAttemptStatusSchema', () => {
  test('accepts the three states of the attempt machine', () => {
    // Arrange / Act / Assert
    for (const status of ['processing', 'confirmed', 'failed']) {
      expect(purchaseAttemptStatusSchema.parse(status)).toBe(status);
    }
  });

  test('rejects a state borrowed from the order machine', () => {
    // Arrange: `completed` belongs to fulfillment, not to the attempt.
    // Act / Assert
    expect(() => purchaseAttemptStatusSchema.parse('completed')).toThrow();
  });
});

describe('isAttemptSettled', () => {
  test('is false only while processing', () => {
    // Arrange / Act / Assert: this is the state a caller must poll through.
    expect(isAttemptSettled('processing')).toBe(false);
  });

  test('is true for both terminal states, including failure', () => {
    // Arrange / Act / Assert: a failed attempt is settled — polling it forever is wrong.
    expect(isAttemptSettled('confirmed')).toBe(true);
    expect(isAttemptSettled('failed')).toBe(true);
  });
});

describe('purchaseAttemptSchema', () => {
  test('accepts a processing attempt with no order and no error', () => {
    // Arrange / Act / Assert
    expect(purchaseAttemptSchema.parse(attempt)).toEqual(attempt);
  });

  test('accepts a confirmed attempt carrying an order id', () => {
    // Arrange
    const confirmed = { ...attempt, status: 'confirmed', order_id: 'ord_0001' };

    // Act / Assert
    expect(purchaseAttemptSchema.parse(confirmed)).toEqual(confirmed);
  });

  test('accepts a failed attempt carrying a public-safe error', () => {
    // Arrange
    const failed = {
      ...attempt,
      status: 'failed',
      error: { code: 'payment_failed', message: 'payment declined' },
    };

    // Act / Assert
    expect(purchaseAttemptSchema.parse(failed)).toEqual(failed);
  });

  test('does not expose the caller identity', () => {
    // Arrange: ownership is tracked server-side, not returned to the caller.
    const leaked = { ...attempt, caller_id: 'caller_1' };

    // Act / Assert
    expect(purchaseAttemptSchema.parse(attempt)).not.toHaveProperty('caller_id');
    expect(() => purchaseAttemptSchema.parse(leaked)).toThrow();
  });

  test('does not carry the authorization proof that created it', () => {
    // Arrange: a stored proof would be a replayable credential behind a read endpoint.
    const withProof = { ...attempt, authorization: { scheme: 'ed25519' } };

    // Act / Assert
    expect(() => purchaseAttemptSchema.parse(withProof)).toThrow();
  });
});

describe('paymentStatusSchema and fulfillmentStatusSchema', () => {
  test('keep the money vocabulary out of fulfillment', () => {
    // Arrange
    const fulfillment = fulfillmentStatusSchema.options as readonly string[];

    // Act / Assert: `paid` on a fulfillment field is how a cleared card gets
    // mistaken for a coffee that has been made.
    for (const moneyStatus of ['paid', 'failed', 'unknown']) {
      expect(fulfillment).not.toContain(moneyStatus);
    }
  });

  test('keep the counter vocabulary out of payment', () => {
    // Arrange
    const payment = paymentStatusSchema.options as readonly string[];

    // Act / Assert
    for (const counterStatus of ['ready', 'completed', 'cancelled']) {
      expect(payment).not.toContain(counterStatus);
    }
  });

  test('share only `pending`, and mean different things by it', () => {
    // Arrange: the single shared word is a stated part of the contract, so it is
    // asserted rather than assumed — a new shared member should fail this test.
    const payment = paymentStatusSchema.options as readonly string[];
    const fulfillment = fulfillmentStatusSchema.options as readonly string[];

    // Act
    const overlap = payment.filter((s) => fulfillment.includes(s));

    // Assert: payment `pending` = unpaid, fulfillment `pending` = unmade.
    expect(overlap).toEqual(['pending']);
  });

  test('allow payment and fulfillment to disagree, in both directions', () => {
    // Arrange: paid but not made, and made but not paid.
    const paidNotMade = makeOrder({
      payment_status: { status: 'paid', updated_at: '2026-10-07T10:00:05.000Z' },
      fulfillment_status: { status: 'pending', updated_at: '2026-10-07T10:00:05.000Z' },
    });
    const madeNotPaid = makeOrder({
      payment_status: { status: 'pending', updated_at: '2026-10-07T10:00:05.000Z' },
      fulfillment_status: { status: 'ready', updated_at: '2026-10-07T10:00:05.000Z' },
    });

    // Act / Assert
    expect(orderSchema.parse(paidNotMade).payment_status.status).toBe('paid');
    expect(orderSchema.parse(paidNotMade).fulfillment_status.status).toBe('pending');
    expect(orderSchema.parse(madeNotPaid).fulfillment_status.status).toBe('ready');
    expect(orderSchema.parse(madeNotPaid).payment_status.status).toBe('pending');
  });

  test('distinguish an unknown payment outcome from a pending one', () => {
    // Arrange: `unknown` is what a timed-out checkout leaves behind.
    const unknown = makeOrder({
      payment_status: { status: 'unknown', updated_at: '2026-10-07T10:00:05.000Z' },
    });

    // Act
    const parsed = orderSchema.parse(unknown);

    // Assert: collapsing these two would tell the user "not paid" when we do not know.
    expect(parsed.payment_status.status).toBe('unknown');
    expect(parsed.payment_status.status).not.toBe('pending');
  });
});

describe('orderSchema', () => {
  test('accepts a well-formed order', () => {
    // Arrange / Act / Assert
    const order = makeOrder();
    expect(orderSchema.parse(order)).toEqual(order);
  });

  test('snapshots the purchased items rather than referencing the catalog', () => {
    // Arrange: the order must still describe the purchase after a catalog change.
    const order = makeOrder();

    // Act
    const parsed = orderSchema.parse(order);

    // Assert
    expect(parsed.items[0].title).toBe('拿铁');
    expect(parsed.items[0].unit_minor).toBe(2500);
  });

  test('carries no payment reference', () => {
    // Arrange: a payment handle is credential-shaped and this schema is returned
    // from a query endpoint.
    const withReference = { ...makeOrder(), payment_reference: 'pi_3Oxxxx' };

    // Act / Assert
    expect(orderSchema.parse(makeOrder())).not.toHaveProperty('payment_reference');
    expect(() => orderSchema.parse(withReference)).toThrow();
  });

  test('carries no authorization proof', () => {
    // Arrange
    const withProof = { ...makeOrder(), authorization: { scheme: 'ed25519' } };

    // Act / Assert
    expect(() => orderSchema.parse(withProof)).toThrow();
  });

  test('rejects an order with no items', () => {
    // Arrange
    const empty = { ...makeOrder(), items: [] };

    // Act / Assert
    expect(() => orderSchema.parse(empty)).toThrow();
  });

  test('rejects an unknown top-level field', () => {
    // Arrange / Act / Assert
    expect(() => orderSchema.parse({ ...makeOrder(), discount_code: 'X' })).toThrow();
  });

  test('rejects a payment block that omits its timestamp', () => {
    // Arrange: a status with no time cannot be ordered against anything else.
    const timeless = { ...makeOrder(), payment_status: { status: 'paid' } };

    // Act / Assert
    expect(() => orderSchema.parse(timeless)).toThrow();
  });
});

describe('purchaseEventSchema', () => {
  test('accepts each declared event type', () => {
    // Arrange
    const types = purchaseEventTypeSchema.options;

    // Act / Assert
    for (const type of types) {
      const event = {
        event_id: 'evt_0001',
        subject_type: 'order',
        subject_id: 'ord_0001',
        type,
        occurred_at: '2026-10-07T10:00:05.000Z',
        data: {},
      };
      expect(purchaseEventSchema.parse(event)).toEqual(event);
    }
  });

  test('rejects an undeclared event type', () => {
    // Arrange
    const invented = {
      event_id: 'evt_0001',
      subject_type: 'order',
      subject_id: 'ord_0001',
      type: 'order.shipped',
      occurred_at: '2026-10-07T10:00:05.000Z',
      data: {},
    };

    // Act / Assert
    expect(() => purchaseEventSchema.parse(invented)).toThrow();
  });

  test('rejects an undeclared subject type', () => {
    // Arrange
    const wrongSubject = {
      event_id: 'evt_0001',
      subject_type: 'user',
      subject_id: 'user_1',
      type: 'order.created',
      occurred_at: '2026-10-07T10:00:05.000Z',
      data: {},
    };

    // Act / Assert
    expect(() => purchaseEventSchema.parse(wrongSubject)).toThrow();
  });

  test('requires the redacted data bag to be present', () => {
    // Arrange: an absent bag would leave redaction to chance.
    const withoutData = {
      event_id: 'evt_0001',
      subject_type: 'order',
      subject_id: 'ord_0001',
      type: 'order.created',
      occurred_at: '2026-10-07T10:00:05.000Z',
    };

    // Act / Assert
    expect(() => purchaseEventSchema.parse(withoutData)).toThrow();
  });
});
