/** Isolated presentation fixture: no live runtime, database, model or payment. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserRuntime } from './browser-support.mjs';
import { parseMerchantOverviewView, parseMerchantOrderDetail } from '../../apps/shopping-agent-web/public/contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assets = resolve(root, 'apps/shopping-agent-web/public');
const output = resolve(process.env.SHOPPING_MERCHANT_PRESENTATION_OUTPUT || resolve(root, '.codex-tmp/merchant-presentation-check'));
const checks = [], errors = [], requests = [];
const internalIds = {
  merchant: 'merchant_internal_fixture', catalog: 'catalog_internal_fixture', entry: 'entry_internal_fixture',
  attempt: 'attempt_internal_fixture', quote: 'quote_internal_fixture', location: 'location_internal_fixture',
};
const at = '2000-01-01T00:00:00.000Z';
const order = parseMerchantOrderDetail({
  order_id: '20261009-001', merchant_id: internalIds.merchant, catalog_id: internalIds.catalog,
  purchase_attempt_id: internalIds.attempt, quote_id: internalIds.quote, currency: 'CNY', terms_hash: 'a'.repeat(64),
  items: [{ entry_id: internalIds.entry, title: '焦糖拿铁', quantity: 2, unit_minor: 2500, line_total_minor: 5000 }],
  subtotal_minor: 5000, fees: [], total_minor: 5000,
  fulfillment: { method: 'pickup', location_id: internalIds.location },
  payment: { status: 'paid', updated_at: at }, fulfillment_status: { status: 'ready', updated_at: at },
  created_at: at, updated_at: at,
});
const overview = parseMerchantOverviewView({
  read_only: true, merchant_id: internalIds.merchant, catalog_id: internalIds.catalog, checked_at: at,
  payment_mode: 'local_simulated', fulfillment_mode: 'local_simulated',
  products: { items: [{ entry_id: internalIds.entry, title: '焦糖拿铁', price_minor: 2500, currency: 'CNY',
    inventory: { availability_status: 'in_stock', available_quantity: 4, reserved_quantity: 1 },
    fulfillment: { methods: ['pickup', 'delivery'], delivery_fee_minor: 500 } }], total: 1, has_more: false, next_cursor: null },
  orders: { items: [order], total: 1, has_more: false, next_cursor: null },
});
const diagnostic = `E:/OCP-Catalog/internal-source.ts ${Object.values(internalIds).join(' ')}`;
let mode = 'success', releaseRead, browser, observeHeldRead;
const heldReadStarted = new Promise(resolveRead => { observeHeldRead = resolveRead; });
const assetMap = new Map([['/merchant', 'merchant.html'], ...['styles.css', 'merchant.css', 'merchant.js', 'contracts.js', 'dom.js', 'api-client.js'].map(file => [`/${file}`, file])]);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  requests.push({ method: request.method, path });
  const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  try {
    if (request.method !== 'GET') return json({ error: { message: 'Fixture is read-only' } }, 405);
    if (path === '/api/merchant-demo/overview') {
      if (mode === 'held') await new Promise(resolveRead => { releaseRead = resolveRead; observeHeldRead(); });
      if (mode === 'failure') return json({ error: { code: 'merchant_read_unavailable', message: diagnostic } }, 503);
      if (mode === 'invalid') return json({ ...overview, products: { ...overview.products, items: [{ ...overview.products.items[0], price_minor: -1 }] } });
      return json(overview);
    }
    if (path === `/api/merchant-demo/orders/${order.order_id}`) return json(order);
    const file = assetMap.get(path);
    if (!file) return json({ error: 'not_found' }, 404);
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' });
    response.end(await readFile(resolve(assets, file)));
  } catch (error) { json({ error: String(error) }, 500); }
});
await mkdir(output, { recursive: true });
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
function check(description, condition) {
  checks.push({ description, passed: Boolean(condition) });
  assert.ok(condition, description);
}
const noIdentifiers = text => !Object.values(internalIds).some(id => text.includes(id));
try {
  const { chromium, launchOptions } = browserRuntime();
  browser = await chromium.launch({ ...launchOptions, timeout: 15_000 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  const idle = () => page.waitForFunction(() => !document.getElementById('merchant-refresh').disabled);
  const readTime = () => page.locator('#checked-at').innerText();
  await page.goto(`${origin}/merchant`); await idle();
  const firstTime = await readTime();
  check('top bar shows only the last successful read time and refresh action', await page.locator('.snapshot-bar p').count() === 1
    && await page.locator('#merchant-identity').count() === 0 && firstTime.startsWith('上次成功读取：') && !firstTime.includes('暂无'));
  check('read time records the successful browser refresh, not a historical fixture timestamp', !firstTime.includes('2000'));
  const productText = await page.locator('#products-list').innerText();
  check('products retain normal names, prices, stock and delivery fees', ['焦糖拿铁', '25.00', '有货', '5.00'].every(text => productText.includes(text)));
  check('product view excludes internal identifiers', noIdentifiers(await page.locator('body').innerText()));
  await page.screenshot({ path: resolve(output, 'merchant-products.png'), fullPage: true });
  await page.locator('#orders-tab').click();
  const orderText = await page.locator('#orders-list').innerText();
  check('order view retains its human order number, item quantity, amount and distinct states',
    [order.order_id, '焦糖拿铁 × 2', '50.00', '模拟已付款', '待取餐（模拟）'].every(text => orderText.includes(text)));
  check('order list excludes internal commerce identifiers', noIdentifiers(orderText));
  await page.locator('#orders-list button').click();
  await page.waitForFunction(() => document.getElementById('order-detail').textContent.includes('整单含费金额'));
  const detailText = await page.locator('#order-detail').innerText();
  check('detail retains human order number, amount and pickup information', [order.order_id, '50.00', '到店自取'].every(text => detailText.includes(text)));
  check('detail excludes internal identifiers and technical pickup location labels', noIdentifiers(detailText) && !detailText.includes('取餐地点标识'));
  await page.screenshot({ path: resolve(output, 'merchant-order-detail.png'), fullPage: true });
  await page.locator('#detail-close').click();
  // The next success should produce a distinct displayed second using the real clock.
  await page.waitForTimeout(1100);
  mode = 'held'; await page.locator('#merchant-refresh').click();
  await heldReadStarted;
  await page.waitForFunction(() => document.getElementById('merchant-refresh').disabled);
  check('an in-flight refresh preserves the previous successful read time', await readTime() === firstTime);
  mode = 'success'; releaseRead(); await idle();
  const secondTime = await readTime();
  check('a successful refresh advances the read time', secondTime !== firstTime);
  mode = 'failure'; await page.locator('#merchant-refresh').click(); await idle();
  check('failed refresh keeps the last successful read time', await readTime() === secondTime);
  check('failed refresh clears unavailable records', await page.locator('#products-list tr').count() === 0 && await page.locator('#orders-list article').count() === 0);
  const failureText = await page.locator('#merchant-notice').innerText();
  check('failure notice gives a local explanation without service diagnostics or source paths', failureText.includes('不可用') && noIdentifiers(failureText) && !failureText.includes('internal-source.ts') && !failureText.includes('E:/'));
  mode = 'invalid'; await page.locator('#merchant-refresh').click(); await idle();
  check('schema-invalid data does not advance the successful read time', await readTime() === secondTime);
  mode = 'success'; await page.locator('#merchant-refresh').click(); await idle();
  check('a valid response restores normal products and orders after failures', await page.locator('#products-list tr').count() === 1 && await page.locator('#orders-list article').count() === 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#orders-list button').click();
  await page.waitForFunction(() => document.getElementById('order-detail').textContent.includes('整单含费金额'));
  check('merchant view fits the mobile viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('order detail fits the mobile dialog', await page.evaluate(() => { const dialog = document.getElementById('order-dialog'); return dialog.scrollWidth <= dialog.clientWidth + 1; }));
  await page.screenshot({ path: resolve(output, 'merchant-mobile.png'), fullPage: true });
  check('all fixture traffic is read-only and remains on the isolated origin', requests.every(request => request.method === 'GET'));
  check('browser has no JavaScript errors', errors.length === 0);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ origin, passed: checks.length, checks, errors, requests, fixtureValidated: true }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, output }));
} catch (error) {
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ origin, passed: checks.filter(check => check.passed).length, checks, errors, failure: error.message }, null, 2));
  throw error;
} finally {
  releaseRead?.();
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
