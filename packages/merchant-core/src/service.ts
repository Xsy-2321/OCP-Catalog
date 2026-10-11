/**
 * The merchant's request handler: routing, identity, CORS, error rendering.
 *
 * `handle(request)` is a plain function from a `Request` to a `Response`, with
 * no server attached. That is what makes the whole API testable at the route
 * level — a test builds a `Request`, calls this, and reads the `Response` — and
 * it means `apps/coffee-merchant-api` is a two-line bootstrap rather than a
 * second place where the API is defined.
 *
 * Caller identity comes from `x-dev-caller-id`. This is a stand-in for an
 * account system, nothing more: it is trivially forgeable, and the code says so
 * wherever it appears. It exists because quote, attempt and order records need
 * an owner so that "can this caller see this?" has an answer at all.
 *
 * A missing caller identity is `unauthorized` — the caller has not said who it
 * is. A caller that names itself and asks for someone else's resource gets
 * `not_found`, because a 403 would confirm the resource exists.
 */
import { Database } from 'bun:sqlite';
import {
  CommerceError,
  DEV_CALLER_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  attemptEventsResponseSchema,
  checkoutRequestSchema,
  createQuoteRequestSchema,
  quoteRequestItems,
  orderEventsResponseSchema,
  orderResponseSchema,
  updateFulfillmentRequestSchema,
  type Order,
  type Quote,
} from '@ocp-catalog/shopping-contracts';
import { SimulatedResponseLoss, runCheckout, settlePendingAttempt } from './checkout';
import type { MerchantContext } from './context';
import { loadCatalog, findEntry } from './catalog';
import type { Clock } from './clock';
import { systemClock } from './clock';
import type { MerchantConfig } from './config';
import { CATALOG_SEED } from './data/catalog';
import { openMerchantDb } from './db';
import { catalogWithInventory, initializeInventory } from './inventory';
import { listEventsForSubjects, recordEvent } from './events';
import {
  errorResponse,
  handleDiscovery,
  handleHealth,
  handleManifest,
  handleQuery,
  handleResolve,
  jsonResponse,
  readJson,
  unexpectedErrorResponse,
} from './http';
import {
  advanceFulfillment,
  getOrderRow,
  parseOrderRow,
  requireOwnedAttempt,
  requireOwnedOrder,
  saveOrderStatuses,
} from './orders';
import { buildQuote, insertQuote } from './quote';
import type { CatalogEntryRecord } from './catalog';
import { productPage } from './product-page';

const MAX_CALLER_ID_LENGTH = 128;

/* --------------------------------------------------------------- assembling */

export interface CreateMerchantOptions {
  readonly config: MerchantConfig;
  readonly clock?: Clock;
  /** Overridable so a test can start from a catalog it controls. */
  readonly catalog?: readonly CatalogEntryRecord[];
  /** Overridable so a test can hand in an already-open database. */
  readonly db?: Database;
}

/**
 * Builds everything a request needs.
 *
 * One call, so a test constructs the same object production does rather than
 * wiring it by hand and drifting. The database is opened here and owned by the
 * caller, who is responsible for closing it.
 */
export function createMerchantContext(options: CreateMerchantOptions): MerchantContext {
  const catalog = options.catalog ?? loadCatalog(CATALOG_SEED);
  const db = options.db ?? openMerchantDb(options.config.databasePath);
  try {
    initializeInventory(db, options.config.merchantId, catalog);
  } catch (error) {
    if (options.db === undefined) db.close();
    throw error;
  }
  return {
    config: options.config,
    db,
    clock: options.clock ?? systemClock,
    catalog,
  };
}

/* ---------------------------------------------------------------- identity */

function requireCallerId(request: Request): string {
  const raw = request.headers.get(DEV_CALLER_HEADER);
  const callerId = (raw ?? '').trim();
  if (callerId === '') {
    throw new CommerceError(
      'unauthorized',
      `missing ${DEV_CALLER_HEADER}: this demo identifies callers with a header, and it is not an account system`,
    );
  }
  if (callerId.length > MAX_CALLER_ID_LENGTH) {
    throw new CommerceError('invalid_request', `${DEV_CALLER_HEADER} must be at most ${MAX_CALLER_ID_LENGTH} characters`);
  }
  return callerId;
}

function requireIdempotencyKey(request: Request): string {
  const raw = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  const key = (raw ?? '').trim();
  if (key === '') {
    throw new CommerceError(
      'invalid_request',
      `missing ${IDEMPOTENCY_KEY_HEADER}: retries of one purchase must present the same key`,
    );
  }
  return key;
}

/* -------------------------------------------------------------------- CORS */

/**
 * CORS headers, emitted only for origins the operator listed.
 *
 * No wildcard: the merchant is reachable from a browser, and `*` would let any
 * page on the internet drive a checkout against a local demo.
 */
function corsHeaders(config: MerchantConfig, request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  if (origin === null || !config.allowedOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': `content-type, ${IDEMPOTENCY_KEY_HEADER}, ${DEV_CALLER_HEADER}`,
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

/* ------------------------------------------------------------------ routes */

function handleCreateQuote(ctx: MerchantContext, rawBody: unknown, request: Request): Response {
  const callerId = requireCallerId(request);
  const parsed = createQuoteRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new CommerceError('invalid_request', `invalid quote request: ${parsed.error.message}`);
  }

  const catalog = catalogWithInventory(ctx);
  const items = quoteRequestItems(parsed.data);
  const records = items.map(item => {
    const record = findEntry(catalog, item.entry_id);
    if (record === null) throw new CommerceError('not_found', `unknown entry_id: ${item.entry_id}`);
    return record;
  });

  const nowMs = ctx.clock.nowMs();
  const quote: Quote = buildQuote(records, parsed.data, { config: ctx.config, nowMs });
  insertQuote(ctx.db, quote, callerId);
  recordEvent(ctx.db, {
    subjectType: 'quote',
    subjectId: quote.quote_id,
    type: 'quote.created',
    nowMs,
    data: {
      items,
      total_minor: quote.total_minor,
      currency: quote.currency,
    },
  });

  return jsonResponse(quote);
}

function handleCheckout(ctx: MerchantContext, rawBody: unknown, request: Request): Response {
  const callerId = requireCallerId(request);
  const idempotencyKey = requireIdempotencyKey(request);
  const parsed = checkoutRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new CommerceError('invalid_request', `invalid checkout request: ${parsed.error.message}`);
  }

  const result = runCheckout(ctx, parsed.data, { callerId, idempotencyKey });

  // `declined` carries a `CommerceError` that was already committed to the
  // database. It is rendered through the same envelope path as a thrown one, so
  // the caller cannot tell — and must not be able to tell — which rejections
  // were cached and which were rolled back.
  if (result.kind === 'declined') return errorResponse(result.error);
  if (result.kind === 'processing') return jsonResponse(result.body, 202);
  return jsonResponse(result.body, 200);
}

function handleGetAttempt(ctx: MerchantContext, attemptId: string, request: Request): Response {
  const callerId = requireCallerId(request);
  // Reading an attempt is what finishes one the merchant reported as unknown.
  const attempt = settlePendingAttempt(ctx, attemptId, callerId);
  return jsonResponse(attempt);
}

function handleGetOrder(ctx: MerchantContext, orderId: string, request: Request): Response {
  const callerId = requireCallerId(request);
  const order: Order = orderResponseSchema.parse(requireOwnedOrder(ctx.db, orderId, callerId));
  return jsonResponse(order);
}

/**
 * The order's status history, for the caller who owns it.
 *
 * Ownership is settled through the same `requireOwnedOrder` the plain order read
 * uses, and before any event is gathered: a stream names the attempt, the quote
 * and the payment, so an unscoped read would turn this route into an oracle that
 * confirms other callers' purchase ids.
 *
 * It spans the quote as well as the order and its attempt so that the stream
 * opens where the purchase did — `quote.created` is what recorded the price the
 * buyer then authorized, and no other route returns it.
 */
function handleGetOrderEvents(ctx: MerchantContext, orderId: string, request: Request): Response {
  const callerId = requireCallerId(request);
  const order = requireOwnedOrder(ctx.db, orderId, callerId);
  const events = listEventsForSubjects(ctx.db, [order.order_id, order.purchase_attempt_id, order.quote_id]);
  return jsonResponse(orderEventsResponseSchema.parse({ order_id: order.order_id, events }));
}

/**
 * The attempt's history, for the caller who owns it.
 *
 * This is the failure path's read surface. The order route begins at an order,
 * so an attempt that was declined, ran past its deadline, or is still
 * `processing` has no order to hang its records off — and those are exactly the
 * attempts an agent that lost a response most needs to read back. Without this
 * route those records are write-only.
 *
 * Deliberately a pure read. Unlike `GET /purchase-attempts/:id`, it does not
 * settle a pending attempt: letting a read of history finish a payment would
 * mean an observer changes what it observes, and a caller polling for evidence
 * would silently be the thing that produced it.
 */
function handleGetAttemptEvents(ctx: MerchantContext, attemptId: string, request: Request): Response {
  const callerId = requireCallerId(request);
  // Checked before any event is gathered, for the same reason as the order
  // route: the stream names the quote and the attempt, so an unscoped read would
  // confirm other callers' ids.
  const attempt = requireOwnedAttempt(ctx.db, attemptId, callerId);
  const events = listEventsForSubjects(ctx.db, [attempt.purchase_attempt_id, attempt.quote_id]);
  return jsonResponse(attemptEventsResponseSchema.parse({
    purchase_attempt_id: attempt.purchase_attempt_id,
    events,
  }));
}

/**
 * Advances an order's fulfilment. An operator action, not a buyer one.
 *
 * There is no merchant-operator identity in this demo — `x-dev-caller-id` names
 * the *buyer*, and the buyer has no business marking their own coffee ready. So
 * the route is gated on `MERCHANT_TEST_MODE` instead of pretending to
 * authenticate: outside test mode it is not a route at all and the caller gets
 * the same `not_found` as any unknown path, which is both the truthful answer
 * and the one that leaks nothing. A real deployment needs a merchant credential
 * here; a second forgeable header wearing a badge would be worse than an honest
 * gap, and the code says so rather than implying the gate is security.
 *
 * The order is looked up unscoped by caller on purpose: the merchant is acting
 * on its own order, so the buyer's identity is irrelevant to whether the move is
 * allowed. What decides that is the state machine in `advanceFulfillment`.
 */
function handleUpdateFulfillment(ctx: MerchantContext, orderId: string, rawBody: unknown): Response {
  if (!ctx.config.testMode) {
    throw new CommerceError('not_found', `no route for POST /commerce/v1/orders/${orderId}/fulfillment`);
  }
  const parsed = updateFulfillmentRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new CommerceError('invalid_request', `invalid fulfillment update: ${parsed.error.message}`);
  }

  const row = getOrderRow(ctx.db, orderId);
  if (row === null) throw new CommerceError('not_found', `no order ${orderId}`);

  const nowMs = ctx.clock.nowMs();
  const current = parseOrderRow(row);
  const order = advanceFulfillment(current, parsed.data.status, nowMs);
  saveOrderStatuses(ctx.db, order);
  recordEvent(ctx.db, {
    subjectType: 'order',
    subjectId: order.order_id,
    type: 'order.fulfillment_changed',
    nowMs,
    data: { from: current.fulfillment_status.status, to: order.fulfillment_status.status },
  });

  return jsonResponse(orderResponseSchema.parse(order));
}

/* ---------------------------------------------------------------- dispatch */

const ATTEMPT_PREFIX = '/commerce/v1/purchase-attempts/';
const ORDER_PREFIX = '/commerce/v1/orders/';
/* Shared by the attempt and order event routes: both are `<resource>/events`. */
const EVENTS_SUFFIX = '/events';
const ORDER_FULFILLMENT_SUFFIX = '/fulfillment';

export async function handleRequest(ctx: MerchantContext, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  const cors = corsHeaders(ctx.config, request);

  try {
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const response = await route(ctx, request, pathname, method);
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  } catch (error) {
    if (error instanceof CommerceError) return errorResponse(error, cors);

    // The simulated response loss reaches here by design: the settlement is
    // committed and the answer is deliberately not delivered. It must NOT render
    // as a commerce error envelope, because a structured body would tell the
    // caller the purchase failed when it actually succeeded.
    if (error instanceof SimulatedResponseLoss) {
      return new Response(error.message, {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...cors },
      });
    }

    return unexpectedErrorResponse(error);
  }
}

async function route(
  ctx: MerchantContext,
  request: Request,
  pathname: string,
  method: string,
): Promise<Response> {
  if (method === 'GET' && pathname === '/.well-known/ocp-catalog') return handleDiscovery(ctx);
  if (method === 'GET' && pathname === '/ocp/manifest') return handleManifest(ctx);
  if (method === 'GET' && pathname === '/ocp/health') return handleHealth(ctx);
  if (method === 'GET' && pathname.startsWith('/products/')) {
    let entryId: string;
    try { entryId = decodeURIComponent(pathname.slice('/products/'.length)); }
    catch { throw new CommerceError('invalid_request', 'invalid product URL'); }
    const record = findEntry(catalogWithInventory(ctx), entryId);
    if (record === null) throw new CommerceError('not_found', `unknown entry_id: ${entryId}`);
    return productPage(record);
  }
  if (method === 'POST' && pathname === '/ocp/query') return handleQuery(ctx, await readJson(request));
  if (method === 'POST' && pathname === '/ocp/resolve') return handleResolve(ctx, await readJson(request));

  if (method === 'POST' && pathname === '/commerce/v1/quotes') {
    return handleCreateQuote(ctx, await readJson(request), request);
  }
  if (method === 'POST' && pathname === '/commerce/v1/checkouts') {
    return handleCheckout(ctx, await readJson(request), request);
  }
  // The event routes are matched before the plain reads they share a prefix
  // with. `/purchase-attempts/x/events` starts with `ATTEMPT_PREFIX` and
  // `/orders/x/events` starts with `ORDER_PREFIX`, so a plain-read branch placed
  // first would swallow both and answer with a resource named "x/events".
  if (method === 'GET' && pathname.startsWith(ATTEMPT_PREFIX) && pathname.endsWith(EVENTS_SUFFIX)) {
    let attemptId: string;
    try { attemptId = decodeURIComponent(pathname.slice(ATTEMPT_PREFIX.length, -EVENTS_SUFFIX.length)); }
    catch { throw new CommerceError('invalid_request', 'invalid purchase attempt URL'); }
    return handleGetAttemptEvents(ctx, attemptId, request);
  }
  if (method === 'GET' && pathname.startsWith(ATTEMPT_PREFIX)) {
    return handleGetAttempt(ctx, decodeURIComponent(pathname.slice(ATTEMPT_PREFIX.length)), request);
  }
  if (method === 'GET' && pathname.startsWith(ORDER_PREFIX) && pathname.endsWith(EVENTS_SUFFIX)) {
    let orderId: string;
    try { orderId = decodeURIComponent(pathname.slice(ORDER_PREFIX.length, -EVENTS_SUFFIX.length)); }
    catch { throw new CommerceError('invalid_request', 'invalid order URL'); }
    return handleGetOrderEvents(ctx, orderId, request);
  }
  if (method === 'POST' && pathname.startsWith(ORDER_PREFIX) && pathname.endsWith(ORDER_FULFILLMENT_SUFFIX)) {
    let orderId: string;
    try { orderId = decodeURIComponent(pathname.slice(ORDER_PREFIX.length, -ORDER_FULFILLMENT_SUFFIX.length)); }
    catch { throw new CommerceError('invalid_request', 'invalid order URL'); }
    return handleUpdateFulfillment(ctx, orderId, await readJson(request));
  }
  if (method === 'GET' && pathname.startsWith(ORDER_PREFIX)) {
    return handleGetOrder(ctx, decodeURIComponent(pathname.slice(ORDER_PREFIX.length)), request);
  }

  throw new CommerceError('not_found', `no route for ${method} ${pathname}`);
}

/** Curried form, for `Bun.serve({ fetch })`. */
export function createRequestHandler(ctx: MerchantContext): (request: Request) => Promise<Response> {
  return (request) => handleRequest(ctx, request);
}
