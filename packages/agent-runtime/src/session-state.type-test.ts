/** Compile-time protection: a generic persisted record isn't an executable purchase state. */
import type { Session, ConfirmableSession, AttemptSession } from './types';
import { isConfirmableSession, hasPurchaseAttempt } from './session-state';

export function checkStateConstraints(session: Session): void {
  // @ts-expect-error A generic session does not guarantee a quote and selection.
  const unsafeConfirmation: ConfirmableSession = session;
  // @ts-expect-error A generic session does not guarantee original attempt evidence.
  const unsafePurchase: AttemptSession = session;
  void unsafeConfirmation;
  void unsafePurchase;
  if (isConfirmableSession(session)) {
    session.quote.items[0];
    session.selection[0];
    session.checkout_url.toLowerCase();
  }
  if (hasPurchaseAttempt(session)) {
    session.attempt.idempotency_key.toLowerCase();
    session.quote.terms_hash.toLowerCase();
  }
  // @ts-expect-error The quantity is derived from items at the input boundary.
  session.intent.quantity = 99;
  // @ts-expect-error Basket lines are replaced through normalization, not edited.
  session.intent.items[0]!.quantity = 99;
  // @ts-expect-error The normalized array cannot be changed in place.
  session.intent.items.push({ query: 'extra', quantity: 1 });
  // @ts-expect-error Replace the whole normalized Intent when editing the basket.
  session.intent.items = [];
  if (session.quote) {
    // @ts-expect-error A quoted line is an immutable value.
    session.quote.items[0]!.unit_price_minor = 1;
    // @ts-expect-error Quoted basket membership cannot be changed in place.
    session.quote.items.splice(0, 1);
    // @ts-expect-error Replace a complete validated quote, never only its lines.
    session.quote.items = [];
  }
}
