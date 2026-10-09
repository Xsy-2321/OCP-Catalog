import type { SkillTarget } from './skill-installer';
import { runTrustedProcess } from './process-execution';

type UpdateOptions = { manager?: string; dryRun: boolean; target: SkillTarget };
type ProcessRunner = (command: readonly string[]) => void;

export function updateOcpCliAndSkill(options: UpdateOptions, runProcess: ProcessRunner = runTrustedProcess) {
  const manager = options.manager ?? 'bun';
  const installCommand = manager === 'npm'
    ? ['npm', 'install', '-g', '@ocp-catalog/ocp-cli@latest']
    : ['bun', 'install', '-g', '@ocp-catalog/ocp-cli@latest'];
  // Keep targets starting with "--" a value in the updated CLI's parser.
  const skillCommand = ['ocp', 'skill', 'update', `--target=${options.target}`];
  if (options.dryRun) {
    return {
      ok: true,
      dry_run: true,
      commands: [installCommand, skillCommand],
      note: 'update installs the latest CLI package, then runs the updated ocp binary to refresh the local skill',
    };
  }
  runProcess(installCommand);
  // Resolve the OCP entry only after the manager finishes, so its declared JS
  // bin comes from the updated installation rather than a cached old manifest.
  runProcess(skillCommand);
  return { ok: true, dry_run: false, commands: [installCommand, skillCommand] };
}
