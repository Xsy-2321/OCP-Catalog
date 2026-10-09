#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Candidate = {
  label: string;
  command: string;
  args: string[];
};

const args = process.argv.slice(2);
const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const bundledCli = fileURLToPath(new URL('../assets/ocp-cli/index.js', import.meta.url));
const isWindows = process.platform === 'win32';

function isFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function commandPaths(command: string): string[] {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return [path.resolve(command)];
  }
  const extensions = isWindows && !path.extname(command) ? ['.exe', '.com', '', '.cmd', '.bat'] : [''];
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(directory => (
    extensions.map(extension => path.resolve(directory.replace(/^"|"$/g, ''), `${command}${extension}`))
  ));
}

// npm's Windows shims need cmd.exe. Resolve only known package entry points
// instead, then let Bun execute the JS with a real argv array. Never parse or
// execute shim contents, which may contain arbitrary shell commands.
function npmShimEntry(shim: string): string | undefined {
  const command = path.basename(shim, path.extname(shim)).toLowerCase();
  const packageName = command === 'ocp' ? '@ocp-catalog/ocp-cli' : command === 'npx' ? 'npm' : undefined;
  if (!packageName) return undefined;
  const directory = path.dirname(shim);
  const packageRoots = [
    path.join(directory, 'node_modules', packageName),
    ...(path.basename(directory).toLowerCase() === '.bin'
      ? [path.join(directory, '..', packageName)] : []),
  ];
  for (const packageRoot of packageRoots) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[command];
      if (typeof bin !== 'string') continue;
      const entry = path.resolve(packageRoot, bin);
      const relative = path.relative(packageRoot, entry);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !isFile(entry)) continue;
      return entry;
    } catch {
      // Other installations on PATH may still contain a usable entry point.
    }
  }
  return undefined;
}

function resolveCandidate(label: string, command: string, prefix: string[] = []): Candidate | undefined {
  for (const executable of commandPaths(command)) {
    if (!isFile(executable)) continue;
    if (/^(?:cmd|powershell|pwsh|sh|bash|dash|zsh|ksh|fish)(?:\.exe|\.com)?$/i.test(path.basename(executable))) {
      throw new Error('Shell executables cannot forward untrusted CLI arguments. Configure the OCP CLI executable or its JS entry point.');
    }
    if (isWindows && /\.(?:cmd|bat)$/i.test(executable)) {
      const entry = npmShimEntry(executable);
      if (entry) return { label, command: process.execPath, args: [entry, ...prefix, ...args] };
      continue;
    }
    if (!isWindows) {
      try {
        accessSync(executable, constants.X_OK);
      } catch {
        continue;
      }
    }
    return { label, command: executable, args: [...prefix, ...args] };
  }
  return undefined;
}

function configuredCommand(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => typeof item !== 'string') || !parsed[0]) {
      throw new Error('OCP_CLI_COMMAND must be a non-empty JSON array of strings.');
    }
    return parsed;
  }
  // Preserve executable-only configurations, including absolute paths with
  // spaces. Prefix arguments must use JSON; shell expressions are unsupported.
  if (commandPaths(trimmed).some(isFile)) return [trimmed];
  throw new Error('OCP_CLI_COMMAND must be an executable or a JSON argv array, e.g. ["bun", "/path/to/ocp.js"]. Shell commands are not supported.');
}

let candidate: Candidate | undefined;
try {
  if (process.env.OCP_CLI_COMMAND) {
    const [command, ...prefix] = configuredCommand(process.env.OCP_CLI_COMMAND);
    candidate = resolveCandidate('OCP_CLI_COMMAND', command, prefix);
    if (!candidate) throw new Error('OCP_CLI_COMMAND has no directly executable entry point.');
  } else if (process.env.OCP_CLI_BIN) {
    candidate = resolveCandidate('OCP_CLI_BIN', process.env.OCP_CLI_BIN);
    if (!candidate) throw new Error('OCP_CLI_BIN has no directly executable entry point. Use an executable or configure a JSON argv array in OCP_CLI_COMMAND.');
  } else {
    candidate = existsSync(bundledCli)
      ? { label: 'bundled skill CLI', command: process.execPath, args: [bundledCli, ...args] }
      : resolveCandidate('ocp from PATH', 'ocp')
        ?? resolveCandidate('bunx @ocp-catalog/ocp-cli', 'bunx', ['@ocp-catalog/ocp-cli'])
        ?? resolveCandidate('npx @ocp-catalog/ocp-cli', 'npx', ['-y', '@ocp-catalog/ocp-cli'])
        // The runner already requires Bun, even when it is absent from PATH.
        ?? { label: 'bun x @ocp-catalog/ocp-cli', command: process.execPath, args: ['x', '@ocp-catalog/ocp-cli', ...args] };
  }
} catch (error) {
  console.error(`Cannot configure OCP CLI: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Skill root: ${skillRoot}`);
  process.exit(1);
}

const result = spawnSync(candidate.command, candidate.args, {
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  console.error(`Failed to run OCP CLI via ${candidate.label}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
