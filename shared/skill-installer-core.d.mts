import type * as filesystem from 'node:fs/promises';

export type InstallOwnershipPolicy = {
  markerName: string;
  isManaged: (marker: unknown) => boolean;
  force?: boolean;
};
export function readInstallMarker<T = Record<string, unknown>>(installDir: string, markerName: string): Promise<T | undefined>;
export function assertManagedDirectory(installDir: string, policy: InstallOwnershipPolicy, action: 'overwrite' | 'uninstall'): Promise<void>;
export function copySkillDirectory(source: string, target: string, markerName: string, io?: typeof filesystem): Promise<void>;
export function hashSkillDirectory(source: string, markerName: string): Promise<string>;
export function replaceManagedDirectory(source: string, target: string, policy: InstallOwnershipPolicy & { marker: unknown }, overrides?: Partial<typeof filesystem>): Promise<void>;
export function removeManagedDirectory(target: string, policy: InstallOwnershipPolicy): Promise<boolean>;
