// Optional real-browser QA. Uses an isolated browser context and local mock API only.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserRuntime } from './browser-support.mjs';
const { chromium, launchOptions } = browserRuntime();
const base = process.env.SHOPPING_PREVIEW_URL || 'http://127.0.0.1:4310';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Browser QA only accepts a local mock preview');
const output = resolve(import.meta.dirname, '../../.codex-tmp/shopping-browser-qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const results = [];
function assert(value, message) { if (!value) throw new Error(message); results.push(message); }
const idle = () => page.waitForFunction(() => !document.getElementById('pending-check').disabled);
async function card(step, message) {
  await page.waitForFunction(value => document.getElementById(`flow-panel-${value}`).classList.contains('is-active')
    && !document.querySelector('.flow-panel.is-leaving'), step);
  assert(await page.evaluate(value => [...document.querySelectorAll('[data-flow-panel]')].every(panel => {
    const active = Number(panel.dataset.flowPanel) === value;
    return panel.classList.contains('is-active') === active && panel.inert !== active
      && panel.getAttribute('aria-hidden') === String(!active)
      && (getComputedStyle(panel).visibility === 'visible') === active;
  }), step), message);
}
async function back(step) {
  const current = Number(await page.locator('[data-flow-panel].is-active').getAttribute('data-flow-panel'));
  if (current < step) throw new Error(`Cannot navigate forward from ${current} to ${step}`);
  if (current > step) await page.locator(`.steps button[data-step="${step}"]`).click();
  await card(step, `Returning to card ${step + 1} leaves only that card visible and interactive`);
}
try {
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('search-button').disabled);
  assert(await page.title() === '一杯之间 · 用户演示购物助手', 'Chinese user-demo title and initial UI loaded');
  await card(0, 'Only the demand card is initially visible');
  assert(await page.locator('.steps button[data-step="2"]').isDisabled(), 'A future quote step is disabled');
  await page.locator('.steps button[data-step="2"]').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await card(0, 'Synthetic future-step clicks cannot advance the shopping flow');
  await page.screenshot({ path: resolve(output, 'desktop-initial.png'), fullPage: true });
  await page.getByRole('button', { name: '寻找咖啡' }).click();
  await idle(); await card(1, 'Searching advances automatically to the candidate card');
  await page.getByRole('button', { name: '查看最终报价' }).first().waitFor();
  assert(await page.getByRole('button', { name: '查看最终报价' }).count() === 2, 'Two valid latte candidates displayed');
  await page.getByRole('button', { name: '查看最终报价' }).nth(1).click();
  await page.getByText('含全部费用的最终报价超过预算，不能购买。').waitFor();
  await idle(); await card(1, 'A failed over-budget quote does not advance the current card');
  assert(await page.locator('#confirm-button').isDisabled(), '31 yuan final total blocked under 30 yuan budget');
  await page.getByRole('button', { name: '查看最终报价' }).first().click();
  await page.getByRole('button', { name: '确认并模拟购买' }).waitFor();
  await page.waitForFunction(() => !document.getElementById('confirm-button').disabled);
  await idle(); await card(2, 'A valid quote automatically opens its quote card');
  assert((await page.locator('#quote-content').textContent()).includes('¥28.00'), 'All-in 28 yuan quote displayed');
  await page.screenshot({ path: resolve(output, 'desktop-quote.png'), fullPage: true });
  await page.getByRole('button', { name: '确认并模拟购买' }).click();
  await page.getByText('模拟订单已确认', { exact: true }).waitFor();
  await idle(); await card(3, 'Explicit confirmation automatically opens the order card');
  assert(await page.getByText('模拟已支付', { exact: true }).isVisible(), 'Explicit UI click leads to mock paid order');
  assert(await page.getByText('制作中', { exact: true }).isVisible(), 'Fulfillment remains preparing, separate from payment');
  const attempt = await page.locator('#order-content').textContent();
  await page.reload();
  await page.getByText('模拟订单已确认', { exact: true }).waitFor();
  await idle(); await card(3, 'Reload recovers the original order card');
  assert(await page.locator('#order-content').textContent() === attempt, 'Reload recovers original order and attempt');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, 'mobile-order.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile page has no horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await back(0);
  await page.getByRole('button', { name: '寻找咖啡' }).click();
  await page.getByRole('button', { name: '查看最终报价' }).first().waitFor();
  await idle(); await card(1, 'A new request opens fresh candidates after returning from an order');
  await page.getByRole('button', { name: '查看最终报价' }).first().click();
  await page.waitForFunction(() => !document.getElementById('confirm-button').disabled);
  await idle(); await card(2, 'The fresh quote restores explicit confirmation on its own card');
  const id = await page.evaluate(() => localStorage.getItem('ocp-shopping-session-id'));
  await page.route(`**/api/sessions/${id}/confirm`, async route => { await route.fetch(); await route.abort('failed'); });
  await page.route(`**/api/sessions/${id}`, route => route.abort('failed'));
  await page.getByRole('button', { name: '确认并模拟购买' }).click();
  await page.getByText('确认请求的结果未知，请查询原购买结果；不要重新购买。').waitFor();
  await idle(); await card(3, 'An uncertain confirmation opens the recovery result card');
  assert(await page.locator('#search-button').isDisabled(), 'Lost browser response locks new purchase flow');
  assert(await page.getByRole('button', { name: '查询原购买结果' }).isVisible(), 'Unknown result keeps recovery action available');
  assert(await page.locator('#cancel-button').isDisabled(), 'Unknown result disables cancellation and replacement');
  assert(await page.getByText('购买结果待查询', { exact: true }).isVisible(), 'Unknown result never retains a stale success heading');
  await page.unrouteAll();
  await page.getByRole('button', { name: '查询原购买结果' }).click();
  await page.getByText('模拟订单已确认', { exact: true }).waitFor();
  await idle(); await card(3, 'Original-attempt recovery keeps the order result card active');
  assert(await page.locator('#confirm-button').isDisabled(), 'Recovery shows original confirmed purchase without another checkout');
  assert(errors.length === 0, 'No browser JavaScript exceptions');
  const report = { status: 'passed', scope: 'A-only deterministic mock browser QA', checks: results, errors };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
