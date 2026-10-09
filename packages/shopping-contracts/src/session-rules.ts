/** Browser-safe workflow rules. Purchase evidence and workflow phase are separate. */
export const SESSION_PHASES = ['new', 'searching', 'candidates', 'quoting', 'awaiting_confirmation',
  'checkout_pending', 'unknown', 'confirmed', 'failed', 'cancelled', 'requote_required'] as const;
export type SessionPhase = typeof SESSION_PHASES[number];
export interface PurchaseState {
  phase: SessionPhase;
  attempt?: { status: 'processing' | 'confirmed' | 'failed' };
}
export function isPendingPurchase(session: PurchaseState): boolean {
  return session.phase === 'checkout_pending' || session.phase === 'unknown' || session.attempt?.status === 'processing';
}
export function canRequestQuote(session: PurchaseState): boolean {
  if (isPendingPurchase(session) || session.phase === 'confirmed' || session.phase === 'cancelled') return false;
  return !session.attempt || (session.attempt.status === 'failed'
    && (session.phase === 'failed' || session.phase === 'requote_required'));
}
export function canSelectCandidate(session: PurchaseState): boolean {
  return canRequestQuote(session) && ['candidates', 'awaiting_confirmation', 'requote_required', 'failed'].includes(session.phase);
}
/** A confirmed attempt with an unavailable order still requires original-attempt recovery. */
export function shouldStopPlanning(session: PurchaseState): boolean {
  return !!session.attempt || ['awaiting_confirmation', 'cancelled', 'unknown', 'checkout_pending', 'confirmed'].includes(session.phase);
}
