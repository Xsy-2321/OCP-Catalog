import { afterEach, describe, expect, test } from 'bun:test';
import { handle as exampleHandle } from '../../../examples/typescript/src/server';
import { OcpConsumer } from './ocp-consumer';
import type { Intent } from './types';

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(true); });
const intent: Intent = { query: '拿铁', items: [{ query: '拿铁', quantity: 1 }], quantity: 1, currency: 'CNY', max_total_minor: 3000, merchant_id: 'coffee-demo', fulfillment: 'pickup' };
function catalog(options: { invalidPrice?: boolean; filters?: boolean; keywordFilters?: boolean; paged?: boolean; repeatedCursor?: boolean; endpoint?: string; redirect?: boolean; actionUrl?: string; denied?: boolean; identity?: boolean; removed?: boolean; healthIdentity?: boolean; malformedHealth?: boolean } = {}) {
  let base = '';
  const requests: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const url = new URL(request.url);
    paths.push(url.pathname);
    const now = new Date().toISOString();
    if (url.pathname === '/ocp/health') return Response.json(options.malformedHealth ? { status: 'healthy' } : {
      ocp_version: '1.0', kind: 'CatalogHealth', catalog_id: options.healthIdentity ? 'other_catalog' : 'cat_test',
      status: 'healthy', ready: true, checked_at: now, details: { internal: 'must not reach the UI' },
    });
    if (url.pathname === '/.well-known/ocp-catalog') return Response.json({ ocp_version: '1.0', kind: 'WellKnownCatalogDiscovery', catalog_id: 'cat_test', manifest_url: `${base}/ocp/manifest` });
    if (url.pathname === '/ocp/manifest') {
      if (options.redirect) return Response.redirect(`${base}/elsewhere`, 302);
      const manifest = await (await exampleHandle(new Request('http://localhost:4400/ocp/manifest'))).json();
      manifest.catalog_id = 'cat_test';
      for (const [name, endpoint] of Object.entries(manifest.endpoints) as [string, { url: string }][]) endpoint.url = `${base}/ocp/${name}`;
      if (options.endpoint) manifest.endpoints.query.url = options.endpoint;
      if (options.filters || options.keywordFilters) {
        manifest.query_capabilities[0].query_packs[0].query_modes = options.keywordFilters ? ['keyword'] : ['hybrid'];
        manifest.query_capabilities[0].input_fields = ['currency', 'max_amount', 'in_stock_only'].map(field => ({ name: `filters.${field}` }));
      }
      return Response.json(manifest);
    }
    if (url.pathname === '/ocp/query') {
      const body = await request.json() as Record<string, unknown>; requests.push(body);
      const products = options.removed ? [] : options.paged ? Array.from({ length: 22 }, (_, index) => ({
        id: index === 21 ? 'latte' : `expensive_${index}`, amount: index === 21 ? 25 : 88,
        currency: 'CNY', stock: 'in_stock',
      })).slice(Number(body.cursor ?? 0), Number(body.cursor ?? 0) + 20) : [
          { id: 'latte', amount: 26, currency: 'CNY', stock: 'in_stock' },
          { id: 'usd', amount: 5, currency: 'USD', stock: 'in_stock' },
          { id: 'empty', amount: 26, currency: 'CNY', stock: 'out_of_stock' },
        ];
      const hasMore = Boolean(options.paged && (!body.cursor || options.repeatedCursor));
      if (options.invalidPrice) products.push({ id: 'unrepresentable', amount: 0.001, currency: 'CNY', stock: 'in_stock' });
      return Response.json({ ocp_version: '1.0', kind: 'CatalogQueryResult', id: 'query_one', catalog_id: options.identity ? 'other_catalog' : 'cat_test',
        query_pack: body.query_pack, query: body.query, result_count: products.length,
        page: { limit: 20, offset: 0, has_more: hasMore, ...(hasMore ? { next_cursor: '20' } : {}) },
        entries: products.map(product => ({ score: 1, entry: { kind: 'CatalogEntry', catalog_id: 'cat_test', entry_id: product.id,
          provider_id: 'provider', object_id: product.id, title: '拿铁', attributes: { price: { currency: product.currency, amount: product.amount }, inventory: { availability_status: product.stock } } } })),
      });
    }
    if (url.pathname === '/ocp/resolve') return Response.json({
      ocp_version: '1.0', kind: 'ResolvableReference', id: 'reference', catalog_id: 'cat_test', entry_id: 'latte',
      commercial_object_id: 'coffee_latte', object_id: 'latte', object_type: 'ocp.commerce.product', provider_id: 'provider', title: '拿铁', visible_attributes: {},
      access: { permission_state: options.denied ? 'denied' : 'granted' },
      freshness: { object_updated_at: now, resolved_at: now }, expires_at: new Date(Date.now() + 10000).toISOString(),
      action_bindings: [{ action_id: 'checkout_demo', action_type: 'api', label: '模拟购买', requires_user_confirmation: true,
        entrypoint: { url: options.actionUrl ?? `${base}/commerce/v1/checkouts`, method: 'POST' } }],
    });
    return new Response('not found', { status: 404 });
  } });
  base = `http://127.0.0.1:${server.port}`; servers.push(server);
  const consumer = new OcpConsumer({ origin: base, catalogId: 'cat_test', manifestUrl: `${base}/ocp/manifest`, discoveryUrl: `${base}/.well-known/ocp-catalog`, checkoutActionId: 'checkout_demo' });
  return { consumer, requests, base, paths };
}
describe('real HTTP OCP read consumer', () => {
  test('cold resolve revalidates a saved candidate against the configured catalog and original constraints', async () => {
    const { consumer, base, paths, requests } = catalog({ filters: true });
    expect((await consumer.resolve('latte', intent)).checkout_url).toBe(`${base}/commerce/v1/checkouts`);
    expect(paths).toEqual(['/.well-known/ocp-catalog', '/ocp/manifest', '/ocp/query', '/ocp/resolve']);
    expect(requests[0]).toMatchObject({ query: intent.query, filters: { currency: 'CNY', max_amount: 30, in_stock_only: true } });
  });
  test('cold resolve cannot turn missing, unaffordable or untrusted saved IDs into trusted entries', async () => {
    const missing = catalog({ removed: true });
    await expect(missing.consumer.resolve('latte', intent)).rejects.toMatchObject({ code: 'requote_required' });
    expect(missing.paths).not.toContain('/ocp/resolve');
    const expensive = catalog();
    await expect(expensive.consumer.resolve('latte', { ...intent, max_total_minor: 100 })).rejects.toMatchObject({ code: 'requote_required' });
    expect(expensive.paths).not.toContain('/ocp/resolve');
    const foreign = catalog({ endpoint: 'https://evil.example/ocp/query' });
    await expect(foreign.consumer.resolve('latte', intent)).rejects.toMatchObject({ code: 'untrusted_endpoint' });
    expect(foreign.paths).not.toContain('/ocp/resolve');
    await expect(catalog({ identity: true }).consumer.resolve('latte', intent)).rejects.toMatchObject({ code: 'catalog_mismatch' });
  });
  test('health checks the configured catalog and exposes no raw merchant details', async () => {
    const { consumer, paths } = catalog();
    const health = await consumer.health();
    expect(health).toMatchObject({ status: 'healthy', ready: true, catalog_id: 'cat_test' });
    expect(paths).toEqual(['/ocp/health']);
    expect(JSON.stringify(health)).not.toContain('must not reach the UI');
    await expect(catalog({ healthIdentity: true }).consumer.health()).rejects.toMatchObject({ code: 'catalog_mismatch' });
    await expect(catalog({ malformedHealth: true }).consumer.health()).rejects.toThrow();
  });
  test('uses declared pack/filters, checks actual returned currency/stock/amount and resolves a known entry', async () => {
    const { consumer, requests, base } = catalog({ filters: true });
    const result = await consumer.search(intent);
    expect(result.entries.map(match => match.entry.entry_id)).toEqual(['latte']);
    expect(result.warnings).toEqual([]);
    expect(requests[0]!.filters).toEqual({ currency: 'CNY', max_amount: 30, in_stock_only: true });
    expect(result.request.query_pack).toBe('ocp.query.keyword.v1');
    expect((await consumer.resolve('latte')).checkout_url).toBe(`${base}/commerce/v1/checkouts`);
    await expect(consumer.resolve('invented')).rejects.toMatchObject({ code: 'invalid_request' });
  });
  test('sends filters declared by a keyword pack without claiming hybrid, and verifies every returned item locally', async () => {
    const { consumer, requests } = catalog({ keywordFilters: true });
    const result = await consumer.search(intent);
    expect(result.request.query_mode).toBe('keyword');
    expect(requests[0]!.filters).toEqual({ currency: 'CNY', max_amount: 30, in_stock_only: true });
    // This test server deliberately ignores its filters and returns USD and
    // sold-out rows. The consumer must still reject both of them.
    expect(result.entries.map(match => match.entry.entry_id)).toEqual(['latte']);
    expect(result.warnings).toEqual([]);
  });
  test('isolates a price that cannot be represented in integer minor units and reports the skipped entry', async () => {
    const { consumer } = catalog({ filters: true, invalidPrice: true });
    const result = await consumer.search(intent);
    expect(result.entries.map(match => match.entry.entry_id)).toEqual(['latte']);
    expect(result.warnings).toEqual(['已跳过 1 个价格无效或无法精确换算为整数分的商品，请以商家最终报价为准。']);
    await expect(consumer.resolve('unrepresentable')).rejects.toMatchObject({ code: 'invalid_request' });
  });
  test('follows cursors to find the only qualifying item at row 22 even when filters are undeclared', async () => {
    const { consumer, requests } = catalog({ paged: true });
    const result = await consumer.search(intent);
    expect(result.entries.map(match => match.entry.entry_id)).toEqual(['latte']);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.cursor).toBe('20');
    expect(requests[0]!.filters).toEqual({});
  });
  test('fails closed on a repeated pagination cursor', async () => {
    await expect(catalog({ paged: true, repeatedCursor: true }).consumer.search(intent))
      .rejects.toMatchObject({ code: 'catalog_unavailable' });
  });
  test('does not send undeclared filters or claim that the original keyword example filters budget', async () => {
    const { consumer, requests } = catalog();
    const result = await consumer.search(intent);
    expect(requests[0]!.filters).toEqual({});
    expect(result.warnings[0]).toContain('不能宣称服务端已筛选');
    expect(result.entries).toHaveLength(1);
  });
  test('rejects untrusted manifest endpoints and mismatched returned catalog identity', async () => {
    await expect(catalog({ endpoint: 'https://evil.example/ocp/query' }).consumer.inspect()).rejects.toMatchObject({ code: 'untrusted_endpoint' });
    await expect(catalog({ identity: true }).consumer.search(intent)).rejects.toMatchObject({ code: 'catalog_mismatch' });
  });
  test('refuses redirects, denied access and an untrusted action binding', async () => {
    await expect(catalog({ redirect: true }).consumer.inspect()).rejects.toThrow();
    const denied = catalog({ denied: true }).consumer; await denied.search(intent);
    await expect(denied.resolve('latte')).rejects.toMatchObject({ code: 'resolve_unavailable' });
    const untrusted = catalog({ actionUrl: 'https://evil.example/commerce/v1/checkouts' }).consumer; await untrusted.search(intent);
    await expect(untrusted.resolve('latte')).rejects.toMatchObject({ code: 'untrusted_endpoint' });
  });
});
