import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHandler } from '../../apps/shopping-agent-api/src/server';
import type { ShoppingCoordinator } from '../../packages/agent-runtime/src';

test('coffee background is served as SVG without accessing shopping state', async () => {
  const coordinator = new Proxy({} as ShoppingCoordinator, {
    get() { throw new Error('Static assets must not access shopping state'); },
  });
  const handler = createHandler(coordinator);
  const response = await handler(new Request('http://127.0.0.1:4400/coffee-bg.svg'));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await response.text()).toBe(await readFile(
    resolve(import.meta.dir, '../../apps/shopping-agent-web/public/coffee-bg.svg'), 'utf8',
  ));
});
