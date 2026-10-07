import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SHOPPING_PLAYWRIGHT_PATH || 'playwright');
const base = process.env.SHOPPING_PREVIEW_URL;
if (!base || new URL(base).hostname !== '127.0.0.1') throw new Error('Supply an isolated loopback HTTP preview');
const output = resolve(process.env.SHOPPING_BROWSER_OUTPUT ?? '.codex-tmp/integration/browser-evidence');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.SHOPPING_BROWSER_EXE ? { executablePath: process.env.SHOPPING_BROWSER_EXE } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], checks = [], purchases = [];
page.on('pageerror', error => errors.push(error.message));
function assert(value, description) { if (!value) throw new Error(description); checks.push(description); }
async function ready() {
  await page.getByRole('button', { name: '寻找咖啡' }).click();
  await page.getByRole('button', { name: '查看最终报价' }).first().waitFor();
  await page.getByRole('button', { name: '查看最终报价' }).first().click();
  await page.waitForFunction(() => !document.getElementById('confirm-button').disabled);
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
  assert((await page.locator('#mode-label').textContent()).includes('HTTP'), 'Page reports actual B HTTP and local simulated payment');
  await ready();
  assert((await page.locator('#quote-content').textContent()).includes('¥25.00'), 'B all-in 25 yuan quote is displayed under 30 yuan budget');
  assert((await current()).attempt === undefined, 'No attempt exists before the user clicks confirm');
  await page.screenshot({ path: resolve(output, 'http-quote.png'), fullPage: true });
  await page.getByRole('button', { name: '确认并模拟购买' }).click();
  await page.getByText('模拟订单已确认', { exact: true }).waitFor();
  assert(await page.getByText('模拟已支付', { exact: true }).isVisible(), 'A confirmation route returns B paid order');
  assert(await page.getByText('待履约', { exact: true }).isVisible(), 'Payment does not imply coffee is ready or collected');
  const first = await current(); purchases.push(first);
  await page.reload(); await page.getByText('模拟订单已确认', { exact: true }).waitFor();
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
  assert(await page.getByRole('button', { name: '寻找咖啡' }).isDisabled(), 'Lost confirmed response locks new purchases');
  assert(await page.getByRole('button', { name: '取消本次购买' }).isDisabled(), 'Lost response locks cancellation and replacement');
  await page.screenshot({ path: resolve(output, 'http-response-lost.png'), fullPage: true });
  await page.unrouteAll(); await page.reload();
  await page.getByText('模拟订单已确认', { exact: true }).waitFor();
  const recovered = await current(); purchases.push(recovered);
  assert(committed.phase === 'confirmed' && recovered.order.order_id === committed.order.order_id,
    'Refresh after committed response loss recovers the same B order');
  assert(recovered.attempt.purchase_attempt_id === committed.attempt.purchase_attempt_id,
    'Recovery retains the original attempt');
  assert(await page.getByRole('button', { name: '确认并模拟购买' }).isDisabled(), 'Recovery does not authorize another checkout');
  assert(errors.length === 0, 'No page JavaScript exceptions');
  await page.screenshot({ path: resolve(output, 'http-recovered-order.png'), fullPage: true });
  const report = { status: 'passed', payment: 'local_simulated', mode: 'http', checks, purchases, errors };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: checks.length,
    order_ids: purchases.map(value => value.order.order_id), output }));
} finally { await browser.close(); }
