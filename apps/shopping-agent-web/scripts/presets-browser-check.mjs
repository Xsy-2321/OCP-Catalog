import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserRuntime } from '../../../tests/shopping-e2e/browser-support.mjs';
import { parseConfigView, parseAgentRunView, parsePendingSessionsView, parseSessionView } from '../public/contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const assets = resolve(root, 'apps/shopping-agent-web/public');
const output = resolve(process.env.SHOPPING_PRESETS_OUTPUT_DIR || resolve(root, '.codex-tmp/shopping-presets-check'));
const requests = [], pageErrors = [], checks = [];
const startedAt = new Date().toISOString();
let fixture, browser, sessionNumber = 0, purchaseRequests = 0;
const gates = new Set();
const pending = parsePendingSessionsView({ sessions: [] });
function resetFixture(options = {}) {
  fixture = { mode: 'http', health: 'online', configStatus: 200, pendingStatus: 200, sessions: new Map(), gate: null, ...options };
}
function configFixture() {
  return parseConfigView({ mode: fixture.mode, merchant_id: 'coffee', payment_mode: 'local_simulated',
    c0_status: 'integrated', contract_version: '1', llm_status: 'configured', llm_model: 'local-fixture',
    merchant_health: { status: fixture.health, message: 'local fixture only', checked_at: new Date().toISOString() } });
}
function sessionFixture(intent, quoted = false) {
  const at = new Date().toISOString();
  const candidate = { entry_id: 'latte', catalog_id: 'coffee', merchant_id: 'coffee', title: 'Local coffee',
    description: 'Local preset regression fixture', search_price_minor: 1800, currency: 'CNY', in_stock: true };
  const session = parseSessionView({ id: `session_fixture_${++sessionNumber}`, mode: fixture.mode,
    phase: quoted ? 'awaiting_confirmation' : 'new', intent, candidates: quoted ? [candidate] : [],
    ...(quoted ? { selected: candidate, quote: { quote_id: `quote_fixture_${sessionNumber}`, merchant_id: 'coffee',
      entry_id: candidate.entry_id, title: candidate.title, quantity: intent.quantity, fulfillment: intent.fulfillment,
      currency: 'CNY', unit_price_minor: 1800, fees: [], total_minor: 1800 * intent.quantity,
      terms_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 300_000).toISOString() } } : {}),
    revision: 1, created_at: at, updated_at: at });
  fixture.sessions.set(session.id, session);
  return session;
}
function holdNextPending() {
  let start, release;
  const gate = { started: new Promise(resolveStart => { start = resolveStart; }),
    wait: new Promise(resolveRelease => { release = resolveRelease; }), start: () => start(), release: () => release() };
  fixture.gate = gate; gates.add(gate);
  return gate;
}
async function bodyOf(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : undefined;
}
const assetMap = new Map([['/', 'index.html'], ...['styles.css', 'app.js', 'contracts.js', 'view-model.js', 'dom.js', 'api-client.js', 'coffee-bg.svg'].map(name => [`/${name}`, name])]);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const record = { method: request.method, path }; requests.push(record);
  const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  try {
    if (request.method === 'GET' && path === '/api/config') return fixture.configStatus === 200
      ? json(configFixture()) : json({ error: { message: 'Local connection fixture failure' } }, fixture.configStatus);
    if (request.method === 'GET' && path === '/api/sessions/pending') {
      const gate = fixture.gate;
      if (gate) { fixture.gate = null; gate.start(); await gate.wait; gates.delete(gate); }
      return fixture.pendingStatus === 200 ? json(pending) : json({ error: { message: 'Local pending fixture failure' } }, fixture.pendingStatus);
    }
    if (request.method === 'POST' && path === '/api/sessions') {
      record.body = await bodyOf(request); return json(sessionFixture(record.body));
    }
    if (request.method === 'POST' && path === '/api/agent/run') {
      record.body = await bodyOf(request);
      const session = sessionFixture({ query: '拿铁', quantity: record.body.quantity, currency: 'CNY',
        max_total_minor: record.body.max_total_minor, merchant_id: 'coffee', fulfillment: record.body.fulfillment }, true);
      return json(parseAgentRunView({ session, planner_mode: 'llm', tool_calls: 1, explanation: 'Local fixed quote.',
        model: 'local-fixture', outcome: 'quote_ready', next_actions: ['confirm_quote', 'choose_candidate', 'edit_request'], warnings: [] }));
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(search|quote))?$/.exec(path);
    const session = match && fixture.sessions.get(match[1]);
    if (session && request.method === 'GET' && !match[2]) return json(parseSessionView(session));
    if (session && request.method === 'POST' && match[2]) {
      record.body = await bodyOf(request);
      const candidate = { entry_id: 'latte', catalog_id: 'coffee', merchant_id: 'coffee', title: 'Local coffee',
        description: 'Local preset regression fixture', search_price_minor: 1800, currency: 'CNY', in_stock: true };
      const next = match[2] === 'search' ? parseSessionView({ ...session, phase: 'candidates', candidates: [candidate] })
        : sessionFixture(session.intent, true);
      // Keep the original route identity when moving from search to quote.
      next.id = session.id; fixture.sessions.set(session.id, next); return json(parseSessionView(next));
    }
    if (request.method !== 'GET') {
      purchaseRequests++; request.resume(); return json({ error: { message: 'No purchase mutation permitted in fixture' } }, 405);
    }
    const file = assetMap.get(path);
    if (!file) return json({ error: 'not_found' }, 404);
    const content = await readFile(resolve(assets, file));
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css'
      : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html', 'cache-control': 'no-store' });
    response.end(content);
  } catch (error) { json({ error: String(error) }, 500); }
});
resetFixture();
await mkdir(output, { recursive: true });
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { origin, startedAt, fixtureValidated: true, externalRequestsBlocked: true, checks };
function check(name, condition) { checks.push({ name, passed: Boolean(condition) }); assert.ok(condition, name); }
async function openPage(options = {}) {
  resetFixture(options);
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000); page.setDefaultNavigationTimeout(15_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await page.goto(origin);
  await page.waitForFunction(() => !document.getElementById('pending-check').disabled);
  return { context, page };
}
const preset = (page, name) => page.locator(`[data-preset="${name}"]`);
const snapshot = page => page.evaluate(() => ({
  mode: document.querySelector('[name="flow-mode"]:checked').value,
  query: document.getElementById('query').value, message: document.getElementById('agent-message').value,
  budget: document.getElementById('budget').value, quantity: document.getElementById('quantity').value,
  mixed: document.getElementById('mixed-basket').checked,
}));
async function seedBasket(page) {
  await page.locator('#budget').fill('90.00');
  await page.locator('#mixed-basket').check();
  await page.locator('.basket-query').nth(0).fill('拿铁');
  await page.locator('.basket-quantity').nth(0).fill('2');
  await page.locator('.basket-query').nth(1).fill('美式');
  check('basket fixture starts with three cups', (await snapshot(page)).quantity === '3');
}
async function settleButtonColors(page) {
  await page.waitForFunction(() => !document.getAnimations().some(animation =>
    animation.playState === 'running' && animation.effect?.target === document.getElementById('pending-check')));
}
async function contrast(page) {
  return page.evaluate(() => {
    const channels = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = color => channels(color).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const color = getComputedStyle(document.getElementById('pending-check')).color;
    const background = getComputedStyle(document.getElementById('recovery-card')).backgroundColor;
    const values = [luminance(color), luminance(background)].sort((a, b) => a - b);
    return { color, background, ratio: (values[1] + 0.05) / (values[0] + 0.05),
      focusVisible: document.getElementById('pending-check').matches(':focus-visible') };
  });
}
async function run() {
  const { chromium, launchOptions } = browserRuntime();
  browser = await chromium.launch({ ...launchOptions, timeout: 15_000 });
  {
    const { context, page } = await openPage();
    await page.locator('#query').fill('馥芮白'); await page.locator('#budget').fill('45.00'); await page.locator('#quantity').fill('2');
    const before = await snapshot(page), start = requests.length, gate = holdNextPending();
    await page.locator('#search-button').click(); await gate.started;
    check('all presets disabled while manual submission waits for pending discovery', await page.locator('.prompt-chip').evaluateAll(buttons => buttons.every(button => button.disabled)));
    await preset(page, 'agent-sweet').evaluate(button => { button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    check('native and synthetic clicks preserve the in-flight manual draft', JSON.stringify(await snapshot(page)) === JSON.stringify(before));
    gate.release();
    await page.waitForFunction(() => document.getElementById('flow-panel-1').classList.contains('is-active') && !document.getElementById('pending-check').disabled);
    const submitted = requests.slice(start).find(request => request.path === '/api/sessions' && request.method === 'POST')?.body;
    check('pending discovery resumes the original manual request', submitted?.query === '馥芮白' && submitted.quantity === 2 && submitted.max_total_minor === 4500);
    check('example cannot switch a pending manual submission to Agent', !requests.slice(start).some(request => request.path === '/api/agent/run') && (await snapshot(page)).mode === 'manual');
    await context.close();
  }
  for (const [name, query, budget] of [['latte', '拿铁', 2800], ['americano-budget', '美式', 3000]]) {
    const { context, page } = await openPage(); await seedBasket(page);
    const start = requests.length; await preset(page, name).click();
    const after = await snapshot(page);
    check(`${name} exits the three-cup mixed basket`, after.mode === 'manual' && !after.mixed && after.quantity === '1' && after.query === query);
    await page.locator('#search-button').click();
    await page.waitForFunction(() => document.getElementById('flow-panel-1').classList.contains('is-active') && !document.getElementById('pending-check').disabled);
    const submitted = requests.slice(start).find(request => request.path === '/api/sessions' && request.method === 'POST')?.body;
    check(`${name} submits one cup without old items`, submitted?.query === query && submitted.quantity === 1 && submitted.max_total_minor === budget
      && submitted.fulfillment === 'pickup' && !Object.hasOwn(submitted, 'items'));
    await context.close();
  }
  for (const name of ['latte', 'agent-sweet', 'americano-budget']) {
    const { context, page } = await openPage();
    await page.locator('[name="flow-mode"][value="agent"]').check(); await page.locator('#agent-message').fill('Local fixture quote');
    await page.locator('#search-button').click();
    await page.waitForFunction(() => !document.getElementById('confirm-button').disabled && document.getElementById('flow-panel-2').classList.contains('is-active'));
    await preset(page, name).click();
    await page.waitForFunction(() => document.getElementById('flow-panel-0').classList.contains('is-active') && document.getElementById('flow-panel-0').getAttribute('aria-hidden') === 'false');
    check(`${name} returns the quoted user to an editable request and visible explanation`, await page.locator('#draft-note').isVisible() && await page.locator('#search-button').isEnabled());
    check(`${name} invalidates the old quote confirmation`, await page.locator('#confirm-button').isDisabled());
    await page.locator('#confirm-button').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await context.close();
  }
  {
    const { context, page } = await openPage({ pendingStatus: 503 });
    const before = await snapshot(page);
    check('pending discovery failure disables every preset', await page.locator('.prompt-chip').evaluateAll(buttons => buttons.every(button => button.disabled)));
    await preset(page, 'agent-sweet').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    check('synthetic preset cannot bypass the pending-purchase safety lock', JSON.stringify(await snapshot(page)) === JSON.stringify(before));
    report.pendingContrast = {};
    report.pendingContrast.normal = await contrast(page);
    check('pending retry normal text contrast is at least 4.5:1', report.pendingContrast.normal.ratio >= 4.5);
    await page.locator('#pending-check').hover(); await settleButtonColors(page);
    report.pendingContrast.hover = await contrast(page);
    check('pending retry hover text contrast is at least 4.5:1', report.pendingContrast.hover.ratio >= 4.5);
    await page.mouse.move(0, 0);
    await page.locator('#connection-check').focus(); await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.getElementById('pending-check').matches(':focus-visible'));
    await settleButtonColors(page);
    report.pendingContrast.focus = await contrast(page);
    check('pending retry keyboard-focused text contrast is at least 4.5:1', report.pendingContrast.focus.ratio >= 4.5 && report.pendingContrast.focus.focusVisible);
    await page.screenshot({ path: resolve(output, 'pending-retry.png'), fullPage: true });
    fixture.pendingStatus = 200;
    await page.locator('#pending-check').click();
    await page.waitForFunction(() => !document.getElementById('search-button').disabled);
    check('successful retry unlocks the request and presets', await page.locator('.prompt-chip').evaluateAll(buttons => buttons.every(button => !button.disabled)));
    await context.close();
  }
  for (const [name, options, label, connected] of [
    ['online', {}, '当前门店已连接', true],
    ['offline', { health: 'offline' }, '当前门店暂不可达', false],
    ['failed', { configStatus: 503 }, '门店连接待检查', false],
    ['mock', { mode: 'mock', health: 'mock' }, '固定门店样例', false],
  ]) {
    const { context, page } = await openPage(options);
    const connection = await page.evaluate(() => ({ label: document.getElementById('store-connection-label').textContent,
      connected: document.getElementById('store-connection-badge').classList.contains('status-pill-live') }));
    check(`${name} connection pill reflects the checked configuration`, connection.label === label && connection.connected === connected);
    if (name === 'online') {
      report.layout = [];
      for (const width of [760, 920, 1040]) {
        await page.setViewportSize({ width, height: 1100 });
        const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth, workspaceRight: document.querySelector('.workspace').getBoundingClientRect().right }));
        report.layout.push(layout);
        check(`${width}px viewport keeps document and workflow within the screen`, layout.scrollWidth <= layout.width && layout.workspaceRight <= layout.width + 1);
        if (width === 920) await page.screenshot({ path: resolve(output, 'layout-920.png'), fullPage: true });
      }
      fixture.health = 'offline'; await page.locator('#connection-check').click();
      await page.waitForFunction(() => !document.getElementById('connection-check').disabled);
      check('recheck removes the connected pill when the merchant goes offline', (await page.locator('#store-connection-label').textContent()) === '当前门店暂不可达'
        && !(await page.locator('#store-connection-badge').evaluate(element => element.classList.contains('status-pill-live'))));
    }
    await context.close();
  }
  check('presets and synthetic old-quote confirmation execute no purchase', purchaseRequests === 0);
  check('all regression pages run without uncaught page errors', pageErrors.length === 0);
}
let deadline;
try {
  await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Preset browser check exceeded 90 seconds')), 90_000); })]);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = String(error); process.exitCode = 1; }
finally {
  clearTimeout(deadline); for (const gate of gates) gate.release();
  if (browser) await browser.close();
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
  Object.assign(report, { purchaseRequests, pageErrors, requests, finishedAt: new Date().toISOString() });
  await writeFile(resolve(output, 'presets-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
