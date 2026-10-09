import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserRuntime } from './browser-support.mjs';
const { chromium, launchOptions } = browserRuntime();
const base = process.env.SHOPPING_PREVIEW_URL;
if (!base || new URL(base).hostname !== '127.0.0.1') throw new Error('Supply an isolated loopback HTTP preview');
const output = resolve(process.env.SHOPPING_BROWSER_OUTPUT ?? '.codex-tmp/integration/browser-evidence');
await mkdir(output, { recursive: true });
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], checks = [], purchases = [];
let confirmRequests = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/confirm')) confirmRequests++; });
function assert(value, description) { if (!value) throw new Error(description); checks.push(description); }
const idle = () => page.waitForFunction(() => !document.getElementById('pending-check').disabled);
async function card(step, description) {
  await page.waitForFunction(value => document.getElementById(`flow-panel-${value}`).classList.contains('is-active')
    && !document.querySelector('.flow-panel.is-leaving'), step);
  assert(await page.evaluate(value => [...document.querySelectorAll('[data-flow-panel]')].every(panel => {
    const active = Number(panel.dataset.flowPanel) === value;
    return panel.classList.contains('is-active') === active && panel.inert !== active
      && panel.getAttribute('aria-hidden') === String(!active)
      && (getComputedStyle(panel).visibility === 'visible') === active;
  }), step), description);
}
async function back(step) {
  const current = Number(await page.locator('[data-flow-panel].is-active').getAttribute('data-flow-panel'));
  if (current < step) throw new Error(`Cannot navigate forward from ${current} to ${step}`);
  if (current > step) await page.locator(`.steps button[data-step="${step}"]`).click();
  await card(step, `Returning to card ${step + 1} preserves a single accessible card`);
}
async function ready() {
  await back(0);
  await page.getByRole('button', { name: '寻找咖啡' }).click();
  await idle(); await card(1, 'Searching advances automatically to candidates');
  await page.getByRole('button', { name: '查看最终报价' }).first().waitFor();
  await page.getByRole('button', { name: '查看最终报价' }).first().click();
  await page.waitForFunction(() => !document.getElementById('confirm-button').disabled);
  await idle(); await card(2, 'A successful quote advances automatically to its quote card');
}
async function current() {
  return page.evaluate(async () => {
    const id = localStorage.getItem('ocp-shopping-session-id');
    return (await fetch(`/api/sessions/${id}`)).json();
  });
}
try {
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('search-button').disabled);
  await card(0, 'Initial HTTP shopping exposes only the demand card');
  const connectionLabel = await page.locator('#mode-label').textContent();
  assert(connectionLabel.length > 0 && !/\bHTTP\b|\bMOCK\b/.test(connectionLabel)
    && (await page.locator('#runtime-note').textContent()).includes('模拟'), 'Connection and payment guidance uses customer language');
  assert(await page.locator('.steps button[data-step="3"]').isDisabled(), 'An unvisited order step cannot be clicked');
  await page.locator('.steps button[data-step="3"]').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await card(0, 'Synthetic forward navigation cannot leave the demand card');
  assert(confirmRequests === 0, 'Forward navigation never authorizes a purchase');
  await ready();
  assert((await page.locator('#quote-content').textContent()).includes('¥25.00'), 'B all-in 25 yuan quote is displayed under 30 yuan budget');
  assert((await current()).attempt === undefined, 'No attempt exists before the user clicks confirm');
  await page.screenshot({ path: resolve(output, 'http-quote.png'), fullPage: true });
  await page.getByRole('button', { name: '确认并模拟购买' }).click();
  await page.getByText('模拟订单已确认', { exact: true }).waitFor();
  await idle(); await card(3, 'Human confirmation advances to the original order');
  assert(await page.getByText('模拟已支付', { exact: true }).isVisible(), 'A confirmation route returns B paid order');
  assert(await page.getByText('待履约', { exact: true }).isVisible(), 'Payment does not imply coffee is ready or collected');
  const first = await current(); purchases.push(first);
  await page.reload(); await page.getByText('模拟订单已确认', { exact: true }).waitFor();
  await idle(); await card(3, 'Reload automatically restores the saved order card');
  assert((await current()).order.order_id === first.order.order_id, 'Reload recovers the original B order');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile layout has no horizontal overflow');
  await page.screenshot({ path: resolve(output, 'http-mobile-order.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready();
  const beforeLoss = await current();
  let committed;
  await page.route(`**/api/sessions/${beforeLoss.id}/confirm`, async route => {
    const response = await route.fetch(); committed = await response.json(); await route.abort('failed');
  });
  await page.route(`**/api/sessions/${beforeLoss.id}`, route => route.abort('failed'));
  await page.getByRole('button', { name: '确认并模拟购买' }).click();
  await page.getByText('确认请求的结果未知，请查询原购买结果；不要重新购买。').waitFor();
  await idle(); await card(3, 'A lost confirmation response opens the result-query card');
  assert(await page.locator('#search-button').isDisabled(), 'Lost confirmed response locks new purchases');
  assert(await page.locator('#cancel-button').isDisabled(), 'Lost response locks cancellation and replacement');
  await page.screenshot({ path: resolve(output, 'http-response-lost.png'), fullPage: true });
  await back(0);
  assert(await page.locator('#query').isDisabled() && await page.locator('#search-button').isDisabled()
    && await page.locator('#confirm-button').isDisabled(), 'Going back during uncertainty cannot unlock editing or another checkout');
  assert((await page.locator('#notice').textContent()).includes('不要重新购买'), 'The uncertainty warning remains visible on an earlier card');
  await page.unrouteAll(); await page.reload();
  await page.getByText('模拟订单已确认', { exact: true }).waitFor();
  await idle(); await card(3, 'Reload after response loss returns to the recovered original order');
  const recovered = await current(); purchases.push(recovered);
  assert(committed.phase === 'confirmed' && recovered.order.order_id === committed.order.order_id,
    'Refresh after committed response loss recovers the same B order');
  assert(recovered.attempt.purchase_attempt_id === committed.attempt.purchase_attempt_id,
    'Recovery retains the original attempt');
  assert(await page.locator('#confirm-button').isDisabled(), 'Recovery does not authorize another checkout');
  assert(confirmRequests === 2, 'Order recovery and navigation send no duplicate confirmation');
  assert(errors.length === 0, 'No page JavaScript exceptions');
  await page.screenshot({ path: resolve(output, 'http-recovered-order.png'), fullPage: true });
  const report = { status: 'passed', payment: 'local_simulated', mode: 'http', checks, purchases, errors };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: checks.length,
    order_ids: purchases.map(value => value.order.order_id), output }));
} finally { await browser.close(); }
