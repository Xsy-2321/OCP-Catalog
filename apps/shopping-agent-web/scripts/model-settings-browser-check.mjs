/** Exercise real frontend assets against an isolated local fixture. Never call a model provider. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserRuntime } from '../../../tests/shopping-e2e/browser-support.mjs';
import { parseConfigView, parsePendingSessionsView } from '../public/contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const assets = resolve(root, 'apps/shopping-agent-web/public');
const output = resolve(process.env.SHOPPING_MODEL_SETTINGS_OUTPUT || resolve(root, '.codex-tmp/model-settings-browser-check'));
const empty = () => ({ configured: false, protocol: 'openai', base_url: '', model: '', timeout_ms: 30000, has_api_key: false, source: 'none' });
const checks = [], pageErrors = [], externalRequests = [], mutations = [];
let settings = empty(), testCalls = 0, testFailure = false, saveFailure = false, loadFailure = false, browser;
const assetMap = new Map([['/', 'index.html'], ['/demo', 'demo.html'], ...['styles.css', 'merchant.css', 'model-settings.css', 'model-settings.js',
  'app.js', 'view-model.js', 'contracts.js', 'api-client.js', 'dom.js', 'coffee-bg.svg'].map(file => [`/${file}`, file])]);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const json = (body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
  try {
    if (request.method === 'GET' && path === '/api/config') return json(parseConfigView({ mode: 'mock', merchant_id: 'coffee', merchant_demo_available: true,
      payment_mode: 'local_simulated', c0_status: 'integrated', contract_version: '1', llm_status: settings.configured ? 'configured' : 'not_configured',
      llm_model: settings.configured ? settings.model : null, merchant_health: { status: 'mock', message: 'Local fixture only', checked_at: new Date().toISOString() } }));
    if (request.method === 'GET' && path === '/api/sessions/pending') return json(parsePendingSessionsView({ sessions: [] }));
    if (request.method === 'GET' && path === '/api/model-settings') return loadFailure
      ? json({ error: { message: '本地样例：暂时无法读取配置。' } }, 503) : json(settings);
    if (request.method === 'POST' && path.startsWith('/api/model-settings')) {
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      const changedEndpoint = body.protocol !== settings.protocol || body.base_url !== settings.base_url;
      if (path === '/api/model-settings/test') {
        testCalls++;
        if (testFailure) return json({ error: { code: 'test_failed', message: '本地样例：所选模型暂不支持工具调用。' } }, 400);
        return json({ ok: true, message: '连接与工具调用测试通过。' });
      }
      if (path === '/api/model-settings/clear') { mutations.push({ action: 'clear' }); settings = empty(); return json(settings); }
      if (path === '/api/model-settings') {
        if (saveFailure) return json({ error: { message: '本地样例：配置保存失败，请重试。' } }, 503);
        if ((!settings.has_api_key || changedEndpoint) && !body.api_key) return json({ error: { message: '请填写对应服务的 API 密钥。' } }, 400);
        mutations.push({ action: 'save', includedKey: Boolean(body.api_key), protocol: body.protocol, base_url: body.base_url, model: body.model });
        settings = { configured: true, protocol: body.protocol, base_url: body.base_url, model: body.model,
          timeout_ms: body.timeout_ms, has_api_key: true, source: 'local' };
        return json(settings);
      }
    }
    const file = request.method === 'GET' && assetMap.get(path);
    if (!file) { request.resume(); return json({ error: 'not_found' }, 404); }
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
    response.end(await readFile(resolve(assets, file)));
  } catch { json({ error: { message: 'Local fixture failure' } }, 500); }
});

function check(name, condition) { checks.push({ name, passed: Boolean(condition) }); assert.ok(condition, name); }
await mkdir(output, { recursive: true });
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { started_at: new Date().toISOString(), checks, externalRequests, mutations };
let deadline;
async function run() {
  const { chromium, launchOptions } = browserRuntime();
  browser = await chromium.launch({ ...launchOptions, timeout: 15000 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(`${origin}/`)) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  const ready = () => page.waitForFunction(() => !document.getElementById('model-settings-fields').disabled);
  const status = page.locator('#model-settings-status');
  const key = page.locator('#model-api-key');
  const entry = page.locator('#demo-entry-view');
  const configuration = page.locator('#api-configuration');
  const edit = async () => {
    await page.locator('#model-edit-config').click();
    await configuration.waitFor({ state: 'visible' });
  };
  const save = async () => {
    await page.locator('#model-save').click();
    await entry.waitFor({ state: 'visible' });
    await configuration.waitFor({ state: 'hidden' });
    await ready();
  };

  await page.goto(`${origin}/demo`);
  await ready();
  check('First run requests user configuration', await page.locator('#model-first-run').isVisible() && await status.textContent() === '待配置 API');
  check('First run shows configuration exclusively', await configuration.isVisible() && !await entry.isVisible()
    && !await page.locator('#model-edit-config').isVisible());
  check('Shopping and merchant destinations are retained behind configuration', await page.locator('#user-demo-entry').getAttribute('href') === '/?start=1'
    && await page.locator('#merchant-demo-entry').getAttribute('href') === '/merchant');
  check('Provider preset fills base URL and model', await page.locator('#model-base-url').inputValue() === 'https://api.deepseek.com'
    && await page.locator('#model-name').inputValue() === 'deepseek-flash');
  await page.locator('#model-first-run-link').click();
  check('First-run prompt focuses the provider field', await page.locator('#model-provider').evaluate(element => element === document.activeElement));
  await page.screenshot({ path: resolve(output, 'first-run-desktop.png'), fullPage: true });

  const buyer = await page.context().newPage();
  buyer.setDefaultTimeout(12000);
  buyer.on('pageerror', error => pageErrors.push(error.message));
  await buyer.route('**/*', route => {
    if (route.request().url().startsWith(`${origin}/`)) return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  });
  await buyer.goto(origin);
  await buyer.waitForFunction(() => !document.getElementById('connection-check').disabled && document.getElementById('flow-viewport').style.height);
  check('Buyer page shows a direct configuration link', await buyer.locator('a[href="/demo#api-configuration"]').count() >= 1);
  await buyer.locator('[name="flow-mode"][value="agent"]').check();
  await buyer.locator('#agent-message').fill('保留这一份未提交的咖啡偏好');
  await buyer.locator('#budget').fill('44.44');
  await buyer.locator('#quantity').fill('2');
  check('Unconfigured buyer disables Agent submission', await buyer.locator('#search-button').isDisabled());
  const buyerDraft = () => buyer.evaluate(() => ({ message: document.getElementById('agent-message').value, budget: document.getElementById('budget').value,
    quantity: document.getElementById('quantity').value, mode: document.querySelector('[name="flow-mode"]:checked').value }));
  const originalDraft = await buyerDraft();
  await page.bringToFront();

  await key.fill('local-ui-fixture-key');
  await page.locator('#model-key-toggle').click();
  check('Key visibility toggle works', await key.getAttribute('type') === 'text');
  await page.locator('#model-test').click();
  await page.locator('#model-settings-feedback.success').waitFor();
  await ready();
  check('Initial test proves capability but keeps configuration as the only view', !settings.configured && testCalls === 1 && mutations.length === 0
    && await configuration.isVisible() && !await entry.isVisible());
  saveFailure = true;
  await page.locator('#model-save').click();
  await page.locator('#model-settings-feedback.error').waitFor();
  await ready();
  check('A failed first save keeps configuration open and does not enable entry', !settings.configured && mutations.length === 0
    && await configuration.isVisible() && !await entry.isVisible());
  saveFailure = false;
  await save();
  check('Saving clears the key and returns to password mode', await key.inputValue() === '' && await key.getAttribute('type') === 'password');
  check('Saving hides the first-run prompt', !await page.locator('#model-first-run').isVisible() && (await status.textContent()).startsWith('已配置'));
  check('Saving automatically shows both entry cards and hides configuration', await entry.isVisible() && !await configuration.isVisible()
    && await page.locator('#user-demo-entry').isVisible() && await page.locator('#merchant-demo-entry').isVisible() && !new URL(page.url()).hash);
  check('Entry view exposes the requested upper-right edit text', await page.locator('#model-edit-config').isVisible()
    && (await page.locator('#model-edit-config').textContent()).trim() === '更改api配置');
  check('Configuration does not use browser storage', await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0));
  await buyer.bringToFront();
  await buyer.evaluate(() => window.dispatchEvent(new Event('focus')));
  await buyer.waitForFunction(() => !document.getElementById('search-button').disabled);
  check('Returning to buyer after a save enables Agent without a reload', !await buyer.locator('#search-button').isDisabled());
  check('Refreshing API configuration preserves the buyer draft', JSON.stringify(await buyerDraft()) === JSON.stringify(originalDraft));
  await page.bringToFront();

  await page.reload();
  await ready();
  check('Configured reload opens the entry view exclusively', await entry.isVisible() && !await configuration.isVisible());
  check('Reload restores public settings without revealing key', await page.locator('#model-name').inputValue() === 'deepseek-flash'
    && await key.inputValue() === '' && !await key.evaluate(element => element.required));
  await page.goto(`${origin}/demo`);
  await ready();
  check('A fresh configured demo visit defaults to the entry view', await entry.isVisible() && !await configuration.isVisible());
  await page.screenshot({ path: resolve(output, 'configured-entry-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  check('Mobile entry view has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(output, 'configured-entry-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await edit();
  check('Edit control opens configuration exclusively with a back action', await configuration.isVisible() && !await entry.isVisible()
    && await page.locator('#model-back-to-entry').isVisible());
  await page.locator('#model-back-to-entry').click();
  check('Back action returns to entries without a settings mutation', await entry.isVisible() && !await configuration.isVisible() && mutations.length === 1);
  await page.goto(`${origin}/demo#api-configuration`);
  await ready();
  check('The buyer configuration deep link opens editing for a saved model', await configuration.isVisible() && !await entry.isVisible());
  await page.locator('#model-name').fill('fixture-tool-model-v2');
  await page.locator('#model-test').click();
  await page.locator('#model-settings-feedback.success').waitFor();
  check('Testing an edited draft does not save it or leave editing', testCalls === 2 && settings.model === 'deepseek-flash' && mutations.length === 1
    && await configuration.isVisible() && !await entry.isVisible());
  await save();
  check('Blank key retains the saved key for same protocol and endpoint', settings.model === 'fixture-tool-model-v2' && mutations[1].includedKey === false);

  await edit();
  await page.locator('#model-base-url').fill('https://another-api.example/v1');
  check('Changing endpoint requires a replacement key', await key.evaluate(element => element.required));
  await page.locator('#model-save').click();
  check('An endpoint change cannot save a blank key', mutations.length === 2 && !await key.evaluate(element => element.validity.valid));
  await key.fill('local-ui-fixture-replacement');
  await save();
  check('New endpoint uses explicitly supplied key', settings.base_url === 'https://another-api.example/v1' && mutations[2].includedKey === true);

  await edit();
  for (const [provider, protocol] of [['anthropic', 'anthropic'], ['gemini', 'gemini'], ['openai', 'openai']]) {
    await page.locator('#model-provider').selectOption(provider);
    check(`${provider} preset selects its native protocol`, await page.locator('#model-protocol').inputValue() === protocol);
  }
  await page.locator('#model-provider').selectOption('custom');
  await page.locator('#model-protocol').selectOption('gemini');
  check('Custom API allows protocol selection', await page.locator('#model-protocol').inputValue() === 'gemini');
  await page.locator('#model-base-url').fill('https://another-api.example/v1');
  await key.fill('local-ui-fixture-key');
  testFailure = true;
  await page.locator('#model-test').click();
  await page.locator('#model-settings-feedback.error').waitFor();
  check('Test failures are visible and preserve saved configuration', (await page.locator('#model-settings-feedback').textContent()).includes('暂不支持工具调用')
    && settings.protocol === 'openai' && mutations.length === 3);

  await page.locator('#model-clear').click();
  await page.locator('#model-clear-cancel').click();
  check('Cancelling clear preserves configuration', settings.configured && mutations.length === 3);
  await page.locator('#model-clear').click();
  await page.locator('#model-clear-confirm').click();
  await page.locator('#model-settings-feedback.success').waitFor();
  await ready();
  check('Clear returns to first-run state and discards the key input', !settings.configured && await page.locator('#model-first-run').isVisible() && await key.inputValue() === '');
  check('Clear shows configuration exclusively and removes saved-config back action', await configuration.isVisible() && !await entry.isVisible()
    && !await page.locator('#model-back-to-entry').isVisible());
  check('Clear focuses configuration after enabling controls', await page.locator('#model-provider').evaluate(element => element === document.activeElement));
  await buyer.bringToFront();
  await buyer.evaluate(() => window.dispatchEvent(new Event('focus')));
  await buyer.waitForFunction(() => !document.getElementById('connection-check').disabled && document.getElementById('search-button').disabled
    && document.getElementById('model-note').textContent.includes('尚未配置'));
  check('Returning to buyer after clear disables Agent and retains its draft', await buyer.locator('#search-button').isDisabled()
    && JSON.stringify(await buyerDraft()) === JSON.stringify(originalDraft));
  await page.bringToFront();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, 'first-run-mobile.png'), fullPage: true });
  check('Mobile configuration view has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  loadFailure = true;
  await page.reload();
  await page.locator('#model-settings-feedback.error').waitFor();
  await ready();
  check('Read failure keeps configuration error visible with no entry cards', await configuration.isVisible() && !await entry.isVisible()
    && !await page.locator('#model-reload').isDisabled());
  loadFailure = false;
  await page.locator('#model-reload').click();
  await page.waitForFunction(() => !document.getElementById('model-settings-fields').disabled
    && !document.getElementById('model-first-run').hidden && !document.getElementById('model-settings-feedback').classList.contains('error'));
  check('Read retry recovers the unconfigured view', await configuration.isVisible() && !await entry.isVisible());
  check('No browser runtime errors', pageErrors.length === 0);
  check('No external requests', externalRequests.length === 0);
  report.test_calls = testCalls;
  report.status = 'passed';
}

try {
  await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Model settings browser check exceeded 60 seconds')), 60000); })]);
} catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
finally {
  clearTimeout(deadline);
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Model settings browser check: ${report.status}; ${checks.length} checks; ${output}`);
}
