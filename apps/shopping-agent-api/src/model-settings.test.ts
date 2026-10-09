import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeSync, constants, openSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createMockRuntime, ShoppingModelClient, type ShoppingCoordinator } from '@ocp-catalog/agent-runtime';
import { createLocalModelSettings } from './model-settings';
import { createHandler } from './server';

const ROOT = resolve('.codex-tmp/model-settings-tests');
const ORIGIN = 'http://127.0.0.1:49992';
const SECRET = 'local-test-key-never-real';
const draft = { protocol: 'openai', base_url: 'https://example.test/v1', model: 'model-a', api_key: SECRET, timeout_ms: 1000 };
const answer = (name: string, value: unknown) => Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
  role: 'assistant', content: null, tool_calls: [{ id: 'connection_1', type: 'function', function: { name, arguments: JSON.stringify(value) } }],
} }] });
let directory: string;
let filename: string;
beforeEach(async () => {
  await mkdir(ROOT, { recursive: true }); directory = await mkdtemp(join(ROOT, 'run-')); filename = join(directory, 'settings.json');
});
afterEach(async () => {
  const suffix = relative(ROOT, directory);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('unsafe model test cleanup path');
  await rm(directory, { recursive: true, force: true });
});
function request(path: string, body?: unknown, headers: Record<string, string> = {}, method?: string) {
  return new Request(`${ORIGIN}${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin: ORIGIN }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function coordinator(): ShoppingCoordinator {
  return { mode: 'mock', merchantId: 'coffee-demo',
    inspectHealth: async () => ({ mode: 'mock', status: 'mock', ready: true, checked_at: new Date(0).toISOString() }),
  } as unknown as ShoppingCoordinator;
}

describe('private local model configuration', () => {
  test('first launch requires user configuration even when the environment contains a key', async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'old-prefilled-test-key';
    try {
      const settings = await createLocalModelSettings(filename);
      expect(settings.getModel()).toBeUndefined();
      expect(settings.view()).toEqual({ configured: false, protocol: 'openai', base_url: '', model: '', timeout_ms: 30_000, has_api_key: false, source: 'none' });
      expect(await lstat(filename).catch(() => undefined)).toBeUndefined();
    } finally { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
  });
  test('save is persisted, reload is usable, views exclude the key and clear removes it', async () => {
    const settings = await createLocalModelSettings(filename);
    const saved = await settings.save(draft);
    expect(saved).toMatchObject({ configured: true, source: 'local', has_api_key: true, model: 'model-a' });
    expect(JSON.stringify(saved)).not.toContain(SECRET); expect(Object.hasOwn(saved, 'api_key')).toBe(false);
    expect(JSON.parse(await readFile(filename, 'utf8'))).toMatchObject({ ...draft, version: 1 });
    const reloaded = await createLocalModelSettings(filename);
    expect(reloaded.getModel()?.model).toBe('model-a'); expect(reloaded.view()).toEqual(saved);
    expect(await reloaded.clear()).toMatchObject({ configured: false, source: 'none', has_api_key: false });
    expect(reloaded.getModel()).toBeUndefined(); expect((await createLocalModelSettings(filename)).getModel()).toBeUndefined();
    expect(await lstat(filename).catch(() => undefined)).toBeUndefined();
  });
  test('an omitted or blank key is retained only for the same normalized protocol and endpoint', async () => {
    const settings = await createLocalModelSettings(filename);
    await settings.save(draft);
    const { api_key: _key, ...withoutKey } = draft;
    await settings.save({ ...withoutKey, base_url: 'https://example.test/v1/', model: 'model-b' });
    await settings.save({ ...withoutKey, api_key: '  ', model: 'model-c' });
    expect(JSON.parse(await readFile(filename, 'utf8')).api_key).toBe(SECRET);
    for (const changed of [{ ...withoutKey, protocol: 'anthropic' }, { ...withoutKey, base_url: 'https://other.test/v1' }]) {
      await expect(settings.save(changed)).rejects.toThrow('重新填写');
    }
    expect(settings.view().model).toBe('model-c');
  });
  test('live instances refresh view, client, draft checks and blank-key saves from authoritative disk', async () => {
    const authorizations: string[] = [];
    const fetcher = (async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization')!);
      return answer('connection_check', { ok: true });
    }) as typeof fetch;
    const first = await createLocalModelSettings(filename, { fetch: fetcher });
    const second = await createLocalModelSettings(filename, { fetch: fetcher });
    await first.save(draft);
    expect(second.view()).toMatchObject({ configured: true, model: 'model-a' });
    expect(second.getModel()?.model).toBe('model-a');
    await second.save({ ...draft, api_key: 'replacement-test-key', model: 'model-b' });
    expect(first.view().model).toBe('model-b'); expect(first.getModel()?.model).toBe('model-b');
    await first.test({ ...draft, api_key: '' });
    expect(authorizations).toEqual(['Bearer replacement-test-key']);
    await first.save({ ...draft, api_key: '', model: 'model-c' });
    expect(JSON.parse(await readFile(filename, 'utf8')).api_key).toBe('replacement-test-key');
    await second.clear();
    expect(first.view()).toMatchObject({ configured: false, has_api_key: false }); expect(first.getModel()).toBeUndefined();
    await expect(first.test({ ...draft, api_key: '' })).rejects.toThrow('API Key');
    await expect(first.save({ ...draft, api_key: '' })).rejects.toThrow('API Key');
    expect(authorizations).toHaveLength(1); expect(await lstat(filename).catch(() => undefined)).toBeUndefined();
  });
  test('concurrent blank-key saves and clear operations cannot restore removed credentials across instances', async () => {
    const first = await createLocalModelSettings(filename), second = await createLocalModelSettings(filename);
    for (let iteration = 0; iteration < 6; iteration++) {
      await first.save(draft);
      const [save, clear] = await Promise.allSettled([first.save({ ...draft, api_key: '', model: 'edited-model' }), second.clear()]);
      expect(clear.status).toBe('fulfilled');
      if (save.status === 'rejected') expect(save.reason.message).toContain('API Key');
      expect(first.view().configured).toBe(false); expect(second.getModel()).toBeUndefined();
      expect(await lstat(filename).catch(() => undefined)).toBeUndefined();
      expect(await lstat(`${filename}.lock`).catch(() => undefined)).toBeUndefined();
    }
  });
  test('an interrupted writer lock waits briefly then fails closed, and never steals the lock', async () => {
    const settings = await createLocalModelSettings(filename);
    await settings.save(draft);
    const lock = await open(`${filename}.lock`, 'wx', 0o600);
    try {
      const pending = settings.clear();
      await expect(pending).rejects.toThrow('其他进程');
      expect((await lstat(`${filename}.lock`)).isFile()).toBe(true);
      expect(settings.getModel()?.model).toBe('model-a');
      expect(JSON.parse(await readFile(filename, 'utf8')).api_key).toBe(SECRET);
    } finally { await lock.close(); await unlink(`${filename}.lock`); }
    await settings.clear(); expect(settings.view().configured).toBe(false);
  });
  test.skipIf(process.platform !== 'win32')('Windows atomic replacement waits for a held reader and preserves the complete original file', async () => {
    const settings = await createLocalModelSettings(filename);
    await settings.save(draft);
    const original = await readFile(filename, 'utf8');
    let descriptor: number | undefined = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    let completion: Promise<unknown> | undefined;
    try {
      // Prove this runtime's descriptor really blocks OS replacement; a test
      // with a descriptor that allows deletion would not exercise the retry.
      const probe = join(directory, 'replacement-probe.tmp');
      await writeFile(probe, original);
      await expect(rename(probe, filename)).rejects.toMatchObject({ code: 'EPERM' });
      await unlink(probe);
      let settled = false;
      const saving = settings.save({ ...draft, model: 'model-after-reader' }).then(
        value => { settled = true; return { ok: true as const, value }; },
        error => { settled = true; return { ok: false as const, error }; },
      );
      completion = saving;
      // Wait for the real save to stage a file before retaining the read handle
      // through multiple retry intervals.
      const stagedDeadline = Date.now() + 1000;
      while (!(await readdir(directory)).some(name => name.startsWith('settings.json.') && name.endsWith('.tmp'))) {
        if (settled || Date.now() >= stagedDeadline) break;
        await new Promise<void>(done => setTimeout(done, 10));
      }
      expect((await readdir(directory)).some(name => name.startsWith('settings.json.') && name.endsWith('.tmp'))).toBe(true);
      await new Promise<void>(done => setTimeout(done, 50));
      expect(settled).toBe(false);
      expect(await readFile(filename, 'utf8')).toBe(original);
      expect(settings.view().model).toBe('model-a');
      closeSync(descriptor); descriptor = undefined;
      const result = await saving;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.model).toBe('model-after-reader');
      const final = JSON.parse(await readFile(filename, 'utf8'));
      expect(final).toEqual({ ...draft, version: 1, model: 'model-after-reader' });
      expect((await createLocalModelSettings(filename)).view().model).toBe('model-after-reader');
      expect(await readdir(directory)).toEqual(['settings.json']);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      await completion;
    }
  });
  test.skipIf(process.platform !== 'win32')('Windows atomic replacement fails closed when a reader outlives the bounded retry', async () => {
    const settings = await createLocalModelSettings(filename);
    await settings.save(draft);
    const original = await readFile(filename, 'utf8');
    let descriptor: number | undefined = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const started = Date.now();
      await expect(settings.save({ ...draft, model: 'must-not-be-persisted' })).rejects.toMatchObject({ code: 'model_settings_unavailable', status: 503 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
      expect(await readFile(filename, 'utf8')).toBe(original);
      expect(settings.view().model).toBe('model-a');
      expect(await readdir(directory)).toEqual(['settings.json']);
      closeSync(descriptor); descriptor = undefined;
      await settings.save({ ...draft, model: 'model-after-release' });
      expect(settings.view().model).toBe('model-after-release');
      expect((await createLocalModelSettings(filename)).view().model).toBe('model-after-release');
      expect(await readdir(directory)).toEqual(['settings.json']);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }, 7000);
  test('disk corruption introduced after startup never falls back to a previously loaded key', async () => {
    let calls = 0;
    const settings = await createLocalModelSettings(filename, { fetch: (async () => { calls++; return answer('connection_check', { ok: true }); }) as unknown as typeof fetch });
    await settings.save(draft); expect(settings.getModel()?.model).toBe('model-a');
    await writeFile(filename, '{broken');
    expect(() => settings.view()).toThrow('无法安全读写'); expect(() => settings.getModel()).toThrow('无法安全读写');
    await expect(settings.test({ ...draft, api_key: '' })).rejects.toThrow('无法安全读写');
    await expect(settings.save({ ...draft, api_key: '' })).rejects.toThrow('无法安全读写');
    expect(calls).toBe(0); expect(await readFile(filename, 'utf8')).toBe('{broken');
    await settings.clear(); expect(settings.getModel()).toBeUndefined();
  });
  test('normalized URLs and escaped JSON that exceed reload limits are rejected before saving', async () => {
    const settings = await createLocalModelSettings(filename);
    const expandedUrl = `https://example.test/${'中'.repeat(250)}`;
    expect(expandedUrl.length).toBeLessThan(2048); expect(new URL(expandedUrl).href.length).toBeGreaterThan(2048);
    await expect(settings.save({ ...draft, base_url: expandedUrl })).rejects.toThrow('规范化');
    await expect(settings.save({ ...draft, api_key: '"'.repeat(4096) })).rejects.toThrow('8192');
    expect(settings.view().configured).toBe(false); expect(await lstat(filename).catch(() => undefined)).toBeUndefined();
  });
  test('every accepted URL/JSON boundary round-trips after saving, including Unicode URL expansion and escaped keys', async () => {
    const settings = await createLocalModelSettings(filename);
    for (const next of [
      { ...draft, base_url: `https://example.test/${'中'.repeat(200)}` },
      { ...draft, base_url: `https://example.test/${'x'.repeat(2027)}`, api_key: 'x'.repeat(4096) },
      { ...draft, api_key: '"'.repeat(3900) },
    ]) {
      const saved = await settings.save(next);
      expect(saved.base_url.length).toBeLessThanOrEqual(2048);
      expect((await lstat(filename)).size).toBeLessThanOrEqual(8192);
      const reloaded = await createLocalModelSettings(filename);
      expect(reloaded.view()).toEqual(saved); expect(reloaded.getModel()?.model).toBe(next.model);
    }
  });
  test.each([
    { protocol: 'other' }, { base_url: 'http://remote.test' }, { base_url: 'https://user:password@example.test' },
    { base_url: 'https://example.test?api_key=private' }, { base_url: 'https://example.test#private' },
    { base_url: '' }, { base_url: 'https://example.test/' + 'x'.repeat(2049) }, { model: '' }, { model: 'x'.repeat(129) },
    { api_key: '' }, { api_key: 123 }, { api_key: 'private\nheader' }, { api_key: 'x'.repeat(4097) },
    { timeout_ms: 99 }, { timeout_ms: 60_001 }, { timeout_ms: '30000' }, { unknown: SECRET },
  ])('invalid draft is rejected before storage or network: %j', async overrides => {
    let calls = 0;
    const settings = await createLocalModelSettings(filename, { fetch: (async () => { calls++; throw new Error(SECRET); }) as unknown as typeof fetch });
    await expect(settings.save({ ...draft, ...overrides })).rejects.toThrow();
    await expect(settings.test({ ...draft, ...overrides })).rejects.toThrow();
    expect(calls).toBe(0); expect(settings.view().configured).toBe(false);
    expect(await lstat(filename).catch(() => undefined)).toBeUndefined();
  });
  test('successful draft test proves function calling, sends authorization only in the header and does not save', async () => {
    let calls = 0;
    const settings = await createLocalModelSettings(filename, { fetch: (async (url, init) => {
      calls++;
      expect(url.toString()).toBe('https://example.test/v1/chat/completions');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
      const body = JSON.parse(init?.body as string);
      expect(body.tool_choice.function.name).toBe('connection_check'); expect(JSON.stringify(body)).not.toContain(SECRET);
      return answer('connection_check', { ok: true });
    }) as typeof fetch });
    expect(await settings.test(draft)).toMatchObject({ ok: true }); expect(calls).toBe(1);
    expect(settings.getModel()).toBeUndefined(); expect(await lstat(filename).catch(() => undefined)).toBeUndefined();
  });
  test('a provider answering text or wrong function arguments fails the check without changing saved configuration', async () => {
    for (const reply of [Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: SECRET } }] }),
      answer('checkout', { ok: true }), answer('connection_check', { ok: false }), answer('connection_check', { ok: true, leaked: SECRET })]) {
      const settings = await createLocalModelSettings(filename, { fetch: (async () => reply) as unknown as typeof fetch });
      await settings.save(draft);
      await expect(settings.test({ ...draft, model: 'unusable-draft' })).rejects.toThrow('工具调用');
      expect(settings.getModel()?.model).toBe('model-a'); expect(JSON.parse(await readFile(filename, 'utf8')).model).toBe('model-a');
    }
  });
  test('queued save and clear mutations leave a complete final file and no temporary key files', async () => {
    const settings = await createLocalModelSettings(filename);
    await Promise.all([settings.save(draft), settings.save({ ...draft, model: 'model-b' }), settings.clear(), settings.save({ ...draft, model: 'model-c' })]);
    expect(settings.view().model).toBe('model-c'); expect((await createLocalModelSettings(filename)).view().model).toBe('model-c');
  });
  test.each(['broken json', JSON.stringify({ ...draft, version: 1, model: '' }), JSON.stringify({ ...draft, version: 2 })])(
    'a corrupt persisted configuration fails closed without leaking content', async content => {
      await writeFile(filename, content);
      await expect(createLocalModelSettings(filename)).rejects.toThrow('无法安全读写');
      expect(await readFile(filename, 'utf8')).toBe(content);
    });
  test('directory junctions cannot redirect private settings reads or writes', async () => {
    const target = join(directory, 'target'), alias = join(directory, 'alias');
    await mkdir(target); await symlink(target, alias, 'junction');
    await expect(createLocalModelSettings(join(alias, 'settings.json'))).rejects.toThrow('无法安全读写');
    const settings = await createLocalModelSettings(join(directory, 'new-parent', 'settings.json'));
    await symlink(target, join(directory, 'new-parent'), 'junction');
    await expect(settings.save(draft)).rejects.toThrow('无法安全读写');
    expect(await lstat(join(target, 'settings.json')).catch(() => undefined)).toBeUndefined();
  });
});

describe('local model configuration routes', () => {
  test('GET, save, test and clear never return a secret, including provider failures', async () => {
    let healthy = true;
    const settings = await createLocalModelSettings(filename, { fetch: (async () => healthy
      ? answer('connection_check', { ok: true }) : new Response(`private provider text ${SECRET}`, { status: 401 })) as unknown as typeof fetch });
    const handler = createHandler(coordinator(), { modelSettings: settings });
    for (const [path, body, status] of [
      ['/api/model-settings', undefined, 200], ['/api/model-settings', draft, 200], ['/api/model-settings/test', draft, 200],
    ] as const) {
      const response = await handler(request(path, body)); expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.text()).not.toContain(SECRET);
    }
    healthy = false;
    const failed = await handler(request('/api/model-settings/test', { ...draft, model: 'bad-draft' }));
    expect(failed.status).toBe(502); const body = await failed.json(); expect(body.error.code).toBe('model_auth_failed');
    expect(JSON.stringify(body)).not.toContain(SECRET); expect(JSON.stringify(body)).not.toContain('private provider text');
    expect(settings.view().model).toBe('model-a');
    const cleared = await handler(request('/api/model-settings/clear', {})); expect(cleared.status).toBe(200);
    expect(await cleared.text()).not.toContain(SECRET); expect(settings.getModel()).toBeUndefined();
  });
  test.each([
    { origin: 'https://evil.test' }, { host: 'evil.test:49992' }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' }, { 'content-type': 'text/plain' },
  ] as Record<string, string>[])('existing host, same-origin and JSON guards protect all settings mutations: %j', async headers => {
    let calls = 0;
    const settings = await createLocalModelSettings(filename, { fetch: (async () => { calls++; return answer('connection_check', { ok: true }); }) as unknown as typeof fetch });
    const handler = createHandler(coordinator(), { modelSettings: settings, allowedHost: '127.0.0.1:49992' });
    for (const path of ['/api/model-settings', '/api/model-settings/test', '/api/model-settings/clear']) {
      const response = await handler(request(path, path.endsWith('/clear') ? {} : draft, headers));
      expect(response.status).toBe(headers['content-type'] ? 415 : 403);
    }
    expect(calls).toBe(0); expect(settings.view().configured).toBe(false);
  });
  test('unexpected methods, oversized input and invalid JSON do not mutate configuration', async () => {
    const settings = await createLocalModelSettings(filename), handler = createHandler(coordinator(), { modelSettings: settings });
    expect((await handler(request('/api/model-settings', undefined, {}, 'DELETE'))).status).toBe(405);
    expect((await handler(request('/api/model-settings', { ...draft, api_key: 'x'.repeat(9000) }))).status).toBe(413);
    expect((await handler(new Request(`${ORIGIN}/api/model-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }))).status).toBe(400);
    expect((await handler(request('/api/model-settings/clear', { api_key: SECRET }))).status).toBe(400);
    expect(settings.view().configured).toBe(false);
  });
  test('demo setup remains available without a merchant demo reader', async () => {
    const handler = createHandler(coordinator(), { modelSettings: await createLocalModelSettings(filename) });
    for (const path of ['/demo', '/demo.html']) {
      const response = await handler(request(path)); expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).toContain('模型');
    }
    for (const path of ['/merchant.css', '/model-settings.css', '/model-settings.js']) {
      const response = await handler(request(path));
      expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).not.toHaveLength(0);
    }
  });
  test('configuration and Agent requests use saved changes immediately; clearing never revives a fallback key', async () => {
    const calls: { model: string; authorization: string | null }[] = [];
    const settings = await createLocalModelSettings(filename, { fetch: (async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      calls.push({ model: body.model, authorization: new Headers(init?.headers).get('authorization') });
      const name = body.tools[0].function.name;
      if (name === 'parse_shopping_intent') return answer(name, { query: '拿铁', items: [{ query: '拿铁', quantity: 1 }], quantity: 1,
        max_total_minor: 3000, purchase_shape: 'same_product', requested_fulfillment: 'pickup', explanation: '一杯拿铁。' });
      return name === 'search' ? answer(name, {}) : answer('quote', { entry_ids: ['mock_latte'], reason: '符合需求。' });
    }) as typeof fetch });
    const runtime = await createMockRuntime(join(directory, 'runtime'));
    const handler = createHandler(runtime, { modelSettings: settings, model: new ShoppingModelClient({ apiKey: 'old-fallback-key' }) });
    const input = { message: '买一杯拿铁', quantity: 1, max_total_minor: 3000 };
    expect((await (await handler(request('/api/config'))).json()).llm_status).toBe('not_configured');
    expect((await handler(request('/api/agent/run', input))).status).toBe(503);
    await handler(request('/api/model-settings', draft));
    expect((await (await handler(request('/api/config'))).json()).llm_model).toBe('model-a');
    await handler(request('/api/model-settings', { ...draft, api_key: '', model: 'model-b' }));
    const result = await handler(request('/api/agent/run', input));
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ model: 'model-b', outcome: 'quote_ready' });
    expect(calls).toHaveLength(3); expect(calls.every(call => call.model === 'model-b' && call.authorization === `Bearer ${SECRET}`)).toBe(true);
    await handler(request('/api/model-settings/clear', {}));
    expect((await (await handler(request('/api/config'))).json()).llm_model).toBeNull();
    expect((await handler(request('/api/agent/run', input))).status).toBe(503);
    await runtime.waitForIdle();
  });
});
