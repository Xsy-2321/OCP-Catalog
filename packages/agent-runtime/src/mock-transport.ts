import { createHash, type KeyObject } from 'node:crypto';
import { computeTermsHash, quoteTermsSchema, TERMS_DOMAIN } from '@ocp-catalog/shopping-contracts';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyLocalMockProof } from './authorization';
import { FlowError } from './errors';
import { atomicJsonWrite, SerialQueue } from './store';
import { mergeSelections } from './validation';
import type { BasketSelection, Candidate, CheckoutInput, Intent, MerchantAttempt, MerchantPort, Order, Quote, ReadOperationOptions } from './types';

export const MOCK_ORIGIN = 'http://127.0.0.1:4401';
export type MockFault = 'none' | 'response_lost' | 'payment_failed' | 'processing' | 'out_of_stock' | 'requote_required';
export interface MockOptions { fault?: MockFault; now?: () => number; quoteTtlMs?: number }

// A-owned development fixtures. They are NOT B's facts or the shared fixtures/shopping.
export const MOCK_CANDIDATES: readonly Candidate[] = [
  { entry_id: 'mock_latte', catalog_id: 'mock_coffee_catalog', merchant_id: 'coffee-demo', title: '经典拿铁',
    description: '双份浓缩 · 绵密奶泡 · 到店自取', search_price_minor: 2600, currency: 'CNY', in_stock: true, fulfillment_methods: ['pickup', 'delivery'] },
  { entry_id: 'mock_special_latte', catalog_id: 'mock_coffee_catalog', merchant_id: 'coffee-demo', title: '特调拿铁',
    description: '焦糖风味 · 最终报价另含打包费', search_price_minor: 2900, currency: 'CNY', in_stock: true, fulfillment_methods: ['pickup'] },
  { entry_id: 'mock_espresso', catalog_id: 'mock_coffee_catalog', merchant_id: 'coffee-demo', title: '浓缩咖啡',
    description: '双份浓缩 · 醇厚坚果香', search_price_minor: 1800, currency: 'CNY', in_stock: true, fulfillment_methods: ['pickup', 'delivery'] },
  { entry_id: 'mock_sold_out', catalog_id: 'mock_coffee_catalog', merchant_id: 'coffee-demo', title: '燕麦拿铁（售罄）',
    description: '缺货测试样例', search_price_minor: 2600, currency: 'CNY', in_stock: false },
];

interface MockData {
  quotes: Record<string, Quote>;
  attempts: Record<string, { user_id: string; fingerprint: string; key: string; result: MerchantAttempt }>;
  orders: Record<string, { user_id: string; order: Order }>;
  payment_count: number;
}

/** Fixed local transport for C1; JSON + process queue are NOT B's final atomic DB/payment implementation. */
export class MockMerchantTransport implements MerchantPort {
  readonly mode = 'mock' as const;
  private readonly queue = new SerialQueue();
  private readonly now: () => number;
  private readonly file: string;
  checkoutCalls = 0;
  constructor(private readonly directory: string, private readonly trustedKey: KeyObject, private readonly options: MockOptions = {}) {
    this.now = options.now ?? Date.now;
    this.file = join(directory, 'mock-transport.json');
  }
  async search(intent: Intent, options: ReadOperationOptions = {}): Promise<Candidate[]> {
    options.signal?.throwIfAborted();
    const query = intent.query.toLowerCase();
    const keyword = /latte|拿铁/.test(query) ? '拿铁' : /espresso|浓缩/.test(query) ? '浓缩' : '';
    return MOCK_CANDIDATES.filter(candidate => (!keyword || candidate.title.includes(keyword))
      && candidate.currency === intent.currency && candidate.in_stock
      && (intent.fulfillment !== 'delivery' || candidate.fulfillment_methods?.includes('delivery'))
      && candidate.search_price_minor * intent.quantity <= intent.max_total_minor).map(value => structuredClone(value));
  }
  async resolve(candidate: Candidate, _intent?: Intent, options: ReadOperationOptions = {}) {
    options.signal?.throwIfAborted();
    this.product(candidate.entry_id);
    return { checkout_url: `${MOCK_ORIGIN}/commerce/v1/checkouts`, expires_at: new Date(this.now() + 300_000).toISOString() };
  }
  async quote(userId: string, candidate: Candidate, intent: Intent, options: ReadOperationOptions = {}): Promise<Quote> {
    return this.quoteBasket(userId, [{ candidate, quantity: intent.quantity }], intent, options);
  }
  async quoteBasket(userId: string, selections: BasketSelection[], intent: Intent, options: ReadOperationOptions = {}): Promise<Quote> {
    options.signal?.throwIfAborted();
    return this.queue.run('data', async () => {
      options.signal?.throwIfAborted();
      const merged = mergeSelections(selections);
      if (!merged.length || merged.reduce((sum, selection) => sum + selection.quantity, 0) !== intent.quantity) throw new FlowError('invalid_request', '整单杯数无效。');
      const items = merged.map(selection => {
        const product = this.product(selection.candidate.entry_id);
        if (!product.in_stock) throw new FlowError('out_of_stock', '商品已售罄。');
        if (!Number.isSafeInteger(selection.quantity) || selection.quantity < 1
          || !product.fulfillment_methods?.includes(intent.fulfillment)) throw new FlowError('invalid_request', '商品不支持所选履约方式或杯数。');
        return { entry_id: product.entry_id, title: product.title, quantity: selection.quantity,
          unit_price_minor: product.search_price_minor, line_total_minor: product.search_price_minor * selection.quantity };
      });
      const fees = [{ label: '打包服务费', amount_minor: 200 }, ...(intent.fulfillment === 'delivery' ? [{ label: '配送费', amount_minor: 500 }] : [])];
      const total = items.reduce((sum, item) => sum + item.line_total_minor, 0) + fees.reduce((sum, fee) => sum + fee.amount_minor, 0);
      const quoteId = `mock_quote_${crypto.randomUUID()}`;
      const wireTerms = quoteTermsSchema.parse({ v: TERMS_DOMAIN, merchant_id: intent.merchant_id, quote_id: quoteId,
        currency: intent.currency, total_minor: total,
        items: items.map(item => ({ entry_id: item.entry_id, quantity: item.quantity, unit_minor: item.unit_price_minor })),
        fees: fees.map((fee, index) => ({ code: index === 0 ? 'packing' : 'delivery', amount_minor: fee.amount_minor })),
        fulfillment: { method: intent.fulfillment, ...(intent.delivery ? { delivery: intent.delivery } : {}) } });
      const quote: Quote = {
        user_id: userId, merchant_id: intent.merchant_id, catalog_id: merged[0]!.candidate.catalog_id,
        entry_id: items[0]!.entry_id, title: items[0]!.title, unit_price_minor: items[0]!.unit_price_minor,
        quantity: intent.quantity, currency: intent.currency, fulfillment: intent.fulfillment,
        ...(intent.delivery ? { delivery: structuredClone(intent.delivery) } : {}), items,
        fees: fees.map((fee, index) => ({ ...fee, ...(intent.items.length > 1 || intent.fulfillment === 'delivery' ? { code: index === 0 ? 'packing' : 'delivery' } : {}) })), total_minor: total,
        quote_id: quoteId, terms_hash: computeTermsHash(wireTerms), wire_terms: wireTerms,
        expires_at: new Date(this.now() + (this.options.quoteTtlMs ?? 120_000)).toISOString(),
      };
      const data = await this.read();
      options.signal?.throwIfAborted();
      data.quotes[quote.quote_id] = quote; await this.write(data);
      options.signal?.throwIfAborted();
      return structuredClone(quote);
    });
  }
  async checkout(input: CheckoutInput): Promise<MerchantAttempt> {
    this.checkoutCalls += 1;
    return this.queue.run('data', async () => {
      const data = await this.read();
      const quote = data.quotes[input.quote_id];
      if (!quote || quote.user_id !== input.user_id) throw new FlowError('not_found', '找不到报价。', 404);
      if (input.checkout_url !== `${MOCK_ORIGIN}/commerce/v1/checkouts`) throw new FlowError('authorization_invalid', '模拟结账入口无效。');
      const fingerprint = createHash('sha256').update(JSON.stringify({
        user: input.user_id, attempt: input.purchase_attempt_id, quote: input.quote_id, hash: input.terms_hash,
      })).digest('hex');
      const original = Object.values(data.attempts).find(attempt => attempt.user_id === input.user_id && attempt.key === input.idempotency_key);
      if (original) {
        if (original.fingerprint !== fingerprint) throw new FlowError('idempotency_conflict', '同一幂等键对应了不同请求。', 409);
        return structuredClone(original.result);
      }
      if (data.attempts[input.purchase_attempt_id]) throw new FlowError('idempotency_conflict', '购买尝试已经存在。', 409);
      const claims = verifyLocalMockProof(input.authorization_proof, this.trustedKey, this.now());
      if (claims.user_id !== input.user_id || claims.purchase_attempt_id !== input.purchase_attempt_id
        || claims.quote_id !== quote.quote_id || claims.terms_hash !== quote.terms_hash || input.terms_hash !== quote.terms_hash
        || claims.merchant_id !== quote.merchant_id || claims.entry_id !== quote.entry_id
        || claims.quantity !== quote.quantity || claims.fulfillment !== quote.fulfillment || claims.currency !== quote.currency) {
        throw new FlowError('authorization_invalid', '模拟购买许可与本次交易不匹配。');
      }
      if (!Number.isSafeInteger(claims.max_total_minor) || quote.total_minor > claims.max_total_minor) throw new FlowError('budget_exceeded', '模拟报价超过许可金额。');
      if (Date.parse(quote.expires_at) <= this.now()) throw new FlowError('quote_expired', '模拟报价已过期。');
      if (this.options.fault === 'out_of_stock') throw new FlowError('out_of_stock', '结账时商品缺货。');
      if (this.options.fault === 'requote_required') throw new FlowError('requote_required', '模拟商家条款变更，需要重新报价。');
      let result: MerchantAttempt;
      if (this.options.fault === 'payment_failed') {
        result = { purchase_attempt_id: input.purchase_attempt_id, status: 'failed', error: { code: 'payment_failed', message: '本地模拟付款失败。' } };
      } else if (this.options.fault === 'processing') {
        result = { purchase_attempt_id: input.purchase_attempt_id, status: 'processing' };
      } else {
        const order: Order = {
          order_id: `mock_order_${crypto.randomUUID()}`, purchase_attempt_id: input.purchase_attempt_id,
          title: quote.title, quantity: quote.quantity, currency: quote.currency, total_minor: quote.total_minor,
          payment_status: 'paid', fulfillment_status: 'preparing', updated_at: new Date(this.now()).toISOString(),
          items: quote.items && structuredClone(quote.items), fulfillment: quote.fulfillment,
          ...(quote.delivery ? { delivery: structuredClone(quote.delivery) } : {}),
          merchant_id: quote.merchant_id, catalog_id: quote.catalog_id, quote_id: quote.quote_id,
          terms_hash: quote.terms_hash, entry_id: quote.entry_id, wire_terms: quote.wire_terms && structuredClone(quote.wire_terms),
        };
        data.payment_count += 1;
        data.orders[order.order_id] = { user_id: input.user_id, order };
        result = { purchase_attempt_id: input.purchase_attempt_id, status: 'confirmed', order_id: order.order_id };
      }
      data.attempts[input.purchase_attempt_id] = { user_id: input.user_id, key: input.idempotency_key, fingerprint, result };
      await this.write(data);
      if (this.options.fault === 'response_lost') throw new Error('mock response lost after saved success');
      return structuredClone(result);
    });
  }
  async getAttempt(userId: string, id: string): Promise<MerchantAttempt> {
    const attempt = (await this.read()).attempts[id];
    if (!attempt || attempt.user_id !== userId) throw new FlowError('not_found', '找不到原购买尝试。', 404);
    return structuredClone(attempt.result);
  }
  async getOrder(userId: string, id: string): Promise<Order> {
    const order = (await this.read()).orders[id];
    if (!order || order.user_id !== userId) throw new FlowError('not_found', '找不到订单。', 404);
    return structuredClone(order.order);
  }
  async diagnostics(): Promise<{ payment_count: number; order_count: number }> {
    const data = await this.read();
    return { payment_count: data.payment_count, order_count: Object.keys(data.orders).length };
  }
  private product(entryId: string) {
    const product = MOCK_CANDIDATES.find(candidate => candidate.entry_id === entryId);
    if (!product) throw new FlowError('not_found', '商品不在固定开发样例中。', 404);
    return product;
  }
  private async read(): Promise<MockData> {
    try { return JSON.parse(await readFile(this.file, 'utf8')) as MockData; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { quotes: {}, attempts: {}, orders: {}, payment_count: 0 };
      throw error;
    }
  }
  private async write(data: MockData) { await mkdir(this.directory, { recursive: true }); await atomicJsonWrite(this.file, data); }
}
