import { commerceErrorSchema, computeTermsHash } from '@ocp-catalog/shopping-contracts';
import type { AuthorizationIssuer } from './authorization';
import { ConfirmedPurchaseProtocolError, FlowError, publicError } from './errors';
import { SerialQueue } from './store';
import { abortable } from './cancellation';
import { assertQuote, intentItems, mergeSelections, parseIntent, sameDelivery, trustedUrl } from './validation';
import { canSelectCandidate, isPendingPurchase } from '@ocp-catalog/shopping-contracts/browser';
import { normalizeStoredSession } from './basket-model';
import { requestBasketQuote, requestOrder } from './merchant-adapter';
import { beginSearch, isConfirmableSession, markUnknown, requireRequote, beginPurchaseAttempt } from './session-state';
import { toSessionView } from './session-view';
import type { ApprovalClaims, MerchantAttempt, MerchantHealth, MerchantPort, PublicSession, ReadOperationOptions, Session, SessionStore } from './types';

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
  /** Shutdown must also wait for canceled callers' underlying work to settle. */
  waitForIdle(): Promise<void> { return this.queue.waitForIdle(); }
  async inspectHealth(): Promise<MerchantHealth & { mode: 'mock' | 'http' }> {
    if (this.merchant.health) {
      try { return { ...await this.merchant.health(), mode: this.mode }; }
      catch { /* Report an unavailable merchant without exposing transport details. */ }
    }
    return { mode: this.mode, status: this.mode === 'mock' ? 'simulated' : 'unavailable',
      ready: this.mode === 'mock', checked_at: new Date(this.now()).toISOString() };
  }
  /** Recover the original purchase even when another tab replaced its local session ID. */
  async listPending(userId: string, options: ReadOperationOptions = {}): Promise<PublicSession[]> {
    return this.readOperation(userId, options.signal, async () => {
      const sessions = await this.pendingSessions(userId);
      return sessions.filter(isPendingPurchase)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .map(session => this.public(session));
    });
  }
  async create(userId: string, input: unknown, options: ReadOperationOptions = {}): Promise<PublicSession> {
    return this.readOperation(userId, options.signal, async () => {
    await this.noOtherPending(userId);
    options.signal?.throwIfAborted();
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
  async get(userId: string, id: string, options: ReadOperationOptions = {}): Promise<PublicSession> {
    return this.readOperation(userId, options.signal, async () => {
      const session = await this.owned(userId, id);
      options.signal?.throwIfAborted();
      if (session.phase === 'checkout_pending') {
        session.phase = 'unknown';
        session.error = { code: 'result_unknown', message: '购买结果待查询，请查询原尝试；不要重新购买。' };
        await this.save(session);
      }
      return this.public(session);
    });
  }
  async search(userId: string, id: string, options: ReadOperationOptions = {}): Promise<PublicSession> {
    return this.readOperation(userId, options.signal, async () => {
      const session = await this.owned(userId, id);
      await this.noOtherPending(userId, id);
      options.signal?.throwIfAborted();
      this.prepareNewQuote(session);
      if (session.phase === 'cancelled') throw new FlowError('invalid_state', '此购物流程已取消，请开始新需求。');
      beginSearch(session);
      await this.save(session);
      try {
        options.signal?.throwIfAborted();
        const groups = [];
        for (const item of intentItems(session.intent)) {
          const lineIntent = { ...session.intent, query: item.query, quantity: item.quantity, items: [item] };
          const { candidates, warnings } = this.merchant.searchWithWarnings
            ? await this.merchant.searchWithWarnings(lineIntent, options)
            : { candidates: await this.merchant.search(lineIntent, options), warnings: [] };
          options.signal?.throwIfAborted();
          session.search_warnings!.push(...warnings);
          groups.push({ ...item, candidates: candidates.filter(candidate => candidate.merchant_id === session.intent.merchant_id
            && candidate.currency === session.intent.currency && candidate.in_stock
            && (candidate.fulfillment_methods ? candidate.fulfillment_methods.includes(session.intent.fulfillment) : session.intent.fulfillment === 'pickup')
            && Number.isSafeInteger(candidate.search_price_minor) && candidate.search_price_minor >= 0
            && candidate.search_price_minor * item.quantity <= session.intent.max_total_minor) });
        }
        session.candidate_groups = groups;
        session.candidates = [...new Map(groups.flatMap(group => group.candidates).map(candidate => [candidate.entry_id, candidate])).values()];
        session.phase = 'candidates';
      } catch (error) {
        await this.finishAbortedRead(session, options.signal);
        session.phase = 'failed';
        session.error = this.preCheckoutError(error, 'search');
      }
      await this.save(session);
      await this.finishAbortedRead(session, options.signal);
      return this.public(session);
    });
  }
  async select(userId: string, id: string, entryId: string | string[], options: ReadOperationOptions = {}): Promise<PublicSession> {
    return this.readOperation(userId, options.signal, async () => {
      const session = await this.owned(userId, id);
      await this.noOtherPending(userId, id);
      options.signal?.throwIfAborted();
      this.prepareNewQuote(session);
      if (!canSelectCandidate(session)) {
        throw new FlowError('invalid_state', '请先搜索候选。');
      }
      const ids = Array.isArray(entryId) ? entryId : [entryId];
      const groups = session.candidate_groups ?? [{ query: session.intent.query, quantity: session.intent.quantity, candidates: session.candidates }];
      if (ids.length !== groups.length || ids.some(value => typeof value !== 'string')) throw new FlowError('invalid_request', '请为每行需求选择一个目录候选。');
      const selections = groups.map((group, index) => {
        const candidate = group.candidates.find(value => value.entry_id === ids[index]);
        if (!candidate) throw new FlowError('invalid_request', '请选择对应需求行实际返回的候选商品。');
        return { candidate, quantity: group.quantity };
      });
      const merged = mergeSelections(selections);
      session.phase = 'quoting';
      session.selection = merged;
      session.selected_entry_ids = [...ids];
      delete session.error;
      delete session.quote;
      delete session.checkout_url;
      delete session.resolve_expires_at;
      await this.save(session);
      try {
        options.signal?.throwIfAborted();
        let checkoutUrl: string | undefined, expiresAt = Infinity;
        for (const selection of merged) {
          const originalItem = groups.find(group => group.candidates.some(value => value.entry_id === selection.candidate.entry_id))!;
          const resolved = await this.merchant.resolve(selection.candidate, { ...session.intent, query: originalItem.query,
            quantity: selection.quantity, items: [{ query: originalItem.query, quantity: selection.quantity }] }, options);
          options.signal?.throwIfAborted();
          const endpoint = trustedUrl(resolved.checkout_url, this.merchantOrigin, ['/commerce/v1/checkouts']);
          if (checkoutUrl && checkoutUrl !== endpoint) throw new FlowError('untrusted_endpoint', '整单商品必须使用同一受信结账入口。');
          checkoutUrl = endpoint;
          const expiry = Date.parse(resolved.expires_at);
          if (!Number.isFinite(expiry) || expiry <= this.now()) throw new FlowError('requote_required', '商品入口已过期，请重新选择。');
          expiresAt = Math.min(expiresAt, expiry);
        }
        const quote = await requestBasketQuote(this.merchant, userId, merged, session.intent, options);
        options.signal?.throwIfAborted();
        // Retain the full quote to let the user see why the total exceeds their budget.
        session.quote = quote;
        assertQuote(quote, userId, merged, session.intent, this.now());
        session.checkout_url = checkoutUrl;
        session.resolve_expires_at = new Date(expiresAt).toISOString();
        session.phase = 'awaiting_confirmation';
      } catch (error) {
        await this.finishAbortedRead(session, options.signal);
        session.phase = error instanceof FlowError && ['quote_expired', 'requote_required'].includes(error.code)
          ? 'requote_required' : 'failed';
        session.error = this.preCheckoutError(error, 'quote');
        if (error instanceof FlowError && error.code === 'invalid_quote') delete session.quote;
      }
      await this.save(session);
      await this.finishAbortedRead(session, options.signal);
      return this.public(session);
    });
  }
  /** Only the trusted UI confirmation route may call this. No planner tool exposes it. */
  async confirm(userId: string, id: string, confirmation: Confirmation): Promise<PublicSession> {
    return this.queue.run(`user:${userId}`, async () => {
      let session = await this.owned(userId, id);
      await this.noOtherPending(userId, id);
      if (!session.quote || confirmation.quote_id !== session.quote.quote_id
        || confirmation.terms_hash !== session.quote.terms_hash) {
        throw new FlowError('confirmation_mismatch', '确认必须对应当前显示的报价和条款。', 409);
      }
      if (session.attempt) return this.public(session); // Duplicate click never creates a new attempt.
      if (!isConfirmableSession(session)
        || !Number.isSafeInteger(confirmation.revision) || confirmation.revision !== session.revision) {
        throw new FlowError('invalid_state', '报价状态已变化，请刷新后明确确认。', 409);
      }
      try {
        assertQuote(session.quote, userId, session.selection, session.intent, this.now());
        if (!session.resolve_expires_at || Date.parse(session.resolve_expires_at) <= this.now()) {
          throw new FlowError('requote_required', '商品入口已过期，请重新报价并确认。');
        }
        if (Math.floor(Math.min(Date.parse(session.quote.expires_at), this.now() + 60_000) / 1000)
          <= Math.floor(this.now() / 1000)) {
          throw new FlowError('requote_required', '购买许可的有效窗口不足，请重新报价。');
        }
      } catch (error) {
        requireRequote(session, publicError(error));
        await this.save(session);
        return this.public(session);
      }
      const checkoutUrl = trustedUrl(session.checkout_url, this.merchantOrigin, ['/commerce/v1/checkouts']);
      const purchasing = beginPurchaseAttempt(session, confirmation.revision);
      // Save a stable attempt/key before any purchase operation; no proof/private key is saved.
      await this.save(purchasing);
      const claims: ApprovalClaims = {
        issuer: this.issuer.issuer ?? 'shopping-agent-local-mock', user_id: userId, merchant_id: purchasing.quote.merchant_id,
        quote_id: purchasing.quote.quote_id, terms_hash: purchasing.quote.terms_hash,
        entry_id: purchasing.quote.entry_id, quantity: purchasing.quote.quantity, fulfillment: purchasing.quote.fulfillment,
        currency: purchasing.quote.currency, max_total_minor: purchasing.intent.max_total_minor,
        purchase_attempt_id: purchasing.attempt.purchase_attempt_id,
        expires_at: new Date(Math.min(Date.parse(purchasing.quote.expires_at), this.now() + 60_000)).toISOString(),
      };
      try {
        const authorizationProof = this.issuer.issue(claims);
        const result = await this.merchant.checkout({
          user_id: userId, purchase_attempt_id: purchasing.attempt.purchase_attempt_id,
          idempotency_key: purchasing.attempt.idempotency_key, quote_id: purchasing.quote.quote_id,
          terms_hash: purchasing.quote.terms_hash, authorization_proof: authorizationProof, checkout_url: checkoutUrl,
          quote: purchasing.quote,
        });
        await this.acceptAttempt(purchasing, result);
      } catch (error) {
        // An explicit merchant rejection is determinate. Transport/parse failures are unknown.
        if (error instanceof ConfirmedPurchaseProtocolError) {
          const evidence = error.confirmedAttempt;
          if (evidence.purchase_attempt_id === purchasing.attempt.purchase_attempt_id
            && evidence.quote_id === purchasing.quote.quote_id && evidence.merchant_id === purchasing.quote.merchant_id
            && evidence.catalog_id === purchasing.quote.catalog_id && evidence.order_id) {
            purchasing.attempt.status = 'confirmed';
            purchasing.attempt.order_id = evidence.order_id;
          }
        }
        if (purchasing.attempt.status !== 'confirmed' && error instanceof FlowError && [
          'unauthorized', 'forbidden', 'quote_expired', 'requote_required', 'budget_exceeded', 'out_of_stock',
          'authorization_invalid', 'payment_failed',
        ].includes(error.code)) {
          this.rejectAttempt(purchasing, publicError(error));
        } else {
          markUnknown(purchasing, '购买结果未知，请查询原尝试；不会自动重新购买。');
          this.diagnose(purchasing, error, 'checkout');
        }
      }
      await this.save(purchasing);
      return this.public(purchasing);
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
        markUnknown(session, '原购买尝试仍无法确认，请稍后再查询。');
        this.diagnose(session, error, 'recover');
      }
      await this.save(session);
      return this.public(session);
    });
  }
  async cancel(userId: string, id: string): Promise<PublicSession> {
    return this.queue.run(`user:${userId}`, async () => {
      const session = await this.owned(userId, id);
      await this.noOtherPending(userId, id);
      this.prepareNewQuote(session);
      session.phase = 'cancelled';
      delete session.error;
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
      session.attempt.status = 'confirmed';
      session.attempt.order_id = result.order_id;
      const order = await requestOrder(this.merchant, session.user_id, result.order_id, session.quote!);
      if (!session.quote || order.order_id !== result.order_id
        || order.purchase_attempt_id !== session.attempt.purchase_attempt_id
        || order.currency !== session.quote.currency || order.total_minor !== session.quote.total_minor
        || order.quantity !== session.quote.quantity || order.payment_status !== 'paid'
        || (order.fulfillment !== undefined && order.fulfillment !== session.quote.fulfillment)
        || !sameDelivery(order.delivery, session.quote.delivery)
        || (order.items && (new Set(order.items.map(item => item.entry_id)).size !== order.items.length
          || order.items.reduce((sum, item) => sum + item.quantity, 0) !== order.quantity
          || order.items.some(item => !Number.isSafeInteger(item.quantity) || item.quantity < 1
            || !Number.isSafeInteger(item.unit_price_minor) || item.unit_price_minor < 0
            || !Number.isSafeInteger(item.line_total_minor) || item.line_total_minor !== item.unit_price_minor * item.quantity)))
        || (session.quote.wire_terms && (!order.wire_terms
          || computeTermsHash(order.wire_terms) !== computeTermsHash(session.quote.wire_terms)))
        || (session.quote.items && (!order.items || order.items.length !== session.quote.items.length
          || order.items.some(item => !session.quote!.items!.some(line => line.entry_id === item.entry_id
            && line.quantity === item.quantity && line.unit_price_minor === item.unit_price_minor
            && line.line_total_minor === item.line_total_minor))))
        || !['preparing', 'ready', 'collected', 'pending', 'completed', 'cancelled'].includes(order.fulfillment_status)
        || !Number.isFinite(Date.parse(order.updated_at))) throw new FlowError('binding_mismatch', '商家订单与原购买不一致。');
      if (session.mode === 'http' && (order.merchant_id !== session.quote.merchant_id
        || order.catalog_id !== session.quote.catalog_id || order.quote_id !== session.quote.quote_id
        || order.terms_hash !== session.quote.terms_hash
        || order.fulfillment !== session.quote.fulfillment || !session.quote.wire_terms || !order.wire_terms
        || computeTermsHash(order.wire_terms) !== computeTermsHash(session.quote.wire_terms))) {
        throw new FlowError('binding_mismatch', '商家订单条款与已确认报价不一致。');
      }
      session.order = order;
      session.phase = 'confirmed';
      delete session.error;
      delete session.diagnostic;
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
      session.phase = 'unknown';
      session.error = { code: 'processing', message: '商家仍在处理，请查询原尝试。' };
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
    delete session.attempt;
    delete session.order;
    delete session.diagnostic;
  }
  private async noOtherPending(userId: string, currentId?: string) {
    const sessions = await this.pendingSessions(userId);
    if (sessions.some(session => session.id !== currentId && isPendingPurchase(session))) {
      throw new FlowError('unresolved_purchase', '此身份还有购买结果未知，请先查询原会话；不能另开流程购买。', 409);
    }
  }
  private pendingSessions(userId: string) {
    return this.store.listPendingForUser?.(userId) ?? this.store.listForUser(userId);
  }
  private readOperation<T>(userId: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    // Cancellation releases this caller, not the user queue. A queued operation
    // must check again after any purchase ahead of it has finished.
    return abortable(this.queue.run(`user:${userId}`, async () => {
      signal?.throwIfAborted();
      const result = await operation();
      signal?.throwIfAborted();
      return result;
    }), signal);
  }
  private async finishAbortedRead(session: Session, signal?: AbortSignal): Promise<void> {
    if (!signal?.aborted) return;
    // Only local pre-purchase state is cleaned up, while still owning the user queue.
    // No canceled run can leave a confirmable quote or overwrite purchase evidence.
    if (!session.attempt) {
      session.phase = 'failed';
      session.error = signal.reason instanceof FlowError ? publicError(signal.reason)
        : { code: 'operation_cancelled', message: '搜索或报价已停止，请重试。' };
      delete session.quote;
      delete session.checkout_url;
      delete session.resolve_expires_at;
      await this.save(session);
    }
    signal.throwIfAborted();
  }
  private preCheckoutError(error: unknown, operation: 'search' | 'quote') {
    const result = publicError(error);
    if (!(error instanceof FlowError)
      || ['network_error', 'timeout', 'protocol_error', 'catalog_unavailable', 'merchant_unavailable'].includes(error.code)) {
      return { ...result, message: `${operation === 'search' ? '目录' : '报价'}服务暂时不可用，请重试。` };
    }
    return result;
  }
  private rejectAttempt(session: Session, error: { code: string; message: string }) {
    session.attempt!.status = 'failed';
    session.phase = ['quote_expired', 'requote_required'].includes(error.code) ? 'requote_required' : 'failed';
    session.error = error;
    delete session.order;
    delete session.diagnostic;
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
    return normalizeStoredSession(session);
  }
  private async save(session: Session) {
    session.revision += 1;
    session.updated_at = new Date(this.now()).toISOString();
    await this.store.write(session);
  }
  private public(session: Session): PublicSession {
    return toSessionView(session);
  }
}
