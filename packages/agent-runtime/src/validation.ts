import { FlowError } from './errors';
import { canonicalJson, computeTermsHash, deliveryAddressSchema, quoteTermsSchema, termsInconsistency, yuanToMinor } from '@ocp-catalog/shopping-contracts';
import type { BasketSelection, Candidate, Intent, LegacyIntent, LegacyQuote, PricedItem } from './types';
import { normalizeIntent } from './basket-model';

export function parseIntent(input: unknown, trustedMerchants: readonly string[] = ['coffee-demo']): Intent {
  if (!input || typeof input !== 'object') throw new FlowError('invalid_request', '请填写购物需求。');
  const value = input as Record<string, unknown>;
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 500
    || !Number.isSafeInteger(value.quantity) || (value.quantity as number) < 1 || (value.quantity as number) > 20
    || value.currency !== 'CNY' || !Number.isSafeInteger(value.max_total_minor)
    || (value.max_total_minor as number) < 1 || (value.max_total_minor as number) > 1_000_000
    || typeof value.merchant_id !== 'string' || !trustedMerchants.includes(value.merchant_id)
    || typeof value.fulfillment !== 'string' || !['pickup', 'delivery'].includes(value.fulfillment)) {
    throw new FlowError('invalid_request', '请使用本地咖啡店、人民币整数分预算和 1–20 杯的有效需求。');
  }
  let items: LegacyIntent['items'];
  if (value.items !== undefined) {
    if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 10) throw new FlowError('invalid_request', '整单需包含 1–10 行商品需求。');
    items = value.items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.query !== 'string' || !item.query.trim()
        || item.query.length > 500 || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 20
        || Object.keys(item).some(key => !['query', 'quantity'].includes(key))) throw new FlowError('invalid_request', '每行商品需填写关键词和 1–20 杯的整数数量。');
      return { query: item.query.trim(), quantity: item.quantity as number };
    });
    if (items.reduce((sum, item) => sum + item.quantity, 0) !== value.quantity) throw new FlowError('invalid_request', '商品各行杯数之和必须等于整单杯数。');
  }
  let delivery: Intent['delivery'];
  if (value.fulfillment === 'delivery') {
    const parsed = deliveryAddressSchema.safeParse(value.delivery);
    if (!parsed.success) throw new FlowError('invalid_request', '配送需填写有效的收件人、手机号和地址。');
    delivery = parsed.data;
  } else if (value.delivery !== undefined) throw new FlowError('invalid_request', '到店自取不能附带配送信息。');
  return normalizeIntent({
    query: value.query.trim(), quantity: value.quantity as number, currency: 'CNY',
    max_total_minor: value.max_total_minor as number, merchant_id: value.merchant_id, fulfillment: value.fulfillment as Intent['fulfillment'],
    ...(items ? { items } : {}), ...(delivery ? { delivery } : {}),
  });
}

export function intentItems(intent: Intent) { return intent.items; }
/** Only the legacy port/storage adapter synthesizes missing priced lines. */
export function quoteItems(quote: Pick<LegacyQuote, 'items' | 'entry_id' | 'title' | 'quantity' | 'unit_price_minor'>): readonly PricedItem[] {
  return quote.items ?? [{ entry_id: quote.entry_id, title: quote.title, quantity: quote.quantity,
    unit_price_minor: quote.unit_price_minor, line_total_minor: quote.unit_price_minor * quote.quantity }];
}
export function sameDelivery(left: Intent['delivery'], right: Intent['delivery']) {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}
export function mergeSelections(selections: BasketSelection[]): BasketSelection[] {
  const merged = new Map<string, BasketSelection>();
  for (const selection of selections) {
    const original = merged.get(selection.candidate.entry_id);
    if (original) original.quantity += selection.quantity;
    else merged.set(selection.candidate.entry_id, { candidate: structuredClone(selection.candidate), quantity: selection.quantity });
  }
  return [...merged.values()];
}

export function assertQuote(quote: LegacyQuote, userId: string, selection: Candidate | BasketSelection[], intent: Intent, now: number) {
  if ((intent.items.length > 1 || intent.fulfillment === 'delivery') && !quote.wire_terms) throw new FlowError('invalid_quote', '整单或配送报价必须附带完整条款快照。');
  const selected = mergeSelections(Array.isArray(selection) ? selection : [{ candidate: selection, quantity: intent.quantity }]);
  const lines = quoteItems(quote), first = lines[0];
  const subtotal = lines.reduce((sum, item) => sum + item.line_total_minor, 0);
  const fees = Array.isArray(quote.fees) ? quote.fees.reduce((sum, fee) => sum + fee.amount_minor, 0) : NaN;
  if (!first || lines.length !== selected.length || new Set(lines.map(item => item.entry_id)).size !== lines.length
    || quote.user_id !== userId || quote.entry_id !== first.entry_id || quote.unit_price_minor !== first.unit_price_minor
    || quote.merchant_id !== intent.merchant_id || quote.quantity !== intent.quantity
    || quote.fulfillment !== intent.fulfillment || quote.currency !== intent.currency
    || !sameDelivery(quote.delivery, intent.delivery)
    || selected.some(({ candidate, quantity }) => !lines.some(item => item.entry_id === candidate.entry_id && item.quantity === quantity)
      || candidate.merchant_id !== quote.merchant_id || (quote.catalog_id !== undefined && candidate.catalog_id !== quote.catalog_id))
    || lines.reduce((sum, item) => sum + item.quantity, 0) !== intent.quantity
    || lines.some(item => !Number.isSafeInteger(item.quantity) || item.quantity < 1
      || !Number.isSafeInteger(item.unit_price_minor) || item.unit_price_minor < 0
      || !Number.isSafeInteger(item.line_total_minor) || item.line_total_minor !== item.unit_price_minor * item.quantity)
    || !quote.quote_id || !quote.terms_hash || !Array.isArray(quote.fees)
    || !Number.isSafeInteger(quote.unit_price_minor) || quote.unit_price_minor < 0
    || !Number.isSafeInteger(quote.total_minor) || quote.total_minor < 0
    || quote.fees.some(fee => !Number.isSafeInteger(fee.amount_minor))
    || !Number.isSafeInteger(subtotal) || !Number.isSafeInteger(fees) || subtotal + fees !== quote.total_minor) {
    throw new FlowError('invalid_quote', '商家报价与所选商品或费用明细不一致。');
  }
  if (quote.wire_terms) {
    const parsed = quoteTermsSchema.safeParse(quote.wire_terms);
    if (!parsed.success) throw new FlowError('invalid_quote', '商家条款格式无效。');
    const terms = parsed.data;
    const feeAmounts = (fees: { amount_minor: number }[]) => fees.map(fee => fee.amount_minor).sort((left, right) => left - right);
    if (computeTermsHash(terms) !== quote.terms_hash || terms.merchant_id !== quote.merchant_id || terms.quote_id !== quote.quote_id
      || terms.currency !== quote.currency || terms.total_minor !== quote.total_minor || terms.fulfillment.method !== quote.fulfillment
      || termsInconsistency(terms) !== null || canonicalJson(feeAmounts(terms.fees)) !== canonicalJson(feeAmounts(quote.fees))
      || quote.fees.some(fee => fee.code !== undefined && !terms.fees.some(term => term.code === fee.code && term.amount_minor === fee.amount_minor))
      || terms.fulfillment.location_id !== undefined || !sameDelivery(terms.fulfillment.delivery, quote.delivery)
      || terms.items.length !== lines.length || new Set(terms.items.map(item => item.entry_id)).size !== terms.items.length
      || terms.items.some(item => !lines.some(line => line.entry_id === item.entry_id
        && line.quantity === item.quantity && line.unit_price_minor === item.unit_minor))) throw new FlowError('invalid_quote', '商家条款与整单报价不一致。');
  }
  if (!Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= now) {
    throw new FlowError('quote_expired', '报价已过期，请重新报价并确认。');
  }
  if (quote.total_minor > intent.max_total_minor) throw new FlowError('budget_exceeded', '含全部费用的最终报价超过预算，不能购买。');
}

export function ocpAmountToMinor(amount: number): number {
  try { return yuanToMinor(amount); }
  catch {
    throw new FlowError('invalid_price', '目录金额无法精确换算为人民币整数分。');
  }
}

export function trustedUrl(value: string, origin: string, allowedPaths: readonly string[]): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new FlowError('untrusted_endpoint', '商家操作地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(origin).origin
    || url.username || url.password || url.search || url.hash || !allowedPaths.includes(url.pathname)) {
    throw new FlowError('untrusted_endpoint', '商家操作地址不在预配置的可信来源和路径中。');
  }
  return url.href;
}
