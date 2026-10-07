/** A-side internal port/read models, NOT a frozen shopping-contracts wire protocol.
 * Replace/adapt at the boundary once B delivers C0; never publish as an OCP standard.
 */
export interface Intent {
  query: string;
  quantity: number;
  currency: 'CNY';
  max_total_minor: number;
  merchant_id: string;
  fulfillment: 'pickup';
}
export interface Candidate {
  entry_id: string;
  catalog_id: string;
  merchant_id: string;
  title: string;
  description: string;
  search_price_minor: number;
  currency: string;
  in_stock: boolean;
}
export interface Quote {
  quote_id: string;
  user_id: string;
  merchant_id: string;
  entry_id: string;
  title: string;
  quantity: number;
  fulfillment: 'pickup';
  currency: string;
  unit_price_minor: number;
  fees: { label: string; amount_minor: number }[];
  total_minor: number;
  terms_hash: string;
  expires_at: string;
}
export interface Order {
  order_id: string;
  purchase_attempt_id: string;
  title: string;
  quantity: number;
  currency: string;
  total_minor: number;
  payment_status: 'paid' | 'pending' | 'failed';
  fulfillment_status: 'preparing' | 'ready' | 'collected';
  updated_at: string;
}
export interface MerchantAttempt {
  purchase_attempt_id: string;
  status: 'processing' | 'confirmed' | 'failed';
  order_id?: string;
  error?: { code: string; message: string };
}
export interface ApprovalClaims {
  issuer: 'shopping-agent-local-mock';
  user_id: string;
  merchant_id: string;
  quote_id: string;
  terms_hash: string;
  entry_id: string;
  quantity: number;
  fulfillment: 'pickup';
  currency: string;
  max_total_minor: number;
  purchase_attempt_id: string;
  expires_at: string;
}
export interface CheckoutInput {
  user_id: string;
  purchase_attempt_id: string;
  idempotency_key: string;
  quote_id: string;
  terms_hash: string;
  authorization_proof: string;
  checkout_url: string;
}
export interface MerchantPort {
  readonly mode: 'mock';
  search(intent: Intent): Promise<Candidate[]>;
  resolve(candidate: Candidate): Promise<{ checkout_url: string; expires_at: string }>;
  quote(userId: string, candidate: Candidate, intent: Intent): Promise<Quote>;
  checkout(input: CheckoutInput): Promise<MerchantAttempt>;
  getAttempt(userId: string, attemptId: string): Promise<MerchantAttempt>;
  getOrder(userId: string, orderId: string): Promise<Order>;
}
export type Phase = 'new' | 'searching' | 'candidates' | 'quoting'
  | 'awaiting_confirmation' | 'checkout_pending' | 'unknown' | 'confirmed'
  | 'failed' | 'cancelled' | 'requote_required';
export interface Session {
  id: string;
  user_id: string;
  mode: 'mock';
  phase: Phase;
  intent: Intent;
  candidates: Candidate[];
  selected?: Candidate;
  checkout_url?: string;
  resolve_expires_at?: string;
  quote?: Quote;
  attempt?: {
    purchase_attempt_id: string;
    idempotency_key: string;
    status: 'processing' | 'confirmed' | 'failed';
  };
  order?: Order;
  error?: { code: string; message: string };
  revision: number;
  created_at: string;
  updated_at: string;
}
export type PublicSession = Omit<Session, 'user_id' | 'checkout_url' | 'resolve_expires_at' | 'attempt' | 'quote'> & {
  attempt?: Omit<NonNullable<Session['attempt']>, 'idempotency_key'>;
  quote?: Omit<Quote, 'user_id'>;
};
export interface SessionStore {
  read(id: string): Promise<Session | undefined>;
  write(session: Session): Promise<void>;
}
