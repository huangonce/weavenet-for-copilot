import * as vscode from 'vscode';
import { CONFIG_SECTION, DEFAULT_BASE_URL, LEGACY_BASE_URL } from '../constants';

export interface ConfiguredModel {
  id: string;
  name?: string;
  route: 'openai' | 'chatgpt' | 'claude';
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
  thinking?: boolean;
}

export interface ExtensionConfig {
  baseUrl: string;
  anthropicVersion: string;
  openaiPromptCaching: boolean;
  openaiPromptCacheKey: string;
  claudePromptCaching: 'automatic' | 'disabled';
  claudePromptCachingTTL: '5m' | '1h';
  temperature?: number;
  topP?: number;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
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
  models: ConfiguredModel[];
}

export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  return {
    baseUrl: normalizeBaseUrl(config.get<string>('baseUrl') ?? ''),
    anthropicVersion: (config.get<string>('anthropicVersion') ?? '2023-06-01').trim() || '2023-06-01',
    openaiPromptCaching: config.get<boolean>('openaiPromptCaching') ?? true,
    openaiPromptCacheKey: (config.get<string>('openaiPromptCacheKey') ?? '').trim(),
    claudePromptCaching: config.get<'automatic' | 'disabled'>('claudePromptCaching') ?? 'automatic',
    claudePromptCachingTTL: config.get<'5m' | '1h'>('claudePromptCachingTTL') ?? '5m',
    temperature: optionalNumber(config.get<number | null>('temperature'), 0, 2),
    topP: optionalNumber(config.get<number | null>('topP'), 0, 1),
    requestTimeoutMs: clamp(config.get<number>('requestTimeoutSeconds') ?? 60, 5, 300) * 1000,
    streamIdleTimeoutMs: clamp(config.get<number>('streamIdleTimeoutSeconds') ?? 90, 10, 600) * 1000,
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
    models: normalizeModels(config.get<unknown[]>('models') ?? []),
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

function optionalNumber(value: number | null | undefined, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, minimum, maximum)
    : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeModels(values: unknown[]): ConfiguredModel[] {
  const models: ConfiguredModel[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const route = record.route;
    if (!id || (route !== 'openai' && route !== 'chatgpt' && route !== 'claude')) continue;
    models.push({
      id,
      route,
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined,
      maxInputTokens: positiveNumber(record.maxInputTokens),
      maxOutputTokens: positiveNumber(record.maxOutputTokens),
      toolCalling: typeof record.toolCalling === 'boolean' ? record.toolCalling : undefined,
      imageInput: typeof record.imageInput === 'boolean' ? record.imageInput : undefined,
      thinking: typeof record.thinking === 'boolean' ? record.thinking : undefined,
    });
  }
  return models;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
