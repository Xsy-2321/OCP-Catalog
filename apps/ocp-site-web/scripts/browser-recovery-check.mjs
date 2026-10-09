import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.versions.bun !== '1.3.13') throw new Error('Site browser checks require Bun 1.3.13');
const dist = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
if (!existsSync(resolve(dist, 'index.html'))) throw new Error('Build the site before running browser recovery checks');
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const path = resolve(dist, `.${decodeURIComponent(new URL(request.url).pathname)}`);
    if (path !== dist && !path.startsWith(`${dist}${sep}`)) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(existsSync(path) && path !== dist ? path : resolve(dist, 'index.html')));
  },
});
console.log(JSON.stringify({ stage: 'server-ready', origin: server.url.origin }));
let child;
let timer;
let timedOut = false;
try {
  child = Bun.spawn([process.env.SITE_NODE_EXE || process.env.SHOPPING_NODE_EXE || 'node',
    fileURLToPath(new URL('./browser-recovery-driver.mjs', import.meta.url))], {
    stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, SITE_PREVIEW_URL: server.url.origin,
      SITE_BROWSER_OUTPUT: process.env.SITE_BROWSER_OUTPUT || resolve(dist, '../../../.codex-tmp/site-browser-recovery') },
  });
  timer = setTimeout(() => {
    timedOut = true;
    console.error('Site browser recovery child exceeded 60 seconds; stopping this test process');
    child.kill();
  }, 60_000);
  const exit = await child.exited;
  process.exitCode = timedOut ? 124 : exit;
} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null) child.kill();
  server.stop(true);
  console.log(JSON.stringify({ stage: 'server-stopped' }));
}
