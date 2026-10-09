#!/usr/bin/env bun
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { createHttpRuntime, type ShoppingModelClient } from '../packages/agent-runtime/src';
import { createMerchantContext, createMerchantDemoReader, loadConfig } from '../packages/merchant-core/src';
import { acquireDataLock, createHandler } from '../apps/shopping-agent-api/src/server';
import { startCoffeeMerchantServer } from '../apps/coffee-merchant-api/src/server';
import { createLocalModelSettings } from '../apps/shopping-agent-api/src/model-settings';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const SCRATCH_ROOT = join(PROJECT_ROOT, '.codex-tmp');
const KEY_ID = 'shopping_demo_local';
const ISSUER = 'shopping_demo_local';
const HOST = '127.0.0.1';

export interface ShoppingDemoOptions {
  dataDir?: string;
  newSession?: boolean;
  checkOnly?: boolean;
  /** Port 0 is available to tests; CLI environment ports must be 1024–65535. */
  shoppingPort?: number;
  merchantPort?: number;
  env?: Record<string, string | undefined>;
  /** Isolated configuration location for programmatic previews and tests. */
  modelSettingsPath?: string;
  /** Explicit protocol fixture injection; CLI never reads a model key from .env. */
  model?: ShoppingModelClient;
}

export interface ShoppingDemo {
  mode: 'check' | 'running';
  directory: string;
  shoppingOrigin: string;
  merchantOrigin: string;
  demoPortalUrl: string;
  userDemoUrl: string;
  merchantDemoUrl: string;
  modelStatus: 'configured' | 'not_configured';
  modelName?: string;
  stop(): Promise<void>;
}

async function readEnvironment(): Promise<Record<string, string | undefined>> {
  let file: Record<string, string | undefined> = {};
  try { file = parseEnv(await readFile(join(PROJECT_ROOT, '.env'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { ...file, ...process.env };
}

function port(value: number | undefined, raw: string | undefined, fallback: number, name: string): number {
  const result = value ?? (raw?.trim() ? Number(raw) : fallback);
  if (!Number.isSafeInteger(result) || (result === 0 ? value !== 0 : result < 1024 || result > 65535)) {
    throw new Error(`${name} 必须为 1024–65535。`);
  }
  return result;
}

/** Keep generated signing material and demo stores in an explicit scratch subdirectory. */
async function demoDirectory(requested: string, newSession: boolean): Promise<string> {
  const directory = resolve(PROJECT_ROOT, requested);
  const suffix = relative(SCRATCH_ROOT, directory);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('SHOPPING_DEMO_DATA_DIR 必须是项目 .codex-tmp 下的独立子目录。');
  }
  await mkdir(SCRATCH_ROOT, { recursive: true });
  let current = SCRATCH_ROOT;
  for (const segment of suffix.split(sep)) {
    current = join(current, segment);
    try { await mkdir(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('演示数据目录不能使用文件或符号链接。');
  }
  return newSession ? mkdtemp(join(directory, 'run-')) : directory;
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('演示密钥必须是数据目录内的普通文件。');
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function signingKey(directory: string): Promise<{ privateKey: KeyObject; publicPem: string }> {
  const privatePath = join(directory, 'authorization.private.pem');
  const publicPath = join(directory, 'authorization.public.pem');
  let privatePem = await optionalFile(privatePath);
  const savedPublic = await optionalFile(publicPath);
  if (privatePem === undefined) {
    if (savedPublic !== undefined) throw new Error('演示私钥缺失，保留原数据并停止启动；请恢复原私钥或使用 --new-session。');
    privatePem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    await writeFile(privatePath, privatePem, { flag: 'wx', mode: 0o600 });
  }
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('演示授权私钥必须使用 Ed25519。');
  const publicPem = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString();
  if (savedPublic === undefined) await writeFile(publicPath, publicPem, { flag: 'wx', mode: 0o600 });
  else if (savedPublic !== publicPem) throw new Error('演示公私钥不匹配；保留原文件并停止启动。');
  return { privateKey, publicPem };
}

/** Starts the real local HTTP A/B pair. Payments remain a merchant-side simulation. */
export async function startShoppingDemo(options: ShoppingDemoOptions = {}): Promise<ShoppingDemo> {
  const env = options.env ?? await readEnvironment();
  const shoppingPort = port(options.shoppingPort, env.SHOPPING_PORT, 4310, 'SHOPPING_PORT');
  const merchantPort = port(options.merchantPort, env.MERCHANT_PORT, 8787, 'MERCHANT_PORT');
  if (shoppingPort !== 0 && shoppingPort === merchantPort) throw new Error('SHOPPING_PORT 与 MERCHANT_PORT 必须不同。');
  const directory = await demoDirectory(options.dataDir ?? env.SHOPPING_DEMO_DATA_DIR ?? '.codex-tmp/shopping-demo', options.newSession ?? false);
  const modelSettings = await createLocalModelSettings(options.modelSettingsPath ?? (options.env
    ? join(directory, 'model-settings.json') : join(SCRATCH_ROOT, 'shopping-model', 'settings.json')));
  const model = modelSettings.getModel() ?? options.model; // No provider request at startup.
  const release = await acquireDataLock(directory);
  let merchant: ReturnType<typeof startCoffeeMerchantServer> | undefined;
  let api: ReturnType<typeof Bun.serve> | undefined;
  let coordinator: Awaited<ReturnType<typeof createHttpRuntime>> | undefined;
  let accepting = true;
  let activeHandlers = 0;
  let drained: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      accepting = false;
      try {
        if (activeHandlers !== 0) await new Promise<void>(done => { drained = done; });
        // A handler returning a Response precedes Bun flushing its bytes. Wait
        // for that transport work too before the single Windows-safe stop(true).
        while (api && api.pendingRequests > 0) await Bun.sleep(5);
        await api?.stop(true);
      } finally {
        // An aborted caller can return before its queued storage cleanup settles.
        await coordinator?.waitForIdle();
        try { await merchant?.stop(); }
        finally { await release(); }
      }
    })();
    return stopping;
  }
  try {
    const key = await signingKey(directory);
    const trustConfig = JSON.stringify({ [KEY_ID]: { public_key_pem: key.publicPem, issuer: ISSUER } });
    const config = { ...loadConfig({ env: {
      MERCHANT_PORT: String(merchantPort || 8787),
      MERCHANT_DB_PATH: join(directory, 'merchant.sqlite'),
      MERCHANT_PUBLIC_BASE_URL: `http://${HOST}:${merchantPort || 8787}`,
      MERCHANT_TRUSTED_KEYS_PATH: 'generated-demo-public-key',
    }, readTextFile: () => trustConfig }), port: merchantPort };

    if (options.checkOnly) {
      const context = createMerchantContext({ config });
      context.db.close();
    } else {
      merchant = startCoffeeMerchantServer({ config, hostname: HOST });
      config.publicBaseUrl = `http://${HOST}:${merchant.server.port}`;
    }
    coordinator = await createHttpRuntime(join(directory, 'agent'), {
      origin: config.publicBaseUrl, merchantId: config.merchantId, catalogId: config.catalogId,
      keyId: KEY_ID, issuer: ISSUER, privateKey: key.privateKey,
    });
    let shoppingOrigin = `http://${HOST}:${shoppingPort || 4310}`;
    if (!options.checkOnly) {
      let handle: ReturnType<typeof createHandler> | undefined;
      // Serve the local preview as a stable runtime. On Windows Bun 1.3.13,
      // development mode can retain a listener stopped inside another handler.
      api = Bun.serve({ hostname: HOST, port: shoppingPort, idleTimeout: 255, development: false,
        id: `shopping_demo_${crypto.randomUUID()}`,
        fetch: async request => {
          if (!accepting || !handle) return new Response('shopping demo is shutting down', { status: 503, headers: { connection: 'close' } });
          activeHandlers++;
          try {
            const response = await handle(request);
            response.headers.set('connection', 'close');
            return response;
          } finally {
            activeHandlers--;
            if (activeHandlers === 0) drained?.();
          }
        },
      });
      shoppingOrigin = `http://${HOST}:${api.port}`;
      handle = createHandler(coordinator, { allowedHost: new URL(shoppingOrigin).host, model: options.model,
        ...(options.model ? {} : { modelSettings }),
        merchantDemo: createMerchantDemoReader(merchant!.ctx) });
    } else await stop();
    return { mode: options.checkOnly ? 'check' : 'running', directory, shoppingOrigin,
      merchantOrigin: config.publicBaseUrl, demoPortalUrl: `${shoppingOrigin}/demo`,
      userDemoUrl: `${shoppingOrigin}/`, merchantDemoUrl: `${shoppingOrigin}/merchant`,
      modelStatus: model ? 'configured' : 'not_configured',
      ...(model ? { modelName: model.model } : {}), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--new-session'].includes(arg))) {
    throw new Error('用法：bun scripts/shopping-demo.ts [--check] [--new-session]');
  }
  const demo = await startShoppingDemo({ checkOnly: args.includes('--check'), newSession: args.includes('--new-session') });
  console.log(`购物演示${demo.mode === 'check' ? '配置检查通过（未开放端口）' : `已启动：${demo.shoppingOrigin}`}`);
  console.log(`商家 HTTP：${demo.merchantOrigin}\n数据目录：${demo.directory}`);
  if (demo.mode === 'running') {
    console.log(`演示门户：${demo.demoPortalUrl}\n用户演示入口：${demo.userDemoUrl}\n商家演示入口：${demo.merchantDemoUrl}`);
  }
  console.log(`模型：${demo.modelName ?? '未配置，请在演示入口填写 API；也可手动搜索'}（启动不调用模型）`);
  console.log(`API 配置：${demo.demoPortalUrl}#api-configuration（保存后立即生效，下次启动沿用）`);
  console.log('身份仅为本机演示，非正式登录；商家页面只读。支付和履约为本地模拟，签名密钥和历史数据保留在上述目录。');
  if (demo.mode === 'check') return;
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void demo.stop().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

if (import.meta.main) {
  await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
