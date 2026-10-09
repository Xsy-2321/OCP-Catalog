import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeTestConfig } from '../../../packages/merchant-core/src/test-support';
import { startCoffeeMerchantServer } from './server';

test('stop drains an entered JSON handler before closing SQLite, is idempotent, and releases the same port', async () => {
  const scratch = resolve(import.meta.dir, '../../../.codex-tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'coffee-lifecycle-'));
  const databasePath = join(directory, 'merchant.sqlite');
  const config = { ...makeTestConfig({ databasePath }), port: 0 };
  const original = startCoffeeMerchantServer({ config });
  let restarted: ReturnType<typeof startCoffeeMerchantServer> | undefined;
  let client: Socket | undefined;
  try {
    const port = original.server.port!;
    const origin = `http://127.0.0.1:${port}`;
    config.publicBaseUrl = origin;
    const health = await fetch(`${origin}/ocp/health`);
    await health.arrayBuffer();
    const firstInstance = health.headers.get('x-coffee-instance-id');
    const body = JSON.stringify({ entry_id: 'entry_latte', quantity: 1, fulfillment: { method: 'pickup' } });
    const split = 12;
    // The socket carries real headers and a partial Content-Length body.
    // The actual quote handler must await the remainder in request.json().
    client = createConnection({ host: '127.0.0.1', port });
    // stop(true) may close the response socket after the handler writes its
    // quote. This test checks persisted facts, not guaranteed response delivery.
    client.on('error', () => {});
    await once(client, 'connect');
    client.resume();
    client.write(`POST /commerce/v1/quotes HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nx-dev-caller-id: lifecycle_user\r\nConnection: close\r\n\r\n${body.slice(0, split)}`);
    for (let i = 0; i < 100 && original.server.pendingRequests === 0; i++) await Bun.sleep(5);
    expect(original.server.pendingRequests).toBeGreaterThan(0);

    const stop = original.stop();
    expect(original.stop()).toBe(stop);
    let stopped = false;
    void stop.then(() => { stopped = true; });
    await Bun.sleep(20);
    expect(stopped).toBe(false);
    expect(original.ctx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM quotes').get()!.n).toBe(0);
    client.end(body.slice(split));
    await stop;
    expect(stopped).toBe(true);
    expect(original.stop()).toBe(stop);
    expect(() => original.ctx.db.query('SELECT 1').get()).toThrow();

    const db = new Database(databasePath, { readonly: true });
    try { expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM quotes').get()!.n).toBe(1); }
    finally { db.close(); }
    restarted = startCoffeeMerchantServer({ config: { ...config, port } });
    const nextHealth = await fetch(`${origin}/ocp/health`);
    expect(nextHealth.status).toBe(200);
    await nextHealth.arrayBuffer();
    expect(nextHealth.headers.get('x-coffee-instance-id')).not.toBe(firstInstance);
    const nextQuote = await fetch(`${origin}/commerce/v1/quotes`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-dev-caller-id': 'lifecycle_user',
    }, body });
    expect(nextQuote.status).toBe(200);
    await nextQuote.json();
    expect(restarted.ctx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM quotes').get()!.n).toBe(2);
  } finally {
    client?.destroy();
    await original.stop();
    await restarted?.stop();
    Bun.gc(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 5000);
