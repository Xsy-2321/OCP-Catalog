import { afterEach, describe, expect, test } from 'bun:test';
import { handle as exampleHandle } from '../../../examples/typescript/src/server';
import { OcpConsumer } from './ocp-consumer';
import type { Intent } from './types';

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(true); });
const intent: Intent = { query: '拿铁', quantity: 1, currency: 'CNY', max_total_minor: 3000, merchant_id: 'coffee-demo', fulfillment: 'pickup' };
function catalog(options: { filters?: boolean; endpoint?: string; redirect?: boolean; actionUrl?: string; denied?: boolean; identity?: boolean } = {}) {
  let base = '';
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const url = new URL(request.url);
    const now = new Date().toISOString();
    if (url.pathname === '/.well-known/ocp-catalog') return Response.json({ ocp_version: '1.0', kind: 'WellKnownCatalogDiscovery', catalog_id: 'cat_test', manifest_url: `${base}/ocp/manifest` });
    if (url.pathname === '/ocp/manifest') {
      if (options.redirect) return Response.redirect(`${base}/elsewhere`, 302);
      const manifest = await (await exampleHandle(new Request('http://localhost:4400/ocp/manifest'))).json();
      manifest.catalog_id = 'cat_test';
      for (const [name, endpoint] of Object.entries(manifest.endpoints) as [string, { url: string }][]) endpoint.url = `${base}/ocp/${name}`;
      if (options.endpoint) manifest.endpoints.query.url = options.endpoint;
      if (options.filters) {
        manifest.query_capabilities[0].query_packs[0].query_modes = ['hybrid'];
        manifest.query_capabilities[0].input_fields = ['currency', 'max_amount', 'in_stock_only'].map(field => ({ name: `filters.${field}` }));
      }
      return Response.json(manifest);
    }
    if (url.pathname === '/ocp/query') {
      const body = await request.json() as Record<string, unknown>; requests.push(body);
      return Response.json({ ocp_version: '1.0', kind: 'CatalogQueryResult', id: 'query_one', catalog_id: options.identity ? 'other_catalog' : 'cat_test',
        query_pack: body.query_pack, query: body.query, result_count: 3, page: { limit: 20, offset: 0, has_more: false },
        entries: [
          { id: 'latte', amount: 26, currency: 'CNY', stock: 'in_stock' },
          { id: 'usd', amount: 5, currency: 'USD', stock: 'in_stock' },
          { id: 'empty', amount: 26, currency: 'CNY', stock: 'out_of_stock' },
        ].map(product => ({ score: 1, entry: { kind: 'CatalogEntry', catalog_id: 'cat_test', entry_id: product.id,
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
  return { consumer, requests, base };
}
describe('real HTTP OCP read consumer (commerce C0 still pending)', () => {
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
