/** Isolated local HTTP browser acceptance. Keys exist only in this process's memory. */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startCoffeeMerchantServer } from '../../apps/coffee-merchant-api/src/server';
import { createHandler } from '../../apps/shopping-agent-api/src/server';
import { createHttpRuntime, ShoppingModelClient } from '../../packages/agent-runtime/src';
import { loadConfig } from '../../packages/merchant-core/src';

const explicitDirectory = process.env.SHOPPING_BROWSER_DATA_DIR;
const integrationDirectory = resolve('.codex-tmp/integration');
if (explicitDirectory === undefined) await mkdir(integrationDirectory, { recursive: true });
// Each ephemeral-port run has a distinct merchant scope; keep its evidence without reusing that scope.
const directory = explicitDirectory === undefined
  ? await mkdtemp(resolve(integrationDirectory, 'browser-data-'))
  : resolve(explicitDirectory);
const resilience = process.argv.includes('--resilience-check');
const basketCheck = process.argv.includes('--basket-check');
await mkdir(directory, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const config = { ...loadConfig({ env: { MERCHANT_DB_PATH: `${directory}/merchant.sqlite`, MERCHANT_TEST_MODE: resilience ? '1' : '0' } }), port: 0,
  trustedKeys: new Map([['browser_local', publicKey]]), trustedIssuers: new Map([['browser_local', 'browser_acceptance']]) };
const merchant = startCoffeeMerchantServer({ config });
config.publicBaseUrl = `http://127.0.0.1:${merchant.server.port}`;
const coordinator = await createHttpRuntime(`${directory}/agent`, { origin: config.publicBaseUrl,
  merchantId: config.merchantId, catalogId: config.catalogId, issuer: 'browser_acceptance', keyId: 'browser_local', privateKey });
const handler = createHandler(coordinator);
const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  // These controls exist only in this isolated acceptance bootstrap, never the application API.
  if (resilience && request.method === 'POST' && new URL(request.url).pathname === '/__browser-test__/control') {
    const body = await request.json() as { fault?: 'none' | 'payment_timeout_then_succeed'; stop_merchant?: boolean };
    if (body.stop_merchant) await merchant.stop();
    if (body.fault) {
      (config.faults as Set<string>).clear();
      if (body.fault === 'payment_timeout_then_succeed') (config.faults as Set<string>).add(body.fault);
    }
    return Response.json({ ok: true });
  }
  return handler(request);
} });
// A local protocol fixture exercises the real model adapter and tool loop without an external key.
const modelFixture = resilience ? Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const body = await request.json() as { tool_choice?: { function?: { name?: string } }; messages: { role: string; content: string | null }[] };
  let name: string, args: Record<string, unknown>;
  if (body.tool_choice?.function?.name === 'parse_shopping_intent') {
    const input = JSON.parse(body.messages.find(message => message.role === 'user')!.content!) as {
      hard_constraints: { quantity: number; max_total_minor: number; fulfillment?: string } };
    name = 'parse_shopping_intent'; args = { query: '咖啡', quantity: input.hard_constraints.quantity,
      max_total_minor: input.hard_constraints.max_total_minor, purchase_shape: 'same_product',
      items: [{ query: '咖啡', quantity: input.hard_constraints.quantity }],
      requested_fulfillment: input.hard_constraints.fulfillment || 'pickup', explanation: '按照表单预算比较咖啡。' };
  } else {
    const result = [...body.messages].reverse().find(message => message.role === 'tool');
    if (!result) { name = 'search'; args = {}; }
    else {
      const { state } = JSON.parse(result.content!) as { state: { candidates: { entry_id: string; price_minor: number; title: string }[] } };
      const candidate = [...state.candidates].sort((left, right) => left.price_minor - right.price_minor)[0]!;
      name = 'quote'; args = { entry_id: candidate.entry_id, reason: `目录候选中「${candidate.title}」价格最低；请核对商家最终含费报价。` };
    }
  }
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: `fixture_${crypto.randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
} }) : undefined;
const modelApi = modelFixture ? Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createHandler(coordinator, {
  model: new ShoppingModelClient({ apiKey: 'browser-fixture-not-a-real-key', model: 'browser-fixture-model',
    baseUrl: `http://127.0.0.1:${modelFixture.port}` }),
}) }) : undefined;
console.log(JSON.stringify({ api: `http://127.0.0.1:${api.port}`, merchant: config.publicBaseUrl,
  database: `${directory}/merchant.sqlite`, payment: 'local_simulated' }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await api.stop(true); await modelApi?.stop(true); await modelFixture?.stop(true); await merchant.stop();
}
process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
if (process.argv.includes('--check') || resilience || basketCheck) {
  const child = Bun.spawn([process.env.SHOPPING_NODE_EXE || 'node', resolve(import.meta.dir,
    basketCheck ? 'browser-basket-check.mjs' : resilience ? 'browser-resilience-check.mjs' : 'browser-http-check.mjs')], {
    stdout: 'inherit', stderr: 'inherit', env: { ...process.env, SHOPPING_PREVIEW_URL: `http://127.0.0.1:${api.port}`,
      ...(modelApi ? { SHOPPING_AGENT_PREVIEW_URL: `http://127.0.0.1:${modelApi.port}` } : {}) },
  });
  const code = await child.exited;
  await close(); process.exit(code);
}
