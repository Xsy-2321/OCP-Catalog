/** Real local A/B/settings API with a protocol fixture; never reads a user's key. */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startShoppingDemo } from '../../scripts/shopping-demo';

const root = resolve(import.meta.dir, '../../.codex-tmp/model-settings-http-browser');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'run-'));
let modelCalls = 0;
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  modelCalls++;
  const body = await request.json() as { tool_choice?: { function?: { name?: string } }; messages: { role: string }[] };
  const forced = body.tool_choice?.function?.name;
  const name = forced ?? (body.messages.some(message => message.role === 'tool') ? 'quote' : 'search');
  const args = name === 'connection_check' ? { ok: true } : name === 'parse_shopping_intent'
    ? { query: '拿铁', items: [{ query: '拿铁', quantity: 1 }], quantity: 1, max_total_minor: 3000,
      purchase_shape: 'same_product', requested_fulfillment: 'pickup', explanation: '一杯拿铁。' }
    : name === 'quote' ? { entry_ids: ['entry_latte'], reason: '核对商家最终报价。' } : {};
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: `fixture_${modelCalls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
} });
let demo: Awaited<ReturnType<typeof startShoppingDemo>> | undefined;
try {
  demo = await startShoppingDemo({ dataDir: directory, shoppingPort: 0, merchantPort: 0,
    env: { DEEPSEEK_API_KEY: 'legacy-key-must-be-ignored' } });
  const child = Bun.spawn([process.env.SHOPPING_NODE_EXE || 'node', resolve(import.meta.dir, 'model-settings-http-browser-check.mjs')], {
    stdout: 'inherit', stderr: 'inherit', env: { ...process.env, SHOPPING_PREVIEW_URL: demo.shoppingOrigin,
      SHOPPING_MODEL_FIXTURE_URL: provider.url.origin, SHOPPING_MODEL_HTTP_BROWSER_OUTPUT: directory },
  });
  process.exitCode = await child.exited;
  console.log(`Local protocol fixture requests: ${modelCalls}; evidence: ${directory}`);
} finally { await demo?.stop(); await provider.stop(true); }
