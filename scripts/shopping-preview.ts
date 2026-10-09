#!/usr/bin/env bun
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { startShoppingDemo, type ShoppingDemo } from './shopping-demo';

const PREVIEW_ROOT = resolve(import.meta.dir, '../.codex-tmp/shopping-dual-preview');
const MANIFEST = 'preview.json';
interface PreviewManifest { version: 1; shopping_port: number; merchant_port: number }

/** Resume only a preview we created; never infer that another directory is disposable. */
async function readManifest(directory: string): Promise<PreviewManifest> {
  const suffix = relative(PREVIEW_ROOT, directory);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('预览恢复目录必须是 .codex-tmp/shopping-dual-preview 下已创建的独立子目录。');
  }
  let current = PREVIEW_ROOT;
  for (const segment of ['', ...suffix.split(sep)]) {
    current = segment ? join(current, segment) : current;
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('预览目录不能使用符号链接或文件。');
  }
  const path = join(directory, MANIFEST);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('预览记录必须是普通小文件。');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as PreviewManifest;
  if (manifest.version !== 1 || !Number.isSafeInteger(manifest.shopping_port) || !Number.isSafeInteger(manifest.merchant_port)
    || manifest.shopping_port < 1024 || manifest.shopping_port > 65535
    || manifest.merchant_port < 1024 || manifest.merchant_port > 65535
    || manifest.shopping_port === manifest.merchant_port) throw new Error('预览端口记录无效，保留原数据并停止。');
  for (const part of ['agent', join('agent', 'sessions')]) {
    const state = await lstat(join(directory, part)).catch(() => undefined);
    if (!state?.isDirectory() || state.isSymbolicLink()) throw new Error('原预览会话目录缺失或使用链接，保留现有数据并停止恢复。');
  }
  for (const part of ['merchant.sqlite', 'authorization.private.pem', 'authorization.public.pem', join('agent', 'sessions', 'runtime-scope.json')]) {
    const state = await lstat(join(directory, part)).catch(() => undefined);
    if (!state?.isFile() || state.isSymbolicLink() || state.size === 0) throw new Error('原预览数据库、签名或会话绑定文件缺失或使用链接，保留现有数据并停止恢复。');
  }
  return manifest;
}

/** New preview: empty private directory and OS-selected ports. Resume: same data/key/origins. */
export async function startShoppingPreview(options: { directory?: string; env?: Record<string, string | undefined> } = {}): Promise<ShoppingDemo> {
  const directory = options.directory ? resolve(options.directory) : undefined;
  const manifest = directory ? await readManifest(directory) : undefined;
  const demo = await startShoppingDemo({ dataDir: directory ?? PREVIEW_ROOT, newSession: !directory,
    shoppingPort: manifest?.shopping_port ?? 0, merchantPort: manifest?.merchant_port ?? 0,
    ...(options.env ? { env: options.env } : {}) });
  try {
    if (!manifest) await writeFile(join(demo.directory, MANIFEST), JSON.stringify({ version: 1,
      shopping_port: Number(new URL(demo.shoppingOrigin).port),
      merchant_port: Number(new URL(demo.merchantOrigin).port) } satisfies PreviewManifest, null, 2), { flag: 'wx' });
    return demo;
  } catch (error) { await demo.stop(); throw error; }
}

async function main() {
  if (process.argv.length > 2) throw new Error('用法：bun run shopping:preview；恢复时设置 SHOPPING_PREVIEW_DATA_DIR。');
  const demo = await startShoppingPreview({ directory: process.env.SHOPPING_PREVIEW_DATA_DIR?.trim() || undefined });
  console.log(`演示门户：${demo.demoPortalUrl}\n用户演示入口：${demo.userDemoUrl}\n商家演示入口：${demo.merchantDemoUrl}`);
  console.log(`数据目录：${demo.directory}\n商家后台：${demo.merchantOrigin}`);
  console.log(`模型：${demo.modelName ?? '未配置，可手动搜索'}（启动不调用模型）`);
  console.log('本机演示身份，非正式登录；商家只读；模拟支付和模拟履约。原演示目录不受影响。');
  console.log('停止用 Ctrl+C。恢复这轮预览：');
  console.log(`$env:SHOPPING_PREVIEW_DATA_DIR='${demo.directory.replaceAll("'", "''")}'\nbun run shopping:preview`);
  let closing = false;
  const close = () => { if (closing) return; closing = true;
    void demo.stop().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : '预览停止失败'); process.exit(1); }); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
if (import.meta.main) await main().catch(error => {
  console.error(error instanceof Error ? error.message : '预览启动失败'); process.exitCode = 1;
});
