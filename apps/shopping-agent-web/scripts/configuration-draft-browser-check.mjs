/** Isolated configuration navigation regression: fixed sessions, fake API keys, no live model or purchase. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserRuntime } from '../../../tests/shopping-e2e/browser-support.mjs';
import { parseConfigView, parseSessionView, parsePendingSessionsView } from '../public/contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const assets = resolve(root, 'apps/shopping-agent-web/public');
const output = resolve(process.env.SHOPPING_CONFIGURATION_DRAFT_OUTPUT || resolve(root, '.codex-tmp/configuration-draft-browser-check'));
const transferKey = 'ocp-shopping-configuration-draft';
const pointerKey = 'ocp-shopping-session-id';
const sessionId = 'session_11111111-1111-4111-8111-111111111111';
const at = new Date().toISOString();
const candidate = { entry_id: 'latte', catalog_id: 'coffee', merchant_id: 'coffee', title: '原拿铁', description: '固定本地样例', search_price_minor: 1800, currency: 'CNY', in_stock: true };
const original = parseSessionView({ id: sessionId, mode: 'mock', phase: 'candidates', intent: { query: '原服务端需求', quantity: 1, currency: 'CNY',
  max_total_minor: 5000, merchant_id: 'coffee', fulfillment: 'pickup' }, candidates: [candidate], revision: 1, created_at: at, updated_at: at });
const quote = { quote_id: 'quote_configuration_fixture', merchant_id: 'coffee', entry_id: 'latte', title: '原拿铁', quantity: 1, fulfillment: 'pickup',
  currency: 'CNY', unit_price_minor: 1800, fees: [], total_minor: 1800, terms_hash: 'c'.repeat(64), expires_at: new Date(Date.now() + 600_000).toISOString() };
const unpaid = parseSessionView({ ...original, phase: 'awaiting_confirmation', selected: candidate, quote, revision: 2 });
const unknown = parseSessionView({ ...unpaid, phase: 'unknown', attempt: { purchase_attempt_id: 'attempt_configuration_original', status: 'processing' },
  error: { code: 'result_unknown', message: '原购买仍待查询，不要重新购买。' }, revision: 3 });
const paid = parseSessionView({ ...unpaid, phase: 'confirmed', attempt: { purchase_attempt_id: 'attempt_configuration_paid', status: 'confirmed' },
  order: { order_id: 'ORDER-CONFIGURATION-PAID', purchase_attempt_id: 'attempt_configuration_paid', title: candidate.title, quantity: 1,
    currency: 'CNY', total_minor: 1800, payment_status: 'paid', fulfillment_status: 'ready', fulfillment: 'pickup', updated_at: at }, revision: 3 });
const checks = [], errors = [], requests = [];
let browser, scenario;
const assetMap = new Map([['/', 'index.html'], ['/demo', 'demo.html'], ...['styles.css', 'merchant.css', 'model-settings.css', 'app.js', 'model-settings.js',
  'view-model.js', 'contracts.js', 'api-client.js', 'dom.js', 'coffee-bg.svg'].map(file => [`/${file}`, file])]);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const record = { scenario: scenario.name, method: request.method, path }; requests.push(record);
  const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  try {
    if (request.method === 'GET' && path === '/api/model-settings') return json({ configured: scenario.configured, protocol: 'openai',
      base_url: scenario.configured ? 'https://fixture.example/v1' : '', model: scenario.configured ? 'fixture-model' : '', timeout_ms: 30000,
      has_api_key: scenario.configured, source: scenario.configured ? 'local' : 'none' });
    if (request.method === 'GET' && path === '/api/config') return json(parseConfigView({ mode: 'mock', merchant_id: 'coffee', merchant_demo_available: true,
      payment_mode: 'local_simulated', c0_status: 'integrated', contract_version: '1', llm_status: scenario.configured ? 'configured' : 'not_configured',
      llm_model: scenario.configured ? 'fixture-model' : null, merchant_health: { status: 'mock', message: 'Fixed local fixture', checked_at: at } }));
    if (request.method === 'GET' && path === '/api/sessions/pending') return json(parsePendingSessionsView({ sessions: scenario.pending ? [scenario.pending] : [] }));
    if (request.method === 'GET' && path === `/api/sessions/${sessionId}`) return scenario.readFailure
      ? json({ error: { code: 'unavailable', message: '原会话读取暂时失败。' } }, 503) : scenario.saved ? json(scenario.saved) : json({ error: { message: 'not_found' } }, 404);
    if (request.method === 'POST' && path === `/api/sessions/${sessionId}/recover`) {
      request.resume(); let recovered = scenario.recoverToPaid ? paid : scenario.pending || scenario.saved;
      // Actual paid recovery writes a fresh projection, increasing revision even though purchase identity is unchanged.
      if (recovered?.order?.payment_status === 'paid') {
        recovered = parseSessionView({ ...recovered, revision: recovered.revision + 1 });
        scenario.saved = recovered;
        if (scenario.recoverToPaid) scenario.pending = null;
      }
      record.attemptId = recovered.attempt?.purchase_attempt_id; return json(recovered);
    }
    if (request.method === 'POST' && path === '/api/model-settings') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.ok(body.api_key || scenario.configured, 'Only a fake explicit key or retained fixture key is allowed');
      scenario.configured = true;
      return json({ configured: true, protocol: body.protocol, base_url: body.base_url, model: body.model, timeout_ms: body.timeout_ms, has_api_key: true, source: 'local' });
    }
    const file = request.method === 'GET' && assetMap.get(path);
    if (!file) { request.resume(); return json({ error: { message: 'Only fixed read/recovery/configuration fixture routes are permitted' } }, 405); }
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html', 'cache-control': 'no-store' });
    response.end(await readFile(resolve(assets, file)));
  } catch { json({ error: { message: 'Fixed fixture failed' } }, 500); }
});
const check = (name, value) => { checks.push({ scenario: scenario.name, name, passed: Boolean(value) }); assert.ok(value, name); };
await mkdir(output, { recursive: true });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { checks, errors, requests };
const ready = page => page.waitForFunction(() => !document.getElementById('connection-check').disabled && !document.getElementById('pending-check').disabled
  && document.getElementById('flow-viewport').style.height && !document.querySelector('.is-leaving'));
const snapshot = page => page.evaluate(() => ({ query: document.getElementById('query').value, message: document.getElementById('agent-message').value,
  mode: document.querySelector('[name="flow-mode"]:checked').value, budget: document.getElementById('budget').value, quantity: document.getElementById('quantity').value,
  mixed: document.getElementById('mixed-basket').checked, items: [...document.querySelectorAll('.basket-input-row')].map(row => ({ query: row.querySelector('.basket-query').value,
    quantity: row.querySelector('.basket-quantity').value })), fulfillment: document.getElementById('fulfillment').value,
  delivery: ['recipient', 'phone', 'address'].map(name => document.getElementById(`delivery-${name}`).value),
  step: document.querySelector('.flow-panel.is-active').getAttribute('data-flow-panel') }));
async function openCase(name, options = {}) {
  scenario = { name, configured: false, saved: null, pending: null, readFailure: false, ...options };
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    if (route.request().url().startsWith(`${origin}/`)) return route.continue();
    errors.push('external request'); return route.abort();
  });
  await page.goto(`${origin}/demo`);
  if (options.saved || options.readFailure) await page.evaluate(key => localStorage.setItem(key, 'session_11111111-1111-4111-8111-111111111111'), pointerKey);
  await page.goto(options.portalStart ? `${origin}/?start=1` : origin); await ready(page);
  if (await page.locator('#flow-back').isEnabled()) { await page.locator('[data-step="0"]').click(); await ready(page); }
  return { context, page };
}
async function editDraft(page) {
  await page.locator('#query').fill('未提交的咖啡关键词');
  await page.locator('#budget').fill('88.88');
  await page.locator('#quantity').fill('3');
  await page.locator('#mixed-basket').check();
  const rows = page.locator('.basket-input-row');
  await rows.nth(0).locator('.basket-query').fill('低糖拿铁'); await rows.nth(0).locator('.basket-quantity').fill('2');
  await rows.nth(1).locator('.basket-query').fill('美式'); await rows.nth(1).locator('.basket-quantity').fill('1');
  await page.locator('#fulfillment').selectOption('delivery');
  await page.locator('#delivery-recipient').fill('仅本次收件人');
  await page.locator('#delivery-phone').fill('13800000000');
  await page.locator('#delivery-address').fill('仅本次浏览器会话一号楼');
  await page.locator('[name="flow-mode"][value="agent"]').check();
  await page.locator('#agent-message').fill('请保留我未提交的两种咖啡偏好');
}
async function configureAndReturn(page, viaEntry = false) {
  await page.locator('#shopping-api-configuration').click();
  await page.waitForFunction(() => !document.getElementById('api-configuration').hidden && !document.getElementById('model-settings-fields').disabled);
  check('Configuration detour offers a return action and avoids start=1', await page.locator('#model-return-shopping').isVisible()
    && await page.locator('#user-demo-entry').getAttribute('href') === '/');
  await page.locator('#model-api-key').fill('detour-fixture-key-only');
  await page.locator('#model-save').click();
  await page.waitForFunction(() => !document.getElementById('demo-entry-view').hidden && document.getElementById('api-configuration').hidden);
  check('Saving preserves the two-view entry behavior and keeps keys out of the draft', await page.locator('#user-demo-entry').isVisible()
    && await page.evaluate(key => !sessionStorage.getItem(key).includes('detour-fixture-key-only'), transferKey));
  await page.locator(viaEntry ? '#user-demo-entry' : '#model-return-shopping').click(); await ready(page);
}
let deadline;
async function run() {
  const { chromium, launchOptions } = browserRuntime(); browser = await chromium.launch(launchOptions);
  for (const [name, options, viaEntry] of [['fresh-agent', {}, true], ['saved-candidates', { saved: original }, false],
    ['unpaid-quote', { saved: unpaid }, true], ['paid-order-recovered-revision', { saved: paid }, false],
    ['portal-new-request-after-paid', { saved: paid, portalStart: true }, true]]) {
    const { context, page } = await openCase(name, options);
    await editDraft(page); const before = await snapshot(page);
    await configureAndReturn(page, viaEntry);
    check('All unsent fields survive API navigation and return', JSON.stringify(await snapshot(page)) === JSON.stringify(before));
    check('Returning consumes the transient draft and keeps private delivery out of local storage', await page.evaluate(key => sessionStorage.getItem(key) === null
      && !JSON.stringify({ ...localStorage }).includes('仅本次'), transferKey));
    check('Return URL does not trigger portal fresh-session behavior', new URL(page.url()).pathname === '/' && !new URL(page.url()).searchParams.has('start'));
    if (options.saved) check('Restored original server identity and intent remain unchanged', await page.evaluate(key => localStorage.getItem(key), pointerKey) === sessionId
      && (await (await fetch(`${origin}/api/sessions/${sessionId}`)).json()).intent.query === original.intent.query);
    if (name === 'unpaid-quote') check('Unsaved request changes cannot confirm the old unpaid quote', await page.locator('#confirm-button').isDisabled());
    if (options.saved?.order?.payment_status === 'paid') {
      check('Paid recovery really advances the projection revision', scenario.saved.revision > paid.revision + 1);
      check('Completed purchase keeps the same order and attempt without another checkout', scenario.saved.order.order_id === paid.order.order_id
        && scenario.saved.attempt.purchase_attempt_id === paid.attempt.purchase_attempt_id
        && (await page.locator('#order-content').textContent()).includes(paid.order.order_id));
    }
    await context.close();
  }
  {
    const { context, page } = await openCase('new-pending-purchase'); await editDraft(page);
    await page.locator('#shopping-api-configuration').click();
    await page.waitForFunction(() => !document.getElementById('model-settings-fields').disabled);
    scenario.pending = unknown; scenario.saved = unknown;
    await page.locator('#model-return-shopping').click(); await ready(page);
    const returned = await snapshot(page);
    check('Newly discovered unknown purchase overrides local draft with server facts', returned.query === unknown.intent.query && returned.budget === '50.00'
      && returned.quantity === '1' && returned.fulfillment === 'pickup' && returned.step === '3'
      && returned.mode === 'manual' && returned.message === '');
    check('Unknown purchase retains its search/edit/confirmation locks', await page.locator('#query').isDisabled()
      && await page.locator('#search-button').isDisabled() && await page.locator('#confirm-button').isDisabled());
    const recoveries = requests.filter(request => request.scenario === scenario.name && request.path.endsWith('/recover'));
    check('Pending purchase recovery keeps the original attempt', (await page.locator('#notice').textContent()).includes('原购买仍待查询')
      && recoveries.length === 1 && recoveries[0].attemptId === unknown.attempt.purchase_attempt_id);
    check('A blocked return still discards private transient data', await page.evaluate(key => sessionStorage.getItem(key) === null, transferKey));
    await context.close();
  }
  {
    const { context, page } = await openCase('new-pending-recovers-paid', { saved: paid }); await editDraft(page);
    await page.locator('#shopping-api-configuration').click();
    await page.waitForFunction(() => !document.getElementById('model-settings-fields').disabled);
    scenario.pending = parseSessionView({ ...paid, phase: 'unknown', attempt: { ...paid.attempt, status: 'processing' },
      error: { code: 'result_unknown', message: '原已支付购买状态暂待查询。' } });
    scenario.saved = scenario.pending; scenario.recoverToPaid = true;
    await page.locator('#model-return-shopping').click(); await ready(page);
    const returned = await snapshot(page);
    check('Startup pending discovery overrides the new draft even if recovery resolves the same purchase as paid', returned.query === original.intent.query
      && returned.budget === '50.00' && returned.quantity === '1' && returned.fulfillment === 'pickup' && returned.step === '3'
      && returned.mode === 'manual' && returned.message === '' && returned.delivery.every(value => value === ''));
    check('Resolved original purchase remains displayed with its existing order identity', (await page.locator('#order-content').textContent()).includes(paid.order.order_id));
    await context.close();
  }
  {
    const { context, page } = await openCase('original-read-error', { readFailure: true }); await editDraft(page);
    await configureAndReturn(page);
    const returned = await snapshot(page);
    check('Non-404 original-session recovery failure does not apply the transferred intent or delivery', returned.query === '拿铁' && returned.budget === '30.00'
      && returned.quantity === '1' && returned.fulfillment === 'pickup' && returned.delivery.every(value => value === '')
      && returned.mode === 'manual' && returned.message === '');
    check('Original-session recovery error remains visible', (await page.locator('#notice').textContent()).includes('原会话读取暂时失败'));
    await context.close();
  }
  {
    const { context, page } = await openCase('disabled-session-storage'); await editDraft(page); const before = await snapshot(page);
    await page.evaluate(() => { const originalSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
      if (this === sessionStorage) throw new Error('Session storage disabled in this isolated fixture'); originalSet.call(this, key, value);
    }; });
    const popupPromise = page.waitForEvent('popup'); await page.locator('#shopping-api-configuration').click(); const popup = await popupPromise;
    await popup.waitForLoadState();
    check('Unavailable storage opens configuration separately and preserves live form', new URL(page.url()).pathname === '/'
      && JSON.stringify(await snapshot(page)) === JSON.stringify(before));
    check('Separate configuration has no opener or copied private draft', await popup.evaluate(key => window.opener === null && sessionStorage.getItem(key) === null, transferKey));
    await context.close();
  }
  check('No model or purchase requests are issued', requests.filter(request => request.method === 'POST')
    .every(request => request.path === '/api/model-settings' || request.path.endsWith('/recover')));
  check('No JavaScript errors or external requests', errors.length === 0);
  report.status = 'passed';
}
try {
  await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Configuration draft browser check exceeded 90 seconds')), 90000); })]);
} catch (error) { report.status = 'failed'; report.failure = String(error); process.exitCode = 1; }
finally {
  clearTimeout(deadline); await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Configuration draft browser check: ${report.status}; ${checks.length} checks; ${output}`);
}
