/**
 * Route-level tests, through `handleRequest`.
 *
 * These call the same function `Bun.serve` will call, with a real `Request` and
 * a real `Response` — the technique the repo already uses in
 * `examples/typescript/src/server.test.ts`. Nothing is mocked, so a route wired
 * to the wrong handler, or one that forgets a header requirement, fails here
 * rather than in A's client at integration time.
 *
 * Two conventions are load-bearing and get their own tests rather than being
 * assumed:
 *
 *   - The status code carries the outcome. `OcpClient` branches on status before
 *     it reads the body, so a rejection smuggled into a 200 body would be
 *     invisible to the caller — and every 2xx body has to be schema-correct.
 *   - The simulated response loss is the one failure that must NOT arrive as a
 *     structured envelope. A tidy `{ error: ... }` would tell the caller the
 *     purchase failed when in fact it settled.
 */
import { describe, expect, test } from 'bun:test';
import {
  catalogManifestSchema,
  catalogQueryResultSchema,
  resolvableReferenceSchema,
} from '@ocp-catalog/ocp-schema';
import {
  CHECKOUT_ACTION_ID,
  DEV_CALLER_HEADER,
  EXPECTED_FILTERABLE_FIELD_REFS,
  IDEMPOTENCY_KEY_HEADER,
  checkoutResponseSchema,
  orderResponseSchema,
  type CommerceErrorResponse,
  type Quote,
} from '@ocp-catalog/shopping-contracts';
import { loadCatalog } from './catalog';
import { manualClock } from './clock';
import type { MerchantContext } from './context';
import { CATALOG_SEED } from './data/catalog';
import { countOrders } from './orders';
import { countPayments } from './payment';
import { buildQuote, insertQuote } from './quote';
import { createRequestHandler, handleRequest } from './service';
import {
  TEST_NOW_MS,
  authorizationFor,
  jsonRequest,
  makeTempDatabasePath,
  makeTestContext,
  openTestDb,
  type TestContextOptions,
} from './test-support';

const CALLER = 'caller_a';
const OTHER_CALLER = 'caller_b';
const ALLOWED_ORIGIN = 'http://localhost:5173';

/* ------------------------------------------------------------------ harness */

interface Server {
  readonly ctx: MerchantContext;
  url(path: string): string;
  send(path: string, init?: RequestInit): Promise<Response>;
  /** Sends a JSON body with the two headers a commerce call needs. */
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  dispose(): void;
}

function makeServer(options: TestContextOptions = {}): Server {
  const { path: dbPath, cleanup } = makeTempDatabasePath();
  const db = openTestDb(dbPath);
  const ctx = makeTestContext({ allowedOrigins: [ALLOWED_ORIGIN], ...options, db });
  const base = ctx.config.publicBaseUrl;

  return {
    ctx,
    url: (path) => `${base}${path}`,
    send: (path, init) => handleRequest(ctx, new Request(`${base}${path}`, init)),
    post: (path, body, headers = {}) =>
      handleRequest(
        ctx,
        jsonRequest(`${base}${path}`, body, {
          headers: { [DEV_CALLER_HEADER]: CALLER, [IDEMPOTENCY_KEY_HEADER]: 'key_1', ...headers },
        }),
      ),
    dispose: () => {
      db.close();
      cleanup();
    },
  };
}

async function withServer<T>(
  options: TestContextOptions,
  work: (server: Server) => Promise<T>,
): Promise<T> {
  const server = makeServer(options);
  try {
    return await work(server);
  } finally {
    server.dispose();
  }
}

/** Posts with the caller header but no Idempotency-Key, for the header tests. */
function callerOnly(
  server: Server,
  path: string,
  body: unknown,
  callerId = CALLER,
): Promise<Response> {
  return handleRequest(
    server.ctx,
    jsonRequest(server.url(path), body, { headers: { [DEV_CALLER_HEADER]: callerId } }),
  );
}

async function readBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function envelope(response: Response): Promise<CommerceErrorResponse['error']> {
  return (await readBody<CommerceErrorResponse>(response)).error;
}

/** Quotes an entry through the HTTP route, the way A will. */
async function quoteThrough(server: Server, entryId = 'entry_latte'): Promise<Quote> {
  const response = await server.post('/commerce/v1/quotes', {
    entry_id: entryId,
    quantity: 1,
    fulfillment: { method: 'pickup' },
  });
  expect(response.status).toBe(200);
  return readBody<Quote>(response);
}

/** The body of a checkout request for a quote, as A builds it. */
function checkoutBody(quote: Quote, attemptId: string, maxTotalMinor?: number): unknown {
  return {
    purchase_attempt_id: attemptId,
    quote_id: quote.quote_id,
    terms_hash: quote.terms_hash,
    authorization: authorizationFor(quote, {
      purchaseAttemptId: attemptId,
      ...(maxTotalMinor === undefined ? {} : { maxTotalMinor }),
    }),
  };
}

/* ------------------------------------------------------ the OCP read surface */

describe('the read surface', () => {
  test('discovery points at every endpoint the merchant serves', async () => {
    await withServer({}, async (server) => {
      const response = await server.send('/.well-known/ocp-catalog');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const discovery = await readBody<Record<string, string>>(response);
      expect(discovery['ocp_version']).toBe('1.0');
      expect(discovery['manifest_url']).toBe(server.url('/ocp/manifest'));
      expect(discovery['query_url']).toBe(server.url('/ocp/query'));
      expect(discovery['resolve_url']).toBe(server.url('/ocp/resolve'));
      expect(discovery['health_url']).toBe(server.url('/ocp/health'));
    });
  });

  test('the manifest is schema-valid and declares exactly the filters that exist', async () => {
    await withServer({}, async (server) => {
      const response = await server.send('/ocp/manifest');
      expect(response.status).toBe(200);

      // Parsed through the protocol's own schema: a field this server invents
      // would fail on A's side with no clue where it came from.
      const manifest = catalogManifestSchema.parse(await readBody(response));
      const capability = manifest.query_capabilities[0];
      if (capability === undefined) throw new Error('no query capability declared');

      // The declaration is derived from the same map the handler reads, so this
      // compares the declaration against that map rather than against a second
      // hand-written list that could drift from both.
      expect(capability.filterable_field_refs).toEqual([...EXPECTED_FILTERABLE_FIELD_REFS]);
      expect(capability.filterable_field_refs).toContain('price#/amount');
      expect(capability.searchable_field_refs).toContain('product.core#/title');
      expect(capability.supports_resolve).toBe(true);
      expect(manifest.data_profile.catalog_entry_count).toBe(CATALOG_SEED.length);
    });
  });

  test('health reports ready with the clock the merchant was given', async () => {
    await withServer({}, async (server) => {
      const response = await server.send('/ocp/health');
      expect(response.status).toBe(200);

      const health = await readBody<Record<string, unknown>>(response);
      expect(health['status']).toBe('healthy');
      expect(health['ready']).toBe(true);
      expect(health['checked_at']).toBe(new Date(TEST_NOW_MS).toISOString());
    });
  });

  test('query returns the latte with a schema-correct result', async () => {
    await withServer({}, async (server) => {
      const response = await server.post('/ocp/query', { query: '拿铁' });
      expect(response.status).toBe(200);

      const result = catalogQueryResultSchema.parse(await readBody(response));
      expect(result.result_count).toBe(1);
      expect(result.entries[0]?.entry.entry_id).toBe('entry_latte');
      expect(result.policy_summary?.rejected_filters).toEqual([]);
      expect(result.policy_summary?.warnings).toEqual([]);
    });
  });

  test('query reports a filter it cannot honour instead of ignoring it silently', async () => {
    await withServer({}, async (server) => {
      // `has_image` is a real protocol filter; this merchant has no images, so it
      // must say so rather than return results that merely look filtered.
      const response = await server.post('/ocp/query', { query: '', filters: { has_image: true } });
      expect(response.status).toBe(200);

      const result = catalogQueryResultSchema.parse(await readBody(response));
      expect(result.policy_summary?.rejected_filters).toEqual(['has_image']);
      expect(result.policy_summary?.warnings).toHaveLength(1);
      expect(result.policy_summary?.warnings?.[0]).toContain('has_image');
      // Rejecting a filter is a policy note, not a failure: the results come back
      // unfiltered, which is exactly why the warning has to be there.
      expect(result.entries).toHaveLength(CATALOG_SEED.length);
    });
  });

  test('query rejects a malformed body with the error envelope', async () => {
    await withServer({}, async (server) => {
      const response = await server.post('/ocp/query', { query: 42 });

      expect(response.status).toBe(400);
      expect((await envelope(response)).code).toBe('invalid_request');
    });
  });

  /**
   * Every filter the manifest declares, exercised against known stock.
   *
   * This is the acceptance line "declared filters actually work" turned into a
   * test: a filter that is declared but never applied returns the unfiltered
   * set, so each case asserts the result differs from it.
   */
  test('each declared filter really narrows the result set', async () => {
    const all = CATALOG_SEED.map((entry) => entry.entry_id).sort();
    const cases: ReadonlyArray<{
      readonly filters: Record<string, unknown>;
      readonly expect: readonly string[];
    }> = [
      { filters: { category: 'merchandise' }, expect: ['entry_gift_box'] },
      { filters: { category: 'coffee' }, expect: all.filter((id) => id !== 'entry_gift_box') },
      { filters: { brand: '不存在的品牌' }, expect: [] },
      { filters: { currency: 'USD' }, expect: [] },
      { filters: { min_amount: 50 }, expect: ['entry_gift_box'] },
      { filters: { max_amount: 10 }, expect: ['entry_americano'] },
      { filters: { availability_status: 'out_of_stock' }, expect: ['entry_soldout'] },
      { filters: { in_stock_only: true }, expect: all.filter((id) => id !== 'entry_soldout') },
    ];

    await withServer({}, async (server) => {
      for (const testCase of cases) {
        const label = JSON.stringify(testCase.filters);
        const response = await server.post('/ocp/query', { query: '', filters: testCase.filters });
        expect(response.status, label).toBe(200);

        const result = catalogQueryResultSchema.parse(await readBody(response));
        const ids = result.entries.map((match) => match.entry.entry_id).sort();

        expect(ids, `filter ${label}`).toEqual([...testCase.expect].sort());
        // A filter that is applied is reported as accepted, and one that is not
        // must appear as rejected. Checking both stops "accepted" from being a
        // claim that is true on its own.
        for (const key of Object.keys(testCase.filters)) {
          expect(result.policy_summary?.accepted_filters, `filter ${label}`).toContain(key);
        }
        expect(result.policy_summary?.rejected_filters, `filter ${label}`).toEqual([]);
      }
    });
  });

  test('resolve hands A the checkout endpoint rather than letting it guess', async () => {
    await withServer({}, async (server) => {
      const response = await server.post('/ocp/resolve', {
        entry_id: 'entry_latte',
        purpose: 'checkout',
      });
      expect(response.status).toBe(200);

      const reference = resolvableReferenceSchema.parse(await readBody(response));
      const checkout = reference.action_bindings.find(
        (binding) => binding.action_id === CHECKOUT_ACTION_ID,
      );

      expect(checkout?.entrypoint.url).toBe(server.url('/commerce/v1/checkouts'));
      expect(checkout?.entrypoint.method).toBe('POST');
      // A only accepts an action from an origin it already trusts, so the URL has
      // to be the advertised base rather than whatever host the request came in on.
      expect(checkout?.entrypoint.url.startsWith(server.ctx.config.publicBaseUrl)).toBe(true);
      expect(checkout?.requires_user_confirmation).toBe(true);
      expect(checkout?.expires_at).toBe(new Date(TEST_NOW_MS + 900_000).toISOString());
    });
  });

  test('resolve of an unknown entry is a 404', async () => {
    await withServer({}, async (server) => {
      const response = await server.post('/ocp/resolve', { entry_id: 'entry_nope' });

      expect(response.status).toBe(404);
      expect((await envelope(response)).code).toBe('not_found');
    });
  });

  test('an unknown route is a 404, and so is a known route with the wrong method', async () => {
    await withServer({}, async (server) => {
      const missing = await server.send('/ocp/nope');
      expect(missing.status).toBe(404);
      expect((await envelope(missing)).code).toBe('not_found');

      // The checkout endpoint is POST-only; a GET must not fall through to
      // something else that happens to be listening.
      const wrongMethod = await server.send('/commerce/v1/checkouts');
      expect(wrongMethod.status).toBe(404);
    });
  });
});

/* --------------------------------------------------------- the commerce surface */

describe('the commerce surface', () => {
  test('a quote comes back with a stored terms_hash and a deadline', async () => {
    await withServer({}, async (server) => {
      const quote = await quoteThrough(server);

      expect(quote.merchant_id).toBe(server.ctx.config.merchantId);
      expect(quote.total_minor).toBe(2500);
      expect(quote.terms_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(quote.expires_at).toBe(
        new Date(TEST_NOW_MS + server.ctx.config.quoteTtlSeconds * 1000).toISOString(),
      );
    });
  });

  test('a delivery quote carries the fee in the total, not only in the fee list', async () => {
    await withServer({}, async (server) => {
      const response = await server.post('/commerce/v1/quotes', {
        entry_id: 'entry_latte',
        quantity: 1,
        fulfillment: { method: 'delivery' },
      });
      expect(response.status).toBe(200);

      const quote = await readBody<Quote>(response);
      expect(quote.fees.map((fee) => fee.code)).toEqual(['delivery']);
      expect(quote.subtotal_minor).toBe(2500);
      // The budget check runs against the total, so a fee that never reaches it
      // is how an affordable drink becomes an over-budget purchase at the till.
      expect(quote.total_minor).toBe(3000);
    });
  });

  test('a fulfillment method the entry does not offer is a 400, not a surprise at checkout', async () => {
    await withServer({}, async (server) => {
      const response = await server.post('/commerce/v1/quotes', {
        entry_id: 'entry_americano', // pickup only
        quantity: 1,
        fulfillment: { method: 'delivery' },
      });

      expect(response.status).toBe(400);
      expect((await envelope(response)).code).toBe('invalid_request');
    });
  });

  test('a quote without a caller identity is unauthorized, not anonymous', async () => {
    await withServer({}, async (server) => {
      const response = await handleRequest(
        server.ctx,
        jsonRequest(server.url('/commerce/v1/quotes'), {
          entry_id: 'entry_latte',
          quantity: 1,
          fulfillment: { method: 'pickup' },
        }),
      );

      expect(response.status).toBe(401);
      const error = await envelope(response);
      expect(error.code).toBe('unauthorized');
      // The message has to name the header, so nobody mistakes this for an
      // account system that merely was not configured.
      expect(error.message).toContain(DEV_CALLER_HEADER);
    });
  });

  test('a full checkout through the routes settles into a readable order', async () => {
    await withServer({}, async (server) => {
      const quote = await quoteThrough(server);
      const attemptId = 'att_route_1';

      const response = await server.post('/commerce/v1/checkouts', checkoutBody(quote, attemptId));
      expect(response.status).toBe(200);

      // Parsed through A's own response schema: the union is what the client
      // discriminates on, so the route must satisfy it exactly.
      const settled = checkoutResponseSchema.parse(await readBody(response));
      if (settled.status !== 'confirmed') throw new Error(`expected confirmed, got ${settled.status}`);
      expect(settled.order.total_minor).toBe(2500);
      expect(settled.purchase_attempt.purchase_attempt_id).toBe(attemptId);
      expect(settled.purchase_attempt.status).toBe('confirmed');
      // Money and coffee are separate facts; a confirmed payment is not a
      // finished drink.
      expect(settled.order.payment_status.status).toBe('paid');
      expect(settled.order.fulfillment_status.status).toBe('pending');

      const fetched = await handleRequest(
        server.ctx,
        new Request(server.url(`/commerce/v1/orders/${settled.order.order_id}`), {
          headers: { [DEV_CALLER_HEADER]: CALLER },
        }),
      );
      expect(fetched.status).toBe(200);
      const order = orderResponseSchema.parse(await readBody(fetched));
      expect(order.order_id).toBe(settled.order.order_id);
      expect(order.payment_status.status).toBe('paid');

      // And asking for an id it never had is a 404, not a 500.
      const missing = await handleRequest(
        server.ctx,
        new Request(server.url('/commerce/v1/orders/ord_never_existed'), {
          headers: { [DEV_CALLER_HEADER]: CALLER },
        }),
      );
      expect(missing.status).toBe(404);
    });
  });

  test('checkout without an Idempotency-Key is refused before anything is charged', async () => {
    await withServer({}, async (server) => {
      const quote = await quoteThrough(server);

      const response = await callerOnly(
        server,
        '/commerce/v1/checkouts',
        checkoutBody(quote, 'att_nokey_1'),
      );

      expect(response.status).toBe(400);
      expect((await envelope(response)).code).toBe('invalid_request');
      expect(countOrders(server.ctx.db)).toBe(0);
      expect(countPayments(server.ctx.db)).toBe(0);
    });
  });

  test('a rejected checkout carries the status its code mandates', async () => {
    await withServer({}, async (server) => {
      const quote = await quoteThrough(server);
      const attemptId = 'att_route_budget';

      const response = await server.post(
        '/commerce/v1/checkouts',
        checkoutBody(quote, attemptId, 100),
      );

      // 409, not 200-with-an-error-body: `OcpClient` branches on status first.
      expect(response.status).toBe(409);
      expect((await envelope(response)).code).toBe('budget_exceeded');
      expect(countOrders(server.ctx.db)).toBe(0);
    });
  });

  test('an expired quote cannot be checked out even with a valid signature', async () => {
    // The clock is held here rather than reached through the context: production
    // only ever needs `nowMs()`, so the context exposes `Clock`, and the ability
    // to move time is a test affordance that stays in the test.
    const clock = manualClock(TEST_NOW_MS);

    await withServer({ clock }, async (server) => {
      const quote = await quoteThrough(server);
      // Move past a deadline the merchant itself published, after the quote was
      // issued and signed against.
      clock.set(Date.parse(quote.expires_at) + 1);

      const response = await server.post(
        '/commerce/v1/checkouts',
        checkoutBody(quote, 'att_route_expired'),
      );

      expect(response.status).toBe(409);
      expect((await envelope(response)).code).toBe('quote_expired');
      expect(countOrders(server.ctx.db)).toBe(0);
    });
  });

  test('a body that is not JSON is an invalid_request, not a crash', async () => {
    await withServer({}, async (server) => {
      const response = await handleRequest(
        server.ctx,
        new Request(server.url('/ocp/query'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{not json',
        }),
      );

      expect(response.status).toBe(400);
      expect((await envelope(response)).code).toBe('invalid_request');
    });
  });

  test('polling an attempt finishes one the merchant reported as unknown', async () => {
    await withServer({ faults: ['payment_timeout_then_succeed'] }, async (server) => {
      const quote = await quoteThrough(server);
      const attemptId = 'att_route_poll';

      const response = await server.post('/commerce/v1/checkouts', checkoutBody(quote, attemptId));

      // 202, not an error: A must poll rather than retry the purchase, and the
      // schema it validates against is the `processing` arm of the union.
      expect(response.status).toBe(202);
      const pending = checkoutResponseSchema.parse(await readBody(response));
      expect(pending.status).toBe('processing');

      const polled = await handleRequest(
        server.ctx,
        new Request(server.url(`/commerce/v1/purchase-attempts/${attemptId}`), {
          headers: { [DEV_CALLER_HEADER]: CALLER },
        }),
      );
      expect(polled.status).toBe(200);
      const settled = await readBody<{ status: string; order_id?: string }>(polled);
      expect(settled.status).toBe('confirmed');
      expect(settled.order_id).toBeDefined();
      // Polling is a read that happens to finish the job; it must not charge again.
      expect(countPayments(server.ctx.db)).toBe(1);
      expect(countOrders(server.ctx.db)).toBe(1);
    });
  });

  test('another caller gets the same 404 for an attempt as for one that never existed', async () => {
    await withServer({ faults: ['payment_timeout_then_succeed'] }, async (server) => {
      const quote = await quoteThrough(server);
      const attemptId = 'att_route_owner';
      await server.post('/commerce/v1/checkouts', checkoutBody(quote, attemptId));

      const foreign = await handleRequest(
        server.ctx,
        new Request(server.url(`/commerce/v1/purchase-attempts/${attemptId}`), {
          headers: { [DEV_CALLER_HEADER]: OTHER_CALLER },
        }),
      );
      const missing = await handleRequest(
        server.ctx,
        new Request(server.url('/commerce/v1/purchase-attempts/att_never_existed'), {
          headers: { [DEV_CALLER_HEADER]: OTHER_CALLER },
        }),
      );

      // 404 rather than 403: a 403 would confirm the attempt exists, turning the
      // id space into an oracle. The two answers must be indistinguishable.
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect((await envelope(foreign)).code).toBe((await envelope(missing)).code);
    });
  });

  test('a lost response arrives as a bare 500, never as an error envelope', async () => {
    await withServer({ faults: ['response_dropped_after_settlement'] }, async (server) => {
      const quote = await quoteThrough(server);

      const response = await server.post(
        '/commerce/v1/checkouts',
        checkoutBody(quote, 'att_route_dropped'),
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('text/plain');

      // The whole point: a structured body would tell A the purchase failed when
      // it actually settled. So there must be no envelope to read.
      const text = await response.text();
      expect(text).not.toContain('"error"');
      expect(() => JSON.parse(text) as unknown).toThrow();

      // And the purchase really did settle, which is why the answer had to be
      // ambiguous rather than negative.
      expect(countOrders(server.ctx.db)).toBe(1);
      expect(countPayments(server.ctx.db)).toBe(1);
    });
  });

  test('an entry that vanished from the catalog is a requote, not a crash', async () => {
    // The catalog changed after A was quoted: the quote is real, the entry is
    // not. The answer must be a structured requote request, not a 500.
    const withoutLatte = CATALOG_SEED.filter((entry) => entry.entry_id !== 'entry_latte');

    await withServer({ catalog: loadCatalog(withoutLatte) }, async (server) => {
      const record = loadCatalog(CATALOG_SEED).find((item) => item.entry.entry_id === 'entry_latte');
      if (record === undefined) throw new Error('the seed no longer has a latte');
      const quote = buildQuote(
        record,
        { entry_id: 'entry_latte', quantity: 1, fulfillment: { method: 'pickup' } },
        { config: server.ctx.config, nowMs: TEST_NOW_MS },
      );
      insertQuote(server.ctx.db, quote, CALLER);

      const response = await server.post(
        '/commerce/v1/checkouts',
        checkoutBody(quote, 'att_route_gone'),
      );

      expect(response.status).toBe(409);
      const error = await envelope(response);
      expect(error.code).toBe('requote_required');
      expect((error.details as { reason?: string } | undefined)?.reason).toBe('entry_gone');
      expect(countOrders(server.ctx.db)).toBe(0);
    });
  });
});

/* -------------------------------------------------------------------- CORS */

describe('CORS', () => {
  test('answers a preflight only for an origin the operator listed', async () => {
    await withServer({}, async (server) => {
      const allowed = await server.send('/ocp/query', {
        method: 'OPTIONS',
        headers: { origin: ALLOWED_ORIGIN },
      });

      expect(allowed.status).toBe(204);
      const allowOrigin = allowed.headers.get('access-control-allow-origin');
      expect(allowOrigin).toBe(ALLOWED_ORIGIN);
      // No wildcard: the merchant is reachable from a browser, and `*` would let
      // any page on the internet drive a checkout against a local demo.
      expect(allowOrigin).not.toBe('*');
      expect(allowed.headers.get('vary')).toBe('origin');
    });
  });

  test('says nothing to an origin that is not on the list', async () => {
    await withServer({}, async (server) => {
      const response = await server.send('/ocp/query', {
        method: 'OPTIONS',
        headers: { origin: 'http://evil.example' },
      });

      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  test('carries the headers on the real response too, not only on the preflight', async () => {
    await withServer({}, async (server) => {
      const response = await handleRequest(
        server.ctx,
        jsonRequest(
          server.url('/ocp/query'),
          { query: '拿铁' },
          { headers: { origin: ALLOWED_ORIGIN } },
        ),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    });
  });

  test('a rejected checkout still carries them, so the browser can read the refusal', async () => {
    await withServer({}, async (server) => {
      const quote = await quoteThrough(server);
      const response = await handleRequest(
        server.ctx,
        jsonRequest(server.url('/commerce/v1/checkouts'), checkoutBody(quote, 'att_cors_1', 1), {
          headers: {
            [DEV_CALLER_HEADER]: CALLER,
            [IDEMPOTENCY_KEY_HEADER]: 'key_cors',
            origin: ALLOWED_ORIGIN,
          },
        }),
      );

      // Without this the browser would hide the 409 body and A would see an
      // opaque network failure instead of `budget_exceeded`.
      expect(response.status).toBe(409);
      expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    });
  });
});

/* ---------------------------------------------------------------- the handler */

describe('the curried handler', () => {
  test('is a plain fetch function, so the app bootstrap stays two lines', async () => {
    const { path, cleanup } = makeTempDatabasePath();
    const db = openTestDb(path);
    try {
      const ctx = makeTestContext({ db });
      const handler = createRequestHandler(ctx);

      const response = await handler(new Request(`${ctx.config.publicBaseUrl}/ocp/health`));
      expect(response.status).toBe(200);
      expect((await readBody<Record<string, unknown>>(response))['status']).toBe('healthy');
    } finally {
      db.close();
      cleanup();
    }
  });
});
