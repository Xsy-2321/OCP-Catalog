/** Explicit page contracts, independent of persisted runtime records. No server imports. */
import { z } from 'zod';
import { deliveryAddressSchema, quoteTermsSchema, quoteFulfillmentSchema } from './terms-schema';
import { quoteLineItemSchema, quoteFeeLineSchema } from './quote-schema';
import { orderSchema, orderPaymentSchema, orderFulfillmentSchema, type Order } from './order-schema';
import { SESSION_PHASES } from './session-rules';

const text = z.string().min(1);
const integer = z.number().int().safe();
const money = integer.nonnegative();
const currency = z.string().regex(/^[A-Z]{3}$/);
const errorSchema = z.object({ code: text, message: text });
const pricedItemSchema = z.object({ entry_id: text, title: text, quantity: integer.positive(),
  unit_price_minor: money, line_total_minor: money });
export const candidateViewSchema = z.object({ entry_id: text, catalog_id: text, merchant_id: text,
  title: text, description: z.string(), search_price_minor: money, currency, in_stock: z.boolean(),
  fulfillment_methods: z.array(z.enum(['pickup', 'delivery'])).optional() });
export const intentViewSchema = z.object({ query: text, quantity: integer.positive(),
  items: z.array(z.object({ query: text, quantity: integer.positive() })).nonempty().optional(),
  currency: z.literal('CNY'), max_total_minor: integer.positive(), merchant_id: text,
  fulfillment: z.enum(['pickup', 'delivery']), delivery: deliveryAddressSchema.optional() });
export const quoteViewSchema = z.object({ quote_id: text, merchant_id: text, catalog_id: text.optional(),
  entry_id: text, title: text, quantity: integer.positive(), fulfillment: z.enum(['pickup', 'delivery']),
  delivery: deliveryAddressSchema.optional(), items: z.array(pricedItemSchema).nonempty().optional(), currency,
  unit_price_minor: money, fees: z.array(z.object({ label: text, amount_minor: integer, code: text.optional() })),
  total_minor: money, terms_hash: text, expires_at: z.string().datetime(), wire_terms: quoteTermsSchema.optional() });
export const runtimeOrderViewSchema = z.object({ order_id: text, purchase_attempt_id: text, title: text,
  quantity: integer.positive(), currency, total_minor: money,
  payment_status: z.enum(['paid', 'pending', 'failed', 'unknown']),
  fulfillment_status: z.enum(['preparing', 'ready', 'collected', 'pending', 'completed', 'cancelled']),
  merchant_id: text.optional(), catalog_id: text.optional(), quote_id: text.optional(), terms_hash: text.optional(),
  entry_id: text.optional(), fulfillment: z.enum(['pickup', 'delivery']).optional(),
  delivery: deliveryAddressSchema.optional(), items: z.array(pricedItemSchema).nonempty().optional(),
  wire_terms: quoteTermsSchema.optional(), updated_at: z.string().datetime() });
export const sessionViewSchema = z.object({
  id: text, mode: z.enum(['mock', 'http']), phase: z.enum(SESSION_PHASES), intent: intentViewSchema,
  candidates: z.array(candidateViewSchema),
  candidate_groups: z.array(z.object({ query: text, quantity: integer.positive(), candidates: z.array(candidateViewSchema) })).optional(),
  search_warnings: z.array(z.string()).optional(), selected: candidateViewSchema.optional(),
  selected_items: z.array(z.object({ candidate: candidateViewSchema, quantity: integer.positive() })).nonempty().optional(),
  selected_entry_ids: z.array(text).optional(), quote: quoteViewSchema.optional(),
  attempt: z.object({ purchase_attempt_id: text, status: z.enum(['processing', 'confirmed', 'failed']) }).optional(),
  attempt_history: z.array(z.object({ purchase_attempt_id: text, status: z.literal('failed'),
    confirmation_revision: integer.nonnegative(), error: errorSchema, ended_at: z.string().datetime(),
    quote_id: text, terms_hash: text })).optional(),
  diagnostic: z.object({ category: z.enum(['network', 'timeout', 'not_found', 'protocol', 'binding', 'unavailable']),
    operation: z.enum(['checkout', 'recover']), at: z.string().datetime() }).optional(),
  order: runtimeOrderViewSchema.optional(), error: errorSchema.optional(), revision: integer.nonnegative(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;
export const parseSessionView = (value: unknown): SessionView => sessionViewSchema.parse(value);
export const pendingSessionsViewSchema = z.object({ sessions: z.array(sessionViewSchema) });
export type PendingSessionsView = z.infer<typeof pendingSessionsViewSchema>;
export const parsePendingSessionsView = (value: unknown): PendingSessionsView => pendingSessionsViewSchema.parse(value);
export const configViewSchema = z.object({ mode: z.enum(['mock', 'http']), merchant_id: text,
  merchant_demo_available: z.boolean().optional(), payment_mode: z.literal('local_simulated'),
  c0_status: z.literal('integrated'), contract_version: text,
  llm_status: z.enum(['configured', 'not_configured']), llm_model: z.string().nullable(),
  merchant_health: z.object({ status: z.enum(['mock', 'online', 'offline']), message: text, checked_at: z.string().datetime() }) });
export type ConfigView = z.infer<typeof configViewSchema>;
export const parseConfigView = (value: unknown): ConfigView => configViewSchema.parse(value);
export const agentRunViewSchema = z.object({ session: sessionViewSchema, planner_mode: z.literal('llm'),
  tool_calls: integer.nonnegative(), explanation: z.string(), model: text,
  outcome: z.enum(['quote_ready', 'no_candidates', 'selection_required', 'quote_failed']),
  next_actions: z.array(z.enum(['confirm_quote', 'choose_candidate', 'edit_request'])), warnings: z.array(z.string()) });
export type AgentRunView = z.infer<typeof agentRunViewSchema>;
export const parseAgentRunView = (value: unknown): AgentRunView => agentRunViewSchema.parse(value);

// Detail and summary are deliberately different privacy projections. They share
// field validators with commerce records, but adding a commerce field won't add a view field.
const merchantOrderFields = { order_id: text, merchant_id: text, catalog_id: text, purchase_attempt_id: text,
  quote_id: text, currency, items: z.array(quoteLineItemSchema).nonempty(), fees: z.array(quoteFeeLineSchema),
  subtotal_minor: money, total_minor: money, terms_hash: text, payment: orderPaymentSchema,
  fulfillment_status: orderFulfillmentSchema, created_at: z.string().datetime(), updated_at: z.string().datetime() };
function validOrderAmounts(order: { items: { entry_id: string; quantity: number; unit_minor: number; line_total_minor: number }[];
  fees: { amount_minor: number }[]; subtotal_minor: number; total_minor: number }): boolean {
  let subtotal = 0;
  let fees = 0;
  if (new Set(order.items.map(item => item.entry_id)).size !== order.items.length) return false;
  for (const item of order.items) {
    const expected = item.quantity * item.unit_minor;
    subtotal += item.line_total_minor;
    if (!Number.isSafeInteger(expected) || item.line_total_minor !== expected || !Number.isSafeInteger(subtotal)) return false;
  }
  for (const fee of order.fees) {
    fees += fee.amount_minor;
    if (!Number.isSafeInteger(fees)) return false;
  }
  return subtotal === order.subtotal_minor && Number.isSafeInteger(subtotal + fees) && subtotal + fees === order.total_minor;
}
export const merchantOrderSummarySchema = z.object({ ...merchantOrderFields,
  fulfillment: z.object({ method: z.enum(['pickup', 'delivery']), location_id: text.optional() }).strict() })
  .refine(validOrderAmounts, 'inconsistent order amounts');
export const merchantOrderDetailSchema = z.object({ ...merchantOrderFields, fulfillment: quoteFulfillmentSchema })
  .refine(validOrderAmounts, 'inconsistent order amounts');
export type MerchantOrderSummary = z.infer<typeof merchantOrderSummarySchema>;
export type MerchantOrderDetail = z.infer<typeof merchantOrderDetailSchema>;
export const parseMerchantOrderSummary = (value: unknown): MerchantOrderSummary => merchantOrderSummarySchema.parse(value);
export const parseMerchantOrderDetail = (value: unknown): MerchantOrderDetail => merchantOrderDetailSchema.parse(value);
function merchantOrderProjection(order: Order) {
  return { order_id: order.order_id, merchant_id: order.merchant_id, catalog_id: order.catalog_id,
    purchase_attempt_id: order.purchase_attempt_id, quote_id: order.quote_id, currency: order.currency,
    items: order.items.map(item => ({ entry_id: item.entry_id, title: item.title, quantity: item.quantity,
      unit_minor: item.unit_minor, line_total_minor: item.line_total_minor })),
    fees: order.fees.map(fee => ({ code: fee.code, label: fee.label, amount_minor: fee.amount_minor })),
    subtotal_minor: order.subtotal_minor, total_minor: order.total_minor, terms_hash: order.terms_hash,
    payment: { status: order.payment.status, updated_at: order.payment.updated_at },
    fulfillment_status: { status: order.fulfillment_status.status, updated_at: order.fulfillment_status.updated_at },
    created_at: order.created_at, updated_at: order.updated_at };
}
export function projectMerchantOrderSummary(order: Order): MerchantOrderSummary {
  return merchantOrderSummarySchema.parse({ ...merchantOrderProjection(order),
    fulfillment: { method: order.fulfillment.method, location_id: order.fulfillment.location_id } });
}
export function projectMerchantOrderDetail(order: Order): MerchantOrderDetail {
  return merchantOrderDetailSchema.parse({ ...merchantOrderProjection(order), fulfillment: {
    method: order.fulfillment.method, location_id: order.fulfillment.location_id, delivery: order.fulfillment.delivery } });
}
export const merchantProductViewSchema = z.object({ entry_id: text, title: text, price_minor: money, currency,
  inventory: z.object({ availability_status: text, available_quantity: money.nullable(), reserved_quantity: money }),
  fulfillment: z.object({ methods: z.array(z.enum(['pickup', 'delivery'])), delivery_fee_minor: money.nullable() }) });
export type MerchantProductView = z.infer<typeof merchantProductViewSchema>;
const pageFields = { next_cursor: z.string().min(1).max(2048).nullable(), has_more: z.boolean(), total: money };
function validPage(page: { items: unknown[]; next_cursor: string | null; has_more: boolean; total: number }): boolean {
  return page.total >= page.items.length && page.has_more === (page.next_cursor !== null) && (!page.has_more || page.items.length > 0);
}
export const merchantProductsPageSchema = z.object({ items: z.array(merchantProductViewSchema), ...pageFields })
  .refine(validPage, 'inconsistent page metadata');
export const merchantOrdersPageSchema = z.object({ items: z.array(merchantOrderSummarySchema), ...pageFields })
  .refine(validPage, 'inconsistent page metadata');
export const merchantOverviewViewSchema = z.object({ read_only: z.literal(true), merchant_id: text, catalog_id: text,
  checked_at: z.string().datetime(), payment_mode: z.literal('local_simulated'), fulfillment_mode: z.literal('local_simulated'),
  products: merchantProductsPageSchema, orders: merchantOrdersPageSchema });
export type MerchantOverviewView = z.infer<typeof merchantOverviewViewSchema>;
export type MerchantProductsPage = z.infer<typeof merchantProductsPageSchema>;
export type MerchantOrdersPage = z.infer<typeof merchantOrdersPageSchema>;
export const parseMerchantOverviewView = (value: unknown): MerchantOverviewView => merchantOverviewViewSchema.parse(value);
export const parseMerchantProductsPage = (value: unknown): MerchantProductsPage => merchantProductsPageSchema.parse(value);
export const parseMerchantOrdersPage = (value: unknown): MerchantOrdersPage => merchantOrdersPageSchema.parse(value);
// Type-only check that browser order details cover the current commerce response.
const _orderCompatible: z.ZodType<MerchantOrderDetail> = orderSchema;
void _orderCompatible;
