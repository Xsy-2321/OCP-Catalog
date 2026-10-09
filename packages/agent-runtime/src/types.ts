import type { DeliveryAddress, QuoteTerms } from '@ocp-catalog/shopping-contracts';
import type { SessionPhase, SessionView } from '@ocp-catalog/shopping-contracts/browser';

/** Internal port/read models. The HTTP boundary adapts shared shopping-contracts
 * wire objects; these application types are not an OCP standard.
 */
/** Compatible external input, normalized once at request/storage/port boundaries. */
export interface LegacyIntent {
  query: string;
  quantity: number;
  items?: readonly IntentItem[];
  currency: 'CNY';
  max_total_minor: number;
  merchant_id: string;
  fulfillment: 'pickup' | 'delivery';
  delivery?: DeliveryAddress;
}
export interface IntentItem { readonly query: string; readonly quantity: number }
export interface Intent {
  readonly query: string;
  readonly quantity: number;
  /** Nonempty after boundary validation; single product is one basket line. */
  readonly items: readonly IntentItem[];
  currency: 'CNY';
  max_total_minor: number;
  merchant_id: string;
  fulfillment: 'pickup' | 'delivery';
  delivery?: DeliveryAddress;
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
  fulfillment_methods?: ('pickup' | 'delivery')[];
}
export interface BasketSelection { candidate: Candidate; quantity: number }
export interface PricedItem { readonly entry_id: string; readonly title: string; readonly quantity: number; readonly unit_price_minor: number; readonly line_total_minor: number }
export interface LegacyQuote {
  quote_id: string;
  user_id: string;
  merchant_id: string;
  catalog_id?: string;
  entry_id: string;
  title: string;
  quantity: number;
  fulfillment: 'pickup' | 'delivery';
  delivery?: DeliveryAddress;
  items?: readonly PricedItem[];
  currency: string;
  unit_price_minor: number;
  fees: { label: string; amount_minor: number; code?: string }[];
  total_minor: number;
  terms_hash: string;
  expires_at: string;
  /** Immutable B terms, persisted for confirmation and restart recovery. Never contains a proof. */
  wire_terms?: QuoteTerms;
}
export interface Quote {
  quote_id: string;
  user_id: string;
  merchant_id: string;
  catalog_id?: string;
  readonly entry_id: string;
  readonly title: string;
  readonly quantity: number;
  readonly unit_price_minor: number;
  /** Nonempty priced basket; legacy display fields are derived at the boundary. */
  readonly items: readonly PricedItem[];
  fulfillment: 'pickup' | 'delivery';
  delivery?: DeliveryAddress;
  currency: string;
  fees: { label: string; amount_minor: number; code?: string }[];
  total_minor: number;
  terms_hash: string;
  expires_at: string;
  wire_terms?: QuoteTerms;
}
export interface Order {
  order_id: string;
  purchase_attempt_id: string;
  title: string;
  quantity: number;
  currency: string;
  total_minor: number;
  payment_status: 'paid' | 'pending' | 'failed' | 'unknown';
  fulfillment_status: 'preparing' | 'ready' | 'collected' | 'pending' | 'completed' | 'cancelled';
  merchant_id?: string;
  catalog_id?: string;
  quote_id?: string;
  terms_hash?: string;
  entry_id?: string;
  fulfillment?: 'pickup' | 'delivery';
  delivery?: DeliveryAddress;
  items?: readonly PricedItem[];
  wire_terms?: QuoteTerms;
  updated_at: string;
}
export interface MerchantAttempt {
  purchase_attempt_id: string;
  status: 'processing' | 'confirmed' | 'failed';
  order_id?: string;
  error?: { code: string; message: string };
  merchant_id?: string;
  catalog_id?: string;
  quote_id?: string;
}
export interface ApprovalClaims {
  issuer: string;
  user_id: string;
  merchant_id: string;
  quote_id: string;
  terms_hash: string;
  entry_id: string;
  quantity: number;
  fulfillment: 'pickup' | 'delivery';
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
  /** Persisted quote context; HTTP checkout requires it even after an A restart. */
  quote?: Quote;
}
export interface MerchantPort {
  readonly mode: 'mock' | 'http';
  health?(): Promise<MerchantHealth>;
  search(intent: Intent, options?: ReadOperationOptions): Promise<Candidate[]>;
  searchWithWarnings?(intent: Intent, options?: ReadOperationOptions): Promise<{ candidates: Candidate[]; warnings: string[] }>;
  resolve(candidate: Candidate, intent?: Intent, options?: ReadOperationOptions): Promise<{ checkout_url: string; expires_at: string }>;
  quote(userId: string, candidate: Candidate, intent: Intent, options?: ReadOperationOptions): Promise<LegacyQuote>;
  quoteBasket?(userId: string, selections: BasketSelection[], intent: Intent, options?: ReadOperationOptions): Promise<LegacyQuote>;
  checkout(input: CheckoutInput): Promise<MerchantAttempt>;
  getAttempt(userId: string, attemptId: string): Promise<MerchantAttempt>;
  getOrder(userId: string, orderId: string): Promise<Order>;
}
/** Cancellation is restricted to discovery and quoting; purchase/recovery never accept it. */
export interface ReadOperationOptions { signal?: AbortSignal }
export interface MerchantHealth {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'simulated' | 'unavailable';
  ready: boolean;
  checked_at: string;
  catalog_id?: string;
}
export type Phase = SessionPhase;
export interface Session {
  id: string;
  user_id: string;
  mode: 'mock' | 'http';
  phase: Phase;
  intent: Intent;
  candidates: Candidate[];
  candidate_groups?: { query: string; quantity: number; candidates: Candidate[] }[];
  search_warnings?: string[];
  /** One normalized basket selection, including single-item purchases. */
  selection?: BasketSelection[];
  selected_entry_ids?: string[];
  checkout_url?: string;
  resolve_expires_at?: string;
  quote?: Quote;
  attempt?: {
    purchase_attempt_id: string;
    idempotency_key: string;
    status: 'processing' | 'confirmed' | 'failed';
    confirmation_revision?: number;
    order_id?: string;
  };
  attempt_history?: {
    purchase_attempt_id: string;
    idempotency_key: string;
    status: 'failed';
    quote: Quote;
    confirmation_revision: number;
    error: { code: string; message: string };
    ended_at: string;
  }[];
  diagnostic?: {
    category: 'network' | 'timeout' | 'not_found' | 'protocol' | 'binding' | 'unavailable';
    operation: 'checkout' | 'recover';
    at: string;
  };
  order?: Order;
  error?: { code: string; message: string };
  revision: number;
  created_at: string;
  updated_at: string;
}
/** Stable page response. Adding a persisted field does not add an API field. */
export type PublicSession = SessionView;
export type ConfirmableSession = Session & { phase: 'awaiting_confirmation'; quote: Quote;
  selection: BasketSelection[]; checkout_url: string; resolve_expires_at: string };
export type AttemptSession = Session & { attempt: NonNullable<Session['attempt']>; quote: Quote };
export interface SessionStore {
  read(id: string): Promise<Session | undefined>;
  write(session: Session): Promise<void>;
  listForUser(userId: string): Promise<Session[]>;
  listPendingForUser?(userId: string): Promise<Session[]>;
}
