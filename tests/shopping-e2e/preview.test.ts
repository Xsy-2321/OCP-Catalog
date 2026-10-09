import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { startShoppingPreview } from '../../scripts/shopping-preview';
import type { ShoppingDemo } from '../../scripts/shopping-demo';

const root = resolve(import.meta.dir, '../../.codex-tmp/shopping-dual-preview');
const directories = new Set<string>();
let demo: ShoppingDemo | undefined;
const blockers: ReturnType<typeof Bun.serve>[] = [];
async function preview(directory?: string) {
  demo = await startShoppingPreview({ ...(directory ? { directory } : {}), env: {} });
  directories.add(demo.directory); return demo;
}
async function digest(directory: string) {
  return createHash('sha256').update(await readFile(join(directory, 'authorization.private.pem'))).digest('hex');
}
function snapshot(directory: string) {
  const db = new Database(join(directory, 'merchant.sqlite'), { readonly: true });
  try { return {
    version: db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='schema_version'").get()!.value,
    orders: db.query<{ n: number }, []>('SELECT COUNT(*) n FROM orders').get()!.n,
    payments: db.query<{ n: number }, []>('SELECT COUNT(*) n FROM payments').get()!.n,
    stock: db.query("SELECT entry_id,available_quantity FROM inventory ORDER BY entry_id").all(),
  }; } finally { db.close(); }
}
afterEach(async () => {
  await demo?.stop(); demo = undefined;
  for (const blocker of blockers.splice(0)) await blocker.stop(true);
  Bun.gc(true);
  for (const directory of directories) {
    const suffix = relative(root, directory);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('unsafe preview test cleanup');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
  directories.clear();
});

test('dual preview uses a private new directory, real pages and free ports; same manifest/key/data survive restart', async () => {
  const first = await preview();
  const key = await digest(first.directory), manifest = await readFile(join(first.directory, 'preview.json'), 'utf8');
  expect(first.shoppingOrigin).not.toBe(first.merchantOrigin);
  expect(first.demoPortalUrl).toBe(`${first.shoppingOrigin}/demo`);
  expect((await fetch(first.demoPortalUrl)).status).toBe(200);
  expect((await fetch(first.merchantDemoUrl)).status).toBe(200);
  const configured = await fetch(`${first.shoppingOrigin}/api/config`);
  expect((await configured.json() as any).merchant_demo_available).toBe(true);
  const cookie = configured.headers.get('set-cookie')!.split(';')[0]!;
  async function call(path: string, body?: unknown) {
    const response = await fetch(`${demo!.shoppingOrigin}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: demo!.shoppingOrigin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status).toBeLessThan(400); return response.json() as Promise<any>;
  }
  const created = await call('/api/sessions', { query: '拿铁', quantity: 1, max_total_minor: 3000,
    currency: 'CNY', merchant_id: 'merchant_coffee_demo', fulfillment: 'pickup' });
  await call(`/api/sessions/${created.id}/search`, {});
  const quoted = await call(`/api/sessions/${created.id}/quote`, { entry_id: 'entry_latte' });
  const bought = await call(`/api/sessions/${created.id}/confirm`, {
    quote_id: quoted.quote.quote_id, terms_hash: quoted.quote.terms_hash, revision: quoted.revision });
  const before = snapshot(first.directory); expect(before.orders).toBe(1); expect(before.version).toBe('3');
  await first.stop(); demo = undefined;
  const restarted = await preview(first.directory);
  expect(restarted.shoppingOrigin).toBe(first.shoppingOrigin); expect(restarted.merchantOrigin).toBe(first.merchantOrigin);
  expect(await digest(first.directory)).toBe(key); expect(snapshot(first.directory)).toEqual(before);
  expect(await readFile(join(first.directory, 'preview.json'), 'utf8')).toBe(manifest);
  const entry = await fetch(restarted.merchantDemoUrl), operator = entry.headers.get('set-cookie')!.split(';')[0]!;
  const view = await fetch(`${restarted.shoppingOrigin}/api/merchant-demo/overview`, { headers: { cookie: operator } });
  expect((await view.json() as any).orders.items[0].order_id).toBe(bought.order.order_id);
  expect((await call(`/api/sessions/${created.id}/recover`, {})).order.order_id).toBe(bought.order.order_id);
});

test('a busy saved port stops safely; it never replaces the original origins, key or data', async () => {
  const first = await preview(), manifest = await readFile(join(first.directory, 'preview.json'), 'utf8');
  const key = await digest(first.directory), state = snapshot(first.directory);
  await first.stop(); demo = undefined;
  const blocker = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(first.shoppingOrigin).port), fetch: () => new Response('occupied') });
  blockers.push(blocker);
  await expect(startShoppingPreview({ directory: first.directory, env: {} })).rejects.toBeDefined();
  expect(await digest(first.directory)).toBe(key); expect(snapshot(first.directory)).toEqual(state);
  expect(await readFile(join(first.directory, 'preview.json'), 'utf8')).toBe(manifest);
  expect(await (await fetch(first.shoppingOrigin)).text()).toBe('occupied');
  await blocker.stop(true);
  expect((await preview(first.directory)).shoppingOrigin).toBe(first.shoppingOrigin);
});

test('resuming an unowned directory or malformed manifest fails without initializing data', async () => {
  await expect(startShoppingPreview({ directory: resolve(root, '../unowned-preview'), env: {} })).rejects.toThrow('恢复目录');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'invalid-test-')); directories.add(directory);
  await writeFile(join(directory, 'preview.json'), JSON.stringify({ version: 1, shopping_port: 0, merchant_port: 8787 }));
  await expect(startShoppingPreview({ directory, env: {} })).rejects.toThrow('端口记录无效');
  await expect(access(join(directory, 'merchant.sqlite'))).rejects.toBeDefined();
  await expect(access(join(directory, 'authorization.private.pem'))).rejects.toBeDefined();
});

test('resume refuses missing original keys and database instead of regenerating empty state', async () => {
  const first = await preview(), manifest = await readFile(join(first.directory, 'preview.json'), 'utf8');
  const state = snapshot(first.directory);
  await first.stop(); demo = undefined;
  await unlink(join(first.directory, 'authorization.private.pem'));
  await unlink(join(first.directory, 'authorization.public.pem'));
  await expect(startShoppingPreview({ directory: first.directory, env: {} })).rejects.toThrow('签名');
  await expect(access(join(first.directory, 'authorization.private.pem'))).rejects.toBeDefined();
  expect(snapshot(first.directory)).toEqual(state);
  expect(await readFile(join(first.directory, 'preview.json'), 'utf8')).toBe(manifest);
  await unlink(join(first.directory, 'merchant.sqlite'));
  await expect(startShoppingPreview({ directory: first.directory, env: {} })).rejects.toThrow('数据库');
  await expect(access(join(first.directory, 'merchant.sqlite'))).rejects.toBeDefined();
});

test('resume refuses a lost session scope before the merchant can initialize or migrate', async () => {
  const first = await preview(), key = await digest(first.directory), state = snapshot(first.directory);
  await first.stop(); demo = undefined;
  await unlink(join(first.directory, 'agent/sessions/runtime-scope.json'));
  await expect(startShoppingPreview({ directory: first.directory, env: {} })).rejects.toThrow('会话绑定');
  expect(await digest(first.directory)).toBe(key); expect(snapshot(first.directory)).toEqual(state);
  await expect(access(join(first.directory, 'agent/sessions/runtime-scope.json'))).rejects.toBeDefined();
});

test('resume refuses a linked sessions directory and leaves its target untouched', async () => {
  const target = await preview(), state = snapshot(target.directory), key = await digest(target.directory);
  await target.stop(); demo = undefined;
  const linked = await preview(); await linked.stop(); demo = undefined;
  const linkPath = join(linked.directory, 'agent/sessions');
  const targetPath = join(target.directory, 'agent/sessions');
  for (const path of [linkPath, targetPath]) {
    const suffix = relative(root, resolve(path));
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('unsafe test link path');
  }
  await unlink(join(linkPath, 'runtime-scope.json'));
  await unlink(join(linkPath, 'sessions.sqlite'));
  await unlink(join(linkPath, 'sqlite-store.json'));
  await rmdir(linkPath); await symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await expect(startShoppingPreview({ directory: linked.directory, env: {} })).rejects.toThrow('会话目录');
    expect(snapshot(target.directory)).toEqual(state); expect(await digest(target.directory)).toBe(key);
  } finally { await rm(linkPath, { force: true, recursive: true }); }
});
