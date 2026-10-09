// Canonical zero-dependency Node mechanism. Agent selection and marker ownership
// remain policies of the two CLI entry points; distribution copies are generated.
import { createHash, randomUUID } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import path from 'node:path';

const missing = error => error?.code === 'ENOENT';

async function inspect(file, io) {
  try { return await io.lstat(file); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}

function safeDirectory(directory) {
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) throw new Error('Refusing to replace a filesystem root.');
  return resolved;
}

export async function readInstallMarker(installDir, markerName) {
  try { return JSON.parse(await filesystem.readFile(path.join(installDir, markerName), 'utf8')); }
  catch (error) {
    if (missing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function assertManagedDirectory(installDir, { markerName, isManaged, force = false }, action) {
  const info = await inspect(safeDirectory(installDir), filesystem);
  if (!info) return;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing to ${action} a non-directory skill at ${installDir}.`);
  if (force) return;
  if (!isManaged(await readInstallMarker(installDir, markerName))) {
    throw new Error(`Refusing to ${action} unmanaged skill at ${installDir}. Re-run with --force if this is intentional.`);
  }
}

export async function copySkillDirectory(source, target, markerName, io = filesystem) {
  const sourceInfo = await io.lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new Error(`Skill payload must be a real directory: ${source}`);
  await io.mkdir(target, { recursive: true });
  for (const entry of await io.readdir(source)) {
    if (entry === markerName) continue;
    const from = path.join(source, entry), to = path.join(target, entry);
    const info = await io.lstat(from);
    if (info.isSymbolicLink()) throw new Error(`Skill payload contains a symbolic link: ${from}`);
    if (info.isDirectory()) await copySkillDirectory(from, to, markerName, io);
    else if (info.isFile()) await io.copyFile(from, to);
    else throw new Error(`Unsupported skill payload entry: ${from}`);
  }
}

export async function hashSkillDirectory(source, markerName) {
  const hash = createHash('sha256');
  async function walk(directory) {
    const rootInfo = await filesystem.lstat(directory);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Skill payload must be a real directory: ${directory}`);
    for (const entry of (await filesystem.readdir(directory)).sort()) {
      if (entry === markerName) continue;
      const full = path.join(directory, entry);
      const info = await filesystem.lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Skill payload contains a symbolic link: ${full}`);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        hash.update(path.relative(source, full).replaceAll('\\', '/'));
        hash.update('\0');
        hash.update(await filesystem.readFile(full));
        hash.update('\0');
      } else throw new Error(`Unsupported skill payload entry: ${full}`);
    }
  }
  await walk(source);
  return hash.digest('hex');
}

export async function replaceManagedDirectory(source, target, policy, overrides = {}) {
  const io = { ...filesystem, ...overrides };
  const installDir = safeDirectory(target);
  const sourceDir = path.resolve(source);
  const relative = path.relative(sourceDir, installDir);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Skill install target cannot be inside its source payload.');
  }
  await assertManagedDirectory(installDir, policy, 'overwrite');
  const parent = path.dirname(installDir);
  await io.mkdir(parent, { recursive: true });
  const staging = await io.mkdtemp(path.join(parent, '.ocp-skill-new-'));
  const backup = `${installDir}.backup-${randomUUID()}`;
  let backedUp = false, installed = false;
  try {
    await copySkillDirectory(sourceDir, staging, policy.markerName, io);
    // Write the marker before swapping directories. Failure here must leave
    // both the previous payload and its ownership marker untouched.
    await io.writeFile(path.join(staging, policy.markerName), `${JSON.stringify(policy.marker, null, 2)}\n`, 'utf8');
    await assertManagedDirectory(installDir, policy, 'overwrite');
    if (await inspect(installDir, io)) {
      await io.rename(installDir, backup);
      backedUp = true;
    }
    await io.rename(staging, installDir);
    // This rename commits the complete payload and marker. Backup cleanup is
    // destructive and may fail partway through; after commit it must never
    // trigger restoration from a backup that may already be incomplete.
    installed = true;
  } catch (error) {
    try {
      if (backedUp) await io.rename(backup, installDir);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Skill install failed and rollback failed. Previous data may remain at ${backup}.`);
    }
    throw error;
  } finally {
    if (!installed) await io.rm(staging, { recursive: true, force: true });
  }
  if (backedUp) {
    try { await io.rm(backup, { recursive: true, force: true }); }
    catch (error) {
      throw new Error(`Skill installation completed at ${installDir}, but backup cleanup failed. Remaining backup path: ${backup}. The new installation was preserved.`, { cause: error });
    }
  }
}

export async function removeManagedDirectory(target, policy) {
  const installDir = safeDirectory(target);
  if (!await inspect(installDir, filesystem)) return false;
  await assertManagedDirectory(installDir, policy, 'uninstall');
  await filesystem.rm(installDir, { recursive: true, force: true });
  return true;
}
