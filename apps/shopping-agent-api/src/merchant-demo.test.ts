import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ShoppingCoordinator } from '@ocp-catalog/agent-runtime';
import type { MerchantDemoReader } from '@ocp-catalog/merchant-core';
import { createMerchantDemoHandler, isMerchantDemoPath } from './merchant-demo';
import { createHandler } from './server';

const ORIGIN = 'http://127.0.0.1:49991';
const ROOT = resolve('.codex-tmp/merchant-demo-api-tests');
const securityHeaders = { 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'" };
const page = { items: [], next_cursor: null, has_more: false, total: 0 };
let directory: string;
let calls: { name: string; input?: unknown }[];
let reader: MerchantDemoReader;

beforeEach(async () => {
  await mkdir(ROOT, { recursive: true }); directory = await mkdtemp(join(ROOT, 'run-'));
  await Promise.all(['demo.html', 'merchant.html', 'merchant.js', 'merchant.css'].map(name => writeFile(join(directory, name), `fixture ${name}`)));
  calls = [];
  reader = {
    overview() {
      calls.push({ name: 'overview' });
      return { read_only: true, merchant_id: 'merchant_fixed', catalog_id: 'catalog_fixed', checked_at: new Date(0).toISOString(),
        payment_mode: 'local_simulated', fulfillment_mode: 'local_simulated', products: page, orders: page };
    },
    products(input) { calls.push({ name: 'products', input }); return page; },
    orders(input) { calls.push({ name: 'orders', input }); return page; },
    order(input) { calls.push({ name: 'order', input }); throw Object.assign(new Error('private stored details'), { code: 'not_found' }); },
  };
});
afterEach(async () => {
  const suffix = relative(ROOT, directory);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('unsafe merchant test cleanup path');
  await rm(directory, { recursive: true, force: true });
});
function request(path: string, cookie?: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...headers } });
}
function isolated(now?: () => number) {
  return createMerchantDemoHandler(reader, { staticRoot: directory, securityHeaders, now });
}
async function enter(handler: ReturnType<typeof isolated>) {
  const response = await handler(request('/merchant'));
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}
function coordinator() {
  return { mode: 'http', merchantId: 'merchant_fixed',
    inspectHealth: async () => ({ mode: 'http', status: 'online', ready: true, checked_at: new Date(0).toISOString() }),
    listPending: async (input: string) => { calls.push({ name: 'user_pending', input }); return []; },
  } as unknown as ShoppingCoordinator;
}

describe('merchant demo role and read routing', () => {
  test('the explicit entry grants only an independent expiring HttpOnly role and retains an existing shopping identity', async () => {
    const handler = isolated();
    const response = await handler(request('/merchant', `ocp_shopping_session=${'a'.repeat(64)}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toBe(securityHeaders['content-security-policy']);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('ocp_merchant_demo=');
    expect(cookie).toContain('Path=/api/merchant-demo'); expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Max-Age=3600');
    expect(cookie).not.toContain('ocp_shopping_session'); expect(calls).toEqual([]);
    expect((await handler(request('/api/merchant-demo/overview', cookie.split(';')[0]))).status).toBe(200);
    expect(calls).toEqual([{ name: 'overview' }]);
  });
  test('the portal and static files do not grant the role or create a shopping cookie', async () => {
    const handler = isolated();
    for (const path of ['/demo', '/demo.html', '/merchant.html', '/merchant.js', '/merchant.css']) {
      const response = await handler(request(path));
      expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect((await handler(request('/api/merchant-demo/overview'))).status).toBe(401); expect(calls).toEqual([]);
  });
  test.each([
    undefined, `ocp_shopping_session=${'a'.repeat(64)}`, 'ocp_merchant_demo=merchant',
    'ocp_merchant_demo=invalid.invalid', 'ocp_merchant_demo=' + 'a'.repeat(513),
  ])('a missing, shopping-only or invalid cookie never reads merchant data (%s)', async cookie => {
    const response = await isolated()(request('/api/merchant-demo/overview', cookie));
    expect(response.status).toBe(401); expect(response.headers.get('set-cookie')).toBeNull(); expect(calls).toEqual([]);
  });
  test('changing a role payload, duplicating its cookie or replaying it into another handler cannot grant access', async () => {
    const handler = isolated(), cookie = await enter(handler);
    const token = cookie.slice(cookie.indexOf('=') + 1), [payload, signed] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), role: 'admin' })).toString('base64url');
    for (const invalid of [`ocp_merchant_demo=${forged}.${signed}`, `${cookie}; ${cookie}`]) {
      expect((await handler(request('/api/merchant-demo/overview', invalid))).status).toBe(401);
    }
    expect((await isolated()(request('/api/merchant-demo/overview', cookie))).status).toBe(401); expect(calls).toEqual([]);
  });
  test('a correctly signed role expires at its deadline', async () => {
    let clock = 1_000_000;
    const handler = isolated(() => clock), cookie = await enter(handler);
    clock += 3_600_000;
    expect((await handler(request('/api/merchant-demo/overview', cookie))).status).toBe(401); expect(calls).toEqual([]);
  });
  test.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'])('%s does not execute any reader or issue identity', async method => {
    const handler = isolated(), cookie = await enter(handler);
    for (const path of ['/merchant', '/api/merchant-demo/overview', '/api/merchant-demo/orders']) {
      const response = await handler(request(path, cookie, method));
      expect(response.status).toBe(405); expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(calls).toEqual([]);
  });
  test('routing passes only bounded page/query arguments and fixed-source reads', async () => {
    const handler = isolated(), cookie = await enter(handler);
    expect((await handler(request('/api/merchant-demo/products?query=%20拿铁%20&limit=50&cursor=opaque', cookie))).status).toBe(200);
    expect((await handler(request('/api/merchant-demo/products?query=', cookie))).status).toBe(200);
    expect((await handler(request('/api/merchant-demo/orders?limit=1', cookie))).status).toBe(200);
    expect((await handler(request('/api/merchant-demo/orders/order_test', cookie))).status).toBe(404);
    expect(calls).toEqual([
      { name: 'products', input: { query: '拿铁', limit: 50, cursor: 'opaque' } },
      { name: 'products', input: { query: '' } }, { name: 'orders', input: { limit: 1 } }, { name: 'order', input: 'order_test' },
    ]);
  });
  test.each([
    '/merchant?role=merchant', '/demo?role=merchant', '/api/merchant-demo/overview?merchant=other',
    '/api/merchant-demo/products?origin=http://other', '/api/merchant-demo/products?db=private',
    '/api/merchant-demo/products?path=private', '/api/merchant-demo/products?caller_id=other',
    '/api/merchant-demo/products?query=' + 'x'.repeat(121), '/api/merchant-demo/products?query=%00',
    '/api/merchant-demo/products?limit=0', '/api/merchant-demo/products?limit=51',
    '/api/merchant-demo/products?limit=1.5', '/api/merchant-demo/products?limit=1e1',
    '/api/merchant-demo/products?limit=01', '/api/merchant-demo/products?limit=-1',
    '/api/merchant-demo/products?cursor=', '/api/merchant-demo/products?cursor=' + 'x'.repeat(2049),
    '/api/merchant-demo/products?query=a&query=b', '/api/merchant-demo/orders?limit=1&limit=2',
    '/api/merchant-demo/orders?status=paid', '/api/merchant-demo/orders/order_test?role=admin',
    '/api/merchant-demo/orders/%00', '/api/merchant-demo/orders/' + 'x'.repeat(257),
  ])('invalid parameters are rejected before reading: %s', async path => {
    const handler = isolated(), cookie = await enter(handler);
    expect((await handler(request(path, cookie))).status).toBe(400); expect(calls).toEqual([]);
  });
  test('reader errors expose safe statuses and no database or identity details', async () => {
    const privateText = 'private.sqlite authorization_proof signature private_key idempotency_key payment_reference';
    const handler = isolated(), cookie = await enter(handler);
    for (const [error, status] of [[new Error(privateText), 503],
      [Object.assign(new Error(privateText), { code: 'invalid_request' }), 400],
      [Object.assign(new Error(privateText), { code: 'not_found' }), 404]] as const) {
      reader.overview = () => { throw error; };
      const response = await handler(request('/api/merchant-demo/overview', cookie));
      expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      for (const value of privateText.split(' ')) expect(text).not.toContain(value);
    }
  });
});

describe('optional merchant capability in the original shopping API', () => {
  test.each(['/demo', '/demo.html', '/merchant', '/merchant.html', '/merchant.js', '/merchant.css', '/api/merchant-demo/overview'])
    ('a standalone handler disables %s without issuing any cookie', async path => {
      const response = await createHandler(coordinator())(request(path));
      expect(response.status).toBe(404); expect(response.headers.get('set-cookie')).toBeNull(); expect(calls).toEqual([]);
    });
  const rejectedHeaders: Record<string, string>[] = [
    { host: 'evil.test:49991' }, { origin: 'http://evil.test' }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ];
  test.each(rejectedHeaders)('host and cross-site checks precede merchant role creation or reads (%j)', async headers => {
    const handler = createHandler(coordinator(), { merchantDemo: reader, allowedHost: '127.0.0.1:49991' });
    for (const path of ['/merchant', '/api/merchant-demo/overview']) {
      const response = await handler(request(path, undefined, 'GET', headers));
      expect(response.status).toBe(403); expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(calls).toEqual([]);
  });
  test('shopping cookies stay owned by the original user flow and never authorize merchant reads', async () => {
    const handler = createHandler(coordinator(), { merchantDemo: reader });
    const identity = 'a'.repeat(64), cookie = `ocp_shopping_session=${identity}`;
    const pending = await handler(request('/api/sessions/pending', cookie));
    expect(pending.status).toBe(200); expect(pending.headers.get('set-cookie')).toBeNull();
    expect(calls).toEqual([{ name: 'user_pending', input: identity }]); calls.length = 0;
    const denied = await handler(request('/api/merchant-demo/overview', cookie));
    expect(denied.status).toBe(401); expect(denied.headers.get('set-cookie')).toBeNull(); expect(calls).toEqual([]);
  });
  test.each(['/contracts.js', '/view-model.js', '/dom.js', '/api-client.js'])(
    'shared module %s never creates a buyer identity for a merchant page', async path => {
      const response = await createHandler(coordinator(), { merchantDemo: reader })(request(path));
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('content-type')).toContain('javascript');
      expect((await response.text()).length).toBeGreaterThan(20);
    });
  test('only enabled handlers advertise the merchant demo and original configuration fields remain', async () => {
    for (const enabled of [false, true]) {
      const response = await createHandler(coordinator(), enabled ? { merchantDemo: reader } : {})(request('/api/config'));
      const config = await response.json();
      expect(config).toMatchObject({ mode: 'http', merchant_id: 'merchant_fixed', llm_status: 'not_configured', payment_mode: 'local_simulated' });
      expect(config.merchant_demo_available).toBe(enabled ? true : undefined);
      expect(response.headers.get('set-cookie')).toContain('ocp_shopping_session=');
    }
    expect(calls).toEqual([]);
  });
  test('the merchant entry uses the actual page and never replaces the original user cookie', async () => {
    const handler = createHandler(coordinator(), { merchantDemo: reader });
    const response = await handler(request('/merchant', `ocp_shopping_session=${'b'.repeat(64)}`));
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('ocp_merchant_demo=');
    expect(response.headers.get('set-cookie')).not.toContain('ocp_shopping_session');
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const overview = await handler(request('/api/merchant-demo/overview', cookie));
    expect(overview.status).toBe(200); expect(await overview.json()).toMatchObject({ read_only: true, merchant_id: 'merchant_fixed' });
  });
  test('merchant method rejection runs before shopping JSON parsing and creates no user identity', async () => {
    const response = await createHandler(coordinator(), { merchantDemo: reader })(request('/api/merchant-demo/overview', undefined, 'POST'));
    expect(response.status).toBe(405); expect(response.headers.get('set-cookie')).toBeNull(); expect(calls).toEqual([]);
  });
  test('the static whitelist cannot be extended by prototype properties or filesystem paths', () => {
    for (const path of ['/constructor', '/toString', '/merchant/private.sqlite', '/merchant-demo.ts', '/demo.js']) expect(isMerchantDemoPath(path)).toBe(false);
    for (const path of ['/demo', '/merchant', '/merchant.css', '/api/merchant-demo/orders/order_test']) expect(isMerchantDemoPath(path)).toBe(true);
  });
});
