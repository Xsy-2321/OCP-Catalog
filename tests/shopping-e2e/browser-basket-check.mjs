/** Browser acceptance against isolated A/B services; every payment is simulated. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserRuntime } from './browser-support.mjs';
const { chromium, launchOptions } = browserRuntime();
const base = process.env.SHOPPING_PREVIEW_URL;
if (!base || new URL(base).hostname !== '127.0.0.1') throw new Error('Use the isolated browser-http-server --basket-check');
const output = resolve(process.env.SHOPPING_BROWSER_OUTPUT || '.codex-tmp/integration/browser-basket');
await mkdir(output, { recursive: true });
const checks = [], errors = [];
function assert(value, message) { if (!value) throw new Error(message); checks.push(message); }
const browser = await chromium.launch(launchOptions);
const idle = page => page.waitForFunction(() => !document.getElementById('pending-check').disabled);
async function card(page, step, message) {
  await page.waitForFunction(value => document.getElementById(`flow-panel-${value}`).classList.contains('is-active')
    && !document.querySelector('.flow-panel.is-leaving'), step);
  assert(await page.evaluate(value => [...document.querySelectorAll('[data-flow-panel]')].every(panel => {
    const active = Number(panel.dataset.flowPanel) === value;
    return panel.classList.contains('is-active') === active && panel.inert !== active
      && panel.getAttribute('aria-hidden') === String(!active)
      && (getComputedStyle(panel).visibility === 'visible') === active;
  }), step), message);
}
async function back(page, step) {
  const current = Number(await page.locator('[data-flow-panel].is-active').getAttribute('data-flow-panel'));
  if (current < step) throw new Error(`Cannot navigate forward from ${current} to ${step}`);
  if (current > step) await page.locator(`.steps button[data-step="${step}"]`).click();
  await card(page, step, `Returning to card ${step + 1} leaves every other card hidden and inert`);
}
async function current(page) {
  return page.evaluate(async () => (await fetch(`/api/sessions/${localStorage.getItem('ocp-shopping-session-id')}`)).json());
}
async function chooseBasket(page) {
  await page.locator('[data-group-index="0"][data-entry-id="entry_latte"]').click();
  await page.locator('[data-group-index="1"][data-entry-id="entry_americano"]').click();
  await page.locator('#basket-quote-button').click(); await idle(page);
  await card(page, 2, 'A complete basket quote automatically opens the sole quote card');
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await idle(page);
  await card(page, 0, 'The basket flow begins with only the demand card visible');
  await page.locator('#mixed-basket').check();
  await page.locator('.basket-query').nth(1).fill('咖啡');
  await page.locator('#budget').fill('40.00');
  assert(await page.locator('#quantity').inputValue() === '2', 'Manual basket derives the total cup count from all lines');
  await page.locator('#fulfillment').selectOption('delivery');
  await page.locator('#delivery-recipient').fill('浏览器验收');
  await page.locator('#delivery-phone').fill('13800000000');
  await page.locator('#delivery-address').fill('测试大学一号楼101室');
  await page.locator('#search-button').click(); await idle(page);
  await card(page, 1, 'A mixed-product search automatically opens the candidate card');
  assert(await page.locator('.candidate-group-heading').count() === 2, 'Search presents each requested product as its own candidate group');
  assert(await page.locator('#basket-quote-button').isDisabled(), 'Incomplete basket selection cannot request a partial quote');
  await chooseBasket(page);
  const quoted = await current(page);
  assert(quoted.phase === 'awaiting_confirmation' && quoted.quote.items.length === 2, 'Mixed products produce one confirmable quote');
  assert(quoted.quote.total_minor === 3990 && quoted.quote.fees.length === 1, 'Delivery fee is charged once and the total is 39.90 yuan');
  const text = await page.locator('#quote-content').textContent();
  assert(text.includes('拿铁 × 1') && text.includes('美式 × 1') && text.includes('¥39.90') && text.includes('测试大学一号楼101室'), 'Quote displays both products, fees, actual total and the delivery address');
  assert(!quoted.attempt, 'Search and quote never execute a purchase');
  await page.screenshot({ path: resolve(output, 'mixed-delivery-quote.png'), fullPage: true });
  await page.locator('#flow-back').click();
  await card(page, 1, 'The previous button returns from quote to basket selection');
  await page.locator('[data-group-index="1"][data-entry-id="entry_latte"]').click();
  assert(await page.locator('#confirm-button').isDisabled() && await page.locator('#quote-section').evaluate(section => section.hidden),
    'Changing a basket selection invalidates the old quote independently of navigation visibility');
  await page.locator('[data-group-index="1"][data-entry-id="entry_americano"]').click();
  await page.locator('#basket-quote-button').click(); await idle(page);
  await card(page, 2, 'Requoting the complete basket automatically returns to the quote card');
  assert(!(await page.locator('#confirm-button').isDisabled()) && (await current(page)).quote.quote_id !== quoted.quote.quote_id, 'A fresh whole-basket quote restores confirmation');
  await back(page, 0);
  assert(await page.locator('#delivery-address').inputValue() === '测试大学一号楼101室', 'Going back preserves the delivery form before editing');
  await page.locator('#delivery-address').fill('测试大学二号楼202室');
  assert(await page.locator('#confirm-button').isDisabled(), 'Editing the delivery address invalidates UI confirmation until a new quote');
  await page.locator('#connection-check').click(); await idle(page);
  await card(page, 0, 'Refreshing facts does not move an edited delivery form forward');
  assert(await page.locator('#delivery-address').inputValue() === '测试大学二号楼202室', 'Refreshing facts preserves the edited delivery address');
  await page.locator('#search-button').click(); await idle(page); await chooseBasket(page);
  const replacement = await current(page);
  assert(replacement.quote.terms_hash !== quoted.quote.terms_hash && replacement.quote.delivery.address === '测试大学二号楼202室', 'New delivery details appear in a new signed quote');
  await page.locator('#confirm-button').click(); await idle(page);
  await card(page, 3, 'Confirming the delivery basket automatically opens only the order card');
  const paid = await current(page);
  assert(paid.phase === 'confirmed' && paid.order.items.length === 2 && paid.order.fulfillment === 'delivery', 'Explicit confirmation creates one whole delivery order');
  assert((await page.locator('#order-content').textContent()).includes('测试大学二号楼202室'), 'Order displays the confirmed delivery details');
  await page.reload(); await idle(page);
  await card(page, 3, 'Reload restores the original order card');
  const recovered = await current(page);
  assert(recovered.order.order_id === paid.order.order_id && JSON.stringify(recovered.order.items) === JSON.stringify(paid.order.items), 'Reload recovers the original complete order');
  assert(await page.locator('#delivery-address').inputValue() === '测试大学二号楼202室' && await page.locator('.basket-query').count() === 2, 'Reload restores the basket and delivery form');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The horizontal basket cards do not overflow a mobile viewport');
  await page.screenshot({ path: resolve(output, 'mixed-delivery-order.png'), fullPage: true });
  const next = await browser.newPage(); next.on('pageerror', error => errors.push(error.message));
  await next.goto(base); await idle(next);
  await card(next, 0, 'A separate browser identity starts at the demand card');
  await next.locator('#query').fill('手冲礼盒'); await next.locator('#budget').fill('100.00');
  await next.locator('#fulfillment').selectOption('delivery');
  await next.locator('#delivery-recipient').fill('浏览器验收'); await next.locator('#delivery-phone').fill('13800000000');
  await next.locator('#delivery-address').fill('测试大学一号楼101室');
  await next.locator('#search-button').click(); await idle(next);
  await card(next, 1, 'An empty search result still opens the candidate card with its empty state');
  assert((await current(next)).candidates.length === 0, 'Pickup-only products are not offered for delivery');
  assert(errors.length === 0, 'Browser has no JavaScript errors');
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, output }));
} catch (error) {
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: checks.length, checks, errors,
    failure: error instanceof Error ? error.message : String(error) }, null, 2)); throw error;
} finally { await browser.close(); }
