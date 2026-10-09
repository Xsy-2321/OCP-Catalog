import type { Intent, LegacyIntent, LegacyQuote, Quote, Session } from './types';
import { FlowError } from './errors';

export function normalizeIntent(intent: LegacyIntent): Intent {
  const items = intent.items ?? [{ query: intent.query, quantity: intent.quantity }];
  if (!items.length) throw new FlowError('invalid_request', '购物需求至少包含一行商品。');
  if (items.some(item => !item || typeof item.query !== 'string' || !item.query.trim()
    || !Number.isSafeInteger(item.quantity) || item.quantity < 1)
    || items.reduce((sum, item) => sum + item.quantity, 0) !== intent.quantity) {
    throw new FlowError('invalid_request', '购物篮的商品明细与总数量不一致。');
  }
  // Supplied aggregates are checked at input validation; aggregates are never
  // independently edited inside the runtime.
  return { ...intent, items: items.map(item => ({ query: item.query, quantity: item.quantity })),
    query: items.map(item => item.query).join(' / ').slice(0, 500),
    quantity: items.reduce((sum, item) => sum + item.quantity, 0) };
}
export function normalizeQuote(quote: LegacyQuote): Quote {
  const items = quote.items ?? [{ entry_id: quote.entry_id, title: quote.title, quantity: quote.quantity,
    unit_price_minor: quote.unit_price_minor, line_total_minor: quote.unit_price_minor * quote.quantity }];
  if (!items.length) throw new FlowError('invalid_quote', '商家报价缺少商品明细。');
  if (quote.entry_id !== items[0]!.entry_id || quote.unit_price_minor !== items[0]!.unit_price_minor
    || quote.quantity !== items.reduce((sum, item) => sum + item.quantity, 0)) {
    throw new FlowError('invalid_quote', '商家报价的派生字段与购物篮不一致。');
  }
  // Do not repair inconsistent legacy aggregates: assertQuote must see the
  // merchant's original fields and reject disagreement before confirmation.
  return { ...quote, items: items.map(item => ({ ...item })) };
}

/** Adapt old persisted single-item fields; preserve signed terms and purchase evidence. */
export function normalizeStoredSession(session: Session): Session {
  const normalized = { ...session, intent: normalizeIntent(session.intent) };
  const legacy = session as Session & { selected?: Session['candidates'][number]; selected_items?: Session['selection'] };
  normalized.selection ??= legacy.selected_items ?? (legacy.selected
    ? [{ candidate: legacy.selected, quantity: session.intent.quantity }] : undefined);
  if (session.quote) normalized.quote = normalizeQuote(session.quote);
  if (session.attempt_history) normalized.attempt_history = session.attempt_history.map(history =>
    ({ ...history, quote: normalizeQuote(history.quote) }));
  if (!normalized.candidate_groups && normalized.candidates.length) normalized.candidate_groups = [{
    query: normalized.intent.query, quantity: normalized.intent.quantity, candidates: normalized.candidates }];
  delete (normalized as typeof legacy).selected;
  delete (normalized as typeof legacy).selected_items;
  return normalized;
}
