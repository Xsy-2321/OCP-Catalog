import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserRuntime } from './browser-support.mjs';
const { chromium, launchOptions } = browserRuntime();
const base = process.env.SHOPPING_PREVIEW_URL, control = process.env.SHOPPING_TEST_CONTROL;
if (!base || !control || [base, control].some(url => new URL(url).hostname !== '127.0.0.1')) throw new Error('Use isolated merchant-browser-server');
const output = resolve(process.env.SHOPPING_BROWSER_OUTPUT); await mkdir(output, { recursive: true });
const checks = [], errors = [], requests = [];
const assert = (value, description) => { if (!value) throw new Error(description); checks.push(description); };
const browser = await chromium.launch(launchOptions);
let context, user, shop;
async function openViews(storageState) {
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, ...(storageState ? { storageState } : {}) });
  user = await context.newPage(); shop = await context.newPage();
  for (const page of [user, shop]) page.on('pageerror', error => errors.push(error.message));
  shop.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname }); });
}
await openViews();
const userIdle = () => user.waitForFunction(() => {
  const viewport = document.getElementById('flow-viewport');
  const pendingCheck = document.getElementById('pending-check');
  // Static HTML has an enabled pending button before its ES module runs.
  // Require module-owned layout, completed reads and the final card transition.
  return viewport instanceof HTMLElement && Number.parseFloat(viewport.style.height) > 0
    && pendingCheck instanceof HTMLButtonElement && !pendingCheck.disabled
    && !document.querySelector('.flow-panel.is-leaving');
});
async function userStep(step) {
  await userIdle();
  const navigation = user.locator(`.steps button[data-step="${step}"]`);
  // Earlier cards remain inert until the shopper uses the visible step navigation.
  if (await navigation.getAttribute('aria-current') !== 'step') await navigation.click();
  await user.waitForFunction(target => {
    const panel = document.getElementById(`flow-panel-${target}`);
    return panel.classList.contains('is-active') && !panel.inert && panel.getAttribute('aria-hidden') === 'false';
  }, step);
}
const shopIdle = () => shop.waitForFunction(() => !document.getElementById('merchant-refresh').disabled && document.getElementById('checked-at').textContent.includes('上次成功读取'));
const snapshot = async () => (await fetch(`${control}/snapshot`)).json();
const current = () => user.evaluate(async () => (await fetch(`/api/sessions/${localStorage.getItem('ocp-shopping-session-id')}`)).json());
async function refreshShop() { await shop.locator('#merchant-refresh').click(); await shopIdle(); }
function stock(state, entry) { return state.stock.find(row => row.entry_id === entry).available_quantity; }
try {
  // This isolated browser rehearsal now enters through the first-use API gate.
  // Save a local dummy configuration; the test only uses manual shopping.
  const configured = await context.request.post(`${base}/api/model-settings`, { data: {
    protocol: 'openai', base_url: 'http://127.0.0.1:9/v1', model: 'local-unused-fixture',
    api_key: 'merchant-browser-fixture-only', timeout_ms: 1000,
  } });
  assert(configured.ok(), 'Isolated demo settings unlock the entry view without a model request');
  await shop.goto(`${base}/demo`);
  await shop.locator('#demo-entry-view').waitFor();
  assert(await shop.locator('#user-demo-entry').getAttribute('href') === '/?start=1' && await shop.locator('#merchant-demo-entry').getAttribute('href') === '/merchant', 'Portal provides a fresh buyer entry and a distinct merchant entry');
  assert((await shop.locator('body').textContent()).includes('非'), 'Portal identifies local demo rather than a real login');
  requests.length = 0; // Merchant request assertions begin with the merchant view.
  await user.goto(base); await userIdle();
  const buyerCookies = await context.cookies(`${base}/`);
  const buyerId = buyerCookies.find(cookie => cookie.name === 'ocp_shopping_session').value;
  assert(await user.locator('#demo-navigation').isVisible(), 'Unified demo enables buyer navigation to the two views');
  await shop.goto(`${base}/merchant`); await shopIdle();
  assert((await context.cookies(`${base}/`)).find(cookie => cookie.name === 'ocp_shopping_session').value === buyerId, 'Merchant entry preserves the original buyer identity');
  const initial = await snapshot(); assert(initial.orders === 0 && initial.payments === 0, 'Independent directory starts with no fabricated orders or payments');
  assert((await shop.locator('#order-total').textContent()) === '0', 'Merchant empty order list reflects SQLite');
  const firstRows = await shop.locator('#products-list tr').count();
  if (await shop.locator('#products-more').isVisible()) {
    await shop.locator('#products-more').click();
    await shop.waitForFunction(count => document.querySelectorAll('#products-list tr').length > count, firstRows);
  }
  assert(await shop.locator('#products-list tr').count() === initial.stock.length, 'Product list displays the complete actual catalog without invented items');
  const productText = await shop.locator('#products-list').innerText();
  assert(!initial.stock.some(row => productText.includes(row.entry_id)), 'Product names exclude internal entry identifiers');
  assert(await shop.locator('#merchant-identity').count() === 0 && /^上次成功读取：/.test(await shop.locator('#checked-at').innerText()), 'Top information contains the last successful read time without merchant or catalog identifiers');
  const pageOne = await (await context.request.get(`${base}/api/merchant-demo/products?limit=2`)).json();
  const pageTwo = await (await context.request.get(`${base}/api/merchant-demo/products?limit=2&cursor=${encodeURIComponent(pageOne.next_cursor)}`)).json();
  assert(pageOne.items.length === 2 && pageOne.has_more && pageTwo.items.length > 0
    && !pageOne.items.some(item => pageTwo.items.some(next => item.entry_id === next.entry_id))
    && pageTwo.total === initial.stock.length, 'Bounded pagination reads further real products without duplication');
  assert(await shop.locator('[data-entry-id="entry_soldout"]').count() === 1 && await shop.locator('[data-entry-id="entry_gift_box"]').count() === 1, 'Merchant sees sold-out and pickup-only products');
  assert((await shop.locator('[data-entry-id="entry_latte"]').textContent()).includes('25.00') && (await shop.locator('[data-entry-id="entry_americano"]').textContent()).includes('9.90'), 'Merchant prices come from the existing catalog');
  await refreshShop(); assert(JSON.stringify(await snapshot()) === JSON.stringify(initial), 'Merchant refresh makes no transaction or stock changes');
  await shop.screenshot({ path: resolve(output, 'merchant-products.png'), fullPage: true });
  await userStep(0);
  await user.locator('#mixed-basket').check(); await user.locator('.basket-query').nth(1).fill('美式');
  await user.locator('#budget').fill('40.00'); await user.locator('#fulfillment').selectOption('delivery');
  await user.locator('#delivery-recipient').fill('双端浏览器验收'); await user.locator('#delivery-phone').fill('13800000000');
  await user.locator('#delivery-address').fill('测试大学一号楼101室');
  await user.locator('#search-button').click(); await userIdle();
  await userStep(1);
  await user.locator('[data-group-index="0"][data-entry-id="entry_latte"]').click();
  await userStep(1);
  await user.locator('[data-group-index="1"][data-entry-id="entry_americano"]').click();
  await userStep(1);
  await user.locator('#basket-quote-button').click(); await userIdle();
  const quote = await current(); assert(quote.phase === 'awaiting_confirmation' && quote.quote.total_minor === 3990, 'Original mixed delivery quotation still waits for confirmation at 39.90 yuan');
  await refreshShop(); assert(JSON.stringify(await snapshot()) === JSON.stringify(initial), 'Buyer search and quote do not create a merchant order or reserve stock');
  await userIdle();
  assert(await user.locator('.steps button[data-step="2"]').getAttribute('aria-current') === 'step', 'Buyer confirms only from the active quotation card');
  await user.locator('#confirm-button').click(); await userIdle();
  const purchased = await current(); assert(purchased.phase === 'confirmed', 'Buyer explicitly confirms the complete simulated purchase');
  await refreshShop(); await shop.locator('#orders-tab').click();
  const card = shop.locator(`[data-order-id="${purchased.order.order_id}"]`).first();
  assert(await shop.locator('#orders-list article').count() === 1, 'Merchant refresh shows exactly one new order');
  const text = await card.textContent();
  assert(text.includes('拿铁 × 1') && text.includes('美式 × 1') && text.includes('39.90'), 'Merchant order matches buyer lines, quantities and final total');
  assert(text.includes('模拟已付款') && text.includes('待履约（模拟）') && !text.includes('已送达'), 'Paid order remains pending fulfillment and never claims delivery');
  assert(!text.includes('13800000000') && !text.includes('测试大学一号楼101室'), 'Order list excludes private delivery details');
  assert(![purchased.order.merchant_id, purchased.order.catalog_id, purchased.order.purchase_attempt_id, purchased.order.quote_id,
    ...purchased.order.items.map(item => item.entry_id)].some(id => id && text.includes(id)), 'Order list excludes internal commerce identifiers while retaining its order number');
  const paidState = await snapshot();
  assert(paidState.orders === 1 && paidState.payments === 1 && stock(paidState, 'entry_latte') === stock(initial, 'entry_latte') - 1
    && stock(paidState, 'entry_americano') === stock(initial, 'entry_americano') - 1, 'Both stock lines and one payment synchronize with the actual database');
  await card.locator('button').click(); await shop.waitForFunction(() => document.getElementById('order-detail').textContent.includes('测试大学一号楼101室'));
  const detail = await shop.locator('#order-detail').textContent();
  assert(detail.includes('双端浏览器验收') && detail.includes('13800000000') && detail.includes('配送费') && detail.includes('5.00'), 'Clicked detail reads persisted delivery information and one fee');
  await shop.screenshot({ path: resolve(output, 'merchant-order-detail.png'), fullPage: true });
  await shop.locator('#detail-close').click(); await shop.reload(); await shopIdle(); await shop.locator('#orders-tab').click();
  assert(await shop.locator(`#orders-list [data-order-id="${purchased.order.order_id}"]`).count() === 2, 'Merchant reload retains the same order');
  await user.reload(); await userIdle(); assert((await current()).order.order_id === purchased.order.order_id, 'Buyer reload still recovers the original order');
  // Preserve the demo identity/localStorage while closing the old browser transport
  // before stopping both servers, just as closing and reopening local previews.
  const storageState = await context.storageState();
  await context.close();
  const restartResponse = await fetch(`${control}/restart`, { method: 'POST' });
  if (!restartResponse.ok) throw new Error(`Isolated restart failed: HTTP ${restartResponse.status}`);
  const restarted = await restartResponse.json();
  assert(JSON.stringify(restarted.snapshot) === JSON.stringify(paidState), 'A/B same-directory same-port restart preserves database state');
  await openViews(storageState);
  await shop.goto(`${base}/merchant`); await shopIdle(); await shop.locator('#orders-tab').click();
  assert(await shop.locator('#orders-list article').count() === 1 && (await shop.locator('#orders-list').textContent()).includes(purchased.order.order_id), 'Merchant re-entry after restart reads the preserved order');
  await user.goto(base); await userIdle(); assert((await current()).order.order_id === purchased.order.order_id, 'Buyer identity and order recovery survive both services restarting');
  assert(await user.locator('.steps button[data-step="3"]').getAttribute('aria-current') === 'step'
    && await user.locator('#order-section').isVisible(), 'An ordinary buyer entry still restores the completed order card');

  // A fresh portal entry changes presentation only; completed purchase records
  // and the recovery pointer survive until a new search creates a new session.
  const originalPointer = await user.evaluate(() => localStorage.getItem('ocp-shopping-session-id'));
  await user.goto(`${base}/demo`);
  await user.locator('#user-demo-entry').click(); await userIdle();
  assert(await user.locator('.steps button[data-step="0"]').getAttribute('aria-current') === 'step'
    && await user.evaluate(() => document.getElementById('flow-panel-0').classList.contains('is-active') && !document.getElementById('flow-panel-0').inert),
  'Completed buyers entering through the real portal start on the request card');
  assert(await user.locator('#query').inputValue() === '拿铁' && await user.locator('#budget').inputValue() === '30.00'
    && await user.locator('#quantity').inputValue() === '1' && await user.locator('#fulfillment').inputValue() === 'pickup'
    && !await user.locator('#mixed-basket').isChecked(), 'Fresh portal entry restores the default request instead of the previous mixed delivery draft');
  assert(await user.locator('#notice').isHidden() && await user.locator('#order-section').isHidden()
    && !((await user.locator('body').innerText()).includes(purchased.order.order_id)), 'Fresh portal entry shows no previous completed-order notice or order');
  assert(new URL(user.url()).pathname === '/' && new URL(user.url()).search === '', 'The fresh-entry flag is consumed from the browser URL');
  assert(await user.evaluate(() => localStorage.getItem('ocp-shopping-session-id')) === originalPointer
    && (await context.cookies(`${base}/`)).find(cookie => cookie.name === 'ocp_shopping_session').value === buyerId,
  'Fresh portal entry preserves the original recovery pointer and buyer cookie');
  const preservedOrder = await (await context.request.get(`${base}/api/sessions/${encodeURIComponent(originalPointer)}`)).json();
  assert(preservedOrder.phase === 'confirmed' && preservedOrder.order.order_id === purchased.order.order_id
    && preservedOrder.attempt.purchase_attempt_id === purchased.attempt.purchase_attempt_id,
  'Fresh portal entry preserves the server order and its original purchase attempt');
  const laterSteps = await user.locator('.steps button[data-step]').evaluateAll(buttons => buttons.slice(1).map(button => button.disabled));
  assert(laterSteps.length === 3 && laterSteps.every(Boolean)
    && await user.evaluate(() => [1, 2, 3].every(step => document.getElementById(`flow-panel-${step}`).inert)),
  'The first card cannot skip directly to candidates, quotation or order');
  assert(JSON.stringify(await snapshot()) === JSON.stringify(paidState), 'Fresh portal entry creates no transaction and changes no saved stock');

  await user.locator('#search-button').click(); await userIdle();
  const nextSearch = await current();
  assert(nextSearch.id !== originalPointer && nextSearch.phase === 'candidates' && !nextSearch.attempt && !nextSearch.order
    && await user.locator('.steps button[data-step="1"]').getAttribute('aria-current') === 'step',
  'A new search creates a distinct session and advances to the candidate card without buying');
  await userStep(1);
  await user.locator('#candidates [data-entry-id="entry_latte"]').click(); await userIdle();
  const nextQuote = await current();
  assert(nextQuote.id === nextSearch.id && nextQuote.phase === 'awaiting_confirmation'
    && nextQuote.quote.total_minor === 2500 && nextQuote.quote.quote_id !== purchased.quote.quote_id
    && !nextQuote.attempt && !nextQuote.order && await user.locator('.steps button[data-step="2"]').getAttribute('aria-current') === 'step',
  'A new successful quotation advances to its own confirmation card without a second purchase');
  assert(JSON.stringify(await snapshot()) === JSON.stringify(paidState), 'New search and quotation retain the single original payment, order, attempt and stock');
  const unpaidEntryRequests = [];
  const recordUnpaidEntryRequest = request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) unpaidEntryRequests.push({ method: request.method(), path });
  };
  user.on('request', recordUnpaidEntryRequest);
  await user.goto(`${base}/demo`);
  await user.locator('#user-demo-entry').click(); await userIdle();
  user.off('request', recordUnpaidEntryRequest);
  const portalQuote = await current();
  assert(portalQuote.id === nextQuote.id && portalQuote.quote.quote_id === nextQuote.quote.quote_id
    && portalQuote.phase === 'awaiting_confirmation' && !portalQuote.attempt && !portalQuote.order
    && await user.locator('.steps button[data-step="2"]').getAttribute('aria-current') === 'step'
    && await user.locator('#quote-section').isVisible(), 'An unpaid buyer returning through the real portal resumes the original quotation and confirmation card');
  assert(new URL(user.url()).search === '' && await user.evaluate(() => localStorage.getItem('ocp-shopping-session-id')) === nextQuote.id,
    'The unpaid portal entry consumes its flag while retaining the original quotation recovery pointer');
  assert(unpaidEntryRequests.length > 0 && unpaidEntryRequests.every(request => request.method === 'GET')
    && JSON.stringify(await snapshot()) === JSON.stringify(paidState), 'An unpaid portal entry only reads the saved progress without creating a session, confirming or changing the single purchase');
  await user.reload(); await userIdle();
  const restoredQuote = await current();
  assert(restoredQuote.id === nextQuote.id && restoredQuote.quote.quote_id === nextQuote.quote.quote_id
    && restoredQuote.phase === 'awaiting_confirmation' && !restoredQuote.attempt
    && await user.locator('.steps button[data-step="2"]').getAttribute('aria-current') === 'step'
    && await user.locator('#quote-section').isVisible(), 'Reloading the clean buyer URL restores the new quotation on its confirmation card');
  const retainedOriginal = await (await context.request.get(`${base}/api/sessions/${encodeURIComponent(originalPointer)}`)).json();
  assert(retainedOriginal.order.order_id === purchased.order.order_id && retainedOriginal.attempt.purchase_attempt_id === purchased.attempt.purchase_attempt_id,
    'The original completed order remains accessible after starting and restoring a new quotation');
  const lastSuccessfulRead = await shop.locator('#checked-at').innerText();
  await shop.route('**/api/merchant-demo/overview', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'merchant_read_unavailable', message: '验收：商家数据暂时不可用' } }) }));
  await refreshShop(); assert(await shop.locator('#orders-list article').count() === 0 && (await shop.locator('#merchant-notice').textContent()).includes('不可用'), 'Read failure clears stale data and shows unavailable without fake fallback');
  assert(await shop.locator('#checked-at').innerText() === lastSuccessfulRead, 'Failed refresh preserves the last successful read time');
  await shop.unroute('**/api/merchant-demo/overview'); await refreshShop();
  assert(await shop.locator('#orders-list article').count() === 1, 'A fresh valid snapshot restores the actual records');
  await shop.setViewportSize({ width: 390, height: 844 }); await shop.locator('#orders-list button').click();
  await shop.waitForFunction(() => document.getElementById('order-detail').textContent.includes('测试大学一号楼101室'));
  assert(await shop.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Merchant view fits a mobile screen');
  assert(await shop.evaluate(() => { const dialog = document.getElementById('order-dialog'); return dialog.scrollWidth <= dialog.clientWidth + 1; }), 'Order detail fits a mobile screen');
  await shop.screenshot({ path: resolve(output, 'merchant-mobile-detail.png'), fullPage: true });
  assert(requests.length > 0 && requests.every(request => request.method === 'GET' && request.path.startsWith('/api/merchant-demo/')), 'Merchant browser uses only dedicated read routes and never recovers or buys');
  assert(JSON.stringify(await snapshot()) === JSON.stringify(paidState), 'All later reads, errors and reloads retain one payment and one order');
  assert(errors.length === 0, 'Both pages have no JavaScript errors');
  await writeFile(resolve(output, 'browser-report.json'), JSON.stringify({ passed: checks.length, checks, errors, merchantRequests: requests, order_id: purchased.order.order_id }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, output }));
} catch (error) {
  await writeFile(resolve(output, 'browser-report.json'), JSON.stringify({ passed: checks.length, checks, errors, failure: error.message }, null, 2)); throw error;
} finally { await context.close(); await browser.close(); }
