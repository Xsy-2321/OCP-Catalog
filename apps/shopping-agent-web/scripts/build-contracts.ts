import { resolve } from 'node:path';

export async function buildBrowserContracts() {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../../../packages/shopping-contracts/src/browser.ts')],
    outdir: resolve(import.meta.dir, '../public'),
    naming: 'contracts.js',
    format: 'esm',
    target: 'browser',
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, 'Browser contracts bundle failed');
}

if (import.meta.main) await buildBrowserContracts();
