import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { createHttpRuntime, createMockRuntime, createConfiguredShoppingModel, runShoppingAgent, FlowError, publicError,
  SHOPPING_CONTRACT_VERSION, type ShoppingCoordinator, type ShoppingModelClient } from '@ocp-catalog/agent-runtime';
import { createMerchantDemoHandler, isMerchantDemoPath, type MerchantDemoReader } from './merchant-demo';
import { parseConfigView, parseAgentRunView, parsePendingSessionsView } from '@ocp-catalog/shopping-contracts/browser';

const STATIC_ROOT = resolve(import.meta.dir, '../../shopping-agent-web/public');
const COOKIE = 'ocp_shopping_session';
const securityHeaders = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};
const cookiePattern = /^[a-f0-9]{64}$/;

/** Local development identity, NOT a production account or login system. */
export function createHandler(coordinator: ShoppingCoordinator, options: {
  allowedHost?: string; model?: ShoppingModelClient; merchantDemo?: MerchantDemoReader;
} = {}) {
  const modelRuns = new Set<string>();
  const merchantDemo = options.merchantDemo
    ? createMerchantDemoHandler(options.merchantDemo, { staticRoot: STATIC_ROOT, securityHeaders }) : undefined;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let newCookie: string | undefined;
    function response(body: unknown, status = 200): Response {
      return new Response(JSON.stringify(body), { status, headers: {
        ...securityHeaders, 'content-type': 'application/json; charset=utf-8',
        ...(newCookie ? { 'set-cookie': `${COOKIE}=${newCookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` } : {}),
      } });
    }
    try {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || (options.allowedHost && url.host !== options.allowedHost)
        || (request.headers.get('host') && request.headers.get('host') !== url.host)) {
        throw new FlowError('forbidden', '仅接受本机来源。', 403);
      }
      const origin = request.headers.get('origin');
      const fetchSite = request.headers.get('sec-fetch-site');
      if ((origin && origin !== url.origin) || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
        throw new FlowError('forbidden', '不接受跨站请求。', 403);
      }
      // Merchant-only requests are dispatched before creating or replacing any
      // shopping identity; their role cookie has its own API path and lifetime.
      if (isMerchantDemoPath(url.pathname)) {
        if (!merchantDemo) throw new FlowError('not_found', '商家演示未启用。', 404);
        return merchantDemo(request);
      }
      if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
        throw new FlowError('invalid_request', '写入请求必须使用 JSON。', 415);
      }
      // Shared read-only browser modules do not create a buyer identity when
      // loaded from the independently scoped merchant demonstration page.
      const sharedModules: Record<string, string> = {
        '/contracts.js': 'contracts.js', '/view-model.js': 'view-model.js',
        '/dom.js': 'dom.js', '/api-client.js': 'api-client.js',
      };
      const sharedModule = Object.hasOwn(sharedModules, url.pathname) ? sharedModules[url.pathname] : undefined;
      if (sharedModule && request.method === 'GET') {
        return new Response(await readFile(join(STATIC_ROOT, sharedModule)), { headers: {
          ...securityHeaders, 'content-type': 'text/javascript; charset=utf-8',
        } });
      }
      const cookieValue = request.headers.get('cookie')?.split(';').map(part => part.trim())
        .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      const userId = cookieValue && cookiePattern.test(cookieValue) ? cookieValue : (newCookie = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''));
      if (url.pathname === '/api/config' && request.method === 'GET') {
        const health = await coordinator.inspectHealth();
        const status = coordinator.mode === 'mock' ? 'mock' : health.ready ? 'online' : 'offline';
        return response(parseConfigView({ mode: coordinator.mode, merchant_id: coordinator.merchantId,
          ...(merchantDemo ? { merchant_demo_available: true } : {}),
          payment_mode: 'local_simulated', c0_status: 'integrated', contract_version: SHOPPING_CONTRACT_VERSION,
          llm_status: options.model ? 'configured' : 'not_configured', llm_model: options.model?.model ?? null,
          merchant_health: { status, message: status === 'mock' ? '独立本地样例模式'
            : status === 'online' ? '商家服务在线' : '商家服务暂时不可用，请检查商家进程。', checked_at: health.checked_at } }));
      }
      if (url.pathname.startsWith('/api/')) {
        let body: Record<string, unknown> = {};
        if (request.method === 'POST') {
          const text = await request.text();
          if (text.length > 8192) throw new FlowError('invalid_request', '请求内容过长。', 413);
          try {
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            body = parsed;
          } catch { throw new FlowError('invalid_request', 'JSON 请求无效。'); }
        }
        if (url.pathname === '/api/sessions/pending' && request.method === 'GET') {
          return response(parsePendingSessionsView({ sessions: await coordinator.listPending(userId) }));
        }
        if (url.pathname === '/api/agent/run' && request.method === 'POST') {
          if (!options.model) throw new FlowError('model_not_configured', '请在后端 .env 填入 DEEPSEEK_API_KEY 并重启服务，然后使用 Agent 规划。', 503);
          if (modelRuns.has(userId)) throw new FlowError('agent_busy', '此身份已有 Agent 规划正在进行，请等待结果。', 429);
          modelRuns.add(userId);
          try { return response(parseAgentRunView(await runShoppingAgent(coordinator, userId, body, options.model))); }
          finally { modelRuns.delete(userId); }
        }
        if (url.pathname === '/api/sessions' && request.method === 'POST') return response(await coordinator.create(userId, body), 201);
        const match = /^\/api\/sessions\/(session_[a-f0-9-]{36})(?:\/(search|quote|confirm|cancel|recover))?$/.exec(url.pathname);
        if (!match) throw new FlowError('not_found', '接口不存在。', 404);
        const id = match[1]!;
        if (request.method === 'GET' && !match[2]) return response(await coordinator.get(userId, id));
        if (request.method !== 'POST') throw new FlowError('not_found', '接口不存在。', 404);
        switch (match[2]) {
          case 'search': return response(await coordinator.search(userId, id));
          case 'quote': {
            if (Object.keys(body).some(key => !['entry_id', 'entry_ids'].includes(key))
              || (body.entry_id !== undefined && body.entry_ids !== undefined)) {
              throw new FlowError('invalid_request', '报价只能包含本次候选商品的选择，数量由原需求确定。');
            }
            if (Array.isArray(body.entry_ids) && body.entry_ids.length >= 1 && body.entry_ids.length <= 10
              && body.entry_ids.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) {
              return response(await coordinator.select(userId, id, body.entry_ids as string[]));
            }
            if (typeof body.entry_id !== 'string' || !body.entry_id || body.entry_id.length > 256
              || body.entry_ids !== undefined) throw new FlowError('invalid_request', '请为每一种需求选择候选商品。');
            return response(await coordinator.select(userId, id, body.entry_id));
          }
          case 'confirm':
            if (typeof body.quote_id !== 'string' || typeof body.terms_hash !== 'string' || !Number.isSafeInteger(body.revision)) {
              throw new FlowError('invalid_request', '请明确确认当前报价。');
            }
            return response(await coordinator.confirm(userId, id, { quote_id: body.quote_id, terms_hash: body.terms_hash, revision: body.revision as number }));
          case 'cancel': return response(await coordinator.cancel(userId, id));
          case 'recover': return response(await coordinator.recover(userId, id));
          default: throw new FlowError('not_found', '接口不存在。', 404);
        }
      }
      const staticFiles: Record<string, { file: string; type: string }> = {
        '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
        '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
        '/contracts.js': { file: 'contracts.js', type: 'text/javascript; charset=utf-8' },
        '/view-model.js': { file: 'view-model.js', type: 'text/javascript; charset=utf-8' },
        '/dom.js': { file: 'dom.js', type: 'text/javascript; charset=utf-8' },
        '/api-client.js': { file: 'api-client.js', type: 'text/javascript; charset=utf-8' },
        '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
        '/coffee-bg.svg': { file: 'coffee-bg.svg', type: 'image/svg+xml; charset=utf-8' },
      };
      const asset = staticFiles[url.pathname];
      if (!asset || request.method !== 'GET') throw new FlowError('not_found', '页面不存在。', 404);
      return new Response(await readFile(join(STATIC_ROOT, asset.file)), { headers: {
        ...securityHeaders, 'content-type': asset.type,
        ...(newCookie ? { 'set-cookie': `${COOKIE}=${newCookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` } : {}),
      } });
    } catch (error) { return response({ error: publicError(error) }, error instanceof FlowError ? error.status : 503); }
  };
}

export async function acquireDataLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'server.lock');
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Fail closed even for a stale lock; do not delete another process's lock automatically.
      throw new Error('数据目录已锁定。确认旧进程已退出后，按使用说明移除 server.lock，或选择新的 SHOPPING_DATA_DIR。');
    }
    throw error;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  await handle.close();
  return async () => { await unlink(path); };
}

/** Load explicit local configuration; HTTP startup fails if a signing key or identity is missing. */
export async function createConfiguredRuntime(directory: string, env: Record<string, string | undefined> = process.env) {
  const mode = env.SHOPPING_MODE ?? 'http';
  if (mode === 'mock') return createMockRuntime(directory);
  if (mode !== 'http') throw new Error('SHOPPING_MODE 必须为 http 或 mock。');
  function required(name: string) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} 是 HTTP 模式必需配置。`);
    return value;
  }
  return createHttpRuntime(directory, {
    origin: required('SHOPPING_MERCHANT_ORIGIN'), merchantId: required('SHOPPING_MERCHANT_ID'),
    catalogId: required('SHOPPING_CATALOG_ID'), issuer: required('SHOPPING_AUTH_ISSUER'),
    keyId: required('SHOPPING_AUTH_KEY_ID'), privateKey: createPrivateKey(await readFile(required('SHOPPING_AUTH_PRIVATE_KEY_PATH'), 'utf8')),
  });
}

if (import.meta.main) {
  const port = Number(process.env.SHOPPING_PORT ?? 4310);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('SHOPPING_PORT 必须为 1024–65535。');
  const directory = resolve(process.env.SHOPPING_DATA_DIR ?? join(import.meta.dir, '../../../.codex-tmp/shopping-agent'));
  const release = await acquireDataLock(directory);
  try {
    const coordinator = await createConfiguredRuntime(directory);
    const model = createConfiguredShoppingModel();
    const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 255,
      fetch: createHandler(coordinator, { allowedHost: `127.0.0.1:${port}`, model }) });
    let closing = false;
    const close = async () => {
      if (closing) return; closing = true;
      await server.stop(false); await coordinator.waitForIdle(); await release(); process.exit(0);
    };
    process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
    console.log(`购物助手 ${coordinator.mode.toUpperCase()}: http://127.0.0.1:${server.port} (contract ${SHOPPING_CONTRACT_VERSION}; model ${model?.model ?? 'not configured'}; local simulated payment only)`);
  } catch (error) { await release(); throw error; }
}
