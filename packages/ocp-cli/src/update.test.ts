import { describe, expect, test } from 'bun:test';
import { updateOcpCliAndSkill } from './update';

describe('CLI update orchestration', () => {
  test('keeps the default Bun installation and forwards the literal target', () => {
    const commands: string[][] = [];
    const target = 'folder with spaces "quotes" & echo SHOULD_STAY_AN_ARGUMENT';
    const result = updateOcpCliAndSkill({ dryRun: false, target }, command => { commands.push([...command]); });
    expect(commands).toEqual([
      ['bun', 'install', '-g', '@ocp-catalog/ocp-cli@latest'],
      ['ocp', 'skill', 'update', `--target=${target}`],
    ]);
    expect(result).toEqual({ ok: true, dry_run: false, commands });
  });

  test('keeps npm selection and dry-run never invokes a process', () => {
    const result = updateOcpCliAndSkill({ manager: 'npm', dryRun: true, target: 'claude' }, () => {
      throw new Error('dry-run started a process');
    });
    expect(result.dry_run).toBe(true);
    expect(result.commands).toEqual([
      ['npm', 'install', '-g', '@ocp-catalog/ocp-cli@latest'],
      ['ocp', 'skill', 'update', '--target=claude'],
    ]);
  });

  test('retains the existing Bun fallback for other manager values', () => {
    expect(updateOcpCliAndSkill({ manager: 'existing-fallback', dryRun: true, target: 'auto' }).commands[0])
      .toEqual(['bun', 'install', '-g', '@ocp-catalog/ocp-cli@latest']);
  });

  test('keeps a leading option prefix part of the target value', () => {
    const commands: string[][] = [];
    updateOcpCliAndSkill({ dryRun: false, target: '--folder=value' }, command => { commands.push([...command]); });
    expect(commands[1]).toEqual(['ocp', 'skill', 'update', '--target=--folder=value']);
    expect(updateOcpCliAndSkill({ dryRun: true, target: '--folder' }).commands[1])
      .toEqual(['ocp', 'skill', 'update', '--target=--folder']);
  });

  test('does not refresh the skill when package installation fails', () => {
    const commands: string[][] = [];
    expect(() => updateOcpCliAndSkill({ manager: 'npm', dryRun: false, target: 'auto' }, command => {
      commands.push([...command]);
      throw new Error('fixture install failed');
    })).toThrow('fixture install failed');
    expect(commands).toEqual([['npm', 'install', '-g', '@ocp-catalog/ocp-cli@latest']]);
  });

  test('propagates skill refresh failures after successful installation', () => {
    const commands: string[][] = [];
    expect(() => updateOcpCliAndSkill({ dryRun: false, target: 'all' }, command => {
      commands.push([...command]);
      if (command[0] === 'ocp') throw new Error('fixture refresh failed');
    })).toThrow('fixture refresh failed');
    expect(commands).toHaveLength(2);
  });
});
