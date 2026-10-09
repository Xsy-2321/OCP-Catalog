import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashSkillDirectory, replaceManagedDirectory, type InstallOwnershipPolicy } from '../../../shared/skill-installer-core.mjs';
import { installOcpSkill, OCP_SKILL_MARKER } from './skill-installer';

const directories: string[] = [];
const markerName = OCP_SKILL_MARKER;
const policies: Record<string, InstallOwnershipPolicy> = {
  cli: { markerName, isManaged: value => (value as any)?.package_name === '@ocp-catalog/ocp-cli' && (value as any)?.skill_name === 'ocp-catalog' },
  standalone: { markerName, isManaged: value => (value as any)?.skill_name === 'ocp-catalog' },
};
const oldMarker = { package_name: '@ocp-catalog/ocp-cli', skill_name: 'ocp-catalog', version: 'old' };

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'ocp-install-core-'));
  directories.push(directory);
  const source = path.join(directory, 'source');
  const target = path.join(directory, 'skills', 'ocp-catalog');
  await fs.mkdir(path.join(source, 'nested'), { recursive: true });
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: ocp-catalog\n---\nnew payload\n');
  await fs.writeFile(path.join(source, 'nested', 'binary.bin'), new Uint8Array([0, 255, 32, 10]));
  await fs.writeFile(path.join(source, markerName), 'stale source marker');
  await fs.writeFile(path.join(target, 'SKILL.md'), 'old payload');
  await fs.writeFile(path.join(target, markerName), JSON.stringify(oldMarker));
  return { directory, source, target };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

for (const [name, policy] of Object.entries(policies)) {
  test(`${name} mechanism copies and hashes the same binary-safe payload and replaces the marker`, async () => {
    const { source, target } = await fixture();
    const hash = await hashSkillDirectory(source, markerName);
    const marker = { ...oldMarker, content_hash: hash };
    await replaceManagedDirectory(source, target, { ...policy, marker });
    expect(await hashSkillDirectory(target, markerName)).toBe(hash);
    expect(JSON.parse(await fs.readFile(path.join(target, markerName), 'utf8'))).toEqual(marker);
    expect((await fs.readdir(path.dirname(target))).sort()).toEqual(['ocp-catalog']);
  });

  for (const failure of ['copy', 'marker', 'rename'] as const) {
    test(`${name} mechanism restores the previous directory and ownership marker after ${failure} failure`, async () => {
      const { source, target } = await fixture();
      const overrides: Partial<typeof fs> = {};
      if (failure === 'copy') overrides.copyFile = async () => { throw new Error('injected copy failure'); };
      if (failure === 'marker') overrides.writeFile = async () => { throw new Error('injected marker failure'); };
      if (failure === 'rename') overrides.rename = async (from, to) => {
        if (String(from).includes('.ocp-skill-new-')) throw new Error('injected rename failure');
        return fs.rename(from, to);
      };
      await expect(replaceManagedDirectory(source, target, { ...policy, marker: { ...oldMarker, version: 'new' } }, overrides)).rejects.toThrow(`injected ${failure} failure`);
      expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('old payload');
      expect(JSON.parse(await fs.readFile(path.join(target, markerName), 'utf8'))).toEqual(oldMarker);
      expect((await fs.readdir(path.dirname(target))).sort()).toEqual(['ocp-catalog']);
    });
  }

  for (const partial of [false, true]) {
    test(`${name} mechanism preserves the complete committed installation after ${partial ? 'partial ' : ''}backup cleanup failure`, async () => {
      const { source, target } = await fixture();
      const marker = { ...oldMarker, version: 'new', content_hash: await hashSkillDirectory(source, markerName) };
      const cause = new Error('injected cleanup failure');
      let backupPath: string | undefined;
      const overrides: Partial<typeof fs> = {
        rm: async (directory, options) => {
          if (String(directory).includes('.backup-')) {
            backupPath = String(directory);
            // A recursive removal can destroy some files before reporting an
            // error. Restoring this backup would destroy the intact new skill.
            if (partial) await fs.unlink(path.join(backupPath, 'SKILL.md'));
            throw cause;
          }
          return fs.rm(directory, options);
        },
      };
      let failure: unknown;
      try { await replaceManagedDirectory(source, target, { ...policy, marker }, overrides); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(`Skill installation completed at ${target}`);
      expect((failure as Error).message).toContain('backup cleanup failed');
      expect((failure as Error).message).toContain(`Remaining backup path: ${backupPath}`);
      expect((failure as Error).cause).toBe(cause);
      expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'));
      expect(Array.from(await fs.readFile(path.join(target, 'nested', 'binary.bin')))).toEqual([0, 255, 32, 10]);
      expect(JSON.parse(await fs.readFile(path.join(target, markerName), 'utf8'))).toEqual(marker);
      expect(await hashSkillDirectory(target, markerName)).toBe(marker.content_hash);
      expect(existsSync(path.join(backupPath!, 'SKILL.md'))).toBe(!partial);
      expect((await fs.readdir(path.dirname(target))).sort()).toEqual(['ocp-catalog', path.basename(backupPath!)].sort());
    });
  }
}

test('CLI keeps package ownership while standalone Node accepts either package owning the same skill', async () => {
  const { directory, source, target } = await fixture();
  await fs.writeFile(path.join(target, markerName), JSON.stringify({ package_name: '@ocp-catalog/skill', skill_name: 'ocp-catalog' }));
  await expect(installOcpSkill({ target, sourceDir: source })).rejects.toThrow('unmanaged');
  const packageRoot = path.join(directory, 'standalone');
  await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await fs.cp(source, path.join(packageRoot, 'skill'), { recursive: true });
  for (const name of ['ocp-skill.mjs', 'installer-core.mjs']) {
    await fs.copyFile(path.resolve(import.meta.dir, '../../ocp-skill/bin', name), path.join(packageRoot, 'bin', name));
  }
  await fs.writeFile(path.join(packageRoot, 'package.json'), '{"version":"9.9.9","type":"module"}');
  const result = spawnSync('node', [path.join(packageRoot, 'bin', 'ocp-skill.mjs'), '--dir', target, '--json'], {
    encoding: 'utf8', timeout: 10_000, shell: false,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).installed_dirs).toEqual([target]);
  const marker = JSON.parse(await fs.readFile(path.join(target, markerName), 'utf8'));
  expect(marker.package_name).toBe('@ocp-catalog/skill');
  expect(marker.package_version).toBe('9.9.9');
  expect(marker.content_hash).toBe(await hashSkillDirectory(source, markerName));
  expect(existsSync(path.join(target, 'nested', 'binary.bin'))).toBe(true);
});

test('the zero-dependency standalone mechanism is an exact generated copy of the shared source', async () => {
  const source = await fs.readFile(path.resolve(import.meta.dir, '../../../shared/skill-installer-core.mjs'));
  const distributed = await fs.readFile(path.resolve(import.meta.dir, '../../ocp-skill/bin/installer-core.mjs'));
  expect(distributed.equals(source)).toBe(true);
});
