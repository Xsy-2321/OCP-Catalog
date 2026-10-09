import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserRuntime } from '../../../tests/shopping-e2e/browser-support.mjs';
import { parseConfigView, parseAgentRunView, parsePendingSessionsView, parseSessionView } from '../public/contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const assets = resolve(root, 'apps/shopping-agent-web/public');
const output = resolve(process.env.SHOPPING_EXPIRY_OUTPUT_DIR || resolve(root, '.codex-tmp/shopping-expiry-check'));
const requests = [], pageErrors = [], checks = [];
let currentSession, purchaseRequests = 0, browser;
const timestamp = new Date().toISOString();
const config = parseConfigView({ mode: 'mock', merchant_id: 'coffee', payment_mode: 'local_simulated',
  c0_status: 'integrated', contract_version: '1', llm_status: 'configured', llm_model: 'local-fixture',
  merchant_health: { status: 'mock', message: 'local fixture only', checked_at: timestamp } });
const pending = parsePendingSessionsView({ sessions: [] });
function agentFixture() {
  const now = Date.now(), at = new Date(now).toISOString();
  const candidate = { entry_id: 'latte', catalog_id: 'coffee', merchant_id: 'coffee', title: 'Latte',
    description: 'Local expiry fixture', search_price_minor: 2600, currency: 'CNY', in_stock: true };
  const session = parseSessionView({ id: 'session_00000000-0000-4000-8000-000000000001', mode: 'mock', phase: 'awaiting_confirmation',
    intent: { query: 'latte', quantity: 1, currency: 'CNY', max_total_minor: 3000, merchant_id: 'coffee', fulfillment: 'pickup' },
    candidates: [candidate], selected: candidate,
    quote: { quote_id: 'quote_fixture', merchant_id: 'coffee', entry_id: 'latte', title: 'Latte', quantity: 1,
      fulfillment: 'pickup', currency: 'CNY', unit_price_minor: 2600, fees: [], total_minor: 2600,
      terms_hash: 'a'.repeat(64), expires_at: new Date(now + 5000).toISOString() },
    revision: 1, created_at: at, updated_at: at });
  const result = parseAgentRunView({ session, planner_mode: 'llm', tool_calls: 1, explanation: 'Local fixed quote.',
    model: 'local-fixture', outcome: 'quote_ready', next_actions: ['confirm_quote', 'choose_candidate', 'edit_request'], warnings: [] });
  currentSession = result.session;
  return result;
}
const assetMap = new Map([['/', 'index.html'], ...['styles.css', 'app.js', 'contracts.js', 'view-model.js', 'dom.js', 'api-client.js'].map(name => [`/${name}`, name])]);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  requests.push({ method: request.method, path });
  const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  try {
    if (request.method === 'GET' && path === '/api/config') return json(config);
    if (request.method === 'GET' && path === '/api/sessions/pending') return json(pending);
    if (request.method === 'POST' && path === '/api/agent/run') { request.resume(); return json(agentFixture()); }
    if (request.method === 'GET' && currentSession && path === `/api/sessions/${currentSession.id}`) return json(parseSessionView(currentSession));
    if (request.method !== 'GET') { purchaseRequests++; request.resume(); return json({ error: { message: 'No purchase mutation permitted in fixture' } }, 405); }
    const file = assetMap.get(path);
    if (!file) return json({ error: 'not_found' }, 404);
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' });
    response.end(await readFile(resolve(assets, file)));
  } catch (error) { json({ error: String(error) }, 500); }
});
await mkdir(output, { recursive: true });
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { origin, startedAt: timestamp, fixtureValidated: true, naturalClock: true, checks };
function check(name, condition) {
  checks.push({ name, passed: Boolean(condition) });
  assert.ok(condition, name);
}
async function run() {
  const { chromium, launchOptions } = browserRuntime();
  browser = await chromium.launch({ ...launchOptions, timeout: 15_000 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(15_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await page.goto(origin);
  await page.waitForFunction(() => !document.getElementById('pending-check').disabled);
  await page.locator('[name="flow-mode"][value="agent"]').check();
  await page.locator('#agent-message').fill('请推荐一杯拿铁');
  await page.locator('#search-button').click();
  await page.waitForFunction(() => !document.getElementById('confirm-button').disabled);
  await page.locator('#candidates button').first().evaluate(button => { button.dataset.expiryProbe = 'preserved'; });
  const snapshot = () => page.evaluate(() => ({
    confirmDisabled: document.getElementById('confirm-button').disabled,
    expiry: document.getElementById('expiry').textContent,
    nextActions: [...document.querySelectorAll('#safety-steps li')].map(node => node.textContent).filter(text => text.startsWith('接下来可以：')),
    candidatePreserved: document.querySelector('#candidates button').dataset.expiryProbe === 'preserved',
    agentMessage: document.getElementById('agent-message').value,
  }));
  report.before = await snapshot();
  check('fresh quote enables explicit confirmation', report.before.confirmDisabled === false && /^报价剩余 [1-5] 秒$/.test(report.before.expiry));
  check('fresh quote suggests confirmation', report.before.nextActions.some(text => text.includes('在报价区确认并模拟购买')));
  await page.screenshot({ path: resolve(output, 'expiry-before.png'), fullPage: true });
  // Allow the real page interval and the real quote deadline to advance, without any API or input event.
  await page.waitForFunction(() => document.getElementById('expiry').textContent === '报价已过期，请重新报价');
  report.after = await snapshot();
  check('natural expiry disables confirmation', report.after.confirmDisabled === true);
  check('natural expiry removes stale confirmation suggestion', !report.after.nextActions.some(text => text.includes('在报价区确认并模拟购买')));
  check('natural expiry retains requote and edit suggestions', report.after.nextActions.some(text => text.includes('在候选区查看最终报价') && text.includes('修改需求后重新提交')));
  check('clock refresh preserves candidates and restored form', report.after.candidatePreserved && report.after.agentMessage === '请推荐一杯拿铁');
  // An artificial click on the disabled control must still pass the fresh business-action guard.
  await page.locator('#confirm-button').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.screenshot({ path: resolve(output, 'expiry-after.png'), fullPage: true });
  check('expiry and synthetic click execute no purchase', purchaseRequests === 0);
  check('no page errors', pageErrors.length === 0);
}
let deadline;
try {
  await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Expiry browser check exceeded 60 seconds')), 60_000); })]);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = String(error); process.exitCode = 1; }
finally {
  clearTimeout(deadline);
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  Object.assign(report, { purchaseRequests, pageErrors, requests, finishedAt: new Date().toISOString() });
  await writeFile(resolve(output, 'expiry-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
