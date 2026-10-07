import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createMockRuntime, FlowError, publicError, type ShoppingCoordinator } from '@ocp-catalog/agent-runtime';

const STATIC_ROOT = resolve(import.meta.dir, '../../shopping-agent-web/public');
const COOKIE = 'ocp_shopping_session';
const securityHeaders = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};
const cookiePattern = /^[a-f0-9]{64}$/;

/** Local development identity, NOT a production account or login system. */
export function createHandler(coordinator: ShoppingCoordinator, options: { allowedHost?: string } = {}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let newCookie: string | undefined;
    function response(body: unknown, status = 200): Response {
      return new Response(JSON.stringify(body), { status, headers: {
        ...securityHeaders, 'content-type': 'application/json; charset=utf-8',
        ...(newCookie ? { 'set-cookie': `${COOKIE}=${newCookie}; Path=/; HttpOnly; SameSite=Strict` } : {}),
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
      if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
        throw new FlowError('invalid_request', '写入请求必须使用 JSON。', 415);
      }
      const cookieValue = request.headers.get('cookie')?.split(';').map(part => part.trim())
        .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      const userId = cookieValue && cookiePattern.test(cookieValue) ? cookieValue : (newCookie = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''));
      if (url.pathname === '/api/config' && request.method === 'GET') {
        return response({ mode: 'mock', c0_status: 'pending', llm_status: 'not_configured' });
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
        if (url.pathname === '/api/sessions' && request.method === 'POST') return response(await coordinator.create(userId, body), 201);
        const match = /^\/api\/sessions\/(session_[a-f0-9-]{36})(?:\/(search|quote|confirm|cancel|recover))?$/.exec(url.pathname);
        if (!match) throw new FlowError('not_found', '接口不存在。', 404);
        const id = match[1]!;
        if (request.method === 'GET' && !match[2]) return response(await coordinator.get(userId, id));
        if (request.method !== 'POST') throw new FlowError('not_found', '接口不存在。', 404);
        switch (match[2]) {
          case 'search': return response(await coordinator.search(userId, id));
          case 'quote':
            if (typeof body.entry_id !== 'string') throw new FlowError('invalid_request', '请选择商品。');
            return response(await coordinator.select(userId, id, body.entry_id));
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
        '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
      };
      const asset = staticFiles[url.pathname];
      if (!asset || request.method !== 'GET') throw new FlowError('not_found', '页面不存在。', 404);
      return new Response(await readFile(join(STATIC_ROOT, asset.file)), { headers: {
        ...securityHeaders, 'content-type': asset.type,
        ...(newCookie ? { 'set-cookie': `${COOKIE}=${newCookie}; Path=/; HttpOnly; SameSite=Strict` } : {}),
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

if (import.meta.main) {
  const port = Number(process.env.SHOPPING_PORT ?? 4310);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('SHOPPING_PORT 必须为 1024–65535。');
  const directory = resolve(process.env.SHOPPING_DATA_DIR ?? join(import.meta.dir, '../../../.codex-tmp/shopping-agent'));
  const release = await acquireDataLock(directory);
  try {
    const coordinator = await createMockRuntime(directory);
    const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: createHandler(coordinator, { allowedHost: `127.0.0.1:${port}` }) });
    let closing = false;
    const close = async () => {
      if (closing) return; closing = true;
      await server.stop(false); await release(); process.exit(0);
    };
    process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
    console.log(`购物助手 MOCK: http://127.0.0.1:${server.port} (C0 pending; LLM not configured; local mock payment only)`);
  } catch (error) { await release(); throw error; }
}
