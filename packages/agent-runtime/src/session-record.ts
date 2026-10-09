import { SESSION_PHASES } from '@ocp-catalog/shopping-contracts';
import { normalizeStoredSession } from './basket-model';
import { FlowError } from './errors';
import type { Session } from './types';

export const sessionIdPattern = /^session_[a-f0-9-]{36}$/;
export function sessionDataCorrupt(): never {
  throw new FlowError('session_data_corrupt', '购物记录损坏，已停止操作；请先恢复原记录并查询原购买结果。', 503);
}

/** Validate before normalizing. A damaged purchase is never discarded. */
export function decodeSession(text: string, id: string): Session {
  try {
    const value = JSON.parse(text) as Session;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== id || !sessionIdPattern.test(id)
      || typeof value.user_id !== 'string' || !value.user_id || !['mock', 'http'].includes(value.mode)
      || !SESSION_PHASES.includes(value.phase) || !value.intent || typeof value.intent !== 'object'
      || typeof value.intent.merchant_id !== 'string' || !Array.isArray(value.candidates)
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.updated_at))
      || (value.attempt !== undefined && (!value.attempt || !['processing', 'confirmed', 'failed'].includes(value.attempt.status)
        || typeof value.attempt.purchase_attempt_id !== 'string' || !value.attempt.purchase_attempt_id
        || typeof value.attempt.idempotency_key !== 'string' || !value.attempt.idempotency_key))) sessionDataCorrupt();
    return normalizeStoredSession(value);
  } catch { return sessionDataCorrupt(); }
}
