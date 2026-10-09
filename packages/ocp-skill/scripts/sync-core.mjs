#!/usr/bin/env node
import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../../shared/skill-installer-core.mjs', import.meta.url));
const target = fileURLToPath(new URL('../bin/installer-core.mjs', import.meta.url));
if (process.argv.includes('--check')) {
  if (!(await readFile(source)).equals(await readFile(target))) throw new Error('Installer core copy drifted. Run node packages/ocp-skill/scripts/sync-core.mjs.');
  console.log('Installer core distribution copy is in sync.');
} else {
  await copyFile(source, target);
  console.log('Generated standalone Node installer core from shared/skill-installer-core.mjs.');
}
