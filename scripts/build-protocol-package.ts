#!/usr/bin/env bun
/**
 * Build a protocol package for npm publishing.
 *
 * Emits `dist/index.js` (bundled ESM via `bun build`) and `dist/index.d.ts`
 * (type declarations via `tsc --emitDeclarationOnly`). Run from a package
 * directory: `bun ../../scripts/build-protocol-package.ts`.
 *
 * The package's `exports` map keeps a `"bun"` condition pointing at
 * `./src/index.ts` so the in-repo workspace still consumes TypeScript source;
 * npm/node consumers fall through to the built `dist` files.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';

const pkgRoot = process.cwd();
const srcEntry = path.join(pkgRoot, 'src', 'index.ts');
const distDir = path.join(pkgRoot, 'dist');

const run = async (command: string[]): Promise<void> => {
  const child = Bun.spawn(command, { cwd: pkgRoot, stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
  }
};

await rm(distDir, { recursive: true, force: true });

// JS bundle (external deps stay external so zod / sibling protocol packages are
// installed from the registry rather than inlined).
await run([
  process.execPath,
  'build',
  srcEntry,
  '--outdir',
  'dist',
  '--target',
  'node',
  '--format',
  'esm',
  '--packages',
  'external',
]);

// Only packages that publish an explicit browser entry get this separate bundle.
// The browser target rejects accidental Node built-in imports at build time.
if (await Bun.file(path.join(pkgRoot, 'src', 'browser.ts')).exists()) {
  await run([process.execPath, 'build', path.join(pkgRoot, 'src', 'browser.ts'),
    '--outdir', 'dist', '--target', 'browser', '--format', 'esm', '--packages', 'external']);
}

// Type declarations. Uses the package tsconfig (which extends the repo base)
// and overrides emit settings on the CLI.
await run([
  process.execPath,
  'x',
  'tsc',
  '-p',
  'tsconfig.json',
  '--declaration',
  '--emitDeclarationOnly',
  '--noEmit',
  'false',
  '--outDir',
  'dist',
]);

console.log(`Built ${path.basename(pkgRoot)} -> dist/index.js + dist/index.d.ts`);
