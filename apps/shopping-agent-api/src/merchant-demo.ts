import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FlowError } from '@ocp-catalog/agent-runtime';
import type { MerchantDemoReader } from '@ocp-catalog/merchant-core';

export type { MerchantDemoReader } from '@ocp-catalog/merchant-core';

const COOKIE = 'ocp_merchant_demo';
const COOKIE_PATH = '/api/merchant-demo';
const LIFETIME_SECONDS = 3600;
const ROLE = 'merchant_demo_read';
const assets: Record<string, { file: string; type: string }> = {
  '/demo': { file: 'demo.html', type: 'text/html; charset=utf-8' },
  '/demo.html': { file: 'demo.html', type: 'text/html; charset=utf-8' },
  '/merchant': { file: 'merchant.html', type: 'text/html; charset=utf-8' },
  '/merchant.html': { file: 'merchant.html', type: 'text/html; charset=utf-8' },
  '/merchant.js': { file: 'merchant.js', type: 'text/javascript; charset=utf-8' },
  '/merchant.css': { file: 'merchant.css', type: 'text/css; charset=utf-8' },
};

export function isMerchantDemoPath(path: string): boolean {
  return Object.hasOwn(assets, path) || path === COOKIE_PATH || path.startsWith(`${COOKIE_PATH}/`);
}

function parameters(url: URL, allowed: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(values, key)) throw new FlowError('invalid_request', '商家查询参数无效。');
    values[key] = value;
  }
  return values;
}

function pageQuery(values: Record<string, string>) {
  let limit: number | undefined;
  if (values.limit !== undefined) {
    if (!/^[1-9]\d{0,2}$/.test(values.limit) || Number(values.limit) > 50) {
      throw new FlowError('invalid_request', '每页数量必须为 1–50 的整数。');
    }
    limit = Number(values.limit);
  }
  if (values.cursor !== undefined && (!values.cursor || values.cursor.length > 2048)) {
    throw new FlowError('invalid_request', '分页游标无效。');
  }
  return { ...(limit !== undefined ? { limit } : {}), ...(values.cursor !== undefined ? { cursor: values.cursor } : {}) };
}

/** Only the unified local demo supplies this reader. Visiting /merchant explicitly
 * grants a temporary local demonstration role; this is not an account/login system. */
export function createMerchantDemoHandler(reader: MerchantDemoReader, options: {
  staticRoot: string;
  securityHeaders: Record<string, string>;
  now?: () => number;
}) {
  const secret = randomBytes(32);
  const now = options.now ?? Date.now;
  const signature = (payload: string) => createHmac('sha256', secret).update(`ocp-merchant-demo-v1.${payload}`).digest();
  function issue(): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, role: ROLE, exp: Math.floor(now() / 1000) + LIFETIME_SECONDS })).toString('base64url');
    return `${payload}.${signature(payload).toString('base64url')}`;
  }
  function authorized(request: Request): boolean {
    const values = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim())
      .filter(value => value.startsWith(`${COOKIE}=`)).map(value => value.slice(COOKIE.length + 1));
    if (values.length !== 1 || values[0]!.length > 512) return false;
    const [payload, signed, extra] = values[0]!.split('.');
    if (!payload || !signed || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signed)) return false;
    try {
      const digest = Buffer.from(signed, 'base64url');
      if (digest.length !== 32 || !timingSafeEqual(signature(payload), digest)) return false;
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const current = Math.floor(now() / 1000);
      return claims?.v === 1 && claims.role === ROLE && Number.isSafeInteger(claims.exp)
        && claims.exp > current && claims.exp <= current + LIFETIME_SECONDS;
    } catch { return false; }
  }
  function json(value: unknown, status = 200): Response {
    return Response.json(value, { status, headers: { ...options.securityHeaders, 'content-type': 'application/json; charset=utf-8' } });
  }
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'GET') throw new FlowError('method_not_allowed', '商家演示只提供读取接口。', 405);
      const url = new URL(request.url);
      const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
      if (asset) {
        parameters(url, []);
        const contents = await readFile(join(options.staticRoot, asset.file));
        return new Response(contents, { headers: {
          ...options.securityHeaders, 'content-type': asset.type,
          ...(url.pathname === '/merchant' ? { 'set-cookie': `${COOKIE}=${issue()}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${LIFETIME_SECONDS}` } : {}),
        } });
      }
      if (!authorized(request)) throw new FlowError('unauthorized', '请从本机商家演示入口进入只读页面。', 401);
      if (url.pathname === `${COOKIE_PATH}/overview`) {
        parameters(url, []);
        return json(await reader.overview());
      }
      if (url.pathname === `${COOKIE_PATH}/products`) {
        const values = parameters(url, ['query', 'limit', 'cursor']);
        const query = values.query?.trim();
        if (values.query !== undefined && (values.query.length > 120 || /[\u0000-\u001f\u007f]/u.test(values.query))) {
          throw new FlowError('invalid_request', '商品查询不能超过 120 个字符或包含控制字符。');
        }
        return json(await reader.products({ ...pageQuery(values), ...(query !== undefined ? { query } : {}) }));
      }
      if (url.pathname === `${COOKIE_PATH}/orders`) {
        return json(await reader.orders(pageQuery(parameters(url, ['limit', 'cursor']))));
      }
      const detail = /^\/api\/merchant-demo\/orders\/([^/]+)$/.exec(url.pathname);
      if (detail) {
        parameters(url, []);
        let id: string;
        try { id = decodeURIComponent(detail[1]!); } catch { throw new FlowError('invalid_request', '订单编号无效。'); }
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new FlowError('invalid_request', '订单编号无效。');
        return json(await reader.order(id));
      }
      throw new FlowError('not_found', '商家演示接口不存在。', 404);
    } catch (error) {
      // Reader validation failures have fixed public messages; SQLite paths,
      // stored rows, stack traces and private request state never cross this API.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'invalid_request') return json({ error: { code, message: '商家查询参数无效。' } }, 400);
      if (code === 'not_found') return json({ error: { code, message: '找不到本商家的订单。' } }, 404);
      if (code === 'unauthorized') return json({ error: { code, message: '请从本机商家演示入口进入只读页面。' } }, 401);
      if (code === 'method_not_allowed') return json({ error: { code, message: '商家演示只提供读取接口。' } }, 405);
      return json({ error: { code: 'merchant_read_unavailable', message: '商家只读数据暂时不可用，请稍后刷新。' } }, 503);
    }
  };
}
