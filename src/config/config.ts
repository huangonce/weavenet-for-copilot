import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../constants';

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

export interface ConnectionProfile {
  name: string;
  baseUrl: string;
  requestHeaders?: Record<string, string>;
  includeModels?: string[];
  excludeModels?: string[];
  models?: ConfiguredModel[];
}

export interface ExtensionConfig {
  profileName?: string;
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

export interface ProfileConfiguration {
  activeProfile: string;
  profiles: ConnectionProfile[];
}

export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const { activeProfile, profiles } = getProfileConfiguration();
  const connection = selectActiveProfile(profiles, activeProfile);

  return {
    profileName: connection?.name,
    baseUrl: connection?.baseUrl ?? '',
    anthropicVersion: (config.get<string>('anthropicVersion') ?? '2023-06-01').trim() || '2023-06-01',
    openaiPromptCaching: config.get<boolean>('openaiPromptCaching') ?? true,
    openaiPromptCacheKey: (config.get<string>('openaiPromptCacheKey') ?? '').trim(),
    claudePromptCaching: config.get<'automatic' | 'disabled'>('claudePromptCaching') ?? 'automatic',
    claudePromptCachingTTL: config.get<'5m' | '1h'>('claudePromptCachingTTL') ?? '5m',
    temperature: optionalNumber(config.get<number | null>('temperature'), 0, 2),
    topP: optionalNumber(config.get<number | null>('topP'), 0, 1),
    requestTimeoutMs: clamp(config.get<number>('requestTimeoutSeconds') ?? 120, 5, 300) * 1000,
    streamIdleTimeoutMs: clamp(config.get<number>('streamIdleTimeoutSeconds') ?? 90, 10, 600) * 1000,
    debug: config.get<boolean>('debug') ?? false,
    modelNamePrefix: (config.get<string>('modelNamePrefix') ?? 'WeaveNet').trim() || 'WeaveNet',
    includeModels: compileRegexList(connection?.includeModels ?? []),
    excludeModels: compileRegexList(connection?.excludeModels ?? []),
    maxInputTokens: Math.max(1, config.get<number>('maxInputTokens') ?? 128000),
    maxOutputTokens: Math.max(1, config.get<number>('maxOutputTokens') ?? 16384),
    sendMaxTokens: config.get<boolean>('sendMaxTokens') ?? false,
    supportsToolCalling: config.get<boolean>('supportsToolCalling') ?? true,
    supportsImageInput: config.get<boolean>('supportsImageInput') ?? false,
    imageInputModels: compileRegexList(config.get<string[]>('imageInputModels') ?? []),
    disabledImageInputModels: compileRegexList(config.get<string[]>('disabledImageInputModels') ?? []),
    metadataRefreshHours: Math.max(1, config.get<number>('metadataRefreshHours') ?? 6),
    requestHeaders: connection?.requestHeaders ?? {},
    models: connection?.models ?? [],
  };
}

export function getProfileConfiguration(): ProfileConfiguration {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const profiles = normalizeConnectionProfiles(config.inspect<unknown[]>('profiles')?.globalValue ?? []);
  const activeProfile = selectActiveProfile(profiles, config.inspect<string>('activeProfile')?.globalValue ?? '');
  return {
    activeProfile: activeProfile?.name ?? profiles[0]?.name ?? '',
    profiles,
  };
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

export function normalizeConnectionProfiles(values: unknown[]): ConnectionProfile[] {
  const profiles: ConnectionProfile[] = [];
  const seenNames = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const baseUrl = typeof record.baseUrl === 'string' ? normalizeBaseUrl(record.baseUrl) : '';
    if (!name || !baseUrl || seenNames.has(name)) continue;
    seenNames.add(name);
    const includeModels = stringArray(record.includeModels);
    const excludeModels = stringArray(record.excludeModels);
    const models = Array.isArray(record.models) ? normalizeModels(record.models) : undefined;
    profiles.push({
      name,
      baseUrl,
      requestHeaders: objectHeaders(record.requestHeaders),
      includeModels,
      excludeModels,
      models,
    });
  }
  return profiles;
}

export function selectActiveProfile(
  profiles: readonly ConnectionProfile[],
  activeProfileName: string,
): ConnectionProfile | undefined {
  const name = activeProfileName.trim();
  return name ? profiles.find((profile) => profile.name === name) : undefined;
}

function objectHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return normalizeHeaders(value as Record<string, unknown>);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
