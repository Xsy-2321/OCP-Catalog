import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { startShoppingDemo, type ShoppingDemo } from '../../scripts/shopping-demo';
import { SqliteSessionStore, FlowError, ShoppingCoordinator, ShoppingModelClient, type PublicSession } from '../../packages/agent-runtime/src';

const scratch = resolve(import.meta.dir, '../../.codex-tmp');
let directory: string;
let demo: ShoppingDemo | undefined;
const helpers: ReturnType<typeof Bun.serve>[] = [];
beforeEach(async () => {
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(join(scratch, 'shopping-demo-test-'));
});
afterEach(async () => {
  await demo?.stop(); demo = undefined;
  for (const helper of helpers.splice(0)) await helper.stop(true);
  const suffix = relative(scratch, directory);
  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..') throw new Error('unsafe test cleanup path');
  Bun.gc(true);
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function helper(fetcher: (request: Request) => Response | Promise<Response> = () => new Response('occupied')) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: fetcher });
  helpers.push(server);
  return server;
}

function snapshot() {
  const db = new Database(join(directory, 'merchant.sqlite'), { readonly: true });
  try {
    return {
      orders: db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM orders').get()!.n,
      payments: db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM payments').get()!.n,
      inventory: db.query<{ available_quantity: number }, []>("SELECT available_quantity FROM inventory WHERE entry_id = 'entry_latte'").get()!.available_quantity,
    };
  } finally { db.close(); }
}

test('preflight checks storage and model configuration without binding sockets or calling the model', async () => {
  let modelCalls = 0;
  const occupiedApi = helper();
  const occupiedMerchant = helper(() => { modelCalls++; return new Response('should not be called'); });
  const options = { dataDir: directory, checkOnly: true,
    shoppingPort: occupiedApi.port!, merchantPort: occupiedMerchant.port!,
    env: {}, model: new ShoppingModelClient({ apiKey: 'local-test-only', baseUrl: occupiedMerchant.url.origin }) };
  const checked = await startShoppingDemo(options);
  expect(checked.mode).toBe('check');
  expect(checked.modelStatus).toBe('configured');
  expect(modelCalls).toBe(0);
  await expect(access(join(directory, 'server.lock'))).rejects.toBeDefined();
  const key = await readFile(join(directory, 'authorization.private.pem'), 'utf8');
  await checked.stop(); // Repeated cleanup must not unlink a later process's lock.
  await startShoppingDemo(options);
  expect(await readFile(join(directory, 'authorization.private.pem'), 'utf8')).toBe(key);
  expect(snapshot()).toEqual({ orders: 0, payments: 0, inventory: 12 });
});

test('one bootstrap performs real HTTP shopping and retains key, order and stock on same-port restart', async () => {
  demo = await startShoppingDemo({ dataDir: directory, shoppingPort: 0, merchantPort: 0, env: {} });
  const configured = await fetch(`${demo.shoppingOrigin}/api/config`);
  const cookie = configured.headers.get('set-cookie')!.split(';')[0]!;
  expect(await configured.json()).toMatchObject({ mode: 'http', llm_status: 'not_configured', merchant_health: { status: 'online' } });
  const key = await readFile(join(directory, 'authorization.private.pem'), 'utf8');
  await expect(startShoppingDemo({ dataDir: directory, shoppingPort: 0, merchantPort: 0, env: {} })).rejects.toThrow('锁定');
  const call = async (path: string, body?: unknown): Promise<PublicSession> => {
    const response = await fetch(`${demo!.shoppingOrigin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: demo!.shoppingOrigin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBeLessThan(400);
    return response.json();
  };
  const created = await call('/api/sessions', { query: '拿铁', quantity: 1, max_total_minor: 3000,
    currency: 'CNY', fulfillment: 'pickup', merchant_id: 'merchant_coffee_demo' });
  await call(`/api/sessions/${created.id}/search`, {});
  const quote = await call(`/api/sessions/${created.id}/quote`, { entry_id: 'entry_latte' });
  expect(quote.phase).toBe('awaiting_confirmation');
  expect(snapshot()).toEqual({ orders: 0, payments: 0, inventory: 12 });
  const purchased = await call(`/api/sessions/${created.id}/confirm`, {
    quote_id: quote.quote!.quote_id, terms_hash: quote.quote!.terms_hash, revision: quote.revision,
  });
  expect(purchased.phase).toBe('confirmed');
  expect(purchased.order?.payment_status).toBe('paid');
  expect(snapshot()).toEqual({ orders: 1, payments: 1, inventory: 11 });
  const shoppingPort = Number(new URL(demo.shoppingOrigin).port);
  const merchantPort = Number(new URL(demo.merchantOrigin).port);
  const stopping = demo.stop();
  expect(demo.stop()).toBe(stopping);
  await stopping;
  demo = await startShoppingDemo({ dataDir: directory, shoppingPort, merchantPort, env: {} });
  expect(await readFile(join(directory, 'authorization.private.pem'), 'utf8')).toBe(key);
  expect((await call(`/api/sessions/${created.id}/recover`, {})).order?.order_id).toBe(purchased.order?.order_id);
  expect(snapshot()).toEqual({ orders: 1, payments: 1, inventory: 11 });
});

test('new-session creates a separate retained store and rejects directories outside project scratch', async () => {
  const first = await startShoppingDemo({ dataDir: directory, checkOnly: true, env: {} });
  const firstKey = await readFile(join(first.directory, 'authorization.private.pem'), 'utf8');
  const next = await startShoppingDemo({ dataDir: directory, checkOnly: true, newSession: true, env: {} });
  expect(next.directory).not.toBe(first.directory);
  expect(await readFile(join(first.directory, 'authorization.private.pem'), 'utf8')).toBe(firstKey);
  expect(await readFile(join(next.directory, 'authorization.private.pem'), 'utf8')).not.toBe(firstKey);
  expect(snapshot()).toEqual({ orders: 0, payments: 0, inventory: 12 });
  await expect(startShoppingDemo({ dataDir: resolve(scratch, '..'), checkOnly: true, env: {} })).rejects.toThrow('.codex-tmp');
});

test('a failed API bind closes the merchant and releases the data lock without resetting storage', async () => {
  const occupied = helper();
  const probe = helper();
  const merchantPort = probe.port!;
  await probe.stop(true);
  await expect(startShoppingDemo({ dataDir: directory, shoppingPort: occupied.port!, merchantPort, env: {} })).rejects.toBeDefined();
  await expect(access(join(directory, 'server.lock'))).rejects.toBeDefined();
  const key = await readFile(join(directory, 'authorization.private.pem'), 'utf8');
  demo = await startShoppingDemo({ dataDir: directory, shoppingPort: 0, merchantPort, env: {} });
  expect(await readFile(join(directory, 'authorization.private.pem'), 'utf8')).toBe(key);
  expect((await fetch(`${demo.merchantOrigin}/ocp/health`)).status).toBe(200);
});

test('shutdown waits for an entered A handler before closing B and releasing the lock', async () => {
  let entered!: () => void;
  let finish!: () => void;
  const modelEntered = new Promise<void>(resolve => { entered = resolve; });
  const modelRelease = new Promise<void>(resolve => { finish = resolve; });
  const localModel = helper(async () => { entered(); await modelRelease; return Response.json({ choices: [] }); });
  demo = await startShoppingDemo({ dataDir: directory, shoppingPort: 0, merchantPort: 0,
    env: {}, model: new ShoppingModelClient({ apiKey: 'local-test-only', baseUrl: localModel.url.origin, timeoutMs: 2000 }) });
  const request = fetch(`${demo.shoppingOrigin}/api/agent/run`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: demo.shoppingOrigin },
    body: JSON.stringify({ message: '买一杯拿铁', quantity: 1, max_total_minor: 3000 }) });
  await modelEntered;
  let stopped = false;
  const stopping = demo.stop().then(() => { stopped = true; });
  try {
    expect((await fetch(`${demo.merchantOrigin}/ocp/health`)).status).toBe(200);
    await access(join(directory, 'server.lock'));
    expect(stopped).toBe(false);
  } finally { finish(); }
  expect((await request).status).toBe(502);
  await stopping;
  await expect(access(join(directory, 'server.lock'))).rejects.toBeDefined();
});

test('shutdown retains B and its lock after an aborted handler returns until its queued write settles', async () => {
  demo = await startShoppingDemo({ dataDir: directory, shoppingPort: 0, merchantPort: 0, env: {} });
  const controller = new AbortController();
  let entered!: () => void, finish!: () => void, draining!: () => void;
  const writeEntered = new Promise<void>(resolve => { entered = resolve; });
  const writeRelease = new Promise<void>(resolve => { finish = resolve; });
  const drainEntered = new Promise<void>(resolve => { draining = resolve; });
  let savedId: string | undefined;
  const originalWrite = SqliteSessionStore.prototype.write;
  const originalCreate = ShoppingCoordinator.prototype.create;
  const originalWait = ShoppingCoordinator.prototype.waitForIdle;
  const write = spyOn(SqliteSessionStore.prototype, 'write').mockImplementation(async function (this: SqliteSessionStore, session) {
    savedId = session.id; entered(); await writeRelease;
    await originalWrite.call(this, session);
  });
  const create = spyOn(ShoppingCoordinator.prototype, 'create').mockImplementation(function (this: ShoppingCoordinator, userId, input) {
    return originalCreate.call(this, userId, input, { signal: controller.signal });
  });
  const wait = spyOn(ShoppingCoordinator.prototype, 'waitForIdle').mockImplementation(function (this: ShoppingCoordinator) {
    draining(); return originalWait.call(this);
  });
  let stopping: Promise<void> | undefined;
  let stopped = false;
  try {
    const request = fetch(`${demo.shoppingOrigin}/api/sessions`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: demo.shoppingOrigin },
      body: JSON.stringify({ query: '拿铁', quantity: 1, max_total_minor: 3000,
        currency: 'CNY', fulfillment: 'pickup', merchant_id: 'merchant_coffee_demo' }) });
    await writeEntered;
    controller.abort(new FlowError('agent_timeout', 'local test cancellation', 504));
    const response = await request;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: 'agent_timeout' } });
    stopping = demo.stop().then(() => { stopped = true; });
    await drainEntered;
    expect((await fetch(`${demo.merchantOrigin}/ocp/health`)).status).toBe(200);
    await access(join(directory, 'server.lock'));
    await expect(startShoppingDemo({ dataDir: directory, shoppingPort: 0, merchantPort: 0, env: {} })).rejects.toThrow('锁定');
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    expect(await new SqliteSessionStore(join(directory, 'agent/sessions')).read(savedId!))
      .toMatchObject({ id: savedId, phase: 'new' });
    await expect(access(join(directory, 'server.lock'))).rejects.toBeDefined();
  } finally {
    finish();
    try { await stopping; }
    finally { write.mockRestore(); create.mockRestore(); wait.mockRestore(); }
  }
});
