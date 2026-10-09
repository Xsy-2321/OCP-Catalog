import { parseSessionView, type SessionView } from '@ocp-catalog/shopping-contracts/browser';
import type { Session } from './types';

/** Allowlist projection; nested schemas also strip any extra runtime fields. */
export function toSessionView(session: Session): SessionView {
  return parseSessionView({ id: session.id, mode: session.mode, phase: session.phase,
    intent: session.intent, candidates: session.candidates, candidate_groups: session.candidate_groups,
    search_warnings: session.search_warnings, selected: session.selection?.[0]?.candidate,
    selected_items: session.selection, selected_entry_ids: session.selected_entry_ids,
    quote: session.quote, attempt: session.attempt ? {
      purchase_attempt_id: session.attempt.purchase_attempt_id, status: session.attempt.status } : undefined,
    attempt_history: session.attempt_history?.map(history => ({ purchase_attempt_id: history.purchase_attempt_id,
      status: history.status, confirmation_revision: history.confirmation_revision, error: history.error,
      ended_at: history.ended_at, quote_id: history.quote.quote_id, terms_hash: history.quote.terms_hash })),
    diagnostic: session.diagnostic, order: session.order, error: session.error,
    revision: session.revision, created_at: session.created_at, updated_at: session.updated_at });
}
