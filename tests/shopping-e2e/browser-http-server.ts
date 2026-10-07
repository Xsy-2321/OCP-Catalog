/** Isolated local HTTP browser acceptance. Keys exist only in this process's memory. */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startCoffeeMerchantServer } from '../../apps/coffee-merchant-api/src/server';
import { createHandler } from '../../apps/shopping-agent-api/src/server';
import { createHttpRuntime } from '../../packages/agent-runtime/src';
import { loadConfig } from '../../packages/merchant-core/src';

const directory = resolve(process.env.SHOPPING_BROWSER_DATA_DIR ?? '.codex-tmp/integration/browser-data');
await mkdir(directory, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const config = { ...loadConfig({ env: { MERCHANT_DB_PATH: `${directory}/merchant.sqlite` } }), port: 0,
  trustedKeys: new Map([['browser_local', publicKey]]), trustedIssuers: new Map([['browser_local', 'browser_acceptance']]) };
const merchant = startCoffeeMerchantServer({ config });
config.publicBaseUrl = `http://127.0.0.1:${merchant.server.port}`;
const coordinator = await createHttpRuntime(`${directory}/agent`, { origin: config.publicBaseUrl,
  merchantId: config.merchantId, catalogId: config.catalogId, issuer: 'browser_acceptance', keyId: 'browser_local', privateKey });
const api = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createHandler(coordinator) });
console.log(JSON.stringify({ api: `http://127.0.0.1:${api.port}`, merchant: config.publicBaseUrl,
  database: `${directory}/merchant.sqlite`, payment: 'local_simulated' }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await api.stop(true); await merchant.stop(); process.exit(0);
}
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
