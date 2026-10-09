import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserRuntime } from './browser-support.mjs';

const origin = process.env.SHOPPING_PREVIEW_URL, provider = process.env.SHOPPING_MODEL_FIXTURE_URL;
if (!origin || !provider || new URL(origin).hostname !== '127.0.0.1' || new URL(provider).hostname !== '127.0.0.1') throw new Error('Use the isolated model-settings-browser-server.ts');
const output = resolve(process.env.SHOPPING_MODEL_HTTP_BROWSER_OUTPUT);
const checks = [], errors = [], mutations = [];
const check = (name, value) => { checks.push({ name, passed: Boolean(value) }); assert.ok(value, name); };
const { chromium, launchOptions } = browserRuntime();
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on('request', request => { if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname); });
  const buyerReady = () => page.waitForFunction(() => !document.getElementById('connection-check').disabled && !document.getElementById('pending-check').disabled
    && document.getElementById('flow-viewport').style.height && !document.querySelector('.is-leaving'));
  await page.goto(`${origin}/demo#api-configuration`);
  await page.waitForFunction(() => document.getElementById('model-settings-status').textContent.includes('待配置'));
  check('First launch requires API configuration despite a legacy environment key', await page.locator('#model-first-run').isVisible());
  check('First launch presents configuration without the demo entry cards', await page.locator('#api-configuration').isVisible()
    && !await page.locator('#demo-entry-view').isVisible());
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => !document.getElementById('connection-check').disabled && !document.getElementById('pending-check').disabled
    && document.getElementById('flow-viewport').style.height);
  await page.locator('#query').fill('尚未提交的低糖拿铁');
  await page.locator('#budget').fill('66.66');
  await page.locator('#quantity').fill('2');
  await page.locator('#fulfillment').selectOption('delivery');
  await page.locator('#delivery-recipient').fill('会话内测试收件人');
  await page.locator('#delivery-phone').fill('13800000000');
  await page.locator('#delivery-address').fill('会话内测试地址一号楼');
  await page.locator('[name="flow-mode"][value="agent"]').check();
  await page.locator('#agent-message').fill('请保留这份尚未提交的口味偏好');
  const buyerDraft = () => page.evaluate(() => ({ query: document.getElementById('query').value, message: document.getElementById('agent-message').value,
    mode: document.querySelector('[name="flow-mode"]:checked').value, budget: document.getElementById('budget').value, quantity: document.getElementById('quantity').value,
    mixed: document.getElementById('mixed-basket').checked, items: [...document.querySelectorAll('.basket-input-row')].map(row => ({ query: row.querySelector('.basket-query').value,
      quantity: row.querySelector('.basket-quantity').value })), step: document.querySelector('.flow-panel.is-active').getAttribute('data-flow-panel'),
    fulfillment: document.getElementById('fulfillment').value, delivery: ['recipient', 'phone', 'address'].map(name => document.getElementById(`delivery-${name}`).value) }));
  const originalDraft = await buyerDraft();
  check('Unconfigured Agent retains the manually entered draft before setup', await page.locator('#search-button').isDisabled());
  await page.locator('#shopping-api-configuration').click();
  await page.waitForFunction(() => !document.getElementById('api-configuration').hidden && !document.getElementById('model-settings-fields').disabled);
  check('Actual setup detour exposes return shopping without a fresh-session flag', await page.locator('#model-return-shopping').isVisible()
    && await page.locator('#user-demo-entry').getAttribute('href') === '/');
  await page.locator('#model-provider').selectOption('custom');
  await page.locator('#model-base-url').fill(provider);
  await page.locator('#model-name').fill('local-http-fixture');
  await page.locator('#model-api-key').fill('browser-fixture-only');
  await page.locator('#model-test').click();
  await page.waitForFunction(() => document.getElementById('model-settings-feedback').textContent.includes('连接成功'));
  check('Draft connection test proves function calling through the actual backend', (await page.locator('#model-settings-feedback').textContent()).includes('工具调用'));
  check('Connection test leaves first-run settings unsaved', (await (await fetch(`${origin}/api/model-settings`)).json()).configured === false);
  check('A test-only action stays on configuration', await page.locator('#api-configuration').isVisible()
    && !await page.locator('#demo-entry-view').isVisible());
  await page.locator('#model-save').click();
  await page.waitForFunction(() => !document.getElementById('demo-entry-view').hidden && document.getElementById('api-configuration').hidden);
  check('Save clears API key input', await page.locator('#model-api-key').inputValue() === '');
  check('Saving opens both entry cards automatically and consumes the edit hash', await page.locator('#user-demo-entry').isVisible()
    && await page.locator('#merchant-demo-entry').isVisible() && !new URL(page.url()).hash);
  const saved = await (await fetch(`${origin}/api/model-settings`)).text();
  check('Actual backend settings view never returns secret', !saved.includes('browser-fixture-only') && JSON.parse(saved).has_api_key === true);
  check('Detour session draft never contains the API key', await page.evaluate(() => !sessionStorage.getItem('ocp-shopping-configuration-draft').includes('browser-fixture-only')));
  await page.locator('#model-return-shopping').click();
  await page.waitForFunction(() => !document.getElementById('connection-check').disabled && !document.getElementById('pending-check').disabled
    && !document.getElementById('search-button').disabled && document.getElementById('flow-viewport').style.height);
  check('Actual settings save and return restore every manually entered shopping field', JSON.stringify(await buyerDraft()) === JSON.stringify(originalDraft));
  check('Actual return consumes private session draft and avoids start=1', await page.evaluate(() => sessionStorage.getItem('ocp-shopping-configuration-draft') === null
    && !JSON.stringify({ ...localStorage }).includes('会话内测试')) && !new URL(page.url()).searchParams.has('start'));
  // Create one real, isolated, simulated paid purchase. No user's model key or preview is involved.
  const paid = await page.evaluate(async () => {
    const post = async (path, body) => {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Paid fixture setup failed: ${response.status} ${path}`);
      return response.json();
    };
    const config = await (await fetch('/api/config')).json();
    const created = await post('/api/sessions', { query: '拿铁', quantity: 1, currency: 'CNY', max_total_minor: 3000,
      merchant_id: config.merchant_id, fulfillment: 'pickup' });
    const searched = await post(`/api/sessions/${created.id}/search`, {});
    const selected = await post(`/api/sessions/${created.id}/quote`, { entry_id: searched.candidates[0].entry_id });
    const confirmed = await post(`/api/sessions/${created.id}/confirm`, { quote_id: selected.quote.quote_id,
      terms_hash: selected.quote.terms_hash, revision: selected.revision });
    localStorage.setItem('ocp-shopping-session-id', confirmed.id);
    return confirmed;
  });
  check('Actual fixture confirms one simulated paid purchase', paid.phase === 'confirmed' && paid.attempt.status === 'confirmed'
    && paid.order.payment_status === 'paid');
  await page.context().request.get(`${origin}/merchant`);
  const merchantOrders = async () => (await (await page.context().request.get(`${origin}/api/merchant-demo/orders`)).json());
  const ordersBefore = await merchantOrders();
  check('Merchant fixture contains exactly the original paid order', ordersBefore.total === 1 && ordersBefore.items[0].order_id === paid.order.order_id);
  const mutationsBefore = mutations.length;
  for (const entry of ['portal', 'direct']) {
    if (entry === 'portal') {
      await page.goto(`${origin}/demo`);
      await page.waitForFunction(() => !document.getElementById('demo-entry-view').hidden);
      check('Portal starts a fresh request after the isolated payment', await page.locator('#user-demo-entry').getAttribute('href') === '/?start=1');
      await page.locator('#user-demo-entry').click(); await buyerReady();
      check('Fresh request clears paid projection while retaining its recovery pointer', await page.locator('#query').inputValue() === '拿铁'
        && await page.evaluate(() => localStorage.getItem('ocp-shopping-session-id')) === paid.id
        && await page.locator('#order-section').isHidden());
    } else {
      await page.goto(`${origin}/`); await buyerReady();
      await page.locator('[data-step="0"]').click(); await buyerReady();
    }
    await page.locator('[name="flow-mode"][value="manual"]').check();
    await page.locator('#query').fill(`已支付后尚未提交的${entry}需求`);
    await page.locator('#budget').fill('99.99'); await page.locator('#quantity').fill('3');
    await page.locator('#mixed-basket').check();
    const rows = page.locator('.basket-input-row');
    await rows.nth(0).locator('.basket-query').fill('低糖拿铁'); await rows.nth(0).locator('.basket-quantity').fill('2');
    await rows.nth(1).locator('.basket-query').fill('美式'); await rows.nth(1).locator('.basket-quantity').fill('1');
    await page.locator('#fulfillment').selectOption('delivery');
    await page.locator('#delivery-recipient').fill('会话内测试已支付收件人');
    await page.locator('#delivery-phone').fill('13800000000');
    await page.locator('#delivery-address').fill('会话内测试已支付新需求地址');
    await page.locator('[name="flow-mode"][value="agent"]').check();
    await page.locator('#agent-message').fill('已支付后这份新口味草稿仍未提交');
    // The existing settings link belongs to Agent controls. Keep the edited manual basket fields, then use its visible link.
    const beforePaidDetour = await buyerDraft();
    await page.locator('#shopping-api-configuration').click();
    await page.waitForFunction(() => !document.getElementById('model-settings-fields').disabled);
    await page.locator('#model-save').click();
    await page.waitForFunction(() => !document.getElementById('demo-entry-view').hidden && document.getElementById('api-configuration').hidden);
    await page.locator(entry === 'portal' ? '#model-return-shopping' : '#user-demo-entry').click(); await buyerReady();
    check(`Actual paid ${entry} draft restores all fields after API save and return`, JSON.stringify(await buyerDraft()) === JSON.stringify(beforePaidDetour));
    const recovered = await page.evaluate(async id => (await (await fetch(`/api/sessions/${id}`)).json()), paid.id);
    check(`Actual paid ${entry} recovery advances revision but preserves purchase identity`, recovered.revision > paid.revision
      && recovered.attempt.purchase_attempt_id === paid.attempt.purchase_attempt_id && recovered.order.order_id === paid.order.order_id
      && recovered.order.payment_status === 'paid');
    check(`Actual paid ${entry} return consumes the private draft and avoids start=1`, await page.evaluate(() => sessionStorage.getItem('ocp-shopping-configuration-draft') === null
      && !JSON.stringify({ ...localStorage }).includes('会话内测试')) && !new URL(page.url()).searchParams.has('start'));
  }
  const ordersAfter = await merchantOrders();
  check('Paid configuration detours create no new session, quote, confirmation or checkout', ordersAfter.total === ordersBefore.total
    && ordersAfter.items[0].order_id === paid.order.order_id && mutations.slice(mutationsBefore).every(path => path === '/api/model-settings' || path.endsWith('/recover')));
  await page.goto(`${origin}/demo`);
  await page.waitForFunction(() => !document.getElementById('demo-entry-view').hidden && document.getElementById('api-configuration').hidden);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('demo-entry-view').hidden && document.getElementById('api-configuration').hidden);
  check('A configured reload shows the entry page without configuration', await page.locator('#demo-entry-view').isVisible()
    && !await page.locator('#api-configuration').isVisible());
  check('Reload retains saved fields and does not populate secret', await page.locator('#model-name').inputValue() === 'local-http-fixture' && await page.locator('#model-api-key').inputValue() === '');
  check('API key is absent from browser storage', await page.evaluate(() => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes('browser-fixture-only')));
  check('Entry page exposes the requested edit configuration link', await page.locator('#model-edit-config').isVisible()
    && (await page.locator('#model-edit-config').textContent()).trim() === '更改api配置');
  await page.locator('#model-edit-config').click();
  check('Edit opens the saved configuration without entry cards', await page.locator('#api-configuration').isVisible()
    && !await page.locator('#demo-entry-view').isVisible() && await page.locator('#model-back-to-entry').isVisible());
  await page.locator('#model-back-to-entry').click();
  check('Back returns to the entry page', await page.locator('#demo-entry-view').isVisible() && !await page.locator('#api-configuration').isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  check('Actual entry page fits mobile width', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'configured-entry-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.locator('#user-demo-entry').click();
  await page.waitForFunction(() => document.getElementById('mode-label').textContent.includes('在线'));
  check('Saved model enables buyer Agent without server restart', (await (await fetch(`${origin}/api/config`)).json()).llm_status === 'configured');
  check('Buyer links directly to API configuration', await page.locator('a[href="/demo#api-configuration"]').count() > 0);
  await page.goto(`${origin}/demo#api-configuration`);
  await page.waitForFunction(() => document.getElementById('model-settings-status').textContent.includes('已配置'));
  check('Buyer deep link opens the saved configuration instead of the entry page', await page.locator('#api-configuration').isVisible()
    && !await page.locator('#demo-entry-view').isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  check('Actual configuration page fits mobile width', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'configured-mobile.png'), fullPage: true });
  await page.locator('#model-clear').click();
  await page.locator('#model-clear-confirm').click();
  await page.waitForFunction(() => document.getElementById('model-settings-status').textContent.includes('待配置'));
  check('Clear immediately disables model in actual backend', (await (await fetch(`${origin}/api/config`)).json()).llm_status === 'not_configured');
  check('Clear remains on configuration and requires another save before entry', await page.locator('#api-configuration').isVisible()
    && !await page.locator('#demo-entry-view').isVisible() && !await page.locator('#model-back-to-entry').isVisible());
  check('No browser runtime errors or failed resource requests', errors.length === 0);
  await writeFile(resolve(output, 'browser-report.json'), JSON.stringify({ status: 'passed', checks, errors }, null, 2));
  console.log(`Actual settings HTTP/browser: ${checks.length} checks passed`);
} catch (error) {
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'browser-report.json'), JSON.stringify({ status: 'failed', checks, errors, failure: String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
