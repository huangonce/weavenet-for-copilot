import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../constants';
import { isValidProfileId, normalizeConnectionProfiles } from '../config/config';
import type { ConnectionProfile } from '../config/config';

export interface ProfilePoolMigrationResult {
  readonly migrated: boolean;
  readonly profiles: ConnectionProfile[];
}

/**
 * Upgrades name-addressed profiles to the connection-pool format. The former
 * active profile is kept first and is the only profile that may inherit an
 * explicitly configured legacy top-level route setting.
 */
export async function migrateProfilePoolConfiguration(): Promise<ProfilePoolMigrationResult> {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const previousProfiles = configuration.inspect<unknown[]>('profiles')?.globalValue ?? [];
  const previousActiveProfile = configuration.inspect<string>('activeProfile')?.globalValue ?? '';
  const seenIds = new Set<string>();
  const upgraded = previousProfiles.map((value) => upgradeProfile(value, previousActiveProfile, configuration, seenIds));
  let profiles = normalizeConnectionProfiles(upgraded);
  const activeIndex = profiles.findIndex((profile) => profile.name === previousActiveProfile.trim());
  if (activeIndex > 0) profiles = [profiles[activeIndex], ...profiles.slice(0, activeIndex), ...profiles.slice(activeIndex + 1)];

  const migrated = previousActiveProfile !== '' || JSON.stringify(previousProfiles) !== JSON.stringify(profiles);
  if (!migrated) return { migrated: false, profiles };

  try {
    await configuration.update('profiles', profiles, vscode.ConfigurationTarget.Global);
    await configuration.update('activeProfile', '', vscode.ConfigurationTarget.Global);
  } catch (error) {
    await Promise.resolve(configuration.update('profiles', previousProfiles, vscode.ConfigurationTarget.Global)).catch(() => undefined);
    await Promise.resolve(configuration.update('activeProfile', previousActiveProfile, vscode.ConfigurationTarget.Global)).catch(() => undefined);
    throw error;
  }
  return { migrated: true, profiles };
}

function upgradeProfile(
  value: unknown,
  activeProfile: string,
  configuration: vscode.WorkspaceConfiguration,
  seenIds: Set<string>,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  const existingId = typeof record.id === 'string' ? record.id.trim().toLowerCase() : '';
  record.id = isValidProfileId(existingId) && !seenIds.has(existingId) ? existingId : randomUUID();
  seenIds.add(record.id as string);
  if (typeof record.name === 'string' && record.name.trim() === activeProfile.trim()) {
    inheritExplicitGlobal(record, 'includeModels', configuration);
    inheritExplicitGlobal(record, 'excludeModels', configuration);
    inheritExplicitGlobal(record, 'requestHeaders', configuration);
    inheritExplicitGlobal(record, 'models', configuration);
  }
  return record;
}

function inheritExplicitGlobal(
  profile: Record<string, unknown>,
  key: 'includeModels' | 'excludeModels' | 'requestHeaders' | 'models',
  configuration: vscode.WorkspaceConfiguration,
): void {
  if (profile[key] !== undefined) return;
  const value = configuration.inspect<unknown>(key)?.globalValue;
  if (value !== undefined) profile[key] = value;
}
