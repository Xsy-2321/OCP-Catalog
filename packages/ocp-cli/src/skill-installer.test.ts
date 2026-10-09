import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { doctorOcpSkill, installOcpSkill, OCP_SKILL_MARKER, resolveSkillTargetDirs, uninstallOcpSkill } from './skill-installer';

const tempDirs: string[] = [];
const environmentKeys = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;
let savedEnvironment: Partial<Record<typeof environmentKeys[number], string>>;

beforeEach(() => {
  savedEnvironment = {};
  for (const key of environmentKeys) { savedEnvironment[key] = process.env[key]; delete process.env[key]; }
});

afterEach(async () => {
  for (const key of environmentKeys) {
    if (savedEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[key];
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('OCP skill installer', () => {
  test('installs the bundled skill into an explicit skills directory', async () => {
    const target = await tempDir();

    const result = await installOcpSkill({ target });

    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(false);
    expect(result.installed_dirs).toEqual([path.join(target, 'ocp-catalog')]);
    expect(existsSync(path.join(target, 'ocp-catalog', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(target, 'ocp-catalog', OCP_SKILL_MARKER))).toBe(true);

    const skill = await readFile(path.join(target, 'ocp-catalog', 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: ocp-catalog');
    expect(skill).not.toContain('packages/ocp-cli');

    const marker = JSON.parse(await readFile(path.join(target, 'ocp-catalog', OCP_SKILL_MARKER), 'utf8'));
    expect(marker).toMatchObject({
      package_name: '@ocp-catalog/ocp-cli',
      package_version: '0.1.3',
      skill_name: 'ocp-catalog',
    });
    expect(marker.content_hash).toBeString();
  });

  test('dry-run returns the plan without writing files', async () => {
    const target = await tempDir();

    const result = await installOcpSkill({ target, dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(result.planned_install_dirs).toEqual([path.join(path.resolve(target), 'ocp-catalog')]);
    expect(result.installed_dirs).toEqual([]);
    expect(existsSync(path.join(target, 'ocp-catalog'))).toBe(false);
  });

  test('doctor reports installed skill validity', async () => {
    const target = await tempDir();
    await installOcpSkill({ target });

    const result = await doctorOcpSkill(target);

    expect(result.targets).toEqual([{
      kind: 'custom',
      skills_dir: path.resolve(target),
      install_dir: path.join(path.resolve(target), 'ocp-catalog'),
      installed: true,
      valid: true,
      managed: true,
      marker: expect.objectContaining({
        package_name: '@ocp-catalog/ocp-cli',
        skill_name: 'ocp-catalog',
      }),
    }]);
  });

  test('refuses to overwrite unmanaged skill directories without force', async () => {
    const target = await tempDir();
    await mkdir(path.join(target, 'ocp-catalog'), { recursive: true });
    await writeFile(path.join(target, 'ocp-catalog', 'SKILL.md'), '---\nname: ocp-catalog\n---\n');

    await expect(installOcpSkill({ target })).rejects.toThrow('Refusing to overwrite unmanaged skill');

    const result = await installOcpSkill({ target, force: true });
    expect(result.force).toBe(true);
    expect(existsSync(path.join(target, 'ocp-catalog', OCP_SKILL_MARKER))).toBe(true);
  });

  test('uninstalls managed skill directories and refuses unmanaged directories', async () => {
    const target = await tempDir();
    await installOcpSkill({ target });

    const removed = await uninstallOcpSkill({ target });
    expect(removed.removed_dirs).toEqual([path.join(target, 'ocp-catalog')]);
    expect(existsSync(path.join(target, 'ocp-catalog'))).toBe(false);

    await mkdir(path.join(target, 'ocp-catalog'), { recursive: true });
    await writeFile(path.join(target, 'ocp-catalog', 'SKILL.md'), '---\nname: ocp-catalog\n---\n');
    await expect(uninstallOcpSkill({ target })).rejects.toThrow('Refusing to uninstall unmanaged skill');
  });

  test('both target resolves codex and agents skill directories', () => {
    const targets = resolveSkillTargetDirs('both');

    expect(targets.some((item) => item.replaceAll('\\', '/').endsWith('/.agents/skills'))).toBe(true);
    expect(targets.some((item) => item.replaceAll('\\', '/').endsWith('/.codex/skills'))).toBe(true);
  });

  test('both stays codex+agents so it keeps its pre-Claude meaning', () => {
    expect(resolveSkillTargetDirs('both')).toHaveLength(2);
    expect(resolveSkillTargetDirs('both').some((item) => item.replaceAll('\\', '/').endsWith('/.claude/skills'))).toBe(false);
  });
  test('codex and combined targets honour an isolated custom CODEX_HOME', () => {
    process.env.CODEX_HOME = path.join(os.tmpdir(), 'ocp-isolated-codex-home');
    const expected = path.join(process.env.CODEX_HOME, 'skills');
    expect(resolveSkillTargetDirs('codex')).toEqual([expected]);
    expect(resolveSkillTargetDirs('auto')).toEqual([expected]);
    expect(resolveSkillTargetDirs('both')).toContain(expected);
    expect(resolveSkillTargetDirs('all')).toContain(expected);
  });

  test('claude target resolves the Claude Code skills directory', () => {
    const targets = resolveSkillTargetDirs('claude');

    expect(targets).toHaveLength(1);
    expect(targets[0]!.replaceAll('\\', '/')).toEndWith('/.claude/skills');
  });

  test('claude target honours CLAUDE_CONFIG_DIR', () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'ocp-claude-home');

    try {
      expect(resolveSkillTargetDirs('claude')).toEqual([
        path.join(os.tmpdir(), 'ocp-claude-home', 'skills'),
      ]);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  test('all target resolves codex, agents, and claude skill directories', () => {
    const targets = resolveSkillTargetDirs('all').map((item) => item.replaceAll('\\', '/'));

    expect(targets).toHaveLength(3);
    expect(targets.some((item) => item.endsWith('/.codex/skills'))).toBe(true);
    expect(targets.some((item) => item.endsWith('/.agents/skills'))).toBe(true);
    expect(targets.some((item) => item.endsWith('/.claude/skills'))).toBe(true);
  });

  test('doctor classifies a claude skills directory', async () => {
    const home = await tempDir();
    const skillsDir = path.join(home, '.claude', 'skills');
    await installOcpSkill({ target: skillsDir });

    const result = await doctorOcpSkill(skillsDir);

    expect(result.targets[0]).toMatchObject({ kind: 'claude', installed: true, valid: true });
  });
});

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ocp-skill-install-'));
  tempDirs.push(dir);
  return dir;
}
