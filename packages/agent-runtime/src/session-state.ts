import { canRequestQuote, isPendingPurchase } from '@ocp-catalog/shopping-contracts/browser';
import type { AttemptSession, ConfirmableSession, Session } from './types';

export function isConfirmableSession(session: Session): session is ConfirmableSession {
  return session.phase === 'awaiting_confirmation' && !!session.quote && !!session.selection?.length
    && !!session.checkout_url && !!session.resolve_expires_at && !session.attempt;
}
export function hasPurchaseAttempt(session: Session): session is AttemptSession {
  return !!session.attempt && !!session.quote;
}
export function requireRequote(session: Session, error: { code: string; message: string }): void {
  session.phase = 'requote_required';
  session.error = error;
}
/** Persists the original key before the coordinator calls a purchase port. */
export function beginPurchaseAttempt(session: ConfirmableSession, revision: number): AttemptSession {
  const purchasing: Session = session;
  purchasing.attempt = { purchase_attempt_id: `attempt_${crypto.randomUUID()}`,
    idempotency_key: `purchase_${crypto.randomUUID()}`, status: 'processing', confirmation_revision: revision };
  purchasing.phase = 'checkout_pending';
  delete purchasing.error;
  return purchasing as AttemptSession;
}
export function beginSearch(session: Session): void {
  if (!canRequestQuote(session)) throw new Error('purchase state does not allow discovery');
  session.phase = 'searching';
  session.search_warnings = [];
  delete session.quote;
  delete session.selection;
  delete session.selected_entry_ids;
  delete session.error;
  delete session.checkout_url;
  delete session.resolve_expires_at;
}
export function markUnknown(session: Session, message: string): void {
  if (!session.attempt) throw new Error('unknown purchase requires original attempt evidence');
  session.phase = 'unknown';
  session.error = { code: 'result_unknown', message };
  delete session.order;
}
export { isPendingPurchase };
