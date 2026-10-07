/**
 * The whole purchase, once, in the order A will drive it.
 *
 * `checkout.test.ts` proves the checkout state machine against quotes it builds
 * by hand. This file exists for the failure it cannot catch: a mismatch *between*
 * endpoints. If query returned an `entry_id` that resolve will not accept, or
 * resolve advertised a checkout URL that checkout is not mounted on, or the
 * quote route produced a `quote_id` the checkout route cannot look up, every
 * individual test above would still pass and the demo would still not work.
 *
 * So nothing here is constructed by hand. Each step feeds the next its own
 * output — the entry id from the query result, the URL from the resolve binding,
 * the quote id from the quote response — and the only thing supplied from
 * outside is the signing key.
 *
 * The last step is the one the acceptance criteria single out: run the purchase
 * again with the same `Idempotency-Key` and assert one order and one payment.
 * Counting orders alone would not be enough — a retry that re-charged while
 * replaying the order response would look identical from the order table.
 */
import { describe, expect, test } from 'bun:test';
import { catalogManifestSchema, catalogQueryResultSchema } from '@ocp-catalog/ocp-schema';
import {
  CHECKOUT_ACTION_ID,
  checkoutResponseSchema,
  type CommerceErrorResponse,
  type Quote,
} from '@ocp-catalog/shopping-contracts';
import type { MerchantContext } from './context';
import { countOrders } from './orders';
import { countPayments } from './payment';
import { handleRequest } from './service';
import {
  authorizationFor,
  jsonRequest,
  makeTempDatabasePath,
  makeTestContext,
  openTestDb,
  TEST_NOW_MS,
  type TestContextOptions,
} from './test-support';

const CALLER = 'caller_smoke';
const ATTEMPT_ID = 'att_smoke_0001';
const IDEM_KEY = 'idem_smoke_0001';

interface Harness {
  readonly ctx: MerchantContext;
  /** Sends a request by URL, exactly as a server would receive it. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  dispose(): void;
}

function harness(options: TestContextOptions = {}): Harness {
  const { path, cleanup } = makeTempDatabasePath();
  const db = openTestDb(path);
  const ctx = makeTestContext({ ...options, db });
  const base = ctx.config.publicBaseUrl;

  return {
    ctx,
    fetch: (url, init) => handleRequest(ctx, new Request(url, init)),
    post: (path, body, headers = {}) =>
      handleRequest(
        ctx,
        jsonRequest(`${base}${path}`, body, { headers: { 'x-dev-caller-id': CALLER, ...headers } }),
      ),
    dispose: () => {
      db.close();
      cleanup();
    },
  };
}

/** Reads the error envelope, so a failure reports the code instead of a parse error. */
async function expectOk(response: Response, at: string): Promise<unknown> {
  if (response.status >= 400) {
    const body = (await response.json()) as Partial<CommerceErrorResponse>;
    throw new Error(`${at}: expected success, got ${response.status} ${JSON.stringify(body.error)}`);
  }
  return response.json();
}

describe('the whole purchase, end to end', () => {
  test('discovery through order, then a retry with the same idempotency key', async () => {
    const server = harness();
    try {
      // 1. Discovery. It is the only URL A knows in advance.
      const discovery = (await expectOk(
        await server.fetch(`${server.ctx.config.publicBaseUrl}/.well-known/ocp-catalog`),
        'discovery',
      )) as Record<string, string>;
      expect(discovery['ocp_version']).toBe('1.0');

      // 2. Manifest, fetched from the URL discovery gave rather than from a
      //    constant — a wrong URL there would otherwise go unnoticed.
      const manifestPath = new URL(discovery['manifest_url'] ?? '').pathname;
      const manifest = catalogManifestSchema.parse(
        await expectOk(await server.fetch(`${server.ctx.config.publicBaseUrl}${manifestPath}`), 'manifest'),
      );
      expect(manifest.query_capabilities[0]?.supports_resolve).toBe(true);

      // 3. Query for the latte.
      const queryPath = new URL(discovery['query_url'] ?? '').pathname;
      const query = catalogQueryResultSchema.parse(
        await expectOk(await server.post(queryPath, { query: '拿铁' }), 'query'),
      );
      const entryId = query.entries[0]?.entry.entry_id;
      if (entryId === undefined) throw new Error('query returned nothing for 拿铁');

      // 4. Resolve that exact entry id. A takes the checkout URL from here and
      //    refuses to build one itself, so the URL is the thing under test.
      const resolvePath = new URL(discovery['resolve_url'] ?? '').pathname;
      const reference = (await expectOk(
        await server.post(resolvePath, { entry_id: entryId, purpose: 'checkout' }),
        'resolve',
      )) as {
        action_bindings: Array<{
          action_id: string;
          entrypoint: { url: string; method: string };
          input_schema?: { required?: readonly string[] };
          requires_user_confirmation?: boolean;
        }>;
      };
      const binding = reference.action_bindings.find((item) => item.action_id === CHECKOUT_ACTION_ID);
      if (binding === undefined) throw new Error('resolve published no checkout binding');
      expect(binding.requires_user_confirmation).toBe(true);
      const checkoutPath = new URL(binding.entrypoint.url).pathname;

      // 5. Quote that entry.
      const quote = (await expectOk(
        await server.post('/commerce/v1/quotes', {
          entry_id: entryId,
          quantity: 1,
          fulfillment: { method: 'pickup' },
        }),
        'quote',
      )) as Quote;
      expect(quote.total_minor).toBe(2500);
      expect(quote.expires_at > new Date(TEST_NOW_MS).toISOString()).toBe(true);

      // 6. Sign an authorization for that quote, bound to this one attempt.
      const authorization = authorizationFor(quote, { purchaseAttemptId: ATTEMPT_ID });
      const checkoutRequest = {
        purchase_attempt_id: ATTEMPT_ID,
        quote_id: quote.quote_id,
        terms_hash: quote.terms_hash,
        authorization,
      };

      // The binding tells A which fields the request needs. If the two ever
      // disagree, A builds a request this server rejects — so check it here.
      expect([...(binding.input_schema?.required ?? [])].sort()).toEqual(
        Object.keys(checkoutRequest).sort(),
      );

      // 7. Checkout, at the URL resolve published.
      const first = checkoutResponseSchema.parse(
        await expectOk(
          await server.post(checkoutPath, checkoutRequest, { 'idempotency-key': IDEM_KEY }),
          'checkout',
        ),
      );
      if (first.status !== 'confirmed') throw new Error(`checkout returned ${first.status}`);
      const orderId = first.order.order_id;

      // 8. Poll the attempt the way A does after a 202 — here it is already
      //    settled, and polling must be a read that changes nothing.
      const attemptPath = `/commerce/v1/purchase-attempts/${ATTEMPT_ID}`;
      const attempt = (await expectOk(
        await server.fetch(`${server.ctx.config.publicBaseUrl}${attemptPath}`, {
          headers: { 'x-dev-caller-id': CALLER },
        }),
        'attempt',
      )) as { status: string; order_id?: string };
      expect(attempt.status).toBe('confirmed');
      expect(attempt.order_id).toBe(orderId);

      // 9. Fetch the order by the id checkout returned.
      const order = (await expectOk(
        await server.fetch(`${server.ctx.config.publicBaseUrl}/commerce/v1/orders/${orderId}`, {
          headers: { 'x-dev-caller-id': CALLER },
        }),
        'order',
      )) as { order_id: string; total_minor: number };
      expect(order.order_id).toBe(orderId);
      expect(order.total_minor).toBe(2500);

      // 10. Retry the identical purchase — same key, same attempt id, same
      //     signature. This is what a retry after a dropped response looks like,
      //     and it must replay rather than buy a second coffee.
      const replay = checkoutResponseSchema.parse(
        await expectOk(
          await server.post(checkoutPath, checkoutRequest, { 'idempotency-key': IDEM_KEY }),
          'checkout replay',
        ),
      );
      if (replay.status !== 'confirmed') throw new Error(`replay returned ${replay.status}`);
      expect(replay.order.order_id).toBe(orderId);

      expect(countOrders(server.ctx.db)).toBe(1);
      // The payment table is the one that would catch a replay that re-charged.
      expect(countPayments(server.ctx.db)).toBe(1);
    } finally {
      server.dispose();
    }
  });

  test('the same key under a different caller is a separate purchase, not a replay', async () => {
    // Idempotency is keyed per caller. Two callers that happen to choose the same
    // key string must not collapse into one order — otherwise the second caller
    // is handed the first caller's coffee. Each buys its own quote, because a
    // quote belongs to the caller who asked for it.
    const server = harness();
    try {
      const orderIds: string[] = [];

      for (const callerId of ['caller_x', 'caller_y']) {
        const quote = (await expectOk(
          await server.post(
            '/commerce/v1/quotes',
            { entry_id: 'entry_latte', quantity: 1, fulfillment: { method: 'pickup' } },
            { 'x-dev-caller-id': callerId },
          ),
          `quote ${callerId}`,
        )) as Quote;

        const attemptId = `att_${callerId}`;
        const result = checkoutResponseSchema.parse(
          await expectOk(
            await server.post(
              '/commerce/v1/checkouts',
              {
                purchase_attempt_id: attemptId,
                quote_id: quote.quote_id,
                terms_hash: quote.terms_hash,
                authorization: authorizationFor(quote, { purchaseAttemptId: attemptId }),
              },
              { 'x-dev-caller-id': callerId, 'idempotency-key': 'shared_key_string' },
            ),
            `checkout ${callerId}`,
          ),
        );
        if (result.status !== 'confirmed') {
          throw new Error(`checkout ${callerId} returned ${result.status}`);
        }
        orderIds.push(result.order.order_id);
      }

      expect(orderIds[0]).not.toBe(orderIds[1]);
      expect(countOrders(server.ctx.db)).toBe(2);
    } finally {
      server.dispose();
    }
  });
});
