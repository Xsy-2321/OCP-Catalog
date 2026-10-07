/**
 * Appended purchase events.
 *
 * Contract §11 D10: these are application process records. Nothing here is
 * hash-chained or signed, so calling them an immutable ledger would be false,
 * and the code says so wherever it names them.
 *
 * The rule that earns this file its existence is redaction. AGENT_B.md §5
 * forbids the query surface and the event log from leaking authorization proofs,
 * signing material or payment secrets. A rule like that decays the moment it is
 * enforced by "remember not to pass that field", so it is enforced here instead:
 * `assertRedacted` walks the payload and throws on a forbidden key. The throw is
 * the point — an event that would leak is a defect, and silently writing a
 * redacted copy would leave the caller believing the original was recorded.
 */
import type { Database } from 'bun:sqlite';
import {
  newPurchaseEventId,
  purchaseEventSchema,
  type PurchaseEvent,
  type PurchaseEventType,
} from '@ocp-catalog/shopping-contracts';

/**
 * Keys that must never appear in event data.
 *
 * Matched case-insensitively on the whole key. Deliberately broad: a key named
 * `signature` or `payment_reference` is a leak whatever the intent behind it,
 * and the cost of a false positive is renaming one field.
 */
export const FORBIDDEN_EVENT_KEYS: readonly string[] = [
  'signature',
  'authorization',
  'auth_proof',
  'proof',
  'key',
  'key_id',
  'private_key',
  'secret',
  'token',
  'access_token',
  'reference',
  'payment_reference',
  'payment_key',
  'jti',
  'max_total_minor',
];

/**
 * Throws if `value` contains a forbidden key anywhere inside it.
 *
 * Walks objects and arrays recursively: a signature nested one level down leaks
 * exactly as much as one at the top.
 */
export function assertRedacted(value: unknown, path = 'data'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertRedacted(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    // The reported path is the leaking key's own path, not its parent's. "at
    // data.order.payment" tells the reader which object to open; the full path
    // tells them which line to change.
    const here = `${path}.${key}`;
    if (FORBIDDEN_EVENT_KEYS.includes(key.toLowerCase())) {
      throw new Error(`event data would leak ${JSON.stringify(key)} at ${here}; redact it before recording`);
    }
    assertRedacted(nested, here);
  }
}

export interface RecordEventParams {
  readonly subjectType: 'quote' | 'attempt' | 'order';
  readonly subjectId: string;
  readonly type: PurchaseEventType;
  readonly nowMs: number;
  readonly data: Record<string, unknown>;
}

export function recordEvent(db: Database, params: RecordEventParams): PurchaseEvent {
  assertRedacted(params.data);

  const event: PurchaseEvent = purchaseEventSchema.parse({
    event_id: newPurchaseEventId(),
    subject_type: params.subjectType,
    subject_id: params.subjectId,
    type: params.type,
    occurred_at: new Date(params.nowMs).toISOString(),
    data: params.data,
  });

  db.query(
    `INSERT INTO purchase_events (event_id, subject_type, subject_id, type, occurred_at_ms, data_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    event.event_id,
    event.subject_type,
    event.subject_id,
    event.type,
    params.nowMs,
    JSON.stringify(event.data),
  );

  return event;
}

interface EventRow {
  event_id: string;
  subject_type: string;
  subject_id: string;
  type: string;
  occurred_at_ms: number;
  data_json: string;
}

export function listEvents(db: Database, subjectId: string): readonly PurchaseEvent[] {
  // Ordered by `rowid`, not by `occurred_at_ms`. Every event of one checkout
  // shares a timestamp — they happen within the same millisecond — so ordering
  // by it would shuffle "payment succeeded" behind "order created" at random,
  // and the log would describe a sequence that never happened. `rowid` is the
  // insertion order, which is the sequence that did.
  const rows = db
    .query<EventRow, [string]>(
      `SELECT event_id, subject_type, subject_id, type, occurred_at_ms, data_json
         FROM purchase_events
        WHERE subject_id = ?
        ORDER BY rowid ASC`,
    )
    .all(subjectId);

  return rows.map((row) => purchaseEventSchema.parse({
    event_id: row.event_id,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    type: row.type,
    occurred_at: new Date(row.occurred_at_ms).toISOString(),
    data: JSON.parse(row.data_json),
  }));
}
