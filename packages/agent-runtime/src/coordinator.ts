import { commerceErrorSchema, computeTermsHash } from '@ocp-catalog/shopping-contracts';
import type { AuthorizationIssuer } from './authorization';
import { ConfirmedPurchaseProtocolError, FlowError, publicError } from './errors';
import { SerialQueue } from './store';
import { assertQuote, parseIntent, trustedUrl } from './validation';
import type { ApprovalClaims, MerchantAttempt, MerchantPort, PublicSession, Session, SessionStore } from './types';

export interface Confirmation { quote_id: string; terms_hash: string; revision: number }

export class ShoppingCoordinator {
  private readonly queue = new SerialQueue();
  constructor(
    private readonly merchant: MerchantPort,
    private readonly store: SessionStore,
    private readonly issuer: AuthorizationIssuer,
    private readonly merchantOrigin: string,
    private readonly now: () => number = Date.now,
    private readonly trustedMerchants: readonly string[] = ['coffee-demo'],
  ) {}
  get mode() { return this.merchant.mode; }
  get merchantId() { return this.trustedMerchants[0]!; }
  async create(userId: string, input: unknown): Promise<PublicSession> {
    return this.queue.run(`user:${userId}`, async () => {
    await this.noOtherPending(userId);
    const intent = parseIntent(input, this.trustedMerchants);
    const timestamp = new Date(this.now()).toISOString();
    const session: Session = {
      id: `session_${crypto.randomUUID()}`, user_id: userId, mode: this.merchant.mode,
      phase: 'new', intent, candidates: [], revision: 0, created_at: timestamp, updated_at: timestamp,
    };
    await this.store.write(session);
    return this.public(session);
    });
  }
  async get(userId: string, id: string): Promise<PublicSession> {
    return this.queue.run(`user:${userId}`, async () => {
      const session = await this.owned(userId, id);
      if (session.phase === 'checkout_pending') {
        session.phase = 'unknown';
        session.error = { code: 'result_unknown', message: '购买结果待查询，请查询原尝试；不要重新购买。' };
        await this.save(session);
      }
      return this.public(session);
    });
  }
  async search(userId: string, id: string): Promise<PublicSession> {
    return this.queue.run(`user:${userId}`, async () => {
      const session = await this.owned(userId, id);
      await this.noOtherPending(userId, id);
      this.prepareNewQuote(session);
      if (session.phase === 'cancelled') throw new FlowError('invalid_state', '此购物流程已取消，请开始新需求。');
      session.phase = 'searching';
      delete session.quote; delete session.selected; delete session.error;
      delete session.checkout_url; delete session.resolve_expires_at;
      await this.save(session);
      try {
        const candidates = await this.merchant.search(session.intent);
        session.candidates = candidates.filter(candidate => candidate.merchant_id === session.intent.merchant_id
          && candidate.currency === session.intent.currency && candidate.in_stock
          && Number.isSafeInteger(candidate.search_price_minor) && candidate.search_price_minor >= 0
          && candidate.search_price_minor * session.intent.quantity <= session.intent.max_total_minor);
        session.phase = 'candidates';
      } catch (error) { session.phase = 'failed'; session.error = publicError(error); }
      await this.save(session);
      return this.public(session);
    });
  }
  async select(userId: string, id: string, entryId: string): Promise<PublicSession> {
    return this.queue.run(`user:${userId}`, async () => {
      const session = await this.owned(userId, id);
      await this.noOtherPending(userId, id);
      this.prepareNewQuote(session);
      if (!['candidates', 'awaiting_confirmation', 'requote_required', 'failed'].includes(session.phase)) {
        throw new FlowError('invalid_state', '请先搜索候选。');
      }
      const candidate = session.candidates.find(value => value.entry_id === entryId);
      if (!candidate) throw new FlowError('invalid_request', '请选择本次目录返回的候选商品。');
      session.phase = 'quoting'; session.selected = candidate;
      delete session.error; delete session.quote; delete session.checkout_url; delete session.resolve_expires_at;
      await this.save(session);
      try {
        const resolved = await this.merchant.resolve(candidate);
        const checkoutUrl = trustedUrl(resolved.checkout_url, this.merchantOrigin, ['/commerce/v1/checkouts']);
        if (!Number.isFinite(Date.parse(resolved.expires_at)) || Date.parse(resolved.expires_at) <= this.now()) {
          throw new FlowError('requote_required', '商品入口已过期，请重新选择。');
        }
        const quote = await this.merchant.quote(userId, candidate, session.intent);
        // Retain the full quote to let the user see why the total exceeds their budget.
        session.quote = quote;
        assertQuote(quote, userId, candidate, session.intent, this.now());
        session.checkout_url = checkoutUrl; session.resolve_expires_at = resolved.expires_at;
        session.phase = 'awaiting_confirmation';
      } catch (error) {
        session.phase = error instanceof FlowError && ['quote_expired', 'requote_required'].includes(error.code)
          ? 'requote_required' : 'failed';
        session.error = publicError(error);
      }
      await this.save(session);
      return this.public(session);
    });
  }
  /** Only the trusted UI confirmation route may call this. No planner tool exposes it. */
  async confirm(userId: string, id: string, confirmation: Confirmation): Promise<PublicSession> {
    return this.queue.run(`user:${userId}`, async () => {
      const session = await this.owned(userId, id);
      await this.noOtherPending(userId, id);
      if (!session.quote || confirmation.quote_id !== session.quote.quote_id
        || confirmation.terms_hash !== session.quote.terms_hash) {
        throw new FlowError('confirmation_mismatch', '确认必须对应当前显示的报价和条款。', 409);
      }
      if (session.attempt) return this.public(session); // Duplicate click never creates a new attempt.
      if (session.phase !== 'awaiting_confirmation' || !session.selected || !session.checkout_url
        || !Number.isSafeInteger(confirmation.revision) || confirmation.revision !== session.revision) {
        throw new FlowError('invalid_state', '报价状态已变化，请刷新后明确确认。', 409);
      }
      try {
        assertQuote(session.quote, userId, session.selected, session.intent, this.now());
        if (!session.resolve_expires_at || Date.parse(session.resolve_expires_at) <= this.now()) {
          throw new FlowError('requote_required', '商品入口已过期，请重新报价并确认。');
        }
        if (Math.floor(Math.min(Date.parse(session.quote.expires_at), this.now() + 60_000) / 1000)
          <= Math.floor(this.now() / 1000)) {
          throw new FlowError('requote_required', '购买许可的有效窗口不足，请重新报价。');
        }
      } catch (error) {
        session.phase = 'requote_required'; session.error = publicError(error);
        await this.save(session);
        return this.public(session);
      }
      const checkoutUrl = trustedUrl(session.checkout_url, this.merchantOrigin, ['/commerce/v1/checkouts']);
      session.attempt = {
        purchase_attempt_id: `attempt_${crypto.randomUUID()}`,
        idempotency_key: `purchase_${crypto.randomUUID()}`, status: 'processing',
        confirmation_revision: confirmation.revision,
      };
      session.phase = 'checkout_pending'; delete session.error;
      // Save a stable attempt/key before any purchase operation; no proof/private key is saved.
      await this.save(session);
      const claims: ApprovalClaims = {
        issuer: this.issuer.issuer ?? 'shopping-agent-local-mock', user_id: userId, merchant_id: session.quote.merchant_id,
        quote_id: session.quote.quote_id, terms_hash: session.quote.terms_hash,
        entry_id: session.quote.entry_id, quantity: session.quote.quantity, fulfillment: session.quote.fulfillment,
        currency: session.quote.currency, max_total_minor: session.intent.max_total_minor,
        purchase_attempt_id: session.attempt.purchase_attempt_id,
        expires_at: new Date(Math.min(Date.parse(session.quote.expires_at), this.now() + 60_000)).toISOString(),
      };
      try {
        const authorizationProof = this.issuer.issue(claims);
        const result = await this.merchant.checkout({
          user_id: userId, purchase_attempt_id: session.attempt.purchase_attempt_id,
          idempotency_key: session.attempt.idempotency_key, quote_id: session.quote.quote_id,
          terms_hash: session.quote.terms_hash, authorization_proof: authorizationProof, checkout_url: checkoutUrl,
          quote: session.quote,
        });
        await this.acceptAttempt(session, result);
      } catch (error) {
        // An explicit merchant rejection is determinate. Transport/parse failures are unknown.
        if (error instanceof ConfirmedPurchaseProtocolError) {
          const evidence = error.confirmedAttempt;
          if (evidence.purchase_attempt_id === session.attempt.purchase_attempt_id
            && evidence.quote_id === session.quote.quote_id && evidence.merchant_id === session.quote.merchant_id
            && evidence.catalog_id === session.quote.catalog_id && evidence.order_id) {
            session.attempt.status = 'confirmed'; session.attempt.order_id = evidence.order_id;
          }
        }
        if (session.attempt.status !== 'confirmed' && error instanceof FlowError && [
          'unauthorized', 'forbidden', 'quote_expired', 'requote_required', 'budget_exceeded', 'out_of_stock',
          'authorization_invalid', 'payment_failed',
        ].includes(error.code)) {
          this.rejectAttempt(session, publicError(error));
        } else {
          session.phase = 'unknown';
          delete session.order;
          session.error = { code: 'result_unknown', message: '购买结果未知，请查询原尝试；不会自动重新购买。' };
          this.diagnose(session, error, 'checkout');
        }
      }
      await this.save(session);
      return this.public(session);
    });
  }
  async recover(userId: string, id: string): Promise<PublicSession> {
    return this.queue.run(`user:${userId}`, async () => {
      const session = await this.owned(userId, id);
      if (!session.attempt) return this.public(session);
      if (session.attempt.status === 'failed') return this.public(session);
      try {
        await this.acceptAttempt(session, await this.merchant.getAttempt(userId, session.attempt.purchase_attempt_id));
      } catch (error) {
        // Even not_found after a lost response is insufficient evidence to repurchase.
        session.phase = 'unknown';
        session.error = { code: 'result_unknown', message: '原购买尝试仍无法确认，请稍后再查询。' };
        delete session.order;
        this.diagnose(session, error, 'recover');
      }
      await this.save(session);
      return this.public(session);
    });
  }
  async cancel(userId: string, id: string): Promise<PublicSession> {
    return this.queue.run(`user:${userId}`, async () => {
      const session = await this.owned(userId, id);
      this.prepareNewQuote(session);
      session.phase = 'cancelled'; delete session.error;
      await this.save(session);
      return this.public(session);
    });
  }
  private async acceptAttempt(session: Session, result: MerchantAttempt) {
    if (!session.attempt || result.purchase_attempt_id !== session.attempt.purchase_attempt_id
      || !['processing', 'confirmed', 'failed'].includes(result.status)
      || (result.status !== 'confirmed' && result.order_id !== undefined)
      || (result.status !== 'failed' && result.error !== undefined)) {
      throw new FlowError('protocol_error', '商家购买状态无效。');
    }
    if (session.attempt.status === 'confirmed' && result.status !== 'confirmed') {
      throw new FlowError('protocol_error', '商家已确认购买状态不能退回处理中或失败。');
    }
    if (session.mode === 'http' && (!session.quote || result.merchant_id !== session.quote.merchant_id
      || result.catalog_id !== session.quote.catalog_id || result.quote_id !== session.quote.quote_id)) {
      throw new FlowError('binding_mismatch', '商家购买状态与原报价不一致。');
    }
    if (result.status === 'confirmed') {
      if (!result.order_id) throw new Error('missing merchant order');
      if (session.attempt.order_id && session.attempt.order_id !== result.order_id) {
        throw new FlowError('binding_mismatch', '商家原购买尝试关联的订单发生变化。');
      }
      // A valid confirmed attempt is already evidence of purchase even if the
      // subsequent order query fails. Recovery must never use a later failure
      // to open a new purchase key.
      session.attempt.status = 'confirmed'; session.attempt.order_id = result.order_id;
      const order = await this.merchant.getOrder(session.user_id, result.order_id);
      if (!session.quote || order.order_id !== result.order_id
        || order.purchase_attempt_id !== session.attempt.purchase_attempt_id
        || order.currency !== session.quote.currency || order.total_minor !== session.quote.total_minor
        || order.quantity !== session.quote.quantity || order.payment_status !== 'paid'
        || !['preparing', 'ready', 'collected', 'pending', 'completed', 'cancelled'].includes(order.fulfillment_status)
        || !Number.isFinite(Date.parse(order.updated_at))) throw new FlowError('binding_mismatch', '商家订单与原购买不一致。');
      if (session.mode === 'http' && (order.merchant_id !== session.quote.merchant_id
        || order.catalog_id !== session.quote.catalog_id || order.quote_id !== session.quote.quote_id
        || order.terms_hash !== session.quote.terms_hash || order.entry_id !== session.quote.entry_id
        || order.fulfillment !== session.quote.fulfillment || !session.quote.wire_terms || !order.wire_terms
        || computeTermsHash(order.wire_terms) !== computeTermsHash(session.quote.wire_terms))) {
        throw new FlowError('binding_mismatch', '商家订单条款与已确认报价不一致。');
      }
      session.order = order; session.phase = 'confirmed'; delete session.error; delete session.diagnostic;
    } else if (result.status === 'failed') {
      const parsed = commerceErrorSchema.safeParse(result.error);
      if (!parsed.success) throw new FlowError('protocol_error', '商家失败原因格式无效。');
      // A malformed error or an idempotency conflict cannot prove no purchase happened.
      if (!['quote_expired', 'requote_required', 'budget_exceeded', 'out_of_stock',
        'authorization_invalid', 'payment_failed', 'unauthorized', 'forbidden'].includes(parsed.data.code)) {
        throw new FlowError('protocol_error', '商家失败原因不能确定原购买结果。');
      }
      const messages: Record<string, string> = {
        quote_expired: '报价已过期，请重新报价并确认。', requote_required: '商家条款已变化，请重新报价并确认。',
        budget_exceeded: '含全部费用的最终报价超过预算，不能购买。', out_of_stock: '商品库存不足，本次未成交。',
        authorization_invalid: '购买许可无效或已过期。', payment_failed: '商家确认模拟付款失败。',
        unauthorized: '本次购买身份未通过校验。', forbidden: '本次购买未获授权。',
      };
      this.rejectAttempt(session, { code: parsed.data.code, message: messages[parsed.data.code]! });
    } else {
      session.phase = 'unknown'; session.error = { code: 'processing', message: '商家仍在处理，请查询原尝试。' };
      delete session.order;
    }
    session.attempt.status = result.status;
  }
  private prepareNewQuote(session: Session) {
    if (!session.attempt) return;
    if (session.attempt.status !== 'failed' || !['failed', 'requote_required'].includes(session.phase)
      || !session.quote || !session.error) {
      throw new FlowError('invalid_state', '此流程已有购买尝试，请先查询原结果。', 409);
    }
    session.attempt_history ??= [];
    session.attempt_history.push({ ...session.attempt, status: 'failed', quote: structuredClone(session.quote),
      confirmation_revision: session.attempt.confirmation_revision ?? session.revision,
      error: structuredClone(session.error), ended_at: new Date(this.now()).toISOString() });
    delete session.attempt; delete session.order; delete session.diagnostic;
  }
  private async noOtherPending(userId: string, currentId?: string) {
    const sessions = await this.store.listForUser(userId);
    if (sessions.some(session => session.id !== currentId
      && (['checkout_pending', 'unknown'].includes(session.phase) || session.attempt?.status === 'processing'))) {
      throw new FlowError('unresolved_purchase', '此身份还有购买结果未知，请先查询原会话；不能另开流程购买。', 409);
    }
  }
  private rejectAttempt(session: Session, error: { code: string; message: string }) {
    session.attempt!.status = 'failed';
    session.phase = ['quote_expired', 'requote_required'].includes(error.code) ? 'requote_required' : 'failed';
    session.error = error; delete session.order; delete session.diagnostic;
  }
  private diagnose(session: Session, error: unknown, operation: 'checkout' | 'recover') {
    const code = error instanceof FlowError ? error.code : '';
    const category = code === 'not_found' ? 'not_found' : code === 'protocol_error' ? 'protocol'
      : code === 'binding_mismatch' ? 'binding' : code === 'timeout' ? 'timeout'
        : code === 'network_error' ? 'network' : 'unavailable';
    session.diagnostic = { category, operation, at: new Date(this.now()).toISOString() };
  }
  private async owned(userId: string, id: string): Promise<Session> {
    const session = await this.store.read(id);
    if (!session || session.user_id !== userId) throw new FlowError('not_found', '找不到这个购物会话。', 404);
    if (session.mode !== this.merchant.mode || !this.trustedMerchants.includes(session.intent.merchant_id)) {
      throw new FlowError('runtime_mismatch', '此会话属于不同商户模式，请恢复原配置。', 409);
    }
    return session;
  }
  private async save(session: Session) {
    session.revision += 1; session.updated_at = new Date(this.now()).toISOString();
    await this.store.write(session);
  }
  private public(session: Session): PublicSession {
    const { user_id: _user, checkout_url: _url, resolve_expires_at: _expiry, attempt, quote, attempt_history, ...rest } = session;
    const publicSession: PublicSession = structuredClone(rest);
    if (attempt) publicSession.attempt = { purchase_attempt_id: attempt.purchase_attempt_id, status: attempt.status };
    if (quote) { const { user_id: _owner, ...readQuote } = quote; publicSession.quote = structuredClone(readQuote); }
    if (attempt_history) publicSession.attempt_history = attempt_history.map(({ idempotency_key: _key, quote: oldQuote, ...history }) =>
      ({ ...structuredClone(history), quote_id: oldQuote.quote_id, terms_hash: oldQuote.terms_hash }));
    return publicSession;
  }
}
