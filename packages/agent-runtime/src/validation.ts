import { FlowError } from './errors';
import type { Candidate, Intent, Quote } from './types';

export function parseIntent(input: unknown): Intent {
  if (!input || typeof input !== 'object') throw new FlowError('invalid_request', '请填写购物需求。');
  const value = input as Record<string, unknown>;
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 500
    || !Number.isSafeInteger(value.quantity) || (value.quantity as number) < 1 || (value.quantity as number) > 20
    || value.currency !== 'CNY' || !Number.isSafeInteger(value.max_total_minor)
    || (value.max_total_minor as number) < 1 || (value.max_total_minor as number) > 1_000_000
    || value.merchant_id !== 'coffee-demo' || value.fulfillment !== 'pickup') {
    throw new FlowError('invalid_request', '请使用本地咖啡店、人民币整数分预算、1–20 杯及到店自取。');
  }
  return {
    query: value.query.trim(), quantity: value.quantity as number, currency: 'CNY',
    max_total_minor: value.max_total_minor as number, merchant_id: 'coffee-demo', fulfillment: 'pickup',
  };
}

export function assertQuote(quote: Quote, userId: string, candidate: Candidate, intent: Intent, now: number) {
  if (quote.user_id !== userId || quote.entry_id !== candidate.entry_id
    || quote.merchant_id !== intent.merchant_id || quote.quantity !== intent.quantity
    || quote.fulfillment !== intent.fulfillment || quote.currency !== intent.currency
    || !quote.quote_id || !quote.terms_hash || !Array.isArray(quote.fees)
    || !Number.isSafeInteger(quote.unit_price_minor) || quote.unit_price_minor < 0
    || !Number.isSafeInteger(quote.total_minor) || quote.total_minor < 0
    || quote.fees.some(fee => !Number.isSafeInteger(fee.amount_minor) || fee.amount_minor < 0)
    || quote.unit_price_minor * quote.quantity + quote.fees.reduce((sum, fee) => sum + fee.amount_minor, 0) !== quote.total_minor) {
    throw new FlowError('invalid_quote', '商家报价与所选商品或费用明细不一致。');
  }
  if (!Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= now) {
    throw new FlowError('quote_expired', '报价已过期，请重新报价并确认。');
  }
  if (quote.total_minor > intent.max_total_minor) throw new FlowError('budget_exceeded', '含全部费用的最终报价超过预算，不能购买。');
}

export function ocpAmountToMinor(amount: number): number {
  const minor = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(minor)
    || Math.abs(amount * 100 - minor) > 1e-7) {
    throw new FlowError('invalid_price', '目录金额无法精确换算为人民币整数分。');
  }
  return minor;
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
