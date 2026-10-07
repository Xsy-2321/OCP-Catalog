import { LocalMockIssuer } from './authorization';
import { FlowError, publicError } from './errors';
import { SerialQueue } from './store';
import { assertQuote, parseIntent, trustedUrl } from './validation';
import type { ApprovalClaims, MerchantAttempt, MerchantPort, PublicSession, Session, SessionStore } from './types';

export interface Confirmation { quote_id: string; terms_hash: string; revision: number }

export class ShoppingCoordinator {
  private readonly queue = new SerialQueue();
  constructor(
    private readonly merchant: MerchantPort,
    private readonly store: SessionStore,
    private readonly issuer: LocalMockIssuer,
    private readonly merchantOrigin: string,
    private readonly now: () => number = Date.now,
  ) {}
  async create(userId: string, input: unknown): Promise<PublicSession> {
    const intent = parseIntent(input);
    const timestamp = new Date(this.now()).toISOString();
    const session: Session = {
      id: `session_${crypto.randomUUID()}`, user_id: userId, mode: this.merchant.mode,
      phase: 'new', intent, candidates: [], revision: 0, created_at: timestamp, updated_at: timestamp,
    };
    await this.store.write(session);
    return this.public(session);
  }
  async get(userId: string, id: string): Promise<PublicSession> {
    return this.queue.run(id, async () => {
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
    return this.queue.run(id, async () => {
      const session = await this.owned(userId, id);
      this.noAttempt(session);
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
    return this.queue.run(id, async () => {
      const session = await this.owned(userId, id);
      this.noAttempt(session);
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
    return this.queue.run(id, async () => {
      const session = await this.owned(userId, id);
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
      } catch (error) {
        session.phase = 'requote_required'; session.error = publicError(error);
        await this.save(session);
        return this.public(session);
      }
      const checkoutUrl = trustedUrl(session.checkout_url, this.merchantOrigin, ['/commerce/v1/checkouts']);
      session.attempt = {
        purchase_attempt_id: `attempt_${crypto.randomUUID()}`,
        idempotency_key: `purchase_${crypto.randomUUID()}`, status: 'processing',
      };
      session.phase = 'checkout_pending'; delete session.error;
      // Save a stable attempt/key before any purchase operation; no proof/private key is saved.
      await this.save(session);
      const claims: ApprovalClaims = {
        issuer: 'shopping-agent-local-mock', user_id: userId, merchant_id: session.quote.merchant_id,
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
        });
        await this.acceptAttempt(session, result);
      } catch (error) {
        // An explicit merchant rejection is determinate. Transport/parse failures are unknown.
        if (error instanceof FlowError && [
          'unauthorized', 'forbidden', 'quote_expired', 'requote_required', 'budget_exceeded', 'out_of_stock',
          'authorization_invalid', 'idempotency_conflict', 'payment_failed',
        ].includes(error.code)) {
          session.attempt.status = 'failed'; session.phase = 'failed'; session.error = publicError(error);
        } else {
          session.phase = 'unknown';
          session.error = { code: 'result_unknown', message: '购买结果未知，请查询原尝试；不会自动重新购买。' };
        }
      }
      await this.save(session);
      return this.public(session);
    });
  }
  async recover(userId: string, id: string): Promise<PublicSession> {
    return this.queue.run(id, async () => {
      const session = await this.owned(userId, id);
      if (!session.attempt) return this.public(session);
      if (session.phase === 'failed') return this.public(session);
      try {
        await this.acceptAttempt(session, await this.merchant.getAttempt(userId, session.attempt.purchase_attempt_id));
      } catch {
        // Even not_found after a lost response is insufficient evidence to repurchase.
        session.phase = 'unknown';
        session.error = { code: 'result_unknown', message: '原购买尝试仍无法确认，请稍后再查询。' };
      }
      await this.save(session);
      return this.public(session);
    });
  }
  async cancel(userId: string, id: string): Promise<PublicSession> {
    return this.queue.run(id, async () => {
      const session = await this.owned(userId, id);
      this.noAttempt(session);
      session.phase = 'cancelled'; delete session.error;
      await this.save(session);
      return this.public(session);
    });
  }
  private async acceptAttempt(session: Session, result: MerchantAttempt) {
    if (!session.attempt || result.purchase_attempt_id !== session.attempt.purchase_attempt_id
      || !['processing', 'confirmed', 'failed'].includes(result.status)) throw new Error('invalid merchant attempt');
    if (result.status === 'confirmed') {
      if (!result.order_id) throw new Error('missing merchant order');
      const order = await this.merchant.getOrder(session.user_id, result.order_id);
      if (!session.quote || order.order_id !== result.order_id
        || order.purchase_attempt_id !== session.attempt.purchase_attempt_id
        || order.currency !== session.quote.currency || order.total_minor !== session.quote.total_minor
        || order.quantity !== session.quote.quantity || order.payment_status !== 'paid'
        || !['preparing', 'ready', 'collected'].includes(order.fulfillment_status)) throw new Error('invalid merchant order');
      session.order = order; session.phase = 'confirmed'; delete session.error;
    } else if (result.status === 'failed') {
      session.phase = 'failed'; session.error = result.error ?? { code: 'payment_failed', message: '商家确认模拟付款失败。' };
    } else {
      session.phase = 'unknown'; session.error = { code: 'processing', message: '商家仍在处理，请查询原尝试。' };
    }
    session.attempt.status = result.status;
  }
  private noAttempt(session: Session) {
    if (session.attempt) throw new FlowError('invalid_state', '此流程已有购买尝试，请先查询原结果。', 409);
  }
  private async owned(userId: string, id: string): Promise<Session> {
    const session = await this.store.read(id);
    if (!session || session.user_id !== userId) throw new FlowError('not_found', '找不到这个购物会话。', 404);
    return session;
  }
  private async save(session: Session) {
    session.revision += 1; session.updated_at = new Date(this.now()).toISOString();
    await this.store.write(session);
  }
  private public(session: Session): PublicSession {
    const { user_id: _user, checkout_url: _url, resolve_expires_at: _expiry, attempt, quote, ...rest } = session;
    const publicSession: PublicSession = structuredClone(rest);
    if (attempt) publicSession.attempt = { purchase_attempt_id: attempt.purchase_attempt_id, status: attempt.status };
    if (quote) { const { user_id: _owner, ...readQuote } = quote; publicSession.quote = structuredClone(readQuote); }
    return publicSession;
  }
}
