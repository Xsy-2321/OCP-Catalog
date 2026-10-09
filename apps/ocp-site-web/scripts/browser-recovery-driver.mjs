import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { catalogManifestSchema, catalogQueryRequestSchema } from '@ocp-catalog/ocp-schema';

const origin = new URL(process.env.SITE_PREVIEW_URL).origin;
const output = resolve(process.env.SITE_BROWSER_OUTPUT || '.codex-tmp/site-browser-recovery');
const executablePath = process.env.SITE_BROWSER_EXE || [
  chromium.executablePath(),
  ...(process.platform === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ] : []),
].find((path) => existsSync(path));

let browser;
// The bootstrap also kills this specific child at 60 seconds if shutdown stalls.
const deadline = setTimeout(() => {
  console.error('Site browser recovery check exceeded 55 seconds');
  void browser?.close();
  process.exitCode = 124;
}, 55_000);
try {
  await mkdir(output, { recursive: true });
  if (!executablePath) throw new Error('No installed browser found; set SITE_BROWSER_EXE. This check does not download browsers.');
  console.log(JSON.stringify({ stage: 'launch', origin, output }));
  browser = await chromium.launch({ headless: true, executablePath, timeout: 15_000 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let searches = 0;
  let manifests = 0;
  const manifest = catalogManifestSchema.parse({
    ocp_version: '1.0', kind: 'CatalogManifest', id: 'catalog:recovery',
    catalog_id: 'recovery', catalog_name: 'Recovery catalog',
    endpoints: {
      query: { url: 'https://catalog.test/ocp/query', method: 'POST' },
      resolve: { url: 'https://catalog.test/ocp/resolve', method: 'POST' },
    },
    query_capabilities: [{ capability_id: 'products', query_packs: [{ pack_id: 'product.search', query_modes: ['keyword'] }] }],
    object_contracts: [],
  });

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' },
      body: JSON.stringify(body) });
    if (route.request().method() === 'OPTIONS') return json({});
    if (url.hostname === 'ocp.deeplumen.io' && url.pathname.endsWith('/.well-known/ocp-registration')) {
      return json({ registration_name: 'Recovery registry', catalog_search_url: 'https://registry.test/search' });
    }
    if (url.hostname === 'registry.test') {
      searches += 1;
      if (searches === 1) return json({ error: 'temporary outage' }, 503);
      return json({ items: [{ catalog_id: 'recovery', catalog_name: 'Recovery catalog', manifest_url: 'https://catalog.test/manifest' }] });
    }
    if (url.hostname === 'catalog.test') {
      manifests += 1;
      if (manifests === 1 || manifests === 3) return json({ error: 'temporary outage' }, 503);
      return json(manifest);
    }
    return route.abort();
  });

  await page.goto(`${origin}/zh/products/ocp-catalog`);
  await page.getByText('目录发现暂不可用。', { exact: false }).waitFor();
  assert.equal(await page.getByText('可访问的注册节点尚未索引任何 catalog。').count(), 0);
  assert.equal(await page.locator('.registry-card dd').first().textContent(), '—');
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  const catalogCard = page.locator('button.catalog-card').filter({ hasText: 'Recovery catalog' });
  await catalogCard.waitFor();
  await catalogCard.click();
  await page.getByText('拉取失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await catalogCard.click();
  const sample = page.locator('.catalog-drawer pre');
  await sample.waitFor();
  catalogQueryRequestSchema.parse(JSON.parse(await sample.textContent()));
  assert.equal(manifests, 2, 'Reopening must retry the failed manifest');

  await page.getByRole('button', { name: '刷新 Manifest', exact: true }).click();
  await page.getByText('拉取失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await sample.waitFor();
  catalogQueryRequestSchema.parse(JSON.parse(await sample.textContent()));
  assert.equal(manifests, 4, 'Explicit refresh and retry must both request fresh data');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await catalogCard.click();
  await sample.waitFor();
  assert.equal(manifests, 4, 'Reopening after explicit refresh and retry must reuse the successful TTL cache');
  await page.screenshot({ path: resolve(output, 'desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await sample.waitFor();
  await page.getByRole('button', { name: '刷新 Manifest', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'mobile.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).hostname === 'registry.test' && response.request().method() === 'POST'),
    page.getByRole('button', { name: '刷新目录', exact: true }).click(),
  ]);
  await catalogCard.waitFor();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole('button', { name: '刷新目录', exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  const report = { status: 'pass', searches, manifests, pageErrors, scenarios: ['directory outage and refresh', 'manifest reopening recovery', 'manifest refresh and retry', 'protocol-valid rendered sample', 'success cache', 'desktop and mobile recovery controls'], screenshots: ['desktop.png', 'mobile.png'] };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ status: 'fail', error: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
} finally {
  clearTimeout(deadline);
  await browser?.close();
}
