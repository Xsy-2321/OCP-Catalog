import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { startShoppingDemo, type ShoppingDemo } from '../../scripts/shopping-demo';

const root = resolve(import.meta.dir, '../../.codex-tmp/model-settings-e2e');
let directory: string;
let demo: ShoppingDemo | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
let calls: { authorization: string | null; body: Record<string, unknown> }[];
beforeEach(async () => {
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, 'run-'));
  calls = [];
});
afterEach(async () => {
  await demo?.stop(); demo = undefined;
  await provider?.stop(true); provider = undefined;
  const suffix = relative(root, directory);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('unsafe model-settings cleanup');
  Bun.gc(true);
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});
function counts() {
  const db = new Database(join(directory, 'merchant.sqlite'), { readonly: true });
  try { return Object.fromEntries(['attempts', 'payments', 'orders'].map(table => [table,
    db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n])); }
  finally { db.close(); }
}
const call = (path: string, body?: unknown) => fetch(`${demo!.shoppingOrigin}${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { origin: demo!.shoppingOrigin,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('first launch ignores prefilled environment keys; saving enables live agent without restart and survives restart', async () => {
  provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    calls.push({ authorization: request.headers.get('authorization'), body });
    const forced = (body.tool_choice as { function?: { name?: string } })?.function?.name;
    const messages = body.messages as { role: string; content: string }[];
    let name: string, args: Record<string, unknown>;
    if (forced === 'connection_check') { name = forced; args = { ok: true }; }
    else if (forced === 'parse_shopping_intent') {
      name = forced; args = { query: '拿铁', items: [{ query: '拿铁', quantity: 1 }], quantity: 1,
        max_total_minor: 3000, purchase_shape: 'same_product', requested_fulfillment: 'pickup', explanation: '一杯拿铁。' };
    } else if (!messages.some(message => message.role === 'tool')) { name = 'search'; args = {}; }
    else { name = 'quote'; args = { entry_ids: ['entry_latte'], reason: '请核对最终报价。' }; }
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: `call_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
  } });
  const env = { DEEPSEEK_API_KEY: 'must-never-be-used', SHOPPING_LLM_API_KEY: 'also-must-never-be-used',
    SHOPPING_LLM_BASE_URL: provider.url.origin };
  demo = await startShoppingDemo({ dataDir: directory, shoppingPort: 0, merchantPort: 0, env });
  expect(demo.modelStatus).toBe('not_configured');
  expect((await call('/api/config')).status).toBe(200);
  expect(await (await call('/api/model-settings')).json()).toMatchObject({ configured: false, has_api_key: false });
  expect((await call('/api/agent/run', { message: '一杯拿铁', quantity: 1, max_total_minor: 3000 })).status).toBe(503);
  expect(calls).toHaveLength(0);
  const draft = { protocol: 'openai', base_url: provider.url.origin, model: 'local-fixture', api_key: 'user-entered-key', timeout_ms: 2000 };
  expect(await (await call('/api/model-settings/test', draft)).json()).toMatchObject({ ok: true });
  expect(await (await call('/api/model-settings')).json()).toMatchObject({ configured: false });
  expect(counts()).toEqual({ attempts: 0, payments: 0, orders: 0 });
  const saved = await call('/api/model-settings', draft);
  expect(saved.status).toBe(200);
  expect(await saved.text()).not.toContain('user-entered-key');
  expect(await (await call('/api/config')).json()).toMatchObject({ llm_status: 'configured', llm_model: 'local-fixture' });
  const agent = await call('/api/agent/run', { message: '一杯拿铁', quantity: 1, max_total_minor: 3000 });
  expect(agent.status).toBe(200);
  expect(await agent.json()).toMatchObject({ planner_mode: 'llm', session: { phase: 'awaiting_confirmation' } });
  expect(counts()).toEqual({ attempts: 0, payments: 0, orders: 0 });
  expect(calls).toHaveLength(4);
  for (const request of calls) {
    expect(request.authorization).toBe('Bearer user-entered-key');
    expect(JSON.stringify(request.body)).not.toContain('user-entered-key');
    expect(request.body).not.toHaveProperty('thinking');
  }
  expect(JSON.parse(await readFile(join(directory, 'model-settings.json'), 'utf8')).api_key).toBe('user-entered-key');
  const shoppingPort = Number(new URL(demo.shoppingOrigin).port), merchantPort = Number(new URL(demo.merchantOrigin).port);
  await demo.stop();
  demo = await startShoppingDemo({ dataDir: directory, shoppingPort, merchantPort, env });
  expect(demo.modelStatus).toBe('configured');
  expect(await (await call('/api/model-settings')).json()).toMatchObject({ configured: true, has_api_key: true, model: 'local-fixture' });
  expect(calls).toHaveLength(4); // Restart never calls any provider.
  expect((await call('/api/model-settings/clear', {})).status).toBe(200);
  expect(await (await call('/api/config')).json()).toMatchObject({ llm_status: 'not_configured' });
  expect((await call('/api/agent/run', { message: '一杯拿铁', quantity: 1, max_total_minor: 3000 })).status).toBe(503);
  expect(counts()).toEqual({ attempts: 0, payments: 0, orders: 0 });
});

test('independent rehearsal stores can reuse explicit model settings while keeping shopping data separate', async () => {
  const settingsPath = join(directory, 'shared', 'settings.json');
  demo = await startShoppingDemo({ dataDir: join(directory, 'first'), shoppingPort: 0, merchantPort: 0, env: {}, modelSettingsPath: settingsPath });
  expect((await call('/api/model-settings', { protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1',
    model: 'claude-example', api_key: 'fixture-key', timeout_ms: 30000 })).status).toBe(200);
  await demo.stop();
  demo = await startShoppingDemo({ dataDir: join(directory, 'second'), shoppingPort: 0, merchantPort: 0, env: {}, modelSettingsPath: settingsPath });
  expect(demo.modelStatus).toBe('configured');
  expect(await (await call('/api/model-settings')).json()).toMatchObject({ protocol: 'anthropic', model: 'claude-example', has_api_key: true });
  expect(await (await call('/api/config')).json()).toMatchObject({ merchant_health: { status: 'online' } });
});

test('two running HTTP instances share saves, key rotation and clearing without reviving a stale key', async () => {
  provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    calls.push({ authorization: request.headers.get('authorization'), body: await request.json() as Record<string, unknown> });
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'shared_connection', type: 'function', function: { name: 'connection_check', arguments: '{"ok":true}' } }] } }] });
  } });
  const settingsPath = join(directory, 'shared', 'settings.json');
  demo = await startShoppingDemo({ dataDir: join(directory, 'first'), shoppingPort: 0, merchantPort: 0, env: {}, modelSettingsPath: settingsPath });
  const second = await startShoppingDemo({ dataDir: join(directory, 'second'), shoppingPort: 0, merchantPort: 0, env: {}, modelSettingsPath: settingsPath });
  const secondCall = (path: string, body?: unknown) => fetch(`${second.shoppingOrigin}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: second.shoppingOrigin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const draft = { protocol: 'openai', base_url: provider.url.origin, model: 'shared-local-fixture', api_key: 'first-fixture-key', timeout_ms: 2000 };
  try {
    expect((await call('/api/model-settings', draft)).status).toBe(200);
    expect(await (await secondCall('/api/model-settings')).json()).toMatchObject({ configured: true, model: draft.model });
    expect(await (await secondCall('/api/config')).json()).toMatchObject({ llm_status: 'configured', llm_model: draft.model });
    expect((await secondCall('/api/model-settings', { ...draft, api_key: 'rotated-fixture-key', model: 'rotated-model' })).status).toBe(200);
    expect(await (await call('/api/config')).json()).toMatchObject({ llm_model: 'rotated-model' });
    expect((await call('/api/model-settings/test', { ...draft, api_key: '' })).status).toBe(200);
    expect(calls).toHaveLength(1); expect(calls[0]!.authorization).toBe('Bearer rotated-fixture-key');
    expect((await call('/api/model-settings/clear', {})).status).toBe(200);
    expect(await (await secondCall('/api/model-settings')).json()).toMatchObject({ configured: false, has_api_key: false });
    expect(await (await secondCall('/api/config')).json()).toMatchObject({ llm_status: 'not_configured' });
    expect((await secondCall('/api/model-settings/test', { ...draft, api_key: '' })).status).toBe(400);
    expect((await secondCall('/api/model-settings', { ...draft, api_key: '' })).status).toBe(400);
    expect((await secondCall('/api/agent/run', { message: '一杯拿铁', quantity: 1, max_total_minor: 3000 })).status).toBe(503);
    expect(calls).toHaveLength(1);
    expect(await (await call('/api/model-settings')).json()).toMatchObject({ configured: false });
  } finally { await second.stop(); }
});
