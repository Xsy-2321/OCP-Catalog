import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type ProcessEntry = { executable: string; prefix: string[] };
type ProcessEnvironment = { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform };
const shellName = /^(?:cmd|powershell|pwsh|sh|bash|dash|zsh|ksh|fish)(?:\.exe|\.com)?$/i;
const windowsWrapper = /\.(?:cmd|bat)$/i;

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); }
  catch { return false; }
}

function commandPaths(command: string, env: NodeJS.ProcessEnv, windows: boolean): string[] {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return [path.resolve(command)];
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  // npm also writes an extensionless POSIX shell shim beside npm.cmd. Windows
  // must never select that script as a native process entry.
  const extensions = windows && !path.extname(command) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  return searchPath.split(path.delimiter).filter(Boolean).flatMap(directory => (
    extensions.map(extension => path.resolve(directory.replace(/^"|"$/g, ''), `${command}${extension}`))
  ));
}

function assertNativeExecutable(executable: string, windows: boolean): void {
  if (shellName.test(path.basename(executable)) || windowsWrapper.test(executable)) {
    throw new Error(`Shell launchers cannot forward CLI arguments safely: ${executable}`);
  }
  if (!windows) accessSync(executable, constants.X_OK);
}

function findNativeExecutable(command: string, env: NodeJS.ProcessEnv, windows: boolean): string | undefined {
  for (const executable of commandPaths(command, env, windows)) {
    if (!isFile(executable) || windowsWrapper.test(executable)) continue;
    assertNativeExecutable(executable, windows);
    return executable;
  }
  return undefined;
}

/** Windows npm/Bun shims are configuration, not shell programs to evaluate.
 * Only known packages with a declared JS bin can supply a wrapper entry point.
 */
function resolvePackageEntry(shim: string, env: NodeJS.ProcessEnv): ProcessEntry {
  const command = path.basename(shim, path.extname(shim)).toLowerCase();
  const packageName = command === 'ocp' ? '@ocp-catalog/ocp-cli' : ['npm', 'npx'].includes(command) ? 'npm' : undefined;
  if (!packageName) throw new Error(`Unsupported Windows wrapper: ${shim}. Use a native executable or the package's JS entry point.`);
  const directory = path.dirname(shim);
  const roots = [
    path.join(directory, 'node_modules', packageName),
    ...(path.basename(directory).toLowerCase() === '.bin' ? [path.join(directory, '..', packageName)] : []),
    ...(command === 'ocp' && path.basename(directory).toLowerCase() === 'bin'
      ? [path.join(directory, '..', 'install', 'global', 'node_modules', packageName)] : []),
  ];
  for (const root of roots) {
    const manifestPath = path.join(root, 'package.json');
    if (!isFile(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; bin?: string | Record<string, string> };
    if (manifest.name !== packageName) throw new Error(`Windows launcher package identity does not match ${packageName}: ${manifestPath}`);
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[command];
    if (typeof bin !== 'string') throw new Error(`Package ${packageName} does not declare the ${command} entry point.`);
    const entry = path.resolve(root, bin);
    const relative = path.relative(root, entry);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !/\.(?:[cm]?js|ts)$/i.test(entry) || !isFile(entry)) {
      throw new Error(`Invalid JS entry point for Windows launcher: ${manifestPath}`);
    }
    if (command === 'ocp') return { executable: process.execPath, prefix: [entry] };
    const adjacentNode = path.join(directory, 'node.exe');
    const node = isFile(adjacentNode) ? adjacentNode : findNativeExecutable('node', env, true);
    if (!node) throw new Error('npm update requires a native Node executable; no safe Node launcher was found.');
    assertNativeExecutable(node, true);
    return { executable: node, prefix: [entry] };
  }
  throw new Error(`No trusted package JS entry point was found for ${shim}. Refusing to execute its shell wrapper.`);
}

export function resolveProcessEntry(command: string, options: ProcessEnvironment = {}): ProcessEntry {
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === 'win32';
  for (const executable of commandPaths(command, env, windows)) {
    if (!isFile(executable)) continue;
    if (windows && windowsWrapper.test(executable)) return resolvePackageEntry(executable, env);
    assertNativeExecutable(executable, windows);
    return { executable, prefix: [] };
  }
  throw new Error(`No safe executable was found for ${command}. Check PATH and the package installation.`);
}

export function runTrustedProcess(command: readonly string[]): void {
  if (!command[0]) throw new Error('Cannot run an empty process command.');
  const entry = resolveProcessEntry(command[0]);
  const result = spawnSync(entry.executable, [...entry.prefix, ...command.slice(1)], {
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw new Error(`Failed to start ${command[0]}: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${command.join(' ')} failed with exit code ${result.status ?? 1}`);
}
