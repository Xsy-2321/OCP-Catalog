// Real A/B browser checks plus a local HTTP model-protocol fixture; no external model key is used.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserRuntime } from './browser-support.mjs';
const { chromium, launchOptions } = browserRuntime();
const base = process.env.SHOPPING_PREVIEW_URL;
const agentBase = process.env.SHOPPING_AGENT_PREVIEW_URL;
if (![base, agentBase].every(value => value && new URL(value).hostname === '127.0.0.1')) {
  throw new Error('Run with browser-http-server.ts --resilience-check using isolated loopback services');
}
const output = resolve(process.env.SHOPPING_BROWSER_OUTPUT ?? '.codex-tmp/integration/browser-resilience');
await mkdir(output, { recursive: true });
const browser = await chromium.launch(launchOptions);
const checks = [], errors = [];
function assert(value, description) { if (!value) throw new Error(description); checks.push(description); }
async function idle(page) { await page.waitForFunction(() => !document.getElementById('pending-check').disabled); }
async function activate(page) {
  // Activating a tab triggers the application's focus health/pending refresh.
  // Let that event enter the page queue before waiting for its busy guard.
  await page.bringToFront();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await idle(page);
}
async function shown(page) { return Number(await page.locator('[data-flow-panel].is-active').getAttribute('data-flow-panel')); }
async function card(page, step, description) {
  await page.waitForFunction(value => document.getElementById(`flow-panel-${value}`).classList.contains('is-active')
    && !document.querySelector('.flow-panel.is-leaving'), step);
  const state = await page.evaluate(() => [...document.querySelectorAll('[data-flow-panel]')].map(panel => ({
    step: Number(panel.dataset.flowPanel), active: panel.classList.contains('is-active'),
    inert: panel.inert, hidden: panel.getAttribute('aria-hidden'), visible: getComputedStyle(panel).visibility === 'visible',
  })));
  assert(state.filter(panel => panel.active && panel.visible && !panel.inert && panel.hidden === 'false').length === 1
    && state.every(panel => panel.step === step ? panel.active && panel.visible && !panel.inert && panel.hidden === 'false'
      : !panel.active && !panel.visible && panel.inert && panel.hidden === 'true'), description);
  assert(await page.locator('#flow-track').evaluate((track, value) => {
    const match = /^translateX\((-?[\d.]+)%\)$/.exec(track.style.transform);
    return Boolean(match && Number(match[1]) === -value * 100);
  }, step),
    `${description}: the horizontal track matches the displayed card`);
}
async function back(page, step) {
  await activate(page);
  const current = await shown(page);
  if (current < step) throw new Error(`Cannot navigate forward from ${current} to ${step}`);
  if (current > step) await page.locator(`.steps button[data-step="${step}"]`).click();
  await card(page, step, `Only card ${step + 1} is visible after returning to an earlier step`);
}
async function load(page, url = base) { await page.goto(url); await activate(page); }
async function current(page) {
  return page.evaluate(async () => {
    const id = localStorage.getItem('ocp-shopping-session-id');
    return (await fetch(`/api/sessions/${id}`)).json();
  });
}
async function ready(page) {
  await back(page, 0);
  await page.locator('#search-button').click();
  await idle(page); await card(page, 1, 'A successful search automatically opens the candidate card');
  await page.getByRole('button', { name: '查看最终报价' }).first().click();
  await page.waitForFunction(() => !document.getElementById('confirm-button').disabled);
  await idle(page); await card(page, 2, 'A successful quote automatically opens the quote card');
}
async function control(body) {
  const response = await fetch(`${base}/__browser-test__/control`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Isolated browser control failed');
}
async function form(page) {
  return page.evaluate(() => Object.fromEntries(['query', 'budget', 'quantity'].map(id => [id, document.getElementById(id).value])));
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await load(page);
  await card(page, 0, 'Initial loading exposes only the demand card');
  const navigationMutations = [];
  page.on('request', request => { if (request.method() !== 'GET') navigationMutations.push(request.url()); });
  assert(await page.locator('.steps button[data-step="1"]').isDisabled()
    && await page.locator('.steps button[data-step="2"]').isDisabled()
    && await page.locator('.steps button[data-step="3"]').isDisabled(), 'All future step buttons are disabled before searching');
  await page.locator('.steps button[data-step="3"]').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await card(page, 0, 'A synthetic click cannot bypass the disabled future step');
  assert(navigationMutations.length === 0, 'Rejected forward navigation sends no mutation request');
  const hiddenFocus = [];
  for (let index = 0; index < 16; index++) {
    await page.keyboard.press('Tab');
    const panel = await page.evaluate(() => document.activeElement?.closest('[data-flow-panel]')?.getAttribute('data-flow-panel'));
    if (panel !== null && panel !== undefined && panel !== '0') hiddenFocus.push(panel);
  }
  assert(hiddenFocus.length === 0, 'Keyboard traversal cannot focus controls in later inactive cards');
  await activate(page);
  assert(await page.locator('[name="flow-mode"][value="manual"]').isChecked(), 'Manual mode remains the default without a model key');
  await page.locator('[name="flow-mode"][value="agent"]').check();
  assert(await page.locator('[name="flow-mode"][value="agent"]').isChecked()
    && !(await page.locator('[name="flow-mode"][value="manual"]').isChecked()),
  'The first real mode click after keyboard/page activation is not swallowed by a background focus refresh');
  assert(await page.locator('#search-button').isDisabled(), 'Unconfigured Agent cannot silently fall back to a mock planner');
  const unconfiguredNote = await page.locator('#model-note').textContent();
  assert(unconfiguredNote.length > 0 && !/API Key|\.env|DeepSeek|模型名/i.test(unconfiguredNote),
    'Unavailable Agent guidance stays in customer language without server setup details');
  await page.locator('[name="flow-mode"][value="manual"]').check();
  await page.locator('#query').fill('美式'); await page.locator('#budget').fill('100.00'); await page.locator('#quantity').fill('2');
  await ready(page);
  await page.reload(); await idle(page);
  await card(page, 2, 'Reload returns to the original quote card');
  assert(JSON.stringify(await form(page)) === JSON.stringify({ query: '美式', budget: '100.00', quantity: '2' }),
    'Reload restores the exact query, budget and quantity belonging to the quote');
  assert((await page.locator('#quote-content').textContent()).includes('美式 × 2'), 'Restored fields and the original two-cup quote agree');
  await page.screenshot({ path: resolve(output, 'restored-intent.png'), fullPage: true });
  await page.locator('#flow-back').click();
  await card(page, 1, 'The previous button returns exactly one card without creating a request');
  assert(await page.locator('.steps button[data-step="2"]').isDisabled(), 'A previously completed quote cannot be entered through forward navigation');
  await page.locator('.steps button[data-step="2"]').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await card(page, 1, 'Synthetic forward navigation to an existing quote is still rejected');
  await back(page, 0);
  assert(JSON.stringify(await form(page)) === JSON.stringify({ query: '美式', budget: '100.00', quantity: '2' }),
    'Returning through previous cards preserves the restored form exactly');
  await page.locator('#query').fill('正在编辑的需求'); await page.locator('#budget').fill('26.50'); await page.locator('#quantity').fill('3');
  await page.locator('#connection-check').click(); await idle(page);
  await card(page, 0, 'Refreshing configuration preserves the returned demand card');
  assert(JSON.stringify(await form(page)) === JSON.stringify({ query: '正在编辑的需求', budget: '26.50', quantity: '3' }),
    'Refreshing pending status does not overwrite an in-progress form draft');
  assert(await page.locator('#confirm-button').isDisabled(), 'Editing a quoted demand requires a new quote before confirmation');
  await page.locator('#query').fill('拿铁'); await page.locator('#budget').fill('30.00'); await page.locator('#quantity').fill('1');
  await ready(page);
  const original = await current(page);
  const rejectBeforeCommit = `**/api/sessions/${original.id}/confirm`;
  await page.route(rejectBeforeCommit, route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'merchant_unavailable', message: 'Local pre-commit rejection fixture' } }) }));
  await page.locator('#confirm-button').click(); await idle(page);
  await card(page, 2, 'A pre-commit confirmation failure returns to the retained quote rather than an empty order card');
  const unchangedQuote = await current(page);
  assert(unchangedQuote.id === original.id && unchangedQuote.phase === 'awaiting_confirmation'
    && unchangedQuote.quote.quote_id === original.quote.quote_id && !unchangedQuote.attempt && !unchangedQuote.order,
  'Recoverable pre-commit failure preserves the original quote without inventing an attempt or order');
  assert(await page.locator('#order-section').evaluate(section => section.hidden)
    && !(await page.locator('#confirm-button').isDisabled()), 'An unchanged confirmable quote is restored after the original-session read succeeds');
  await page.unroute(rejectBeforeCommit);
  const other = await context.newPage(); await load(other); await ready(other);
  const stale = await current(other);
  await control({ fault: 'payment_timeout_then_succeed' });
  await page.locator('#confirm-button').click();
  await page.getByText('购买结果待查询', { exact: true }).waitFor();
  await other.getByText('购买结果待查询', { exact: true }).waitFor();
  await idle(page); await idle(other);
  const pending = await current(other);
  await card(other, 3, 'A cross-tab unknown purchase opens the authoritative result card');
  assert(pending.id === original.id && pending.phase === 'unknown', 'A storage event switches the other tab to the authoritative pending purchase');
  assert(await other.locator('#search-button').isDisabled(), 'The other tab cannot start a new purchase while a result is unknown');
  assert(await other.getByRole('button', { name: '恢复这笔购买' }).isVisible(), 'A persistent pending panel exposes the original recovery action');
  await other.screenshot({ path: resolve(output, 'pending-across-tabs.png'), fullPage: true });
  await back(other, 0);
  assert(await other.locator('#query').isDisabled() && await other.locator('#search-button').isDisabled()
    && await other.locator('#confirm-button').isDisabled() && await other.locator('#cancel-button').isDisabled(),
    'Returning to demand while pending never unlocks editing, new purchases, confirmation or cancellation');
  assert(await other.getByRole('button', { name: '恢复这笔购买' }).isVisible(), 'Original-attempt recovery remains visible outside the hidden result card');
  await other.locator('#pending-check').click(); await idle(other);
  await card(other, 0, 'Checking the same pending purchase preserves the chosen earlier card');
  await page.close();
  // Simulate an older tab/version leaving a stale pointer, then prove server discovery wins after reload.
  await other.evaluate(id => localStorage.setItem('ocp-shopping-session-id', id), stale.id);
  await other.reload(); await idle(other);
  await other.getByText('模拟订单已确认', { exact: true }).waitFor();
  const recovered = await current(other);
  assert(recovered.id === original.id && recovered.attempt.purchase_attempt_id === pending.attempt.purchase_attempt_id,
    'Reload recovers the same original attempt even when localStorage points at a different session');
  const cookie = (await context.cookies()).find(value => value.name === 'ocp_shopping_session');
  assert(cookie && cookie.expires > Date.now() / 1000, 'Local browser identity persists across a normal browser restart');
  await ready(other); await other.locator('#confirm-button').click();
  await other.getByText('购买结果待查询', { exact: true }).waitFor(); await idle(other);
  const noPointer = await current(other);
  await other.evaluate(() => localStorage.clear());
  await other.reload(); await idle(other);
  assert((await current(other)).attempt.purchase_attempt_id === noPointer.attempt.purchase_attempt_id,
    'Server pending discovery recovers an unknown attempt after localStorage is cleared');
  await control({ fault: 'none' });
  await other.route('**/api/sessions', route => route.abort('failed'));
  await back(other, 0);
  await other.locator('#search-button').click(); await idle(other);
  assert((await other.locator('#notice').getAttribute('class')) === 'error'
    && !(await other.locator('#notice').textContent()).includes('模拟订单已确认'),
  'A new request error is visible instead of being hidden by the previous successful order');
  await other.unrouteAll();

  const modelContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const agent = await modelContext.newPage(); agent.on('pageerror', error => errors.push(error.message));
  const browserRequests = [];
  agent.on('request', request => browserRequests.push({ url: request.url(), body: request.postData() || '' }));
  await load(agent, agentBase);
  await agent.locator('[name="flow-mode"][value="agent"]').check();
  await agent.locator('#agent-message').fill('请比较便宜的咖啡，预算不超过15元，一杯。');
  await agent.locator('#budget').fill('15.00');
  await agent.locator('#search-button').click();
  await agent.waitForFunction(() => !document.getElementById('confirm-button').disabled);
  await idle(agent); await card(agent, 2, 'Successful Agent planning automatically opens the quote without a purchase');
  const planned = await current(agent);
  assert(planned.intent.max_total_minor === 1500 && planned.intent.quantity === 1 && planned.quote.total_minor <= 1500,
    'Natural-language planning uses the real backend model adapter and obeys form budget and quantity');
  assert(!planned.attempt && browserRequests.every(request => !request.url.endsWith('/confirm')),
    'The model tool loop stops at a quote and never confirms a purchase');
  assert((await agent.locator('#planning-heading').textContent()) === 'Agent 推荐依据'
    && (await agent.locator('#planning-explanation').textContent()).includes(planned.quote.title)
    && (await agent.locator('#planning-explanation').textContent()).includes(`¥${(planned.quote.total_minor / 100).toFixed(2)}`),
  'The page describes the verified product and final all-in quote instead of unverified model prose');
  assert(browserRequests.every(request => new URL(request.url).origin === agentBase)
    && !JSON.stringify(browserRequests).includes('browser-fixture-not-a-real-key')
    && !(await agent.content()).includes('browser-fixture-not-a-real-key'), 'The model key never enters browser requests or rendered content');
  await agent.screenshot({ path: resolve(output, 'agent-quote.png'), fullPage: true });
  await agent.locator('#cancel-button').click(); await idle(agent);
  await card(agent, 0, 'Cancellation returns to demand without creating an order');
  assert((await current(agent)).phase === 'cancelled'
    && !(await agent.locator('#planning-explanation').textContent()).includes('请核对报价后确认'),
  'Cancelling an Agent quote clears its outdated confirmation instruction');
  assert(!(await agent.locator('#safety-steps').textContent()).includes('接下来可以'),
    'A cancelled quote does not advertise disabled confirmation or quote actions');
  await agent.locator('#agent-message').fill('请比较便宜的咖啡，预算不超过30元，一杯。');
  await agent.locator('#budget').fill('30.00');
  await agent.locator('#search-button').click();
  await agent.waitForFunction(() => !document.getElementById('confirm-button').disabled);
  const beforeManualChoice = await current(agent);
  const alternative = beforeManualChoice.candidates.find(candidate => candidate.entry_id !== beforeManualChoice.selected.entry_id);
  if (!alternative) throw new Error('The isolated catalog must provide an alternative under the 30 yuan budget');
  await back(agent, 1);
  await agent.locator('.coffee-card').filter({ has: agent.getByRole('heading', { name: alternative.title, exact: true }) })
    .getByRole('button', { name: '查看最终报价' }).click();
  await agent.waitForFunction(() => !document.getElementById('confirm-button').disabled);
  const afterManualChoice = await current(agent);
  const selectionExplanation = await agent.locator('#planning-explanation').textContent();
  assert(afterManualChoice.id === beforeManualChoice.id && afterManualChoice.selected.entry_id === alternative.entry_id
    && afterManualChoice.quote.quote_id !== beforeManualChoice.quote.quote_id
    && selectionExplanation.includes(alternative.title) && !selectionExplanation.includes(beforeManualChoice.selected.title)
    && (await agent.locator('#planning-heading').textContent()) !== 'Agent 推荐依据',
  'Manually selecting another candidate in the same session clears the old Agent reason and describes the new quote');
  await agent.screenshot({ path: resolve(output, 'agent-manual-selection.png'), fullPage: true });
  await agent.locator('#confirm-button').click();
  await agent.getByText('模拟订单已确认', { exact: true }).waitFor();
  await idle(agent);
  await card(agent, 3, 'Explicit human confirmation automatically opens the order card');
  assert(await agent.getByText('模拟已支付', { exact: true }).isVisible(), 'Only the subsequent human click completes the B simulated payment');
  await agent.setViewportSize({ width: 390, height: 844 });
  await agent.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert(await agent.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The Agent and recovery UI has no mobile horizontal overflow');
  await agent.screenshot({ path: resolve(output, 'agent-mobile-order.png'), fullPage: true });

  await control({ stop_merchant: true });
  await other.locator('#connection-check').click(); await idle(other);
  assert((await other.locator('#mode-label').textContent()).includes('商家暂不可达'), 'An actual stopped merchant is shown as offline after a health check');
  assert(!(await other.locator('#runtime-note').textContent()).includes('已连接'), 'Offline configuration never claims the merchant is connected');
  await other.screenshot({ path: resolve(output, 'merchant-offline.png'), fullPage: true });
  assert(errors.length === 0, 'No browser JavaScript exceptions across recovery and Agent flows');
  const report = { status: 'passed', scope: 'Real A/B HTTP and browser; model is a local HTTP protocol fixture, not live DeepSeek', checks, errors,
    recovered_attempt: recovered.attempt.purchase_attempt_id, agent_order: (await current(agent)).order.order_id };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: checks.length, scope: report.scope, output }));
} finally { await browser.close(); }
