/**
 * Idempotency for checkout (contract §5 D4).
 *
 * The guarantee: two requests carrying the same `Idempotency-Key` from the same
 * caller produce exactly one payment and exactly one order, whether they arrive
 * one after the other or at the same moment.
 *
 * The mechanism is a UNIQUE constraint, not application bookkeeping. Two
 * requests that each read "no record exists" and then each proceed is the
 * classic way a duplicate order is created, and no amount of care in the read
 * fixes it — only the write can. So the record is inserted inside the same
 * `BEGIN IMMEDIATE` transaction that does the work, which means a competing
 * request cannot even begin until the first has committed, and will then see a
 * settled record rather than an empty table.
 *
 * What the record compares is a digest of the *business* request — attempt id,
 * quote id, terms hash — and never transport details. A retry that re-serializes
 * its body, reorders its headers or re-signs with a fresh `jti` is the same
 * business request and must replay; including any of those in the digest would
 * turn a legitimate retry into a spurious conflict.
 */
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { canonicalJson } from '@ocp-catalog/shopping-contracts';

/**
 * Domain tag mixed into the digest.
 *
 * Without it, a digest computed here and a hash computed for some future
 * purpose from the same three fields would be equal, and "equal digest" would
 * quietly start meaning two different things.
 */
export const IDEMPOTENCY_DIGEST_DOMAIN = 'ocp.demo.idempotency.v1';

export interface CheckoutDigestInput {
  readonly purchaseAttemptId: string;
  readonly quoteId: string;
  readonly termsHash: string;
}

export function computeCheckoutDigest(input: CheckoutDigestInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        v: IDEMPOTENCY_DIGEST_DOMAIN,
        purchase_attempt_id: input.purchaseAttemptId,
        quote_id: input.quoteId,
        terms_hash: input.termsHash,
      }),
      'utf8',
    )
    .digest('hex');
}

export interface IdempotencyParams {
  readonly callerId: string;
  readonly merchantId: string;
  readonly idemKey: string;
  readonly requestDigest: string;
  readonly purchaseAttemptId: string;
  readonly nowMs: number;
}

export type IdempotencyLookup =
  /** No record existed; one has now been claimed for this request. */
  | { readonly kind: 'new' }
  /** The same business request has already been settled; replay its answer. */
  | {
      readonly kind: 'replay';
      readonly responseStatus: number;
      readonly responseJson: string;
      readonly purchaseAttemptId: string;
    }
  /** The key was used for a different business request. */
  | { readonly kind: 'conflict' };

interface IdempotencyRow {
  request_digest: string;
  purchase_attempt_id: string;
  state: string;
  response_status: number | null;
  response_json: string | null;
}

function readRecord(db: Database, params: IdempotencyParams): IdempotencyRow | null {
  return db
    .query<IdempotencyRow, [string, string, string]>(
      `SELECT request_digest, purchase_attempt_id, state, response_status, response_json
         FROM idempotency_records
        WHERE caller_id = ? AND merchant_id = ? AND idem_key = ?`,
    )
    .get(params.callerId, params.merchantId, params.idemKey);
}

/**
 * Claims the key for this request, or reports what the key already means.
 *
 * Must be called inside the same transaction as the work, and `settle` must be
 * called before that transaction commits. A claim that is never settled would be
 * an unanswerable "in progress" — and because the claim lives in the same
 * transaction, a failure between the two rolls the claim back along with
 * everything else, so a corrected retry is re-evaluated instead of being pinned
 * to an error that no longer applies.
 */
export function beginIdempotentRequest(db: Database, params: IdempotencyParams): IdempotencyLookup {
  const existing = readRecord(db, params);

  if (existing !== null) {
    if (existing.request_digest !== params.requestDigest) return { kind: 'conflict' };
    if (existing.state !== 'settled' || existing.response_status === null || existing.response_json === null) {
      // Unreachable while claim and settle share a transaction: a competing
      // request blocks on the write lock and can only observe a committed row.
      // If it ever becomes reachable, the transaction boundary was moved and
      // the idempotency guarantee moved with it — which is worth a crash, not a
      // plausible-looking guess about an outcome nobody knows yet.
      throw new Error(
        'internal: idempotency record is not settled; claim and settle must share one transaction',
      );
    }
    return {
      kind: 'replay',
      responseStatus: existing.response_status,
      responseJson: existing.response_json,
      purchaseAttemptId: existing.purchase_attempt_id,
    };
  }

  // A plain INSERT, not INSERT OR IGNORE. If the UNIQUE constraint ever fires
  // here, the failure is that two writers got past the read above, and that is
  // a defect to surface rather than to swallow.
  db.query(
    `INSERT INTO idempotency_records
       (caller_id, merchant_id, idem_key, request_digest, purchase_attempt_id, state, response_status, response_json, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, 'processing', NULL, NULL, ?, ?)`,
  ).run(
    params.callerId,
    params.merchantId,
    params.idemKey,
    params.requestDigest,
    params.purchaseAttemptId,
    params.nowMs,
    params.nowMs,
  );

  return { kind: 'new' };
}

export interface SettleParams extends IdempotencyParams {
  readonly responseStatus: number;
  /** The exact response body, serialized. Replayed verbatim on a retry. */
  readonly responseJson: string;
}

/**
 * Records the answer for this key.
 *
 * The body is stored as it was sent, not recomputed on replay. Recomputing
 * would let a later state change rewrite history: a checkout that answered
 * "unknown" would start answering "confirmed" on a retry, and A would have no
 * way to tell a replayed answer from a fresh one.
 */
export function settleIdempotentRequest(db: Database, params: SettleParams): void {
  db.query(
    `UPDATE idempotency_records
        SET state = 'settled', response_status = ?, response_json = ?, updated_at_ms = ?
      WHERE caller_id = ? AND merchant_id = ? AND idem_key = ?`,
  ).run(
    params.responseStatus,
    params.responseJson,
    params.nowMs,
    params.callerId,
    params.merchantId,
    params.idemKey,
  );
}
