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
  checkoutRequestSchema,
  createQuoteRequestSchema,
  orderResponseSchema,
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
import { recordEvent } from './events';
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
import { requireOwnedOrder } from './orders';
import { buildQuote, insertQuote } from './quote';
import type { CatalogEntryRecord } from './catalog';

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
  const db = options.db ?? openMerchantDb(options.config.databasePath);
  return {
    config: options.config,
    db,
    clock: options.clock ?? systemClock,
    catalog: options.catalog ?? loadCatalog(CATALOG_SEED),
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

  const record = findEntry(ctx.catalog, parsed.data.entry_id);
  if (record === null) {
    throw new CommerceError('not_found', `unknown entry_id: ${parsed.data.entry_id}`);
  }

  const nowMs = ctx.clock.nowMs();
  const quote: Quote = buildQuote(record, parsed.data, { config: ctx.config, nowMs });
  insertQuote(ctx.db, quote, callerId);
  recordEvent(ctx.db, {
    subjectType: 'quote',
    subjectId: quote.quote_id,
    type: 'quote.created',
    nowMs,
    data: {
      entry_id: parsed.data.entry_id,
      quantity: parsed.data.quantity,
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

/* ---------------------------------------------------------------- dispatch */

const ATTEMPT_PREFIX = '/commerce/v1/purchase-attempts/';
const ORDER_PREFIX = '/commerce/v1/orders/';

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
  if (method === 'POST' && pathname === '/ocp/query') return handleQuery(ctx, await readJson(request));
  if (method === 'POST' && pathname === '/ocp/resolve') return handleResolve(ctx, await readJson(request));

  if (method === 'POST' && pathname === '/commerce/v1/quotes') {
    return handleCreateQuote(ctx, await readJson(request), request);
  }
  if (method === 'POST' && pathname === '/commerce/v1/checkouts') {
    return handleCheckout(ctx, await readJson(request), request);
  }
  if (method === 'GET' && pathname.startsWith(ATTEMPT_PREFIX)) {
    return handleGetAttempt(ctx, decodeURIComponent(pathname.slice(ATTEMPT_PREFIX.length)), request);
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
