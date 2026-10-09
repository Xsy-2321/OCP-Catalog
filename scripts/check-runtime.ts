import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { packageManager } = JSON.parse(readFileSync(resolve(import.meta.dir, '../package.json'), 'utf8')) as { packageManager: string };
const expected = packageManager.replace(/^bun@/, '');
if (Bun.version !== expected) {
  console.error(`需要 Bun ${expected}，当前为 ${Bun.version}。请使用 packageManager / CI 固定版本后再启动或验收。`);
  process.exit(1);
}
console.log(`Bun ${Bun.version}: runtime verified`);
