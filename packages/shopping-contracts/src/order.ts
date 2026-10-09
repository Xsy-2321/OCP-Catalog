/**
 * An order, and the events recorded around it.
 *
 * Payment and fulfillment are two separate status fields rather than one. A
 * single `status` invites exactly one bug, and it is the expensive one: showing
 * "completed" the moment the card clears, so the customer walks to the counter
 * for a coffee nobody has started making. Money and coffee are tracked apart.
 *
 * The order carries a snapshot of what was bought. If the catalog changes later,
 * the order must still say what it was.
 *
 * Note what is NOT here: no payment reference, no authorization proof. A
 * payment handle is a credential-shaped value and a query endpoint that returns
 * it is a query endpoint that leaks it. The reference stays server-side.
 */
import { z } from 'zod';
import { orderSchema, type Order } from './order-schema';
import { buildQuoteTerms } from './quote';
import { computeTermsHash, termsInconsistency } from './terms';

export * from './order-schema';

/**
 * Checks the purchased snapshot independently of transport and persistence.
 * Caller/merchant identity and indexed storage scope remain boundary checks.
 * A reason is returned without changing or repairing the order.
 */
export function orderInconsistency(order: Order): string | null {
  if (!orderSchema.safeParse(order).success) return 'order does not match its field schema';
  if (new Set(order.items.map(item => item.entry_id)).size !== order.items.length) {
    return 'order contains duplicate item identities';
  }
  const createdAt = Date.parse(order.created_at);
  if ([order.updated_at, order.payment.updated_at, order.fulfillment_status.updated_at]
    .some(timestamp => Date.parse(timestamp) < createdAt)) {
    return 'order update timestamp precedes its creation';
  }

  let subtotal = 0;
  for (const item of order.items) {
    const expected = item.unit_minor * item.quantity;
    if (![item.quantity, item.unit_minor, item.line_total_minor, expected].every(Number.isSafeInteger)) {
      return `line ${item.entry_id}: amounts or product exceed the safe integer range`;
    }
    if (item.line_total_minor !== expected) {
      return `line ${item.entry_id}: line_total_minor ${item.line_total_minor} != ${item.unit_minor} x ${item.quantity}`;
    }
    subtotal += item.line_total_minor;
    if (!Number.isSafeInteger(subtotal)) return 'item subtotal exceeds the safe integer range';
  }
  if (!Number.isSafeInteger(order.subtotal_minor) || order.subtotal_minor !== subtotal) {
    return `subtotal_minor ${order.subtotal_minor} != sum of line totals ${subtotal}`;
  }
  let fees = 0;
  for (const fee of order.fees) {
    if (!Number.isSafeInteger(fee.amount_minor)) return `fee ${fee.code}: amount exceeds the safe integer range`;
    fees += fee.amount_minor;
    if (!Number.isSafeInteger(fees)) return 'fee total exceeds the safe integer range';
  }
  const expectedTotal = subtotal + fees;
  if (!Number.isSafeInteger(order.total_minor) || !Number.isSafeInteger(expectedTotal)) {
    return 'order total exceeds the safe integer range';
  }
  if (order.total_minor !== expectedTotal) {
    return `total_minor ${order.total_minor} != subtotal ${subtotal} plus fees ${fees}`;
  }
  const terms = buildQuoteTerms(order);
  const termsProblem = termsInconsistency(terms);
  if (termsProblem !== null) return termsProblem;
  if (computeTermsHash(terms) !== order.terms_hash) return 'terms_hash does not match the order contents';
  return null;
}

export const purchaseEventSubjectTypeSchema = z.enum(['quote', 'attempt', 'order']);

export const purchaseEventTypeSchema = z.enum([
  'quote.created',
  'attempt.created',
  'attempt.confirmed',
  'attempt.failed',
  'payment.succeeded',
  'payment.failed',
  'order.created',
  'order.fulfillment_changed',
]);

export type PurchaseEventType = z.infer<typeof purchaseEventTypeSchema>;

/**
 * An appended record of something that happened.
 *
 * These are application process records, not a tamper-evident ledger: nothing
 * here is hash-chained or signed, so a claim of immutability would be false.
 * `data` must be redacted before it is stored — no signatures, no keys, no
 * payment handles.
 */
export const purchaseEventSchema = z
  .object({
    event_id: z.string().min(1),
    subject_type: purchaseEventSubjectTypeSchema,
    subject_id: z.string().min(1),
    type: purchaseEventTypeSchema,
    occurred_at: z.string().datetime(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type PurchaseEvent = z.infer<typeof purchaseEventSchema>;
