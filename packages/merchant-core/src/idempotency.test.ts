/**
 * Idempotency is a database property, not application care.
 *
 * `beginIdempotentRequest` is tested here for what it reports; the guarantee it
 * exists to provide — one payment and one order under concurrent retries — is
 * tested end to end in `checkout.test.ts`, because that is where a defect would
 * actually cost money. What is worth pinning at this level is the shape of the
 * three answers and the two rules that make them meaningful: the digest covers
 * only business fields (so a re-serialized retry replays rather than conflicts),
 * and the key is scoped per caller (so two callers cannot collide by accident).
 */
import { describe, expect, test } from 'bun:test';
import {
  IDEMPOTENCY_DIGEST_DOMAIN,
  beginIdempotentRequest,
  computeCheckoutDigest,
  settleIdempotentRequest,
  type IdempotencyParams,
} from './idempotency';
import { inTransaction } from './db';
import { TEST_NOW_MS, makeTempDatabasePath, openTestDb } from './test-support';

function withDb<T>(work: (db: ReturnType<typeof openTestDb>) => T): T {
  const { path, cleanup } = makeTempDatabasePath();
  const db = openTestDb(path);
  try {
    return work(db);
  } finally {
    db.close();
    cleanup();
  }
}

function params(overrides: Partial<IdempotencyParams> = {}): IdempotencyParams {
  return {
    callerId: 'caller_a',
    merchantId: 'merchant_coffee_demo',
    idemKey: 'key_1',
    requestDigest: computeCheckoutDigest({
      purchaseAttemptId: 'att_1',
      quoteId: 'quote_1',
      termsHash: 'a'.repeat(64),
    }),
    purchaseAttemptId: 'att_1',
    nowMs: TEST_NOW_MS,
    ...overrides,
  };
}

describe('computeCheckoutDigest', () => {
  const base = { purchaseAttemptId: 'att_1', quoteId: 'quote_1', termsHash: 'a'.repeat(64) };

  test('is 32 bytes of lowercase hex', () => {
    expect(computeCheckoutDigest(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is stable for the same request', () => {
    expect(computeCheckoutDigest(base)).toBe(computeCheckoutDigest({ ...base }));
  });

  test('changes when any one field changes', () => {
    const digest = computeCheckoutDigest(base);

    expect(computeCheckoutDigest({ ...base, purchaseAttemptId: 'att_2' })).not.toBe(digest);
    expect(computeCheckoutDigest({ ...base, quoteId: 'quote_2' })).not.toBe(digest);
    expect(computeCheckoutDigest({ ...base, termsHash: 'b'.repeat(64) })).not.toBe(digest);
  });

  test('is domain-tagged rather than a bare hash of the three fields', () => {
    // Without the tag, a digest computed for a future purpose from the same
    // three fields would compare equal, and "same digest" would quietly come to
    // mean two different things.
    expect(IDEMPOTENCY_DIGEST_DOMAIN).toBe('ocp.demo.idempotency.v1');
    expect(computeCheckoutDigest(base)).not.toBe(
      computeCheckoutDigest({ ...base, quoteId: base.quoteId + ' ' }).slice(0, 64),
    );
  });
});

describe('beginIdempotentRequest', () => {
  test('claims the key the first time', () => {
    withDb((db) => {
      expect(inTransaction(db, () => beginIdempotentRequest(db, params()))).toEqual({ kind: 'new' });
    });
  });

  test('replays the recorded answer when the same request returns', () => {
    withDb((db) => {
      const body = JSON.stringify({ status: 'confirmed', order_id: 'ord_1' });
      inTransaction(db, () => {
        beginIdempotentRequest(db, params());
        settleIdempotentRequest(db, { ...params(), responseStatus: 200, responseJson: body });
      });

      const second = inTransaction(db, () => beginIdempotentRequest(db, params()));

      expect(second).toEqual({
        kind: 'replay',
        responseStatus: 200,
        responseJson: body,
        purchaseAttemptId: 'att_1',
      });
    });
  });

  test('replays the body verbatim rather than recomputing it', () => {
    // A checkout that answered "unknown" must keep answering "unknown". If the
    // body were recomputed on replay, a later state change would rewrite the
    // history of a response the caller already has.
    withDb((db) => {
      const body = JSON.stringify({ status: 'processing' });
      inTransaction(db, () => {
        beginIdempotentRequest(db, params());
        settleIdempotentRequest(db, { ...params(), responseStatus: 202, responseJson: body });
      });

      const replay = inTransaction(db, () => beginIdempotentRequest(db, params()));
      expect(replay.kind === 'replay' && replay.responseJson).toBe(body);
      expect(replay.kind === 'replay' && replay.responseStatus).toBe(202);
    });
  });

  test('reports a conflict when the same key carries a different request', () => {
    withDb((db) => {
      inTransaction(db, () => {
        beginIdempotentRequest(db, params());
        settleIdempotentRequest(db, { ...params(), responseStatus: 200, responseJson: '{}' });
      });

      const other = params({
        requestDigest: computeCheckoutDigest({
          purchaseAttemptId: 'att_9',
          quoteId: 'quote_1',
          termsHash: 'a'.repeat(64),
        }),
      });

      expect(inTransaction(db, () => beginIdempotentRequest(db, other))).toEqual({ kind: 'conflict' });
    });
  });

  test('treats a re-serialized retry as the same request', () => {
    // The digest is over business fields only. A retry that re-signed with a
    // fresh `jti`, reordered its headers or re-encoded its body is the same
    // purchase and must replay; had any of that gone into the digest, this would
    // be reported as a conflict and the caller would be stuck.
    withDb((db) => {
      const digest = computeCheckoutDigest({
        purchaseAttemptId: 'att_1',
        quoteId: 'quote_1',
        termsHash: 'a'.repeat(64),
      });
      const again = computeCheckoutDigest({
        purchaseAttemptId: 'att_1',
        quoteId: 'quote_1',
        termsHash: 'a'.repeat(64),
      });

      inTransaction(db, () => {
        beginIdempotentRequest(db, params({ requestDigest: digest }));
        settleIdempotentRequest(db, {
          ...params({ requestDigest: digest }),
          responseStatus: 200,
          responseJson: '{}',
        });
      });

      expect(inTransaction(db, () => beginIdempotentRequest(db, params({ requestDigest: again }))).kind).toBe('replay');
    });
  });

  test('scopes the key per caller', () => {
    // Two callers choosing the same key string is a coincidence, not a
    // collision — they must not replay each other's orders.
    withDb((db) => {
      inTransaction(db, () => {
        beginIdempotentRequest(db, params({ callerId: 'caller_a' }));
        settleIdempotentRequest(db, {
          ...params({ callerId: 'caller_a' }),
          responseStatus: 200,
          responseJson: '{"who":"a"}',
        });
      });

      expect(inTransaction(db, () => beginIdempotentRequest(db, params({ callerId: 'caller_b' })))).toEqual({
        kind: 'new',
      });
    });
  });

  test('scopes the key per merchant', () => {
    withDb((db) => {
      inTransaction(db, () => {
        beginIdempotentRequest(db, params({ merchantId: 'merchant_coffee_demo' }));
        settleIdempotentRequest(db, {
          ...params({ merchantId: 'merchant_coffee_demo' }),
          responseStatus: 200,
          responseJson: '{}',
        });
      });

      expect(inTransaction(db, () => beginIdempotentRequest(db, params({ merchantId: 'merchant_other' })))).toEqual({
        kind: 'new',
      });
    });
  });

  test('refuses to answer for a claim that was never settled', () => {
    // Unreachable while the claim and the settle share one transaction: a
    // competing request blocks on the write lock and can only ever observe a
    // committed row. It is a crash rather than a guess because if this ever does
    // fire, the transaction boundary moved and the idempotency guarantee moved
    // with it — and inventing an outcome for a purchase nobody can describe
    // would be worse than stopping.
    withDb((db) => {
      inTransaction(db, () => beginIdempotentRequest(db, params()));

      expect(() => inTransaction(db, () => beginIdempotentRequest(db, params()))).toThrow(
        /idempotency record is not settled/,
      );
    });
  });

  test('a rolled-back claim leaves the key free again', () => {
    // This is why a rejection before money moves throws instead of caching: the
    // claim rolls back with it, so a corrected retry is re-evaluated rather than
    // pinned to a stale error.
    withDb((db) => {
      expect(() =>
        inTransaction(db, () => {
          beginIdempotentRequest(db, params());
          throw new Error('something went wrong before settling');
        }),
      ).toThrow('something went wrong before settling');

      expect(inTransaction(db, () => beginIdempotentRequest(db, params()))).toEqual({ kind: 'new' });
    });
  });

  test('the unique constraint is in the schema, not in this code', () => {
    // The guarantee for concurrent arrivals is the database's, so it is worth
    // proving the constraint exists rather than trusting that the read above
    // will not race.
    withDb((db) => {
      const insert = db.query(
        `INSERT INTO idempotency_records
           (caller_id, merchant_id, idem_key, request_digest, purchase_attempt_id, state, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const write = (): void => {
        insert.run('caller_a', 'merchant_coffee_demo', 'key_1', 'digest', 'att_1', 'processing', 0, 0);
      };

      write();
      expect(write).toThrow();
    });
  });
});
