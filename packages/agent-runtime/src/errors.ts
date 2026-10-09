import type { MerchantAttempt } from './types';

export class FlowError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'FlowError';
  }
}
/** A bound, valid merchant confirmation survives failure of the surrounding order response. */
export class ConfirmedPurchaseProtocolError extends FlowError {
  readonly confirmedAttempt: MerchantAttempt;
  constructor(attempt: MerchantAttempt) {
    super('protocol_error', '商家已确认原购买尝试，但订单响应未通过校验，请查询原购买尝试。', 502);
    this.name = 'ConfirmedPurchaseProtocolError';
    // Enumerate only the validated business identifiers. Never retain the raw response or cause.
    this.confirmedAttempt = Object.freeze({ purchase_attempt_id: attempt.purchase_attempt_id, status: 'confirmed',
      order_id: attempt.order_id, merchant_id: attempt.merchant_id, catalog_id: attempt.catalog_id, quote_id: attempt.quote_id });
  }
}
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof FlowError
    ? { code: error.code, message: error.message }
    : { code: 'unavailable', message: '服务暂时不可用，请稍后重试。' };
}
