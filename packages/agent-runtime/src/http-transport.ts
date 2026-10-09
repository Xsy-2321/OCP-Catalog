import {
  CHECKOUT_ACTION_ID, COMMERCE_ERROR_HTTP_STATUS, DEV_CALLER_HEADER, IDEMPOTENCY_KEY_HEADER,
  authorizationProofSchema, buildQuoteTerms, checkoutConfirmedResponseSchema,
  checkoutProcessingResponseSchema, checkoutRequestSchema, commerceErrorResponseSchema,
  computeTermsHash, createQuoteRequestSchema, createQuoteResponseSchema, orderResponseSchema, orderInconsistency,
  purchaseAttemptResponseSchema, quoteInconsistency, quoteTermsSchema, termsInconsistency,
  type CommerceErrorCode, type Order as WireOrder, type PurchaseAttempt, type Quote as WireQuote,
} from '@ocp-catalog/shopping-contracts';
import { ConfirmedPurchaseProtocolError, FlowError } from './errors';
import { OcpConsumer } from './ocp-consumer';
import { requestSignal } from './cancellation';
import { mergeSelections, ocpAmountToMinor, parseIntent, quoteItems, sameDelivery, trustedUrl } from './validation';
import type { BasketSelection, Candidate, CheckoutInput, Intent, MerchantAttempt, MerchantPort, Order, Quote, ReadOperationOptions } from './types';

export interface HttpMerchantTransportOptions {
  origin: string;
  merchantId: string;
  catalogId: string;
  manifestUrl?: string;
  discoveryUrl?: string;
  checkoutActionId?: string;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface Schema<T> { safeParse(value: unknown): { success: true; data: T } | { success: false } }

const SAFE_ERRORS: Record<CommerceErrorCode, string> = {
  invalid_request: '商家拒绝了不符合契约的请求。', unauthorized: '商家未接受当前调用身份。',
  forbidden: '当前身份没有操作权限。', quote_expired: '报价已过期，请重新报价并确认。',
  requote_required: '商家条款已变化，请重新报价并确认。', budget_exceeded: '最终金额超过确认预算。',
  out_of_stock: '商家确认商品库存不足。', authorization_invalid: '商家未接受本次购买许可。',
  idempotency_conflict: '原购买键与交易信息冲突，请查询原尝试。',
  payment_failed: '商家确认本地模拟付款失败。', not_found: '商家未返回当前身份的原记录。',
};

function protocol(): FlowError { return new FlowError('protocol_error', '商家响应未通过契约或业务绑定校验，请查询原购买尝试。', 502); }
function parse<T>(schema: Schema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw protocol();
  return result.data;
}
function identifier(value: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw protocol();
  return value;
}

/** The only commerce HTTP boundary. Payment in B remains a local simulation. */
export class HttpMerchantTransport implements MerchantPort {
  readonly mode = 'http' as const;
  private readonly origin: string;
  private readonly consumer: OcpConsumer;
  private readonly now: () => number;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpMerchantTransportOptions) {
    const configured = new URL(options.origin);
    this.origin = configured.origin;
    trustedUrl(options.origin, this.origin, ['/', '']);
    identifier(options.merchantId); identifier(options.catalogId);
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new Error('invalid merchant timeout');
    this.consumer = new OcpConsumer({
      origin: this.origin, catalogId: options.catalogId,
      manifestUrl: options.manifestUrl ?? `${this.origin}/ocp/manifest`,
      discoveryUrl: options.discoveryUrl ?? `${this.origin}/.well-known/ocp-catalog`,
      checkoutActionId: options.checkoutActionId ?? CHECKOUT_ACTION_ID,
      fetch: options.fetch,
    });
  }

  async health() { return this.consumer.health(); }

  async search(intent: Intent, options: ReadOperationOptions = {}): Promise<Candidate[]> {
    return (await this.searchWithWarnings(intent, options)).candidates;
  }

  async searchWithWarnings(intent: Intent, options: ReadOperationOptions = {}): Promise<{ candidates: Candidate[]; warnings: string[] }> {
    this.intent(intent);
    const { entries, warnings } = await this.consumer.search(intent, options);
    const candidates = entries.map(({ entry }) => {
      const price = entry.attributes.price as { amount: number; currency: string };
      const fulfillment = entry.attributes.fulfillment as { methods?: unknown } | undefined;
      const methods = Array.isArray(fulfillment?.methods)
        ? fulfillment.methods.filter((method): method is 'pickup' | 'delivery' => method === 'pickup' || method === 'delivery') : undefined;
      return {
        entry_id: entry.entry_id, catalog_id: entry.catalog_id, merchant_id: this.options.merchantId,
        title: entry.title, description: entry.summary ?? '', search_price_minor: ocpAmountToMinor(price.amount),
        currency: price.currency, in_stock: true,
        ...(methods ? { fulfillment_methods: methods } : {}),
      };
    });
    return { candidates: candidates.filter(candidate => candidate.fulfillment_methods
      ? candidate.fulfillment_methods.includes(intent.fulfillment) : intent.fulfillment === 'pickup'), warnings };
  }

  async resolve(candidate: Candidate, intent?: Intent, options: ReadOperationOptions = {}): Promise<{ checkout_url: string; expires_at: string }> {
    this.candidate(candidate);
    if (intent) this.intent(intent);
    const resolved = await this.consumer.resolve(candidate.entry_id, intent, options);
    const checkoutUrl = trustedUrl(resolved.checkout_url, this.origin, ['/commerce/v1/checkouts']);
    const expiries = [resolved.reference.expires_at, ...(resolved.binding.expires_at ? [resolved.binding.expires_at] : [])];
    if (expiries.some(value => !Number.isFinite(Date.parse(value)) || Date.parse(value) <= this.now())) throw protocol();
    return { checkout_url: checkoutUrl, expires_at: new Date(Math.min(...expiries.map(Date.parse))).toISOString() };
  }

  async quote(userId: string, candidate: Candidate, intent: Intent, options: ReadOperationOptions = {}): Promise<Quote> {
    return this.quoteBasket(userId, [{ candidate, quantity: intent.quantity }], intent, options);
  }

  async quoteBasket(userId: string, selections: BasketSelection[], intent: Intent, options: ReadOperationOptions = {}): Promise<Quote> {
    this.intent(intent);
    const merged = mergeSelections(selections);
    if (!merged.length || merged.length > 10 || merged.some(selection => !Number.isSafeInteger(selection.quantity) || selection.quantity < 1)
      || merged.reduce((sum, selection) => sum + selection.quantity, 0) !== intent.quantity) throw protocol();
    for (const selection of merged) this.candidate(selection.candidate);
    const fulfillment = { method: intent.fulfillment, ...(intent.delivery ? { delivery: intent.delivery } : {}) };
    const body = createQuoteRequestSchema.parse(intent.fulfillment === 'pickup' && merged.length === 1
      ? { entry_id: merged[0]!.candidate.entry_id, quantity: intent.quantity, fulfillment }
      : { items: merged.map(selection => ({ entry_id: selection.candidate.entry_id, quantity: selection.quantity })), fulfillment });
    const { status, value } = await this.request('/commerce/v1/quotes', userId, body, undefined, options.signal);
    if (status !== 200) throw protocol();
    const wire = parse(createQuoteResponseSchema, value);
    this.wireQuote(wire);
    const item = wire.items[0]!;
    if (wire.items.length !== merged.length || merged.some(selection => !wire.items.some(line => line.entry_id === selection.candidate.entry_id
      && line.quantity === selection.quantity)) || wire.currency !== intent.currency
      || wire.fulfillment.method !== intent.fulfillment || wire.fulfillment.location_id !== undefined
      || !sameDelivery(wire.fulfillment.delivery, intent.delivery)) throw protocol();
    if (Date.parse(wire.expires_at) <= this.now()) throw new FlowError('quote_expired', SAFE_ERRORS.quote_expired, 409);
    return {
      quote_id: wire.quote_id, user_id: identifier(userId), merchant_id: wire.merchant_id, catalog_id: wire.catalog_id,
      entry_id: item.entry_id, title: item.title, quantity: wire.items.reduce((sum, line) => sum + line.quantity, 0), fulfillment: wire.fulfillment.method, currency: wire.currency,
      ...(wire.fulfillment.delivery ? { delivery: wire.fulfillment.delivery } : {}),
      items: wire.items.map(line => ({ entry_id: line.entry_id, title: line.title, quantity: line.quantity,
        unit_price_minor: line.unit_minor, line_total_minor: line.line_total_minor })),
      unit_price_minor: item.unit_minor, fees: wire.fees.map(fee => ({ label: fee.label, amount_minor: fee.amount_minor,
        ...(intent.items.length > 1 || intent.fulfillment === 'delivery' ? { code: fee.code } : {}) })),
      total_minor: wire.total_minor, terms_hash: wire.terms_hash, expires_at: wire.expires_at,
      wire_terms: buildQuoteTerms(wire),
    };
  }

  async checkout(input: CheckoutInput): Promise<MerchantAttempt> {
    trustedUrl(input.checkout_url, this.origin, ['/commerce/v1/checkouts']);
    const quote = input.quote;
    if (!quote || quote.user_id !== input.user_id || quote.quote_id !== input.quote_id
      || quote.terms_hash !== input.terms_hash || quote.merchant_id !== this.options.merchantId
      || quote.catalog_id !== this.options.catalogId || !quote.wire_terms) throw protocol();
    const terms = parse(quoteTermsSchema, quote.wire_terms);
    const lines = quoteItems(quote);
    if (computeTermsHash(terms) !== quote.terms_hash || terms.quote_id !== quote.quote_id
      || terms.merchant_id !== quote.merchant_id || terms.currency !== quote.currency
      || terms.total_minor !== quote.total_minor || terms.items.length !== lines.length
      || new Set(terms.items.map(item => item.entry_id)).size !== terms.items.length
      || lines.reduce((sum, line) => sum + line.quantity, 0) !== quote.quantity
      || quote.entry_id !== lines[0]?.entry_id || quote.unit_price_minor !== lines[0]?.unit_price_minor
      || terms.items.some(item => !lines.some(line => line.entry_id === item.entry_id && line.quantity === item.quantity
        && line.unit_price_minor === item.unit_minor && line.line_total_minor === line.unit_price_minor * line.quantity))
      || new Set(lines.map(line => line.entry_id)).size !== lines.length || terms.fulfillment.method !== quote.fulfillment
      || !sameDelivery(terms.fulfillment.delivery, quote.delivery)
      || terms.fulfillment.location_id !== undefined || termsInconsistency(terms) !== null
      || ![terms.total_minor, ...terms.items.flatMap(item => [item.unit_minor, item.quantity, item.unit_minor * item.quantity]),
        ...terms.fees.map(fee => fee.amount_minor), terms.items.reduce((sum, item) => sum + item.unit_minor * item.quantity, 0),
        terms.fees.reduce((sum, fee) => sum + fee.amount_minor, 0)].every(Number.isSafeInteger)
      || !Array.isArray(quote.fees) || quote.fees.length !== terms.fees.length
      || quote.fees.some((fee, index) => fee.amount_minor !== terms.fees[index]!.amount_minor
        || (fee.code !== undefined && fee.code !== terms.fees[index]!.code))
      || !Number.isFinite(Date.parse(quote.expires_at))) throw protocol();
    let rawProof: unknown;
    try { rawProof = JSON.parse(input.authorization_proof); } catch { throw protocol(); }
    const authorization = parse(authorizationProofSchema, rawProof);
    const claims = authorization.payload;
    const nowSeconds = Math.floor(this.now() / 1000);
    if (claims.user_id !== input.user_id || claims.purchase_attempt_id !== input.purchase_attempt_id
      || claims.quote_id !== quote.quote_id || claims.terms_hash !== quote.terms_hash
      || claims.merchant_id !== quote.merchant_id || claims.currency !== quote.currency
      || !Number.isSafeInteger(claims.max_total_minor) || claims.max_total_minor < quote.total_minor
      || claims.issued_at > nowSeconds || claims.expires_at <= nowSeconds || claims.expires_at <= claims.issued_at
      || claims.expires_at > claims.issued_at + 60 || claims.expires_at * 1000 > Date.parse(quote.expires_at)) throw protocol();
    // Deliberately enumerate the wire fields. Caller, URL and idempotency metadata never enter this body.
    const body = checkoutRequestSchema.parse({ purchase_attempt_id: identifier(input.purchase_attempt_id),
      quote_id: input.quote_id, terms_hash: input.terms_hash, authorization });
    const { status, value } = await this.request('/commerce/v1/checkouts', input.user_id, body, input.idempotency_key);
    if (status === 200) {
      // A valid bound confirmation is evidence of purchase even when its order is malformed.
      // Read that independent fact first, so a later protocol error cannot erase it and permit a new key.
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || (value as Record<string, unknown>).status !== 'confirmed') throw protocol();
      const confirmed = parse(purchaseAttemptResponseSchema, (value as Record<string, unknown>).purchase_attempt);
      this.attempt(confirmed, input.purchase_attempt_id, quote.quote_id);
      if (confirmed.status !== 'confirmed' || !confirmed.order_id) throw protocol();
      const confirmedAttempt = this.mapAttempt(confirmed);
      try {
        const response = parse(checkoutConfirmedResponseSchema, value);
        if (confirmed.order_id !== response.order.order_id) throw protocol();
        this.order(response.order, response.order.order_id);
        if (response.order.purchase_attempt_id !== input.purchase_attempt_id || response.order.quote_id !== quote.quote_id
          || response.order.terms_hash !== quote.terms_hash || response.order.payment.status !== 'paid'
          || !['pending', 'ready', 'completed', 'cancelled'].includes(response.order.fulfillment_status.status)
          || computeTermsHash(buildQuoteTerms(response.order)) !== computeTermsHash(terms)) throw protocol();
        return confirmedAttempt;
      } catch {
        throw new ConfirmedPurchaseProtocolError(confirmedAttempt);
      }
    }
    if (status === 202) {
      const response = parse(checkoutProcessingResponseSchema, value);
      this.attempt(response.purchase_attempt, input.purchase_attempt_id, quote.quote_id);
      if (response.purchase_attempt.status !== 'processing') throw protocol();
      return this.mapAttempt(response.purchase_attempt);
    }
    throw protocol();
  }

  async getAttempt(userId: string, attemptId: string): Promise<MerchantAttempt> {
    const { status, value } = await this.request(`/commerce/v1/purchase-attempts/${encodeURIComponent(identifier(attemptId))}`, userId);
    if (status !== 200) throw protocol();
    const attempt = parse(purchaseAttemptResponseSchema, value);
    this.attempt(attempt, attemptId);
    return this.mapAttempt(attempt);
  }

  async getOrder(userId: string, orderId: string): Promise<Order> {
    const { status, value } = await this.request(`/commerce/v1/orders/${encodeURIComponent(identifier(orderId))}`, userId);
    if (status !== 200) throw protocol();
    const wire = parse(orderResponseSchema, value);
    this.order(wire, orderId);
    const item = wire.items[0]!;
    return {
      order_id: wire.order_id, purchase_attempt_id: wire.purchase_attempt_id, title: item.title,
      quantity: wire.items.reduce((sum, line) => sum + line.quantity, 0), currency: wire.currency, total_minor: wire.total_minor,
      items: wire.items.map(line => ({ entry_id: line.entry_id, title: line.title, quantity: line.quantity,
        unit_price_minor: line.unit_minor, line_total_minor: line.line_total_minor })),
      payment_status: wire.payment.status, fulfillment_status: wire.fulfillment_status.status,
      updated_at: wire.updated_at, merchant_id: wire.merchant_id, catalog_id: wire.catalog_id,
      quote_id: wire.quote_id, terms_hash: wire.terms_hash, entry_id: item.entry_id,
      fulfillment: wire.fulfillment.method, ...(wire.fulfillment.delivery ? { delivery: wire.fulfillment.delivery } : {}), wire_terms: buildQuoteTerms(wire),
    };
  }

  private intent(intent: Intent) {
    try { parseIntent(intent, [this.options.merchantId]); } catch { throw protocol(); }
  }
  private candidate(candidate: Candidate) {
    if (candidate.merchant_id !== this.options.merchantId || candidate.catalog_id !== this.options.catalogId) throw protocol();
    identifier(candidate.entry_id);
  }
  private wireQuote(quote: WireQuote) {
    if (quote.merchant_id !== this.options.merchantId || quote.catalog_id !== this.options.catalogId
      || quote.items.length < 1 || quote.items.length > 10 || quote.fulfillment.location_id !== undefined
      || new Set(quote.items.map(item => item.entry_id)).size !== quote.items.length
      || Date.parse(quote.expires_at) <= Date.parse(quote.created_at)
      || !this.amounts(quote) || quoteInconsistency(quote) !== null) throw protocol();
  }
  private amounts(quote: WireQuote | WireOrder): boolean {
    return [quote.subtotal_minor, quote.total_minor, ...quote.items.flatMap(item => [item.quantity, item.unit_minor,
      item.line_total_minor, item.quantity * item.unit_minor]), ...quote.fees.map(fee => fee.amount_minor),
      quote.fees.reduce((sum, fee) => sum + fee.amount_minor, 0),
      quote.subtotal_minor + quote.fees.reduce((sum, fee) => sum + fee.amount_minor, 0)].every(Number.isSafeInteger);
  }
  private attempt(attempt: PurchaseAttempt, expectedId: string, expectedQuoteId?: string) {
    if (attempt.purchase_attempt_id !== expectedId || attempt.merchant_id !== this.options.merchantId
      || attempt.catalog_id !== this.options.catalogId || (expectedQuoteId !== undefined && attempt.quote_id !== expectedQuoteId)
      || Date.parse(attempt.updated_at) < Date.parse(attempt.created_at)
      || (attempt.status === 'confirmed' ? !attempt.order_id || attempt.error !== undefined
        : attempt.status === 'processing' ? attempt.order_id !== undefined || attempt.error !== undefined
          : attempt.order_id !== undefined || attempt.error === undefined)) throw protocol();
  }
  private mapAttempt(attempt: PurchaseAttempt): MerchantAttempt {
    return { purchase_attempt_id: attempt.purchase_attempt_id, status: attempt.status,
      merchant_id: attempt.merchant_id, catalog_id: attempt.catalog_id, quote_id: attempt.quote_id,
      ...(attempt.order_id ? { order_id: attempt.order_id } : {}),
      ...(attempt.error ? { error: { code: attempt.error.code, message: SAFE_ERRORS[attempt.error.code] } } : {}) };
  }
  private order(order: WireOrder, expectedId: string) {
    if (order.order_id !== expectedId || order.merchant_id !== this.options.merchantId || order.catalog_id !== this.options.catalogId
      || order.items.length < 1 || order.items.length > 10 || order.fulfillment.location_id !== undefined
      || new Set(order.items.map(item => item.entry_id)).size !== order.items.length
      || Date.parse(order.updated_at) < Date.parse(order.created_at)
      || Date.parse(order.payment.updated_at) < Date.parse(order.created_at)
      || Date.parse(order.fulfillment_status.updated_at) < Date.parse(order.created_at)
      ) throw protocol();
    if (orderInconsistency(order) !== null) throw protocol();
  }
  private async request(path: string, userId: string, body?: unknown, key?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const endpoint = trustedUrl(`${this.origin}${path}`, this.origin, [path]);
    const headers: Record<string, string> = { [DEV_CALLER_HEADER]: identifier(userId) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = identifier(key);
    let response: Response;
    try {
      response = await this.fetcher(endpoint, { method: body === undefined ? 'GET' : 'POST', headers,
        redirect: 'error', credentials: 'omit', signal: requestSignal(signal, this.timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      signal?.throwIfAborted();
      const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      throw new FlowError(timeout ? 'timeout' : 'network_error', timeout ? '商家请求超时，请查询原购买尝试。' : '无法连接商家，请查询原购买尝试。', 503);
    }
    signal?.throwIfAborted();
    if (response.status >= 500) throw new FlowError('merchant_unavailable', '商家暂时无法确认结果，请查询原购买尝试。', 503);
    if (response.status >= 300 && response.status < 400) throw protocol();
    let value: unknown;
    try { value = await response.json(); } catch { signal?.throwIfAborted(); throw protocol(); }
    signal?.throwIfAborted();
    if (!response.ok) {
      const { error } = parse(commerceErrorResponseSchema, value);
      if (COMMERCE_ERROR_HTTP_STATUS[error.code] !== response.status) throw protocol();
      throw new FlowError(error.code, SAFE_ERRORS[error.code], response.status);
    }
    return { status: response.status, value };
  }
}
