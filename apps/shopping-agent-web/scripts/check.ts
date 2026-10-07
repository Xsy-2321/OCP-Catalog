import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';
const root = join(import.meta.dir, '..');
new Script(await readFile(join(root, 'public/app.js'), 'utf8'));
for (const file of ['index.html', 'styles.css']) await readFile(join(root, 'public', file), 'utf8');
if (process.argv.includes('--build')) {
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const file of ['index.html', 'app.js', 'styles.css']) await copyFile(join(root, 'public', file), join(root, 'dist', file));
}
console.log('Shopping UI: JavaScript syntax and static assets OK');
