import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashSkillDirectory, readInstallMarker as readMarker, removeManagedDirectory, replaceManagedDirectory } from '../../../shared/skill-installer-core.mjs';

export const OCP_SKILL_NAME = 'ocp-catalog';
export const OCP_SKILL_MARKER = '.ocp-skill-install.json';
const OCP_CLI_PACKAGE = '@ocp-catalog/ocp-cli';

export type SkillTarget = 'auto' | 'codex' | 'agents' | 'claude' | 'both' | 'all' | string;

export type SkillInstallOptions = {
  target?: SkillTarget;
  dryRun?: boolean;
  force?: boolean;
  sourceDir?: string;
};

export type SkillInstallPlan = {
  skill_name: string;
  source_dir: string;
  target_dirs: string[];
  planned_install_dirs: string[];
};

export type SkillInstallResult = SkillInstallPlan & {
  ok: true;
  dry_run: boolean;
  force: boolean;
  installed_dirs: string[];
};

export type SkillUninstallResult = {
  ok: true;
  skill_name: string;
  dry_run: boolean;
  force: boolean;
  target_dirs: string[];
  removed_dirs: string[];
};

export type SkillDoctorResult = {
  skill_name: string;
  source_dir?: string;
  targets: Array<{
    kind: string;
    skills_dir: string;
    install_dir: string;
    installed: boolean;
    valid: boolean;
    managed: boolean;
    marker?: SkillInstallMarker;
  }>;
};

export type SkillInstallMarker = {
  package_name: string;
  package_version: string;
  skill_name: string;
  content_hash: string;
  installed_at: string;
  source: string;
};

export async function installOcpSkill(options: SkillInstallOptions = {}): Promise<SkillInstallResult> {
  const sourceDir = options.sourceDir ? path.resolve(options.sourceDir) : await findOcpSkillSource();
  await assertSkillSource(sourceDir);

  const targetDirs = resolveSkillTargetDirs(options.target ?? 'auto');
  const force = options.force ?? false;
  const plan: SkillInstallPlan = {
    skill_name: OCP_SKILL_NAME,
    source_dir: sourceDir,
    target_dirs: targetDirs,
    planned_install_dirs: targetDirs.map(resolveInstallDir),
  };

  if (options.dryRun) {
    return {
      ...plan,
      ok: true,
      dry_run: true,
      force,
      installed_dirs: [],
    };
  }

  const contentHash = await hashSkillDirectory(sourceDir, OCP_SKILL_MARKER);
  const packageVersion = await readPackageVersion();
  const installedDirs: string[] = [];

  for (const targetDir of targetDirs) {
    const installDir = resolveInstallDir(targetDir);
    await replaceManagedDirectory(sourceDir, installDir, {
      ...ownershipPolicy(force),
      marker: {
        package_name: OCP_CLI_PACKAGE,
        package_version: packageVersion,
        skill_name: OCP_SKILL_NAME,
        content_hash: contentHash,
        installed_at: new Date().toISOString(),
        source: sourceDir,
      },
    });
    installedDirs.push(installDir);
  }

  return {
    ...plan,
    ok: true,
    dry_run: false,
    force,
    installed_dirs: installedDirs,
  };
}

export async function uninstallOcpSkill(options: Omit<SkillInstallOptions, 'sourceDir'> = {}): Promise<SkillUninstallResult> {
  const targetDirs = resolveSkillTargetDirs(options.target ?? 'auto');
  const force = options.force ?? false;
  const removedDirs: string[] = [];

  if (options.dryRun) {
    return {
      ok: true,
      skill_name: OCP_SKILL_NAME,
      dry_run: true,
      force,
      target_dirs: targetDirs,
      removed_dirs: [],
    };
  }

  for (const targetDir of targetDirs) {
    const installDir = resolveInstallDir(targetDir);
    if (await removeManagedDirectory(installDir, ownershipPolicy(force))) removedDirs.push(installDir);
  }

  return {
    ok: true,
    skill_name: OCP_SKILL_NAME,
    dry_run: false,
    force,
    target_dirs: targetDirs,
    removed_dirs: removedDirs,
  };
}

export async function doctorOcpSkill(target: SkillTarget = 'auto'): Promise<SkillDoctorResult> {
  const targets = resolveSkillTargetDirs(target);
  let sourceDir: string | undefined;

  try {
    sourceDir = await findOcpSkillSource();
  } catch {
    sourceDir = undefined;
  }

  return {
    skill_name: OCP_SKILL_NAME,
    ...(sourceDir ? { source_dir: sourceDir } : {}),
    targets: await Promise.all(targets.map(async (skillsDir) => {
      const installDir = resolveInstallDir(skillsDir);
      const skillFile = path.join(installDir, 'SKILL.md');
      const marker = await readInstallMarker(installDir);
      const installed = existsSync(installDir);
      return {
        kind: classifySkillsDir(path.dirname(installDir)),
        skills_dir: path.dirname(installDir),
        install_dir: installDir,
        installed,
        valid: installed && existsSync(skillFile),
        managed: !!marker,
        ...(marker ? { marker } : {}),
      };
    })),
  };
}

export async function findOcpSkillSource(): Promise<string> {
  const candidates = [
    path.join(import.meta.dir, 'skills', OCP_SKILL_NAME),
    path.resolve(import.meta.dir, '..', '..', '..'),
    path.resolve(import.meta.dir, '..', '..', '..', 'skills', OCP_SKILL_NAME),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'SKILL.md'))) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate bundled ${OCP_SKILL_NAME} skill`);
}

export function resolveSkillTargetDirs(target: SkillTarget): string[] {
  if (target === 'auto') {
    if (process.env.CODEX_HOME) return [path.join(process.env.CODEX_HOME, 'skills')];

    const agentsDir = agentsSkillsDir();
    if (existsSync(agentsDir)) return [agentsDir];

    const claudeDir = claudeSkillsDir();
    if (existsSync(claudeDir)) return [claudeDir];

    return [codexSkillsDir()];
  }

  if (target === 'codex') {
    return [codexSkillsDir()];
  }

  if (target === 'agents') {
    return [agentsSkillsDir()];
  }

  if (target === 'claude') {
    return [claudeSkillsDir()];
  }

  // 'both' predates Claude Code support and stays codex+agents so existing
  // invocations keep installing exactly where they used to. 'all' is the
  // everything option.
  if (target === 'both') {
    return uniquePaths([codexSkillsDir(), agentsSkillsDir()]);
  }

  if (target === 'all') {
    return uniquePaths([codexSkillsDir(), agentsSkillsDir(), claudeSkillsDir()]);
  }

  return [path.resolve(target)];
}

function codexSkillsDir() {
  return process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, 'skills')
    : path.join(homeDir(), '.codex', 'skills');
}

function agentsSkillsDir() {
  return path.join(homeDir(), '.agents', 'skills');
}

function claudeSkillsDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'skills')
    : path.join(homeDir(), '.claude', 'skills');
}

async function assertSkillSource(sourceDir: string): Promise<void> {
  const skillFile = path.join(sourceDir, 'SKILL.md');
  if (!existsSync(skillFile)) {
    throw new Error(`Skill source is missing SKILL.md: ${sourceDir}`);
  }

  const content = await readFile(skillFile, 'utf8');
  if (!content.includes(`name: ${OCP_SKILL_NAME}`)) {
    throw new Error(`Skill source is not ${OCP_SKILL_NAME}: ${sourceDir}`);
  }
}

async function readInstallMarker(installDir: string): Promise<SkillInstallMarker | undefined> {
  return readMarker<SkillInstallMarker>(installDir, OCP_SKILL_MARKER);
}

function ownershipPolicy(force: boolean) {
  return {
    markerName: OCP_SKILL_MARKER,
    force,
    isManaged: (value: unknown) => {
      const marker = value as Partial<SkillInstallMarker> | undefined;
      return marker?.package_name === OCP_CLI_PACKAGE && marker.skill_name === OCP_SKILL_NAME;
    },
  };
}

async function readPackageVersion(): Promise<string> {
  const candidates = [
    path.resolve(import.meta.dir, '..', 'package.json'),
    path.resolve(import.meta.dir, '..', '..', '..', 'packages', 'ocp-cli', 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(await readFile(candidate, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // Continue to the next package.json candidate.
    }
  }

  return '0.0.0';
}

function resolveInstallDir(targetDir: string) {
  const resolved = path.resolve(targetDir);
  return path.basename(resolved) === OCP_SKILL_NAME ? resolved : path.join(resolved, OCP_SKILL_NAME);
}

function classifySkillsDir(skillsDir: string) {
  const normalized = skillsDir.replaceAll('\\', '/');
  if (normalized.endsWith('/.agents/skills')) return 'agents';
  if (normalized.endsWith('/.codex/skills')) return 'codex';
  if (normalized.endsWith('/.claude/skills')) return 'claude';
  return 'custom';
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map((item) => path.resolve(item)))];
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}
