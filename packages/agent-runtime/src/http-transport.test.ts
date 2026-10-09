import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTH_DOMAIN, AUTH_SCHEME, authorizationProofSchema, authorizationSigningBytes, buildQuoteTerms,
  computeQuoteTermsHash, type Order as WireOrder, type PurchaseAttempt, type Quote as WireQuote,
} from '@ocp-catalog/shopping-contracts';
import { Ed25519AuthorizationIssuer } from './authorization';
import { HttpMerchantTransport } from './http-transport';
import { ShoppingCoordinator } from './coordinator';
import { ConfirmedPurchaseProtocolError, publicError } from './errors';
import { FileSessionStore } from './store';
import type { ApprovalClaims, Candidate, Intent, Quote, Session } from './types';
import manifestFixture from '../../../fixtures/shopping/manifest.json';
import queryFixture from '../../../fixtures/shopping/query-result.json';
import resolveFixture from '../../../fixtures/shopping/resolve.json';

const NOW = Date.parse('2026-10-07T10:05:00.000Z');
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const keys = generateKeyPairSync('ed25519');
const candidate: Candidate = { entry_id: 'entry_latte', catalog_id: 'catalog_coffee_demo', merchant_id: 'merchant_coffee_demo',
  title: '拿铁', description: '本地模拟', search_price_minor: 2500, currency: 'CNY', in_stock: true };
const intent: Intent = { query: '拿铁', items: [{ query: '拿铁', quantity: 1 }], quantity: 1, currency: 'CNY', max_total_minor: 3000,
  merchant_id: candidate.merchant_id, fulfillment: 'pickup' };
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(true); });

function wireQuote(): WireQuote {
  const draft = { quote_id: 'quote_one', merchant_id: candidate.merchant_id, catalog_id: candidate.catalog_id, currency: 'CNY',
    items: [{ entry_id: candidate.entry_id, title: candidate.title, quantity: 1, unit_minor: 2500, line_total_minor: 2500 }],
    fees: [], subtotal_minor: 2500, total_minor: 2500, fulfillment: { method: 'pickup' as const }, created_at: iso(), expires_at: iso(900_000) };
  return { ...draft, terms_hash: computeQuoteTermsHash(draft) };
}
function wireAttempt(status: 'processing' | 'confirmed' | 'failed' = 'confirmed'): PurchaseAttempt {
  return { purchase_attempt_id: 'attempt_one', merchant_id: candidate.merchant_id, catalog_id: candidate.catalog_id,
    quote_id: 'quote_one', status, ...(status === 'confirmed' ? { order_id: 'order_one' } : {}),
    ...(status === 'failed' ? { error: { code: 'payment_failed' as const, message: 'raw secret-looking error' } } : {}),
    created_at: iso(), updated_at: iso() };
}
function wireOrder(): WireOrder {
  const { expires_at: _expiry, ...quote } = wireQuote();
  return { ...quote, order_id: 'order_one', purchase_attempt_id: 'attempt_one',
    payment: { status: 'paid', updated_at: iso() }, fulfillment_status: { status: 'pending', updated_at: iso() }, updated_at: iso() };
}
function readQuote(wire = wireQuote()): Quote {
  const item = wire.items[0]!;
  return { quote_id: wire.quote_id, user_id: 'user_one', merchant_id: wire.merchant_id, catalog_id: wire.catalog_id,
    entry_id: item.entry_id, title: item.title, quantity: item.quantity, fulfillment: 'pickup', currency: wire.currency,
    items: [{ entry_id: item.entry_id, title: item.title, quantity: item.quantity,
      unit_price_minor: item.unit_minor, line_total_minor: item.line_total_minor }],
    unit_price_minor: item.unit_minor, fees: wire.fees.map(fee => ({ label: fee.label, amount_minor: fee.amount_minor })),
    total_minor: wire.total_minor, terms_hash: wire.terms_hash, expires_at: wire.expires_at, wire_terms: buildQuoteTerms(wire) };
}
function claims(overrides: Partial<ApprovalClaims> = {}): ApprovalClaims {
  return { issuer: 'agent_a_demo', user_id: 'user_one', merchant_id: candidate.merchant_id, quote_id: 'quote_one',
    terms_hash: wireQuote().terms_hash, entry_id: candidate.entry_id, quantity: 1, fulfillment: 'pickup', currency: 'CNY',
    max_total_minor: 3000, purchase_attempt_id: 'attempt_one', expires_at: iso(60_000), ...overrides };
}
function issuer(now = () => NOW) { return new Ed25519AuthorizationIssuer({ issuer: 'agent_a_demo', keyId: 'agent_a_test', privateKey: keys.privateKey, now }); }
function server(handler: (request: Request) => Response | Promise<Response>) {
  const requests: { path: string; headers: Headers; body?: unknown }[] = [];
  const instance = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    requests.push({ path: new URL(request.url).pathname, headers: request.headers,
      ...(request.method === 'POST' ? { body: await request.clone().json() } : {}) });
    return handler(request);
  } });
  servers.push(instance);
  const origin = `http://127.0.0.1:${instance.port}`;
  const transport = new HttpMerchantTransport({ origin, merchantId: candidate.merchant_id, catalogId: candidate.catalog_id, now: () => NOW });
  return { transport, origin, requests };
}
function checkout(origin: string, quote = readQuote()) {
  return { user_id: 'user_one', purchase_attempt_id: 'attempt_one', idempotency_key: 'key_one', quote_id: quote.quote_id,
    terms_hash: quote.terms_hash, authorization_proof: issuer().issue(claims({ terms_hash: quote.terms_hash })),
    checkout_url: `${origin}/commerce/v1/checkouts`, quote };
}

describe('shared backend Ed25519 issuer', () => {
  test('signs shared canonical bytes and binds the confirmation identity/budget/attempt with a 60-second cap', () => {
    const proof = authorizationProofSchema.parse(JSON.parse(issuer().issue(claims({ expires_at: iso(900_000) }))));
    expect(proof.scheme).toBe(AUTH_SCHEME); expect(proof.key_id).toBe('agent_a_test');
    expect(proof.payload).toMatchObject({ v: AUTH_DOMAIN, issuer: 'agent_a_demo', user_id: 'user_one',
      merchant_id: candidate.merchant_id, quote_id: 'quote_one', purchase_attempt_id: 'attempt_one', max_total_minor: 3000,
      issued_at: NOW / 1000, expires_at: NOW / 1000 + 60 });
    expect(verify(null, authorizationSigningBytes(proof.payload), keys.publicKey, Buffer.from(proof.signature, 'base64url'))).toBe(true);
    expect(verify(null, authorizationSigningBytes({ ...proof.payload, user_id: 'another_user' }), keys.publicKey,
      Buffer.from(proof.signature, 'base64url'))).toBe(false);
    expect(proof.payload).not.toHaveProperty('private_key');
  });
  test('requires the configured issuer and a valid whole-second quote window', () => {
    expect(() => issuer().issue(claims({ issuer: 'untrusted' }))).toThrow();
    expect(() => issuer().issue(claims({ expires_at: iso(999) }))).toThrow();
    expect(() => issuer().issue(claims({ expires_at: iso(-1) }))).toThrow();
    expect(() => issuer().issue(claims({ max_total_minor: Number.MAX_SAFE_INTEGER + 1 }))).toThrow();
    const proof = authorizationProofSchema.parse(JSON.parse(issuer(() => NOW + 250).issue(claims({ expires_at: iso(1400) }))));
    expect(proof.payload.expires_at).toBe(NOW / 1000 + 1);
  });
});

describe('real HTTP merchant commerce boundary', () => {
  test('catalog truncation warnings reach the public session and refresh on later searches', async () => {
    let incomplete = true;
    let unavailable = false;
    let pages = 0;
    const instance = server(request => {
      const path = new URL(request.url).pathname;
      if (path === '/.well-known/ocp-catalog') return Response.json({ ocp_version: '1.0', kind: 'WellKnownCatalogDiscovery',
        catalog_id: candidate.catalog_id, manifest_url: `${instance.origin}/ocp/manifest` });
      if (path === '/ocp/manifest') {
        const manifest = structuredClone(manifestFixture);
        for (const [name, endpoint] of Object.entries(manifest.endpoints)) endpoint.url = `${instance.origin}/ocp/${name}`;
        return Response.json(manifest);
      }
      if (path === '/ocp/query') {
        if (unavailable) return new Response('unavailable', { status: 503 });
        pages += 1;
        return Response.json({ ...queryFixture, page: { ...queryFixture.page, has_more: incomplete,
          ...(incomplete ? { next_cursor: `page_${pages}` } : {}) } });
      }
      return new Response('unknown', { status: 404 });
    });
    const directory = await mkdtemp(join(tmpdir(), 'ocp-search-warning-'));
    try {
      const store = new FileSessionStore(directory);
      const coordinator = new ShoppingCoordinator(instance.transport, store, issuer(), instance.origin, () => NOW, [candidate.merchant_id]);
      const created = await coordinator.create('user_one', intent);
      const searched = await coordinator.search('user_one', created.id);
      expect(pages).toBe(50);
      expect(searched.phase).toBe('candidates');
      expect(searched.candidates).toHaveLength(1);
      expect(searched.search_warnings).toEqual(['目录超过 50 页，已停止查询；当前候选不代表全部匹配商品。']);
      expect((await coordinator.get('user_one', created.id)).search_warnings).toEqual(searched.search_warnings);
      expect((await store.read(created.id))!.search_warnings).toEqual(searched.search_warnings);
      expect(searched.attempt).toBeUndefined();
      incomplete = false;
      expect((await coordinator.search('user_one', created.id)).search_warnings).toEqual([]);
      incomplete = true;
      expect((await coordinator.search('user_one', created.id)).search_warnings).toHaveLength(1);
      unavailable = true;
      const failed = await coordinator.search('user_one', created.id);
      expect(failed.phase).toBe('failed');
      expect(failed.search_warnings).toEqual([]);
      expect(instance.requests.every(request => !request.path.startsWith('/commerce/'))).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('transport retains local-filter warnings while its original search API still returns candidates', async () => {
    const instance = server(request => {
      const path = new URL(request.url).pathname;
      if (path === '/.well-known/ocp-catalog') return Response.json({ ocp_version: '1.0', kind: 'WellKnownCatalogDiscovery',
        catalog_id: candidate.catalog_id, manifest_url: `${instance.origin}/ocp/manifest` });
      if (path === '/ocp/manifest') {
        const manifest = structuredClone(manifestFixture);
        for (const [name, endpoint] of Object.entries(manifest.endpoints)) endpoint.url = `${instance.origin}/ocp/${name}`;
        manifest.query_capabilities[0]!.input_fields = [];
        return Response.json(manifest);
      }
      if (path === '/ocp/query') return Response.json(queryFixture);
      return new Response('unknown', { status: 404 });
    });
    const result = await instance.transport.searchWithWarnings(intent);
    expect(result.candidates).toHaveLength(1);
    expect(result.warnings).toEqual(['目录未声明或未使用这些筛选，A 仅在返回结果本地复核：currency, max_amount, in_stock_only。不能宣称服务端已筛选。']);
    expect(await instance.transport.search(intent)).toEqual(result.candidates);
  });
  test('the configured catalog resolves only a standard trusted checkout URL and refuses redirect/expiry/foreign origin', async () => {
    let actionUrl: string | undefined;
    let expired = false;
    let redirect = false;
    let visits = 0;
    const instance = server(request => {
      const path = new URL(request.url).pathname;
      if (path === '/.well-known/ocp-catalog') return Response.json({ ocp_version: '1.0', kind: 'WellKnownCatalogDiscovery',
        catalog_id: candidate.catalog_id, manifest_url: `${instance.origin}/ocp/manifest` });
      if (path === '/ocp/manifest') {
        const manifest = structuredClone(manifestFixture);
        for (const [name, endpoint] of Object.entries(manifest.endpoints)) endpoint.url = `${instance.origin}/ocp/${name}`;
        return Response.json(manifest);
      }
      if (path === '/ocp/query') return Response.json(queryFixture);
      if (path === '/other') { visits += 1; return Response.json(resolveFixture); }
      if (path === '/ocp/resolve') {
        if (redirect) return Response.redirect(`${instance.origin}/other`, 302);
        const reference = structuredClone(resolveFixture);
        reference.expires_at = new Date(Date.now() + (expired ? -1 : 60_000)).toISOString();
        const binding = reference.action_bindings.find(value => value.action_id === 'checkout')!;
        binding.entrypoint.url = actionUrl ?? `${instance.origin}/commerce/v1/checkouts`;
        binding.expires_at = reference.expires_at;
        return Response.json(reference);
      }
      return new Response('unknown', { status: 404 });
    });
    const transport = new HttpMerchantTransport({ origin: instance.origin, merchantId: candidate.merchant_id, catalogId: candidate.catalog_id });
    const [selected] = await transport.search(intent);
    expect(selected).toMatchObject({ entry_id: 'entry_latte', search_price_minor: 2500 });
    expect((await transport.resolve(selected!)).checkout_url).toBe(`${instance.origin}/commerce/v1/checkouts`);
    for (const endpoint of ['https://evil.example/commerce/v1/checkouts', `${instance.origin}/commerce/v1/checkouts?secret=anything`,
      `${instance.origin}/commerce/v1/other`, `${instance.origin}/commerce/v1/checkouts#fragment`]) {
      actionUrl = endpoint;
      await expect(transport.resolve(selected!)).rejects.toThrow();
    }
    actionUrl = undefined; expired = true;
    await expect(transport.resolve(selected!)).rejects.toThrow();
    expired = false; redirect = true;
    await expect(transport.resolve(selected!)).rejects.toThrow();
    expect(visits).toBe(0);
  });
  test('quote sends only the declared fields plus the backend caller header and persists shared priced terms', async () => {
    const { transport, requests } = server(() => Response.json(wireQuote()));
    const quote = await transport.quote('user_one', candidate, intent);
    expect(requests[0]!.path).toBe('/commerce/v1/quotes');
    expect(requests[0]!.headers.get('x-dev-caller-id')).toBe('user_one');
    expect(requests[0]!.body).toEqual({ entry_id: 'entry_latte', quantity: 1, fulfillment: { method: 'pickup' } });
    expect(quote).toEqual(readQuote());
  });
  test('a persisted candidate can be quoted after restart only after a fresh trusted catalog query', async () => {
    let entryRemoved = false;
    const instance = server(request => {
      const path = new URL(request.url).pathname;
      if (path === '/.well-known/ocp-catalog') return Response.json({ ocp_version: '1.0', kind: 'WellKnownCatalogDiscovery',
        catalog_id: candidate.catalog_id, manifest_url: `${instance.origin}/ocp/manifest` });
      if (path === '/ocp/manifest') {
        const manifest = structuredClone(manifestFixture);
        for (const [name, endpoint] of Object.entries(manifest.endpoints)) endpoint.url = `${instance.origin}/ocp/${name}`;
        return Response.json(manifest);
      }
      if (path === '/ocp/query') return Response.json(entryRemoved
        ? { ...queryFixture, result_count: 0, entries: [] } : queryFixture);
      if (path === '/ocp/resolve') {
        const reference = structuredClone(resolveFixture);
        reference.expires_at = new Date(Math.max(NOW, Date.now()) + 60_000).toISOString();
        const binding = reference.action_bindings.find(value => value.action_id === 'checkout')!;
        binding.entrypoint.url = `${instance.origin}/commerce/v1/checkouts`; binding.expires_at = reference.expires_at;
        return Response.json(reference);
      }
      if (path === '/commerce/v1/quotes') return Response.json(wireQuote());
      return new Response('unknown', { status: 404 });
    });
    const directory = await mkdtemp(join(tmpdir(), 'ocp-candidate-restart-'));
    try {
      const store = new FileSessionStore(directory);
      const fresh = () => new ShoppingCoordinator(new HttpMerchantTransport({ origin: instance.origin,
        merchantId: candidate.merchant_id, catalogId: candidate.catalog_id, now: () => NOW }),
      store, issuer(), instance.origin, () => NOW, [candidate.merchant_id]);
      const before = fresh();
      const created = await before.create('user_one', intent);
      const searched = await before.search('user_one', created.id);
      expect(searched.phase).toBe('candidates');
      const priorRequests = instance.requests.length;
      const quoted = await fresh().select('user_one', created.id, candidate.entry_id);
      expect(quoted.phase).toBe('awaiting_confirmation');
      expect(quoted.quote!.total_minor).toBe(2500);
      expect(instance.requests.slice(priorRequests).map(request => request.path)).toEqual([
        '/.well-known/ocp-catalog', '/ocp/manifest', '/ocp/query', '/ocp/resolve', '/commerce/v1/quotes',
      ]);
      entryRemoved = true;
      const beforeRemoved = instance.requests.length;
      const stale = await fresh().select('user_one', created.id, candidate.entry_id);
      expect(stale.phase).toBe('requote_required');
      expect(stale.error!.code).toBe('requote_required');
      expect(instance.requests.slice(beforeRemoved).map(request => request.path)).toEqual([
        '/.well-known/ocp-catalog', '/ocp/manifest', '/ocp/query',
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test.each(['merchant', 'catalog', 'entry', 'quantity', 'fulfillment', 'currency', 'arithmetic', 'hash', 'expiry', 'extra'] as const)(
    'rejects a quote with invalid %s before confirmation', async mutation => {
      const wire = wireQuote();
      if (mutation === 'merchant') wire.merchant_id = 'other_merchant';
      if (mutation === 'catalog') wire.catalog_id = 'other_catalog';
      if (mutation === 'entry') wire.items[0]!.entry_id = 'other_item';
      if (mutation === 'quantity') { wire.items[0]!.quantity = 2; wire.items[0]!.line_total_minor = 5000; wire.subtotal_minor = 5000; wire.total_minor = 5000; }
      if (mutation === 'fulfillment') wire.fulfillment.method = 'delivery';
      if (mutation === 'currency') wire.currency = 'USD';
      if (mutation === 'arithmetic') wire.total_minor += 1;
      if (mutation === 'hash') wire.terms_hash = '0'.repeat(64);
      if (mutation === 'expiry') wire.expires_at = iso(-1);
      if (mutation === 'extra') Object.assign(wire, { authorization: 'must not appear' });
      if (!['arithmetic', 'hash'].includes(mutation)) wire.terms_hash = computeQuoteTermsHash(wire);
      const { transport } = server(() => Response.json(wire));
      await expect(transport.quote('user_one', candidate, intent)).rejects.toMatchObject({ code: 'protocol_error' });
    });
  test('checkout 200 requires bound attempt and paid order, keeps idempotency and caller in headers, and maps pending truthfully', async () => {
    const { transport, requests, origin } = server(() => Response.json({ status: 'confirmed', purchase_attempt: wireAttempt(), order: wireOrder() }));
    const result = await transport.checkout(checkout(origin));
    expect(result).toMatchObject({ status: 'confirmed', purchase_attempt_id: 'attempt_one', order_id: 'order_one',
      quote_id: 'quote_one', merchant_id: candidate.merchant_id, catalog_id: candidate.catalog_id });
    expect(requests[0]!.headers.get('idempotency-key')).toBe('key_one');
    expect(requests[0]!.headers.get('x-dev-caller-id')).toBe('user_one');
    expect(Object.keys(requests[0]!.body as object).sort()).toEqual(['authorization', 'purchase_attempt_id', 'quote_id', 'terms_hash']);
    expect((requests[0]!.body as Record<string, unknown>).authorization).toMatchObject({ scheme: AUTH_SCHEME, key_id: 'agent_a_test' });
    const orderServer = server(() => Response.json(wireOrder()));
    expect(await orderServer.transport.getOrder('user_one', 'order_one')).toMatchObject({ payment_status: 'paid', fulfillment_status: 'pending' });
  });
  test('checkout 202 preserves processing and the original attempt/key', async () => {
    const { transport, origin, requests } = server(() => Response.json({ status: 'processing', purchase_attempt: wireAttempt('processing') }, { status: 202 }));
    expect(await transport.checkout(checkout(origin))).toMatchObject({ status: 'processing', purchase_attempt_id: 'attempt_one' });
    expect(requests[0]!.headers.get('idempotency-key')).toBe('key_one');
  });
  test('paid and cancelled fulfillment remain independent transaction facts', async () => {
    const order = wireOrder(); order.fulfillment_status.status = 'cancelled';
    const { transport, origin } = server(request => new URL(request.url).pathname === '/commerce/v1/checkouts'
      ? Response.json({ status: 'confirmed', purchase_attempt: wireAttempt(), order }) : Response.json(order));
    expect(await transport.checkout(checkout(origin))).toMatchObject({ status: 'confirmed', order_id: 'order_one' });
    expect(await transport.getOrder('user_one', 'order_one')).toMatchObject({ payment_status: 'paid', fulfillment_status: 'cancelled' });
  });
  test.each(['attempt', 'quote', 'merchant', 'catalog', 'order_id', 'payment', 'terms', 'shape', 'status'] as const)(
    'does not accept confirmed checkout with invalid %s', async mutation => {
      const body = { status: 'confirmed', purchase_attempt: wireAttempt(), order: wireOrder() };
      if (mutation === 'attempt') body.purchase_attempt.purchase_attempt_id = 'other_attempt';
      if (mutation === 'quote') body.purchase_attempt.quote_id = 'other_quote';
      if (mutation === 'merchant') body.order.merchant_id = 'other_merchant';
      if (mutation === 'catalog') body.order.catalog_id = 'other_catalog';
      if (mutation === 'order_id') body.order.order_id = 'other_order';
      if (mutation === 'payment') body.order.payment.status = 'unknown';
      if (mutation === 'terms') { body.order.items[0]!.unit_minor = 2600; body.order.items[0]!.line_total_minor = 2600;
        body.order.subtotal_minor = 2600; body.order.total_minor = 2600; body.order.terms_hash = computeQuoteTermsHash(body.order); }
      if (mutation === 'shape') Object.assign(body.order, { payment: 'paid' });
      if (mutation === 'status') body.purchase_attempt.status = 'processing';
      const { transport, origin } = server(() => Response.json(body));
      await expect(transport.checkout(checkout(origin))).rejects.toMatchObject({ code: 'protocol_error' });
    });
  test.each(['shape', 'terms', 'missing', 'extra'] as const)(
    'keeps only bound confirmed identifiers when the checkout order has invalid %s', async mutation => {
      const body: Record<string, unknown> = { status: 'confirmed', purchase_attempt: wireAttempt(), order: wireOrder() };
      if (mutation === 'shape') body.order = { payment: 'raw-secret-value', signature: 'must-not-be-retained' };
      if (mutation === 'terms') (body.order as WireOrder).total_minor += 1;
      if (mutation === 'missing') delete body.order;
      if (mutation === 'extra') body.raw_secret = 'must-not-be-retained';
      const { transport, origin } = server(() => Response.json(body));
      try { await transport.checkout(checkout(origin)); throw new Error('expected protocol rejection'); }
      catch (error) {
        expect(error).toBeInstanceOf(ConfirmedPurchaseProtocolError);
        expect((error as ConfirmedPurchaseProtocolError).confirmedAttempt).toEqual({ purchase_attempt_id: 'attempt_one', status: 'confirmed',
          order_id: 'order_one', merchant_id: candidate.merchant_id, catalog_id: candidate.catalog_id, quote_id: 'quote_one' });
        expect(JSON.stringify(error)).not.toContain('raw-secret-value');
        expect(JSON.stringify(error)).not.toContain('must-not-be-retained');
        expect(Object.keys(publicError(error)).sort()).toEqual(['code', 'message']);
      }
    });
  test.each(['attempt', 'quote', 'merchant', 'catalog', 'status', 'missing_order_id'] as const)(
    'does not grant confirmed evidence to an attempt with invalid %s', async mutation => {
      const attempt = wireAttempt();
      if (mutation === 'attempt') attempt.purchase_attempt_id = 'other_attempt';
      if (mutation === 'quote') attempt.quote_id = 'other_quote';
      if (mutation === 'merchant') attempt.merchant_id = 'other_merchant';
      if (mutation === 'catalog') attempt.catalog_id = 'other_catalog';
      if (mutation === 'status') attempt.status = 'failed';
      if (mutation === 'missing_order_id') delete attempt.order_id;
      const { transport, origin } = server(() => Response.json({ status: 'confirmed', purchase_attempt: attempt, order: {} }));
      try { await transport.checkout(checkout(origin)); throw new Error('expected protocol rejection'); }
      catch (error) {
        expect(error).toMatchObject({ code: 'protocol_error' });
        expect(error).not.toBeInstanceOf(ConfirmedPurchaseProtocolError);
      }
    });
  test.each(['failed', 'processing'] as const)(
    'a confirmed HTTP attempt with malformed order cannot unlock purchase on later %s recovery', async status => {
      let currentAttempt: PurchaseAttempt | undefined;
      let checkoutCalls = 0;
      const { transport, origin } = server(async request => {
        if (new URL(request.url).pathname === '/commerce/v1/checkouts') {
          checkoutCalls += 1;
          const body = await request.json() as { purchase_attempt_id: string };
          currentAttempt = { ...wireAttempt(), purchase_attempt_id: body.purchase_attempt_id };
          return Response.json({ status: 'confirmed', purchase_attempt: currentAttempt, order: { payment: 'malformed' } });
        }
        return Response.json({ ...wireAttempt(status), purchase_attempt_id: currentAttempt!.purchase_attempt_id });
      });
      const directory = await mkdtemp(join(tmpdir(), 'ocp-confirmed-evidence-'));
      try {
        const store = new FileSessionStore(directory);
        const coordinator = new ShoppingCoordinator(transport, store, issuer(), origin, () => NOW, [candidate.merchant_id]);
        const session: Session = { id: `session_${crypto.randomUUID()}`, user_id: 'user_one', mode: 'http', phase: 'awaiting_confirmation',
          intent, candidates: [candidate], selection: [{ candidate, quantity: 1 }], quote: readQuote(), checkout_url: `${origin}/commerce/v1/checkouts`,
          resolve_expires_at: iso(60_000), revision: 3, created_at: iso(), updated_at: iso() };
        await store.write(session);
        const unknown = await coordinator.confirm('user_one', session.id, { quote_id: session.quote!.quote_id,
          terms_hash: session.quote!.terms_hash, revision: session.revision });
        expect(unknown.phase).toBe('unknown'); expect(unknown.order).toBeUndefined();
        expect(unknown.attempt!.status).toBe('confirmed');
        const first = (await store.read(session.id))!.attempt!;
        expect(first.order_id).toBe('order_one');
        const recovered = await coordinator.recover('user_one', session.id);
        expect(recovered.phase).toBe('unknown'); expect(recovered.attempt!.status).toBe('confirmed');
        expect((await store.read(session.id))!.attempt).toEqual(first);
        await expect(coordinator.search('user_one', session.id)).rejects.toMatchObject({ code: 'invalid_state' });
        await expect(coordinator.create('user_one', intent)).rejects.toMatchObject({ code: 'unresolved_purchase' });
        expect(checkoutCalls).toBe(1);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  test('HTTP code and envelope status must agree; a processing attempt cannot carry an order', async () => {
    for (const response of [
      Response.json({ status: 'processing', purchase_attempt: wireAttempt('processing') }, { status: 200 }),
      Response.json({ status: 'confirmed', purchase_attempt: wireAttempt(), order: wireOrder() }, { status: 202 }),
      Response.json({ status: 'processing', purchase_attempt: { ...wireAttempt('processing'), order_id: 'order_one' } }, { status: 202 }),
    ]) {
      const { transport, origin } = server(() => response);
      await expect(transport.checkout(checkout(origin))).rejects.toMatchObject({ code: 'protocol_error' });
    }
  });
  test('checkout after an A restart uses the persisted quote; missing or changed terms never reach B', async () => {
    const { transport, origin, requests } = server(() => Response.json({ status: 'processing', purchase_attempt: wireAttempt('processing') }, { status: 202 }));
    const input = checkout(origin); delete input.quote.wire_terms;
    await expect(transport.checkout(input)).rejects.toMatchObject({ code: 'protocol_error' });
    expect(requests).toHaveLength(0);
    await expect(transport.checkout({ ...checkout(origin), checkout_url: `${origin}/commerce/v1/checkouts?token=secret` })).rejects.toMatchObject({ code: 'untrusted_endpoint' });
    expect(requests).toHaveLength(0);
    expect(await transport.checkout(checkout(origin))).toMatchObject({ status: 'processing' });
  });
  test('recovers only the requested ids and exposes unknown payment distinctly from paid', async () => {
    const body = wireOrder(); body.payment.status = 'unknown';
    const { transport, requests } = server(() => Response.json(body));
    expect(await transport.getOrder('user_one', 'order_one')).toMatchObject({ payment_status: 'unknown', fulfillment_status: 'pending' });
    expect(requests[0]!.headers.get('x-dev-caller-id')).toBe('user_one');
    await expect(transport.getOrder('user_one', 'different_order')).rejects.toMatchObject({ code: 'protocol_error' });
    const attempts = server(() => Response.json(wireAttempt('failed')));
    expect(await attempts.transport.getAttempt('user_one', 'attempt_one')).toMatchObject({ status: 'failed', error: { code: 'payment_failed' } });
    expect((await attempts.transport.getAttempt('user_one', 'attempt_one')).error!.message).not.toContain('raw');
    await expect(attempts.transport.getAttempt('user_one', 'other_attempt')).rejects.toMatchObject({ code: 'protocol_error' });
  });
  test('only schema-correct non-2xx errors get fixed public messages; 5xx stays unavailable', async () => {
    const cases = [
      { status: 409, body: { error: { code: 'requote_required', message: 'private raw message', details: { secret: 'redact me' } } }, code: 'requote_required' },
      { status: 404, body: { error: { code: 'not_found', message: 'not yours' } }, code: 'not_found' },
      { status: 409, body: { error: { code: 123, message: { secret: true } } }, code: 'protocol_error' },
      { status: 409, body: { error: { code: 'not_found', message: 'wrong code/status' } }, code: 'protocol_error' },
      { status: 503, body: { error: { code: 'out_of_stock', message: 'misleading determinate code' } }, code: 'merchant_unavailable' },
    ];
    for (const value of cases) {
      const { transport } = server(() => Response.json(value.body, { status: value.status }));
      try { await transport.getAttempt('user_one', 'attempt_one'); throw new Error('expected rejection'); }
      catch (error) { expect(error).toMatchObject({ code: value.code }); expect((error as Error).message).not.toContain('private'); }
    }
  });
  test('malformed JSON, redirects, network failure and timeout are classified without raw details', async () => {
    const malformed = server(() => new Response('{not json', { headers: { 'content-type': 'application/json' } }));
    await expect(malformed.transport.getAttempt('user_one', 'attempt_one')).rejects.toMatchObject({ code: 'protocol_error' });
    let visits = 0;
    const redirected = server(request => new URL(request.url).pathname === '/other' ? (++visits, Response.json(wireAttempt()))
      : Response.redirect(`${redirected.origin}/other`, 302));
    await expect(redirected.transport.getAttempt('user_one', 'attempt_one')).rejects.toMatchObject({ code: 'network_error' });
    expect(visits).toBe(0);
    for (const name of ['TypeError', 'TimeoutError']) {
      const transport = new HttpMerchantTransport({ origin: 'http://127.0.0.1:4401', merchantId: candidate.merchant_id, catalogId: candidate.catalog_id,
        fetch: (async () => { const error = new Error('sensitive raw URL'); error.name = name; throw error; }) as unknown as typeof fetch });
      await expect(transport.getAttempt('user_one', 'attempt_one')).rejects.toMatchObject({ code: name === 'TimeoutError' ? 'timeout' : 'network_error' });
    }
  });
});
