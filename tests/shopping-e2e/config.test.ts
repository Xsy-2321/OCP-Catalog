import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredRuntime } from '../../apps/shopping-agent-api/src/server';

let directory: string;
let env: Record<string, string>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ocp-http-config-'));
  const { privateKey } = generateKeyPairSync('ed25519');
  const keyPath = join(directory, 'private.pem');
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  env = {
    SHOPPING_MERCHANT_ORIGIN: 'http://127.0.0.1:4401',
    SHOPPING_MERCHANT_ID: 'merchant_coffee_demo', SHOPPING_CATALOG_ID: 'catalog_coffee_demo',
    SHOPPING_AUTH_ISSUER: 'local_issuer', SHOPPING_AUTH_KEY_ID: 'local_key',
    SHOPPING_AUTH_PRIVATE_KEY_PATH: keyPath,
  };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('configured primary runtime', () => {
  test.each([
    'SHOPPING_MERCHANT_ORIGIN', 'SHOPPING_MERCHANT_ID', 'SHOPPING_CATALOG_ID',
    'SHOPPING_AUTH_ISSUER', 'SHOPPING_AUTH_KEY_ID', 'SHOPPING_AUTH_PRIVATE_KEY_PATH',
  ])('missing %s fails instead of falling back to mock', async field => {
    delete env[field];
    await expect(createConfiguredRuntime(join(directory, 'sessions'), env)).rejects.toThrow(field);
  });
  test('defaults to HTTP with a backend key and persists only the runtime scope', async () => {
    const runtime = await createConfiguredRuntime(join(directory, 'agent'), env);
    expect(runtime.mode).toBe('http');
    expect(runtime.merchantId).toBe('merchant_coffee_demo');
    expect(JSON.parse(await readFile(join(directory, 'agent/sessions/runtime-scope.json'), 'utf8'))).toEqual({
      mode: 'http', origin: 'http://127.0.0.1:4401', merchant_id: 'merchant_coffee_demo', catalog_id: 'catalog_coffee_demo',
    });
  });
  test('mock is available only through an explicit mode and an unknown mode is rejected', async () => {
    expect((await createConfiguredRuntime(join(directory, 'mock'), { SHOPPING_MODE: 'mock' })).mode).toBe('mock');
    await expect(createConfiguredRuntime(join(directory, 'bad'), { SHOPPING_MODE: 'automatic' })).rejects.toThrow('SHOPPING_MODE');
  });
});
