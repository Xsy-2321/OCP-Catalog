import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBrowserContracts } from './build-contracts';
const root = join(import.meta.dir, '..');
if (process.argv.includes('--build')) await buildBrowserContracts();
const scripts = ['app.js', 'merchant.js', 'model-settings.js', 'contracts.js', 'view-model.js', 'dom.js', 'api-client.js'];
const assets = ['index.html', 'demo.html', 'merchant.html', 'styles.css', 'merchant.css', 'model-settings.css', 'coffee-bg.svg', ...scripts];
const parser = new Bun.Transpiler({ loader: 'js' });
for (const file of scripts) parser.transformSync(await readFile(join(root, 'public', file), 'utf8'));
for (const file of assets) await readFile(join(root, 'public', file), 'utf8');
if (process.argv.includes('--build')) {
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const file of assets) await copyFile(join(root, 'public', file), join(root, 'dist', file));
}
console.log('Shopping UI: JavaScript syntax and static assets OK');
