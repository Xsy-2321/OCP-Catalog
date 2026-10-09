/** Isolated portal-entry regression. Reads real page assets but never a live API,
 * model, database or purchase service. Search and recovery only return validated
 * fixed projections; confirmation and all other purchase mutations are forbidden. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserRuntime } from './browser-support.mjs';
import { parseConfigView, parsePendingSessionsView, parseSessionView } from '../../apps/shopping-agent-web/public/contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assets = resolve(root, 'apps/shopping-agent-web/public');
const output = resolve(process.env.SHOPPING_PORTAL_ENTRY_OUTPUT || resolve(root, '.codex-tmp/portal-entry-browser-check'));
const storageKey = 'ocp-shopping-session-id';
const cookieName = 'ocp_shopping_session';
const cookieValue = 'a'.repeat(64);
const checks = [], pageErrors = [], requests = [], cases = [], externalRequests = [];
let purchaseRequests = 0, browser, scenario;
const at = new Date().toISOString();
const delivery = { recipient: '上次的收件人', phone: '13800000000', address: '上次地址一号楼' };
const caramel = { entry_id: 'fixture_caramel', catalog_id: 'coffee', merchant_id: 'coffee', title: '焦糖拿铁',
  description: '固定本地样例', search_price_minor: 2500, currency: 'CNY', in_stock: true };
const espresso = { ...caramel, entry_id: 'fixture_espresso', title: '浓缩咖啡', search_price_minor: 1800 };
const oldItems = [{ entry_id: caramel.entry_id, title: caramel.title, quantity: 2, unit_price_minor: 2500, line_total_minor: 5000 },
  { entry_id: espresso.entry_id, title: espresso.title, quantity: 1, unit_price_minor: 1800, line_total_minor: 1800 }];
const oldConfirmed = parseSessionView({
  id: 'session_old_confirmed_fixture', mode: 'mock', phase: 'confirmed',
  intent: { query: '焦糖拿铁、浓缩咖啡', quantity: 3, items: [{ query: '焦糖拿铁', quantity: 2 }, { query: '浓缩咖啡', quantity: 1 }],
    currency: 'CNY', max_total_minor: 12000, merchant_id: 'coffee', fulfillment: 'delivery', delivery },
  candidates: [caramel, espresso], selected: caramel,
  quote: { quote_id: 'quote_old_fixture', merchant_id: 'coffee', entry_id: caramel.entry_id, title: '整单咖啡', quantity: 3,
    fulfillment: 'delivery', delivery, currency: 'CNY', unit_price_minor: 2500, items: oldItems,
    fees: [{ code: 'delivery', label: '配送费', amount_minor: 500 }], total_minor: 7300,
    terms_hash: 'b'.repeat(64), expires_at: new Date(Date.now() + 60_000).toISOString() },
  attempt: { purchase_attempt_id: 'attempt_old_fixture', status: 'confirmed' },
  order: { order_id: '20261009-PORTAL-OLD', purchase_attempt_id: 'attempt_old_fixture', title: '整单咖啡', quantity: 3,
    currency: 'CNY', total_minor: 7300, payment_status: 'paid', fulfillment_status: 'ready',
    fulfillment: 'delivery', delivery, items: oldItems, updated_at: at },
  revision: 3, created_at: at, updated_at: at,
});
const pendingUnknown = parseSessionView({
  id: 'session_pending_portal_fixture', mode: 'mock', phase: 'unknown',
  intent: { query: '原购买的焦糖拿铁', quantity: 2, currency: 'CNY', max_total_minor: 9000, merchant_id: 'coffee', fulfillment: 'pickup' },
  candidates: [caramel], selected: caramel,
  quote: { quote_id: 'quote_pending_fixture', merchant_id: 'coffee', entry_id: caramel.entry_id, title: caramel.title, quantity: 2,
    fulfillment: 'pickup', currency: 'CNY', unit_price_minor: 2500, fees: [], total_minor: 5000,
    terms_hash: 'c'.repeat(64), expires_at: new Date(Date.now() + 60_000).toISOString() },
  attempt: { purchase_attempt_id: 'attempt_original_pending_fixture', status: 'processing' },
  error: { code: 'result_unknown', message: '原购买的结果仍待查询，请保留原尝试。' },
  revision: 2, created_at: at, updated_at: at,
});
const pendingConfirmed = parseSessionView({ ...pendingUnknown, phase: 'confirmed', error: undefined,
  attempt: { purchase_attempt_id: pendingUnknown.attempt.purchase_attempt_id, status: 'confirmed' },
  order: { order_id: '20261009-PORTAL-RECOVERED', purchase_attempt_id: pendingUnknown.attempt.purchase_attempt_id,
    title: caramel.title, quantity: 2, currency: 'CNY', total_minor: 5000, payment_status: 'paid', fulfillment_status: 'ready',
    fulfillment: 'pickup', updated_at: at }, revision: 3 });
const checkoutPending = parseSessionView({ ...pendingUnknown, id: 'session_checkout_pending_portal_fixture', phase: 'checkout_pending',
  attempt: { purchase_attempt_id: 'attempt_original_checkout_fixture', status: 'processing' },
  error: { code: 'processing', message: '原购买仍在处理中，请查询原尝试。' } });
const unpaidCandidates = parseSessionView({
  id: 'session_unpaid_candidates_fixture', mode: 'mock', phase: 'candidates',
  intent: { query: '还没购买的拿铁', quantity: 2, currency: 'CNY', max_total_minor: 7000, merchant_id: 'coffee', fulfillment: 'pickup' },
  candidates: [caramel], revision: 1, created_at: at, updated_at: at,
});
const unpaidQuote = parseSessionView({ ...unpaidCandidates, id: 'session_unpaid_quote_fixture', phase: 'awaiting_confirmation', selected: caramel,
  quote: { quote_id: 'quote_unpaid_fixture', merchant_id: 'coffee', entry_id: caramel.entry_id, title: caramel.title, quantity: 2,
    fulfillment: 'pickup', currency: 'CNY', unit_price_minor: 2500, fees: [], total_minor: 5000,
    terms_hash: 'd'.repeat(64), expires_at: new Date(Date.now() + 600_000).toISOString() }, revision: 2 });
const newQuery = '新搜索，不应直接付款';
const newSearchRequest = { query: newQuery, quantity: 1, currency: 'CNY', max_total_minor: 3000, merchant_id: 'coffee', fulfillment: 'pickup' };
const newCreated = parseSessionView({ id: 'session_new_search_fixture', mode: 'mock', phase: 'new',
  intent: newSearchRequest, candidates: [], revision: 0, created_at: at, updated_at: at });
const newCandidates = parseSessionView({ ...newCreated, phase: 'candidates', candidates: [caramel], revision: 1 });
const sessionFixtures = new Map([oldConfirmed, pendingUnknown, checkoutPending, unpaidCandidates, unpaidQuote].map(session => [session.id, session]));
const recoverPaths = [...sessionFixtures.keys()].map(id => `/api/sessions/${id}/recover`);
const config = parseConfigView({ mode: 'mock', merchant_id: 'coffee', merchant_demo_available: true,
  payment_mode: 'local_simulated', c0_status: 'integrated', contract_version: '1', llm_status: 'configured', llm_model: 'local-fixture',
  merchant_health: { status: 'mock', message: 'local portal-entry fixture', checked_at: at } });
const emptyPending = parsePendingSessionsView({ sessions: [] });
const assetMap = new Map([['/', 'index.html'], ['/demo', 'demo.html'],
  ...['styles.css', 'merchant.css', 'app.js', 'contracts.js', 'view-model.js', 'dom.js', 'api-client.js'].map(file => [`/${file}`, file])]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const entry = { scenario: scenario?.name, method: request.method, path: url.pathname, query: url.search };
  requests.push(entry);
  const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  const session = value => {
    const validated = parseSessionView(value);
    entry.sessionId = validated.id; entry.attemptId = validated.attempt?.purchase_attempt_id;
    entry.phase = validated.phase; entry.orderId = validated.order?.order_id; entry.paymentStatus = validated.order?.payment_status;
    return json(validated);
  };
  try {
    if (request.method === 'GET' && url.pathname === '/api/config') return json(config);
    if (request.method === 'GET' && url.pathname === '/api/sessions/pending') {
      if (scenario.pendingFailure) return json({ error: { code: 'pending_unavailable', message: '本地样例的未决查询暂不可用。' } }, 503);
      const pending = parsePendingSessionsView(scenario.pendingSession && !scenario.recovered ? { sessions: [scenario.pendingSession] } : emptyPending);
      entry.pendingCount = pending.sessions.length;
      return json(pending);
    }
    const id = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/recover)?$/)?.[1];
    const saved = scenario.savedSession?.id === id ? scenario.savedSession : sessionFixtures.get(id);
    if (request.method === 'GET' && saved) return session(scenario.recovered && id === pendingUnknown.id ? pendingConfirmed : saved);
    if (request.method === 'POST' && recoverPaths.includes(url.pathname)) {
      let body = ''; for await (const chunk of request) body += chunk;
      entry.body = JSON.parse(body);
      assert.deepEqual(entry.body, {}, 'Recovery must carry no new purchase parameters');
      if (scenario.autoRecoverConfirmed && id === pendingUnknown.id) scenario.recovered = true;
      return session(scenario.recovered && id === pendingUnknown.id ? pendingConfirmed : saved);
    }
    if (request.method === 'POST' && scenario.allowSearch && ['/api/sessions', `/api/sessions/${newCreated.id}/search`].includes(url.pathname)) {
      let body = ''; for await (const chunk of request) body += chunk;
      entry.body = JSON.parse(body);
      assert.deepEqual(entry.body, url.pathname === '/api/sessions' ? newSearchRequest : {}, 'Only the fixed explicit new search is allowed');
      return session(url.pathname === '/api/sessions' ? newCreated : newCandidates);
    }
    if (request.method !== 'GET') {
      purchaseRequests++; request.resume();
      return json({ error: { code: 'fixture_read_only', message: 'Fixture forbids purchase, model and confirmation mutations' } }, 405);
    }
    const file = assetMap.get(url.pathname);
    if (!file) return json({ error: 'not_found' }, 404);
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' });
    response.end(await readFile(resolve(assets, file)));
  } catch (error) { json({ error: String(error) }, 500); }
});
await mkdir(output, { recursive: true });
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { origin, startedAt: at, fixtureValidated: true, checks, cases };
function check(description, condition) {
  checks.push({ scenario: scenario?.name, description, passed: Boolean(condition) });
  assert.ok(condition, description);
}
const caseRequests = () => requests.filter(request => request.scenario === scenario.name);
const oldReads = () => caseRequests().filter(request => request.method === 'GET' && request.path === `/api/sessions/${oldConfirmed.id}`);
async function openCase(name, options = {}) {
  scenario = { name, ...options };
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addCookies([{ name: cookieName, value: cookieValue, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(15_000);
  page.on('pageerror', error => pageErrors.push({ scenario: name, message: error.message }));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(`${origin}/`)) return route.continue();
    externalRequests.push({ scenario: name, url: route.request().url() });
    return route.abort();
  });
  await page.goto(`${origin}/demo`);
  await page.evaluate(({ key, pointer }) => {
    localStorage.setItem(key, pointer); localStorage.setItem('portal-preserve-note', 'keep unrelated local data');
  }, { key: storageKey, pointer: options.pointer || oldConfirmed.id });
  return { page, context };
}
async function settled(page, step) {
  // Static HTML already has an active first panel and enabled controls. Require
  // the app's inline layout marker so this cannot pass before the ES module boots.
  await page.waitForFunction(expected => Boolean(document.getElementById('flow-viewport').style.height)
    && !document.getElementById('pending-check').disabled && !document.getElementById('connection-check').disabled
    && document.querySelector('.flow-panel.is-active')?.getAttribute('data-flow-panel') === String(expected)
    && !document.querySelector('.is-leaving')
    && Math.abs(document.getElementById('flow-viewport').getBoundingClientRect().height
      - document.querySelector('.flow-panel.is-active').getBoundingClientRect().height) < 1, step);
}
async function snapshot(page) {
  return page.evaluate(key => ({
    url: location.href, step: Number(document.querySelector('.flow-panel.is-active').getAttribute('data-flow-panel')),
    query: document.getElementById('query').value, quantity: document.getElementById('quantity').value,
    budget: document.getElementById('budget').value, message: document.getElementById('agent-message').value,
    mode: document.querySelector('[name="flow-mode"]:checked').value,
    mixed: document.getElementById('mixed-basket').checked, basketRows: document.querySelectorAll('.basket-input-row').length,
    fulfillment: document.getElementById('fulfillment').value,
    delivery: ['recipient', 'phone', 'address'].map(name => document.getElementById(`delivery-${name}`).value),
    queryDisabled: document.getElementById('query').disabled, searchDisabled: document.getElementById('search-button').disabled,
    confirmDisabled: document.getElementById('confirm-button').disabled,
    pointer: localStorage.getItem(key), preservedLocalData: localStorage.getItem('portal-preserve-note'),
    planningHidden: document.getElementById('planning-section').hidden,
    quoteHidden: document.getElementById('quote-section').hidden, orderHidden: document.getElementById('order-section').hidden,
    orderText: document.getElementById('order-content').textContent,
    quoteText: document.getElementById('quote-content').textContent,
    recoveryVisible: !document.getElementById('recovery-card').hidden,
    pendingText: document.getElementById('pending-list').textContent,
    pendingNotice: document.getElementById('pending-note').textContent,
    activeCount: document.querySelectorAll('.flow-panel.is-active').length,
    inaccessibleOthers: [...document.querySelectorAll('.flow-panel:not(.is-active)')].every(panel => panel.inert && panel.getAttribute('aria-hidden') === 'true' && getComputedStyle(panel).visibility === 'hidden'),
    fits: document.documentElement.scrollWidth <= innerWidth,
  }), storageKey);
}
function defaultDraft(value) {
  return value.query === '拿铁' && value.quantity === '1' && value.budget === '30.00' && value.message === ''
    && value.mode === 'manual' && !value.mixed && value.basketRows === 0 && value.fulfillment === 'pickup' && value.delivery.every(part => part === '');
}
async function syntheticForward(page, locked = false) {
  const currentStep = (await snapshot(page)).step;
  await page.evaluate(({ submit, current }) => {
    for (const step of [1, 2, 3].filter(step => step > current)) document.querySelector(`[data-step="${step}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('confirm-button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    if (submit) document.getElementById('intent-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }, { submit: locked, current: currentStep });
  await settled(page, currentStep);
  check('synthetic future-step and confirm events cannot advance or purchase', (await snapshot(page)).step === currentStep && purchaseRequests === 0);
}
async function identityRetained(context, page, expectedPointer) {
  const value = await snapshot(page);
  const cookie = (await context.cookies(origin)).find(cookie => cookie.name === cookieName);
  check('entry preserves the saved pointer, unrelated local data and identity cookie', value.pointer === expectedPointer
    && value.preservedLocalData === 'keep unrelated local data' && cookie?.value === cookieValue);
}
async function run() {
  const { chromium, launchOptions } = browserRuntime();
  browser = await chromium.launch({ ...launchOptions, timeout: 15_000 });
  {
    const { page, context } = await openCase('portal-confirmed-start');
    check('the actual portal user link carries the one-time start flag', await page.locator('#user-demo-entry').getAttribute('href') === '/?start=1');
    await page.locator('#user-demo-entry').click(); await settled(page, 0);
    const first = await snapshot(page); cases.push({ name: scenario.name, first });
    check('portal entry starts on step one with clean defaults', defaultDraft(first) && !first.searchDisabled && !first.queryDisabled && first.confirmDisabled);
    check('the first portal visit consumes its start flag', !new URL(first.url).searchParams.has('start'));
    check('old confirmed facts and planner are absent from the fresh page', first.planningHidden && first.quoteHidden && first.orderHidden && first.orderText === '' && first.quoteText === '');
    check('only the active request card is accessible after entry', first.activeCount === 1 && first.inaccessibleOthers);
    check('paid portal entry reads and recovers the saved order before resetting', oldReads().length > 0
      && caseRequests().some(request => request.path === `/api/sessions/${oldConfirmed.id}/recover` && request.attemptId === oldConfirmed.attempt.purchase_attempt_id));
    check('portal entry still discovers server pending purchases', caseRequests().some(request => request.path === '/api/sessions/pending'));
    await identityRetained(context, page, oldConfirmed.id); await syntheticForward(page);
    await page.locator('#query').fill('上一次页面未提交的需求'); await page.locator('#budget').fill('99.99');
    await page.goto(`${origin}/demo`); await page.locator('#user-demo-entry').click(); await settled(page, 0);
    const repeated = await snapshot(page); cases.at(-1).repeated = repeated;
    check('every later portal click also clears the previous page draft', defaultDraft(repeated) && !repeated.searchDisabled);
    check('every later portal visit also consumes its start flag', !new URL(repeated.url).searchParams.has('start'));
    check('repeated portal entry checks payment again before resetting', oldReads().length >= 2);
    await identityRetained(context, page, oldConfirmed.id);
    await page.screenshot({ path: resolve(output, 'portal-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await settled(page, 0);
    check('fresh request card fits the mobile viewport', (await snapshot(page)).fits);
    await page.screenshot({ path: resolve(output, 'portal-mobile.png'), fullPage: true });
    await context.close();
  }
  {
    const { page, context } = await openCase('direct-confirmed-restore');
    await page.goto(`${origin}/`); await settled(page, 3);
    const restored = await snapshot(page); cases.push({ name: scenario.name, restored });
    check('direct root visit retains ordinary confirmed-order recovery', restored.step === 3 && restored.orderText.includes(oldConfirmed.order.order_id) && !restored.orderHidden);
    check('direct root visit restores the saved basket and delivery draft', restored.mixed && restored.basketRows === 2 && restored.quantity === '3'
      && restored.fulfillment === 'delivery' && restored.delivery[0] === delivery.recipient);
    check('direct root visit reads and recovers the original session', oldReads().length > 0 && caseRequests().some(request => request.path === `/api/sessions/${oldConfirmed.id}/recover`
      && request.attemptId === oldConfirmed.attempt.purchase_attempt_id));
    await identityRetained(context, page, oldConfirmed.id);
    await context.close();
  }
  {
    const { page, context } = await openCase('consume-only-start-parameter');
    await page.goto(`${origin}/?campaign=coffee&start=1&tag=a&tag=b#keep-section`); await settled(page, 0);
    const value = await snapshot(page), url = new URL(value.url); cases.push({ name: scenario.name, value });
    check('entry consumes only start and preserves all other query values and the hash', !url.searchParams.has('start')
      && url.searchParams.get('campaign') === 'coffee' && JSON.stringify(url.searchParams.getAll('tag')) === JSON.stringify(['a', 'b']) && url.hash === '#keep-section');
    check('query-bearing paid entry checks the old order then retains clean defaults', defaultDraft(value) && oldReads().length > 0 && !value.searchDisabled);
    await identityRetained(context, page, oldConfirmed.id); await syntheticForward(page);
    await context.close();
  }
  {
    const { page, context } = await openCase('pending-unknown-entry-and-explicit-recovery', { pendingSession: pendingUnknown, pointer: pendingUnknown.id });
    await page.locator('#user-demo-entry').click(); await settled(page, 3);
    const unknown = await snapshot(page); cases.push({ name: scenario.name, unknown });
    const recoverPath = `/api/sessions/${pendingUnknown.id}/recover`;
    const automatic = caseRequests().filter(request => request.method === 'POST' && request.path === recoverPath);
    check('pending entry performs automatic recovery of the original attempt', automatic.length === 1 && automatic[0].attemptId === pendingUnknown.attempt.purchase_attempt_id);
    check('unknown automatic result restores step four and keeps the purchase lock', unknown.step === 3 && unknown.queryDisabled && unknown.searchDisabled && unknown.confirmDisabled);
    check('unknown purchase facts survive portal entry', unknown.query === pendingUnknown.intent.query && unknown.quantity === '2' && unknown.quoteText.includes(caramel.title));
    check('global recovery remains visible for the original pending purchase', unknown.recoveryVisible && unknown.pendingText.includes(caramel.title)
      && await page.locator('#pending-list button').count() === 1);
    await identityRetained(context, page, pendingUnknown.id);
    await page.screenshot({ path: resolve(output, 'pending-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await settled(page, 3);
    check('pending lock and global recovery fit the mobile viewport', (await snapshot(page)).fits);
    await page.screenshot({ path: resolve(output, 'pending-mobile.png'), fullPage: true });
    await page.locator('[data-step="0"]').click(); await settled(page, 0);
    const returned = await snapshot(page);
    check('manual return preserves the unknown draft and its purchase lock', returned.query === pendingUnknown.intent.query && returned.queryDisabled && returned.searchDisabled);
    await syntheticForward(page, true);
    check('a locked synthetic submission makes no new search, model or session request', purchaseRequests === 0);
    scenario.recovered = true;
    await page.locator('#pending-list button').click(); await settled(page, 3);
    const recovered = await snapshot(page); cases.at(-1).recovered = recovered;
    check('explicit original recovery advances to the confirmed order card', recovered.step === 3 && recovered.orderText.includes(pendingConfirmed.order.order_id) && !recovered.orderHidden);
    check('successful explicit recovery clears the pending lock and global warning', !recovered.queryDisabled && !recovered.recoveryVisible);
    const recoveries = caseRequests().filter(request => request.method === 'POST' && request.path === recoverPath);
    check('automatic and explicit recovery preserve one session, attempt and order binding', recoveries.length === 2
      && recoveries.every(request => request.sessionId === pendingUnknown.id && request.attemptId === pendingUnknown.attempt.purchase_attempt_id)
      && pendingConfirmed.order.purchase_attempt_id === pendingUnknown.attempt.purchase_attempt_id);
    check('pending recovery never reads the obsolete confirmed session pointer', oldReads().length === 0);
    await identityRetained(context, page, pendingUnknown.id);
    await context.close();
  }
  {
    const { page, context } = await openCase('pending-auto-recovery-paid-start', {
      pendingSession: pendingUnknown, pointer: pendingUnknown.id, autoRecoverConfirmed: true,
    });
    await page.locator('#user-demo-entry').click(); await settled(page, 0);
    const fresh = await snapshot(page); cases.push({ name: scenario.name, fresh });
    check('automatic recovery to paid starts a clean unlocked request card', fresh.step === 0 && defaultDraft(fresh)
      && !fresh.queryDisabled && !fresh.searchDisabled && fresh.confirmDisabled && !fresh.recoveryVisible);
    check('paid recovery facts do not remain on the new request page', fresh.planningHidden && fresh.quoteHidden && fresh.orderHidden
      && fresh.orderText === '' && fresh.quoteText === '');
    const recovery = caseRequests().filter(request => request.method === 'POST');
    check('automatic paid recovery retains exactly the original attempt and order binding', recovery.length === 1
      && recovery[0].path === `/api/sessions/${pendingUnknown.id}/recover` && recovery[0].sessionId === pendingUnknown.id
      && recovery[0].attemptId === pendingUnknown.attempt.purchase_attempt_id && recovery[0].phase === 'confirmed'
      && recovery[0].paymentStatus === 'paid' && recovery[0].orderId === pendingConfirmed.order.order_id);
    const discoveries = caseRequests().filter(request => request.path === '/api/sessions/pending');
    check('the pending discovery is checked again after paid recovery', discoveries.length === 2
      && discoveries[0].pendingCount === 1 && discoveries[1].pendingCount === 0);
    await identityRetained(context, page, pendingUnknown.id); await syntheticForward(page);
    await context.close();
  }
  {
    const { page, context } = await openCase('pending-discovery-failure', { pendingFailure: true });
    await page.locator('#user-demo-entry').click(); await settled(page, 3);
    const failed = await snapshot(page); cases.push({ name: scenario.name, failed });
    check('pending discovery failure restores the original order and draft', failed.step === 3 && failed.orderText.includes(oldConfirmed.order.order_id)
      && failed.mixed && failed.basketRows === 2 && failed.delivery[0] === delivery.recipient);
    check('even a paid order cannot clear a failed pending-discovery lock', failed.queryDisabled && failed.searchDisabled && failed.confirmDisabled);
    check('failed discovery keeps a visible global retry explanation', failed.recoveryVisible && failed.pendingNotice.includes('无法检查'));
    check('failed discovery still queries the saved order', oldReads().length > 0);
    await identityRetained(context, page, oldConfirmed.id);
    await page.locator('[data-step="0"]').click(); await settled(page, 0); await syntheticForward(page, true);
    check('locked failure path allows only original recovery, not purchase or search', purchaseRequests === 0
      && caseRequests().filter(request => request.method !== 'GET').every(request => request.path === `/api/sessions/${oldConfirmed.id}/recover`));
    await context.close();
  }
  {
    const { page, context } = await openCase('unpaid-candidates-and-explicit-new-search', { pointer: unpaidCandidates.id, allowSearch: true });
    await page.locator('#user-demo-entry').click(); await settled(page, 1);
    const restored = await snapshot(page); cases.push({ name: scenario.name, restored });
    check('unpaid candidate progress resumes step two with its original draft', restored.step === 1 && restored.query === unpaidCandidates.intent.query
      && restored.quantity === '2' && restored.budget === '70.00' && !restored.queryDisabled && restored.quoteHidden && restored.orderHidden);
    check('candidate entry makes no confirmation or new attempt', caseRequests().every(request => request.method === 'GET') && purchaseRequests === 0);
    await identityRetained(context, page, unpaidCandidates.id); await syntheticForward(page);
    await page.locator('[data-step="0"]').click(); await settled(page, 0);
    await page.locator('#query').fill(newQuery); await page.locator('#quantity').fill('1'); await page.locator('#budget').fill('30.00');
    await page.locator('#search-button').click(); await settled(page, 1);
    const searched = await snapshot(page); cases.at(-1).searched = searched;
    check('an explicit new search goes to candidates with the new draft', searched.step === 1 && searched.query === newQuery
      && searched.quantity === '1' && searched.budget === '30.00' && searched.pointer === newCreated.id);
    check('new search never quotes, confirms or creates a purchase attempt', searched.quoteHidden && searched.orderHidden && searched.confirmDisabled
      && caseRequests().filter(request => request.method === 'POST').length === 2
      && caseRequests().filter(request => request.method === 'POST').every(request => ['/api/sessions', `/api/sessions/${newCreated.id}/search`].includes(request.path) && !request.attemptId)
      && !newCreated.attempt && !newCandidates.attempt && purchaseRequests === 0);
    await page.screenshot({ path: resolve(output, 'unpaid-candidates.png'), fullPage: true });
    await context.close();
  }
  {
    const { page, context } = await openCase('unpaid-quote-resume', { pointer: unpaidQuote.id });
    await page.locator('#user-demo-entry').click(); await settled(page, 2);
    const restored = await snapshot(page); cases.push({ name: scenario.name, restored });
    check('unpaid quoted progress resumes step three with its original draft', restored.step === 2 && restored.query === unpaidQuote.intent.query
      && restored.quantity === '2' && restored.budget === '70.00' && !restored.quoteHidden && restored.orderHidden);
    check('restored fresh quote still awaits explicit confirmation', !restored.confirmDisabled && caseRequests().every(request => request.method === 'GET') && purchaseRequests === 0);
    await identityRetained(context, page, unpaidQuote.id);
    await page.screenshot({ path: resolve(output, 'unpaid-quote.png'), fullPage: true });
    await context.close();
  }
  {
    const { page, context } = await openCase('checkout-pending-resume', { pendingSession: checkoutPending, pointer: checkoutPending.id });
    await page.locator('#user-demo-entry').click(); await settled(page, 3);
    const restored = await snapshot(page); cases.push({ name: scenario.name, restored });
    check('checkout_pending resumes step four and keeps its original draft locked', restored.step === 3 && restored.query === checkoutPending.intent.query
      && restored.queryDisabled && restored.searchDisabled && restored.confirmDisabled && restored.recoveryVisible);
    check('checkout_pending recovery retains the original purchase attempt', caseRequests().some(request => request.path === `/api/sessions/${checkoutPending.id}/recover`
      && request.attemptId === checkoutPending.attempt.purchase_attempt_id));
    await identityRetained(context, page, checkoutPending.id);
    await context.close();
  }
  for (const [session, expectedStep] of [[unpaidCandidates, 1], [unpaidQuote, 2]]) {
    const errored = parseSessionView({ ...session, error: { code: 'fixture_previous_failure', message: '上次操作失败，原进度仍需保留。' } });
    const { page, context } = await openCase(`unpaid-${session.phase}-error-resume`, { pointer: session.id, savedSession: errored });
    await page.locator('#user-demo-entry').click(); await settled(page, expectedStep);
    const restored = await snapshot(page); cases.push({ name: scenario.name, restored });
    check('an error without a purchase attempt preserves the unpaid stage and draft', restored.step === expectedStep
      && restored.query === errored.intent.query && restored.quantity === '2' && restored.budget === '70.00'
      && !restored.queryDisabled && restored.orderHidden && restored.quoteHidden === (expectedStep !== 2));
    check('failed unpaid progress remains a read-only restoration until user action', caseRequests().every(request => request.method === 'GET')
      && !errored.attempt && purchaseRequests === 0);
    await identityRetained(context, page, session.id);
    await context.close();
  }
  for (const paymentStatus of ['pending', 'failed', 'unknown']) {
    const unpaidOrder = parseSessionView({ ...oldConfirmed, order: { ...oldConfirmed.order, payment_status: paymentStatus } });
    const { page, context } = await openCase(`confirmed-order-payment-${paymentStatus}`, { savedSession: unpaidOrder });
    await page.locator('#user-demo-entry').click(); await settled(page, 3);
    const restored = await snapshot(page); cases.push({ name: scenario.name, restored });
    check('a confirmed phase alone cannot reset an order without paid payment status', restored.step === 3 && restored.query === unpaidOrder.intent.query
      && restored.orderText.includes(unpaidOrder.order.order_id) && !restored.orderHidden);
    await identityRetained(context, page, oldConfirmed.id);
    await context.close();
  }
  scenario = { name: 'complete-fixture-safety' };
  check('all mutation traffic is fixed original recovery or one explicit candidate search', purchaseRequests === 0 && requests.filter(request => request.method !== 'GET')
    .every(request => request.method === 'POST' && (recoverPaths.includes(request.path)
      || (request.scenario === 'unpaid-candidates-and-explicit-new-search' && ['/api/sessions', `/api/sessions/${newCreated.id}/search`].includes(request.path)))));
  check('fixture never contacts a live or external origin', externalRequests.length === 0);
  check('all portal entry pages have zero JavaScript page errors', pageErrors.length === 0);
}
let deadline;
try {
  await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Portal entry browser check exceeded 90 seconds')), 90_000); })]);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = String(error); process.exitCode = 1; }
finally {
  clearTimeout(deadline);
  await browser?.close(); server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  Object.assign(report, { checksPassed: checks.filter(check => check.passed).length, purchaseRequests, pageErrors, requests, externalRequests, output, finishedAt: new Date().toISOString() });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checksPassed, purchaseRequests, pageErrors, failure: report.failure, output }));
}
