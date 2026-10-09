/** Test-only isolated bootstrap. No test controls exist in the application API. */
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../.codex-tmp/merchant-preview-acceptance');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
async function startRuntime(shoppingPort: number, merchantPort: number) {
  const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, 'merchant-browser-runtime.ts'),
    directory, String(shoppingPort), String(merchantPort)], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  let output = '';
  while (!output.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Isolated runtime failed: ${await stderr}`);
    output += decoder.decode(chunk.value, { stream: true });
  }
  const info = JSON.parse(output.split('\n')[0]!) as {
    shoppingOrigin: string; merchantOrigin: string; demoPortalUrl: string; userDemoUrl: string; merchantDemoUrl: string;
  };
  // Drain the remaining output while the subprocess runs.
  const drained = (async () => { while (!(await reader.read()).done) { /* no credentials printed by this fixture */ } })();
  let stopping: Promise<void> | undefined;
  return { ...info, stop(): Promise<void> {
    stopping ??= (async () => {
      child.stdin.write('stop\n'); await child.stdin.flush(); child.stdin.end();
      const exit = await child.exited; await drained;
      if (exit !== 0) throw new Error(`Isolated runtime did not stop cleanly: ${await stderr}`);
    })();
    return stopping;
  } };
}
let demo = await startRuntime(0, 0);
const ports = { shoppingPort: Number(new URL(demo.shoppingOrigin).port), merchantPort: Number(new URL(demo.merchantOrigin).port) };
function snapshot() {
  const db = new Database(resolve(directory, 'merchant.sqlite'), { readonly: true });
  try { return {
    orders: db.query<{ n: number }, []>('SELECT COUNT(*) n FROM orders').get()!.n,
    payments: db.query<{ n: number }, []>('SELECT COUNT(*) n FROM payments').get()!.n,
    attempts: db.query<{ n: number }, []>('SELECT COUNT(*) n FROM attempts').get()!.n,
    stock: db.query('SELECT entry_id,available_quantity FROM inventory ORDER BY entry_id').all(),
    reservations: db.query('SELECT entry_id,quantity,state FROM inventory_reservations ORDER BY entry_id').all(),
  }; } finally { db.close(); }
}
const control = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/snapshot') return Response.json(snapshot());
  if (request.method === 'POST' && url.pathname === '/restart') {
    await demo.stop();
    demo = await startRuntime(ports.shoppingPort, ports.merchantPort);
    return Response.json({ user: demo.userDemoUrl, merchant: demo.merchantDemoUrl, snapshot: snapshot() });
  }
  return new Response('test control not found', { status: 404 });
} });
await writeFile(resolve(directory, 'run-info.json'), JSON.stringify({ directory, ...ports,
  portal: demo.demoPortalUrl, user: demo.userDemoUrl, merchant: demo.merchantDemoUrl,
  restart_mode: 'new_process',
  model: 'disabled', payment: 'local_simulated' }, null, 2));
console.log(JSON.stringify({ directory, user: demo.userDemoUrl, merchant: demo.merchantDemoUrl }));
try {
  const browserEnv: Record<string, string | undefined> = { ...process.env, SHOPPING_PREVIEW_URL: demo.shoppingOrigin, SHOPPING_BROWSER_OUTPUT: directory,
    SHOPPING_TEST_CONTROL: `http://127.0.0.1:${control.port}` };
  delete browserEnv.DEEPSEEK_API_KEY; delete browserEnv.SHOPPING_LLM_API_KEY;
  const child = Bun.spawn([process.env.SHOPPING_NODE_EXE || 'node', resolve(import.meta.dir, 'browser-merchant-check.mjs')], {
    env: browserEnv, stdout: 'inherit', stderr: 'inherit',
  });
  process.exitCode = await child.exited;
} finally {
  await control.stop(true); await demo.stop();
  console.log(JSON.stringify({ stopped: true, directory, snapshot: snapshot() }));
}
