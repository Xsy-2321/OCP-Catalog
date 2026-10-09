import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directories: string[] = [];
const runnerSource = path.resolve(import.meta.dir, '../../../skills/ocp-catalog/scripts/ocp-skill-runner.ts');
const fixtureSource = 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.OCP_TEST_EXIT ?? 0));';
const dataArgs = [
  'normal search',
  '&echo OCP_RUNNER_INJECTION_MARKER',
  '|echo OCP_RUNNER_INJECTION_MARKER',
  '" &echo OCP_RUNNER_INJECTION_MARKER & "',
  '%PATH% !PATH! ^ & | < > ( )',
  '$(echo OCP_RUNNER_INJECTION_MARKER) `echo OCP_RUNNER_INJECTION_MARKER`',
  'C:\\catalog with spaces\\quote"\\',
  'line one\nline two',
  '中文查询',
  '',
];

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ocp-runner-security-'));
  directories.push(directory);
  const scripts = path.join(directory, 'skill', 'scripts');
  mkdirSync(scripts, { recursive: true });
  const runner = path.join(scripts, 'ocp-skill-runner.ts');
  copyFileSync(runnerSource, runner);
  const cli = path.join(directory, 'fixture cli.js');
  writeFileSync(cli, fixtureSource);
  return { directory, runner, cli };
}

function run(runner: string, args: string[], overrides: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !['ocp_cli_command', 'ocp_cli_bin', 'ocp_test_exit', 'path'].includes(key.toLowerCase())
  )));
  return spawnSync(process.execPath, [runner, ...args], {
    env: { ...env, PATH: process.env.PATH ?? '', ...overrides },
    encoding: 'utf8',
    timeout: 10_000,
    shell: false,
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const relative = path.relative(os.tmpdir(), directory);
    if (!relative.startsWith('ocp-runner-security-') || relative.includes(path.sep)) throw new Error('Invalid fixture cleanup target');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('standalone skill runner argument boundaries', () => {
  it('preserves shell metacharacters as literal OCP_CLI_BIN arguments', () => {
    const { runner, cli } = fixture();
    const result = run(runner, [cli, ...dataArgs], { OCP_CLI_BIN: process.execPath });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(dataArgs);
  });

  it('forwards OCP_CLI_COMMAND JSON prefix and data arguments without a shell', () => {
    const { runner, cli } = fixture();
    const result = run(runner, dataArgs, { OCP_CLI_COMMAND: JSON.stringify([process.execPath, cli, 'fixed prefix']) });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['fixed prefix', ...dataArgs]);
  });

  it('supports an executable-only OCP_CLI_COMMAND and propagates the child exit status', () => {
    const { runner, cli } = fixture();
    const result = run(runner, [cli, ...dataArgs], { OCP_CLI_COMMAND: process.execPath, OCP_TEST_EXIT: '23' });
    expect(result.status).toBe(23);
    expect(JSON.parse(result.stdout)).toEqual(dataArgs);
  });

  it('rejects legacy shell expressions and invalid argv rather than falling back', () => {
    const { runner } = fixture();
    for (const command of ['echo OCP_RUNNER_INJECTION_MARKER & echo SECOND_COMMAND', '[]', '["bun", 1]', '["", "--version"]', '[malformed']) {
      const result = run(runner, dataArgs, { OCP_CLI_COMMAND: command, OCP_CLI_BIN: process.execPath });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Cannot configure OCP CLI');
    }
  });

  it('uses the current runtime for the bundled CLI even with no PATH', () => {
    const { directory, runner } = fixture();
    const assets = path.join(directory, 'skill', 'assets', 'ocp-cli');
    mkdirSync(assets, { recursive: true });
    writeFileSync(path.join(assets, 'index.js'), fixtureSource);
    const result = run(runner, dataArgs, { PATH: '' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(dataArgs);
  });

  it.skipIf(process.platform !== 'win32')('runs global and local npm shim JS entries without executing batch files', () => {
    for (const local of [false, true]) {
      const { directory, runner } = fixture();
      const nodeModules = path.join(directory, 'node_modules');
      const launcherDirectory = local ? path.join(nodeModules, '.bin') : directory;
      const packageRoot = path.join(nodeModules, '@ocp-catalog', 'ocp-cli');
      mkdirSync(launcherDirectory, { recursive: true });
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(path.join(launcherDirectory, 'ocp.cmd'), '@echo OCP_BATCH_WRAPPER_WAS_EXECUTED\r\n');
      writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { ocp: 'index.js' } }));
      writeFileSync(path.join(packageRoot, 'index.js'), fixtureSource);
      const result = run(runner, dataArgs, { PATH: launcherDirectory });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(dataArgs);
    }
  });

  it.skipIf(process.platform !== 'win32')('rejects unsupported batch launchers and explicit shell executables', () => {
    const { directory, runner } = fixture();
    const wrapper = path.join(directory, 'custom.cmd');
    writeFileSync(wrapper, '@echo OCP_BATCH_WRAPPER_WAS_EXECUTED\r\n');
    const wrapperResult = run(runner, dataArgs, { OCP_CLI_BIN: wrapper });
    expect(wrapperResult.status).toBe(1);
    expect(wrapperResult.stdout).toBe('');

    const shellResult = run(runner, dataArgs, { OCP_CLI_COMMAND: JSON.stringify([process.env.ComSpec ?? 'cmd.exe', '/c', 'echo']) });
    expect(shellResult.status).toBe(1);
    expect(shellResult.stdout).toBe('');
    expect(shellResult.stderr).toContain('Shell executables cannot forward');
  });
});
