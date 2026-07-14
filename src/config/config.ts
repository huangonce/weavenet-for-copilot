import * as vscode from 'vscode';
import { CONFIG_SECTION, DEFAULT_BASE_URL, LEGACY_BASE_URL } from '../constants';

export interface ExtensionConfig {
  baseUrl: string;
  anthropicVersion: string;
  openaiPromptCaching: boolean;
  openaiPromptCacheKey: string;
  claudePromptCaching: 'automatic' | 'disabled';
  debug: boolean;
  modelNamePrefix: string;
  includeModels: RegExp[];
  excludeModels: RegExp[];
  maxInputTokens: number;
  maxOutputTokens: number;
  sendMaxTokens: boolean;
  supportsToolCalling: boolean;
  supportsImageInput: boolean;
  imageInputModels: RegExp[];
  disabledImageInputModels: RegExp[];
  metadataRefreshHours: number;
  requestHeaders: Record<string, string>;
}

export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  return {
    baseUrl: normalizeBaseUrl(config.get<string>('baseUrl') ?? ''),
    anthropicVersion: (config.get<string>('anthropicVersion') ?? '2023-06-01').trim() || '2023-06-01',
    openaiPromptCaching: config.get<boolean>('openaiPromptCaching') ?? true,
    openaiPromptCacheKey: (config.get<string>('openaiPromptCacheKey') ?? '').trim(),
    claudePromptCaching: config.get<'automatic' | 'disabled'>('claudePromptCaching') ?? 'automatic',
    debug: config.get<boolean>('debug') ?? false,
    modelNamePrefix: (config.get<string>('modelNamePrefix') ?? 'WeaveNet').trim() || 'WeaveNet',
    includeModels: compileRegexList(config.get<string[]>('includeModels') ?? []),
    excludeModels: compileRegexList(config.get<string[]>('excludeModels') ?? []),
    maxInputTokens: Math.max(1, config.get<number>('maxInputTokens') ?? 128000),
    maxOutputTokens: Math.max(1, config.get<number>('maxOutputTokens') ?? 16384),
    sendMaxTokens: config.get<boolean>('sendMaxTokens') ?? false,
    supportsToolCalling: config.get<boolean>('supportsToolCalling') ?? true,
    supportsImageInput: config.get<boolean>('supportsImageInput') ?? false,
    imageInputModels: compileRegexList(config.get<string[]>('imageInputModels') ?? []),
    disabledImageInputModels: compileRegexList(config.get<string[]>('disabledImageInputModels') ?? []),
    metadataRefreshHours: Math.max(1, config.get<number>('metadataRefreshHours') ?? 6),
    requestHeaders: normalizeHeaders(config.get<Record<string, unknown>>('requestHeaders') ?? {}),
  };
}

/**
 * Migrates only the former bundled endpoint. Other user-selected endpoints
 * remain untouched, including workspace-specific overrides.
 */
export async function migrateLegacyBaseUrl(): Promise<boolean> {
  let migrated = false;
  const migrate = async (
    configuration: vscode.WorkspaceConfiguration,
    target: vscode.ConfigurationTarget,
    value: unknown,
  ): Promise<void> => {
    if (typeof value !== 'string' || normalizeBaseUrl(value) !== LEGACY_BASE_URL) {
      return;
    }

    await configuration.update('baseUrl', DEFAULT_BASE_URL, target);
    migrated = true;
  };

  const globalConfiguration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const globalInspection = globalConfiguration.inspect<string>('baseUrl');
  await migrate(globalConfiguration, vscode.ConfigurationTarget.Global, globalInspection?.globalValue);
  await migrate(globalConfiguration, vscode.ConfigurationTarget.Workspace, globalInspection?.workspaceValue);

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderConfiguration = vscode.workspace.getConfiguration(CONFIG_SECTION, folder.uri);
    const folderInspection = folderConfiguration.inspect<string>('baseUrl');
    await migrate(
      folderConfiguration,
      vscode.ConfigurationTarget.WorkspaceFolder,
      folderInspection?.workspaceFolderValue,
    );
  }

  return migrated;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function compileRegexList(values: string[]): RegExp[] {
  const result: RegExp[] = [];
  for (const value of values) {
    if (!value.trim()) {
      continue;
    }
    try {
      result.push(new RegExp(value));
    } catch {
      void vscode.window.showWarningMessage(`Invalid WeaveNet model regex ignored: ${value}`);
    }
  }
  return result;
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && key.trim()) {
      result[key] = value;
    }
  }
  return result;
}
