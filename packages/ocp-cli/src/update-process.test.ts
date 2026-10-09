import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProcessEntry } from './process-execution';

const temporaryDirs: string[] = [];
const cliEntry = fileURLToPath(new URL('./index.ts', import.meta.url));
const packageName = '@ocp-catalog/ocp-cli';
const wrapperTrap = 'OCP_UPDATE_WRAPPER_MUST_NOT_EXECUTE';
const targets = [
  'review directory with spaces',
  'review "double quotes" and \'single quotes\'',
  'review-directory&echo OCP_UPDATE_SUBCOMMAND_MARKER',
  'review-directory|echo OCP_UPDATE_PIPE_MARKER',
  'review %PATH% !PATH! ^ caret (parentheses)',
  '中文目录 "quoted"&echo OCP_UPDATE_QUOTE_MARKER',
  'line one\nline two',
  '--folder',
];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ocp update argv '));
  temporaryDirs.push(directory);
  return directory;
}

function nativeNode(): string {
  const result = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) throw new Error('These local process tests require the native Node executable.');
  return result.stdout.trim();
}

type Invocation = { command: string; args: string[] };
type LocalUpdateFixture = { directory: string; bin: string; log: string; env: NodeJS.ProcessEnv };

async function localUpdateFixture(realSkillDryRun = false): Promise<LocalUpdateFixture> {
  const directory = await temporaryDirectory();
  const bin = path.join(directory, 'bin with spaces');
  const npmRoot = path.join(bin, 'node_modules', 'npm');
  const ocpRoot = path.join(bin, 'node_modules', packageName);
  const log = path.join(directory, 'invocations.jsonl');
  await mkdir(npmRoot, { recursive: true });
  await mkdir(ocpRoot, { recursive: true });
  const recordOcp = [
    "const fs = require('node:fs');",
    'fs.appendFileSync(process.env.OCP_UPDATE_FIXTURE_LOG, JSON.stringify({ command: "ocp", args: process.argv.slice(2) }) + "\\n");',
    ...(realSkillDryRun ? [
      `const result = require('node:child_process').spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cliEntry)}, ...process.argv.slice(2), '--dry-run'], { shell: false, encoding: 'utf8' });`,
      'fs.writeFileSync(process.env.OCP_UPDATE_FIXTURE_CHILD_PLAN, result.stdout);',
      'if (result.error || result.status !== 0) { process.stderr.write(result.stderr || String(result.error)); process.exit(result.status || 1); }',
    ] : []),
    'process.exit(Number(process.env.OCP_UPDATE_FIXTURE_REFRESH_EXIT || 0));',
  ].join('\n');
  const recordNpm = [
    "const fs = require('node:fs');",
    'fs.appendFileSync(process.env.OCP_UPDATE_FIXTURE_LOG, JSON.stringify({ command: "npm", args: process.argv.slice(2) }) + "\\n");',
    'const exitCode = Number(process.env.OCP_UPDATE_FIXTURE_INSTALL_EXIT || 0);',
    'if (exitCode) process.exit(exitCode);',
    // The local fixture changes only its own entry declaration, emulating the
    // installation boundary without loading npm or touching global packages.
    `fs.writeFileSync(${JSON.stringify(path.join(ocpRoot, 'package.json'))}, ${JSON.stringify(JSON.stringify({ name: packageName, bin: { ocp: 'updated.cjs' } }))});`,
    ...(process.platform === 'win32' ? [] : [
      `fs.writeFileSync(${JSON.stringify(path.join(bin, 'ocp'))}, ${JSON.stringify('#!/usr/bin/env node\n' + recordOcp)});`,
      `fs.chmodSync(${JSON.stringify(path.join(bin, 'ocp'))}, 0o755);`,
    ]),
  ].join('\n');
  await writeFile(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'record.cjs' } }));
  await writeFile(path.join(npmRoot, 'record.cjs'), recordNpm);
  await writeFile(path.join(ocpRoot, 'package.json'), JSON.stringify({ name: packageName, bin: { ocp: 'stale.cjs' } }));
  await writeFile(path.join(ocpRoot, 'stale.cjs'), 'throw new Error("The stale OCP entry must not run");');
  await writeFile(path.join(ocpRoot, 'updated.cjs'), recordOcp);
  if (process.platform === 'win32') {
    for (const command of ['npm', 'ocp']) {
      await writeFile(path.join(bin, command + '.cmd'), `@echo ${wrapperTrap}\r\n@exit /b 0\r\n`);
      // npm's real Windows installation also contains a POSIX companion shim.
      await writeFile(path.join(bin, command), `#!/bin/sh\necho ${wrapperTrap}\n`);
    }
  } else {
    await writeFile(path.join(bin, 'npm'), '#!/usr/bin/env node\n' + recordNpm);
    await writeFile(path.join(bin, 'ocp'), '#!/usr/bin/env node\nthrow new Error("The stale OCP entry must not run");');
    await chmod(path.join(bin, 'npm'), 0o755);
    await chmod(path.join(bin, 'ocp'), 0o755);
    // Structural Windows resolver tests do not execute this native placeholder.
    await writeFile(path.join(bin, 'node.exe'), 'native Windows fixture');
  }
  const nodeDirectory = path.dirname(nativeNode());
  const env = { ...process.env };
  // Isolate command resolution from the user's global npm/ocp installation.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  delete env.NODE_OPTIONS;
  delete env.BUN_OPTIONS;
  env.PATH = [bin, nodeDirectory].join(path.delimiter);
  env.OCP_UPDATE_FIXTURE_LOG = log;
  env.OCP_UPDATE_FIXTURE_CHILD_PLAN = path.join(directory, 'child-dry-run.json');
  return { directory, bin, log, env };
}

function invokeUpdate(fixture: LocalUpdateFixture, args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliEntry, 'update', ...args], {
    cwd: fixture.directory,
    env: { ...fixture.env, ...environment },
    shell: false,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

async function invocations(fixture: LocalUpdateFixture): Promise<Invocation[]> {
  return (await readFile(fixture.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Invocation);
}

describe('complete CLI update process boundary with local package fixtures', () => {
  test('passes every target as one unchanged argv and resolves the newly installed entry', async () => {
    const fixture = await localUpdateFixture();
    const sideEffect = path.join(fixture.directory, 'subcommand-output.txt');
    const literalTargets = [...targets, `review&echo OCP_UPDATE_SIDE_EFFECT>"${sideEffect}"`];
    for (const target of literalTargets) {
      const result = invokeUpdate(fixture, ['--manager', 'npm', `--target=${target}`]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      // A shell echo (or wrapper output) would make this single JSON invalid.
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        dry_run: false,
        commands: [
          ['npm', 'install', '-g', '@ocp-catalog/ocp-cli@latest'],
          ['ocp', 'skill', 'update', `--target=${target}`],
        ],
      });
      expect(result.stdout).not.toContain(wrapperTrap);
    }
    expect(existsSync(sideEffect)).toBe(false);
    expect(await invocations(fixture)).toEqual(literalTargets.flatMap(target => [
      { command: 'npm', args: ['install', '-g', '@ocp-catalog/ocp-cli@latest'] },
      { command: 'ocp', args: ['skill', 'update', `--target=${target}`] },
    ]));
  }, 30_000);

  test('keeps explicit directory precedence over target, scope and agent', async () => {
    const fixture = await localUpdateFixture();
    const target = targets[5];
    const result = invokeUpdate(fixture, ['--manager', 'npm', '--target', 'all', '--dir', target, '--scope', 'project', '--agent', 'claude']);
    expect(result.status).toBe(0);
    expect((await invocations(fixture))[1]).toEqual({ command: 'ocp', args: ['skill', 'update', `--target=${target}`] });
  });

  test('keeps project, agent and automatic target policies in actual CLI parsing', async () => {
    const fixture = await localUpdateFixture();
    const cases = [
      { flags: ['--scope', 'project', '--agent', 'claude'], target: path.join(fixture.directory, '.claude', 'skills') },
      { flags: ['--scope', 'project'], target: path.join(fixture.directory, '.agents', 'skills') },
      { flags: ['--agent', 'all'], target: 'all' },
      { flags: ['--agent', 'codex'], target: 'codex' },
      { flags: [], target: 'auto' },
    ];
    for (const scenario of cases) {
      const result = invokeUpdate(fixture, ['--dry-run', ...scenario.flags]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).commands).toEqual([
        ['bun', 'install', '-g', '@ocp-catalog/ocp-cli@latest'],
        ['ocp', 'skill', 'update', `--target=${scenario.target}`],
      ]);
    }
    await expect(readFile(fixture.log, 'utf8')).rejects.toThrow();
  });

  test('installation failure stops the second process without running wrappers', async () => {
    const fixture = await localUpdateFixture();
    const result = invokeUpdate(fixture, ['--manager', 'npm', '--target', targets[2]], { OCP_UPDATE_FIXTURE_INSTALL_EXIT: '17' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error.message).toContain('npm install -g @ocp-catalog/ocp-cli@latest failed with exit code 17');
    expect(await invocations(fixture)).toEqual([{ command: 'npm', args: ['install', '-g', '@ocp-catalog/ocp-cli@latest'] }]);
  });

  test('preserves leading dashes through parent flags and the actual child skill parser', async () => {
    const fixture = await localUpdateFixture(true);
    const cases = [
      { flags: ['--target=--folder'], target: '--folder' },
      { flags: ['--dir=--folder', '--target=all'], target: '--folder' },
      { flags: ['--dir=--folder=value with spaces&echo MARKER'], target: '--folder=value with spaces&echo MARKER' },
    ];
    for (const scenario of cases) {
      const result = invokeUpdate(fixture, ['--manager=npm', ...scenario.flags]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).commands[1]).toEqual(['ocp', 'skill', 'update', `--target=${scenario.target}`]);
      const plan = JSON.parse(await readFile(fixture.env.OCP_UPDATE_FIXTURE_CHILD_PLAN!, 'utf8'));
      expect(plan.dry_run).toBe(true);
      expect(plan.target_dirs).toEqual([path.join(fixture.directory, scenario.target)]);
      expect(plan.planned_install_dirs).toEqual([path.join(fixture.directory, scenario.target, 'ocp-catalog')]);
      expect(plan.installed_dirs).toEqual([]);
      expect(existsSync(path.join(fixture.directory, scenario.target))).toBe(false);
    }
    expect((await invocations(fixture)).filter(invocation => invocation.command === 'ocp').map(invocation => invocation.args))
      .toEqual(cases.map(scenario => ['skill', 'update', `--target=${scenario.target}`]));
  });

  test('refresh failure remains an error after successful local installation', async () => {
    const fixture = await localUpdateFixture();
    const result = invokeUpdate(fixture, ['--manager', 'npm', '--target', targets[0]], { OCP_UPDATE_FIXTURE_REFRESH_EXIT: '23' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error.message).toContain('failed with exit code 23');
    expect((await invocations(fixture)).map(invocation => invocation.command)).toEqual(['npm', 'ocp']);
  });
});

describe('Windows package launcher resolution', () => {
  test('uses declared npm JS and native Node instead of either companion shell shim', async () => {
    const fixture = await localUpdateFixture();
    await writeFile(path.join(fixture.bin, 'npm.cmd'), `@echo ${wrapperTrap}\r\n`);
    const entry = resolveProcessEntry('npm', { env: fixture.env, platform: 'win32' });
    expect(entry.executable).toBe(process.platform === 'win32' ? nativeNode() : path.join(fixture.bin, 'node.exe'));
    expect(entry.prefix).toEqual([path.join(fixture.bin, 'node_modules', 'npm', 'record.cjs')]);
  });

  test('uses current Bun for an OCP manifest declared JS entry', async () => {
    const fixture = await localUpdateFixture();
    await writeFile(path.join(fixture.bin, 'ocp.cmd'), `@echo ${wrapperTrap}\r\n`);
    expect(resolveProcessEntry('ocp', { env: fixture.env, platform: 'win32' })).toEqual({
      executable: process.execPath,
      prefix: [path.join(fixture.bin, 'node_modules', packageName, 'stale.cjs')],
    });
  });

  test('recognizes the local node_modules/.bin layout without evaluating its wrapper', async () => {
    const directory = await temporaryDirectory();
    const bin = path.join(directory, 'node_modules', '.bin');
    const root = path.join(directory, 'node_modules', packageName);
    await mkdir(bin, { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(path.join(bin, 'ocp.cmd'), `@echo ${wrapperTrap}\r\n`);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: packageName, bin: { ocp: 'cli.js' } }));
    await writeFile(path.join(root, 'cli.js'), '');
    expect(resolveProcessEntry('ocp', { platform: 'win32', env: { PATH: bin } }).prefix).toEqual([path.join(root, 'cli.js')]);
  });

  test('recognizes the conventional Bun global installation layout', async () => {
    const directory = await temporaryDirectory();
    const bin = path.join(directory, 'bin');
    const root = path.join(directory, 'install', 'global', 'node_modules', packageName);
    await mkdir(bin, { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(path.join(bin, 'ocp.cmd'), `@echo ${wrapperTrap}\r\n`);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: packageName, bin: 'cli.js' }));
    await writeFile(path.join(root, 'cli.js'), '');
    expect(resolveProcessEntry('ocp', { platform: 'win32', env: { PATH: bin } }).prefix).toEqual([path.join(root, 'cli.js')]);
  });

  test('rejects unknown batch files and named shell programs', async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, 'custom.cmd'), `@echo ${wrapperTrap}\r\n`);
    await writeFile(path.join(directory, 'cmd.exe'), 'fixture');
    expect(() => resolveProcessEntry('custom', { platform: 'win32', env: { PATH: directory } })).toThrow('Unsupported Windows wrapper');
    expect(() => resolveProcessEntry('cmd', { platform: 'win32', env: { PATH: directory } })).toThrow('Shell launchers');
  });

  test('rejects a missing package declaration instead of invoking the shell wrapper', async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, 'ocp.cmd'), `@echo ${wrapperTrap}\r\n`);
    expect(() => resolveProcessEntry('ocp', { platform: 'win32', env: { PATH: directory } })).toThrow('No trusted package JS entry point');
  });

  test('rejects package identity mismatches and bin paths outside the trusted package', async () => {
    const fixture = await localUpdateFixture();
    await writeFile(path.join(fixture.bin, 'ocp.cmd'), `@echo ${wrapperTrap}\r\n`);
    const manifest = path.join(fixture.bin, 'node_modules', packageName, 'package.json');
    await writeFile(manifest, JSON.stringify({ name: 'unrelated-package', bin: 'stale.cjs' }));
    expect(() => resolveProcessEntry('ocp', { platform: 'win32', env: fixture.env })).toThrow('package identity does not match');
    await writeFile(manifest, JSON.stringify({ name: packageName, bin: '../../outside.js' }));
    expect(() => resolveProcessEntry('ocp', { platform: 'win32', env: fixture.env })).toThrow('Invalid JS entry point');
    await writeFile(manifest, JSON.stringify({ name: packageName, bin: 'arbitrary.cmd' }));
    expect(() => resolveProcessEntry('ocp', { platform: 'win32', env: fixture.env })).toThrow('Invalid JS entry point');
  });
});
