import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockRuntime, type PublicSession } from '../../packages/agent-runtime/src';
import { acquireDataLock, createHandler } from '../../apps/shopping-agent-api/src/server';

let directory: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let cookie: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ocp-shopping-http-'));
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createHandler(await createMockRuntime(directory)) });
  base = `http://127.0.0.1:${server.port}`;
  const config = await fetch(`${base}/api/config`);
  cookie = config.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(async () => { await server.stop(true); await rm(directory, { recursive: true, force: true }); });
async function call(path: string, body?: unknown, ownCookie = cookie) {
  return fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    cookie: ownCookie, origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function ready(entry = 'mock_latte'): Promise<PublicSession> {
  const created: PublicSession = await (await call('/api/sessions', { query: '拿铁', quantity: 1, currency: 'CNY',
    max_total_minor: 3000, merchant_id: 'coffee-demo', fulfillment: 'pickup' })).json();
  await call(`/api/sessions/${created.id}/search`, {});
  return (await call(`/api/sessions/${created.id}/quote`, { entry_id: entry })).json();
}
function confirmation(session: PublicSession) { return { quote_id: session.quote!.quote_id, terms_hash: session.quote!.terms_hash, revision: session.revision }; }

describe('A-only local HTTP E2E (not B integration)', () => {
  test('serves Chinese UI and explicitly reports mock payment, shared contract and missing LLM', async () => {
    const config = await (await call('/api/config')).json();
    expect(config).toEqual({ mode: 'mock', merchant_id: 'coffee-demo', payment_mode: 'local_simulated',
      c0_status: 'integrated', contract_version: '0.1.0', llm_status: 'not_configured' });
    const response = await call('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('本地模拟付款');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await call('/app.js')).status).toBe(200);
    expect((await call('/styles.css')).status).toBe(200);
  });
  test('no checkout before UI confirmation; confirmed order has inclusive price and separate fulfillment', async () => {
    const quoted = await ready();
    expect(quoted.phase).toBe('awaiting_confirmation'); expect(quoted.attempt).toBeUndefined();
    expect(quoted.quote!.total_minor).toBe(2800);
    const results = await Promise.all(Array.from({ length: 5 }, async () => (await call(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).json() as Promise<PublicSession>));
    expect(new Set(results.map(result => result.order!.order_id)).size).toBe(1);
    expect(results[0]!.order!.payment_status).toBe('paid'); expect(results[0]!.order!.fulfillment_status).toBe('preparing');
    const recovered = await (await call(`/api/sessions/${quoted.id}/recover`, {})).json();
    expect(recovered.order.order_id).toBe(results[0]!.order!.order_id);
    expect(JSON.stringify(recovered)).not.toContain('authorization_proof');
    expect(JSON.stringify(recovered)).not.toContain('idempotency_key');
  });
  test('final fees over budget reject HTTP confirmation', async () => {
    const quoted = await ready('mock_special_latte');
    expect(quoted.error!.code).toBe('budget_exceeded'); expect(quoted.quote!.total_minor).toBe(3100);
    expect((await call(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).status).toBe(409);
  });
  test('foreign cookie cannot read, confirm or recover a quote/session', async () => {
    const quoted = await ready();
    for (const [path, body] of [[`/api/sessions/${quoted.id}`, undefined],
      [`/api/sessions/${quoted.id}/confirm`, confirmation(quoted)], [`/api/sessions/${quoted.id}/recover`, {}]] as const) {
      expect((await call(path, body, 'ocp_shopping_session=' + 'b'.repeat(64))).status).toBe(404);
    }
  });
  test('blocks CSRF, invalid JSON, wrong content type and untrusted Host', async () => {
    const quoted = await ready();
    const path = `${base}/api/sessions/${quoted.id}/confirm`;
    const body = JSON.stringify(confirmation(quoted));
    expect((await fetch(path, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body })).status).toBe(403);
    expect((await fetch(path, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body })).status).toBe(403);
    expect((await fetch(path, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body })).status).toBe(415);
    expect((await fetch(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{bad' })).status).toBe(400);
    expect((await fetch(`${base}/api/config`, { headers: { host: 'evil.example' } })).status).toBe(403);
  });
  test('lost success response survives API/runtime restart with same cookie and attempt', async () => {
    await server.stop(true);
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createHandler(await createMockRuntime(directory, { fault: 'response_lost' })) });
    base = `http://127.0.0.1:${server.port}`;
    const quoted = await ready();
    const unknown: PublicSession = await (await call(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).json();
    expect(unknown.phase).toBe('unknown');
    await server.stop(true);
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createHandler(await createMockRuntime(directory)) });
    base = `http://127.0.0.1:${server.port}`;
    const recovered: PublicSession = await (await call(`/api/sessions/${quoted.id}/recover`, {})).json();
    expect(recovered.phase).toBe('confirmed');
    expect(recovered.attempt!.purchase_attempt_id).toBe(unknown.attempt!.purchase_attempt_id);
    const duplicate: PublicSession = await (await call(`/api/sessions/${quoted.id}/confirm`, confirmation(quoted))).json();
    expect(duplicate.order!.order_id).toBe(recovered.order!.order_id);
  });
  test('one data directory cannot be used by two API processes', async () => {
    const release = await acquireDataLock(directory);
    await expect(acquireDataLock(directory)).rejects.toThrow('数据目录已锁定');
    await release();
    const again = await acquireDataLock(directory); await again();
  });
});
