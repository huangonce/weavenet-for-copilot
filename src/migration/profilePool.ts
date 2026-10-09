import { createHmac, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { AuthManager } from '../auth/auth';
import { CONFIG_SECTION, MODEL_SNAPSHOT_KEY_PREFIX } from '../constants';
import { getConfig, isApiType, isValidProfileId, normalizeConnectionProfiles } from '../config/config';
import type { ApiType, ConnectionProfile } from '../config/config';
import { t } from '../l10n';
import { RelayClient } from '../relay/client';
import type { RoutedModel } from '../relay/types';
import { canonicalRelayHeaders, isReservedRelayHeader } from '../relay/headers';
import { isReasoningEffort } from '../relay/openaiCapabilities';
import { normalizeRelayBaseUrl } from '../relay/url';
import { MAX_SNAPSHOT_MODELS } from '../copilot/modelSnapshotStore';
import { catalogArtifactRevision } from '../copilot/catalogIdentity';
import { assignUniquePickerIds, toRoutedModel } from '../relay/models';
import { readLegacyCatalogSnapshot } from './catalogUpgrade';

interface LegacyCatalog {
  models: RoutedModel[];
  directory: RoutedModel[];
  verifyCurrent?: () => Promise<void>;
  preserve?: (profile: ConnectionProfile) => Promise<void>;
}
export interface ProfilePoolMigrationResult { readonly migrated: boolean; readonly profiles: ConnectionProfile[] }

/** The only setting upgrade boundary that understands old route/variant declarations. */
export async function migrateProfilePoolConfiguration(context?: vscode.ExtensionContext): Promise<ProfilePoolMigrationResult> {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const previousProfiles = configuration.inspect<unknown[]>('profiles')?.globalValue ?? [];
  const previousActiveProfile = configuration.inspect<string>('activeProfile')?.globalValue ?? '';
  const previousStrategy = configuration.inspect<string>('openaiApiStrategy')?.globalValue;
  const previousIdentity = JSON.stringify(previousProfiles);
  const seenIds = new Set<string>();
  const upgraded: unknown[] = [];
  const catalogs = new Map<string, LegacyCatalog>();
  let migratedProtocols = false;
  let unresolvedAuto = false;
  for (const value of previousProfiles) {
    if (!record(value)) { upgraded.push(value); continue; }
    const entry = { ...value };
    const oldId = typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : '';
    entry.id = isValidProfileId(oldId) && !seenIds.has(oldId) ? oldId : randomUUID();
    seenIds.add(entry.id as string);
    if (typeof entry.name === 'string' && entry.name.trim() === previousActiveProfile.trim()) {
      for (const key of ['includeModels', 'excludeModels', 'requestHeaders', 'models']) {
        if (entry[key] === undefined) entry[key] = configuration.inspect<unknown>(key)?.globalValue;
      }
    }
    if (entry.apiType !== undefined && !isApiType(entry.apiType)) throw new Error(t('A Relay API type is invalid.'));
    const models = Array.isArray(entry.models) ? entry.models.filter(record).map((model): Record<string, unknown> => ({
      ...model, id: typeof model.id === 'string' ? model.id.trim() : model.id,
    })) : [];
    if (!isApiType(entry.apiType)) {
      const strategy = previousStrategy === 'auto' || previousStrategy === 'responses' ? previousStrategy : 'chat';
      const catalog = context ? await legacyCatalog(context, entry, strategy) : { models: [], directory: [] };
      catalogs.set(entry.id as string, catalog);
      entry.apiType = strategy === 'responses' ? 'responses' : 'chat-completions';
      entry.models = models.map(model => upgradeModel(model, entry.apiType as ApiType, strategy,
        catalog.models.find(item => item.upstreamId === model.id && (model.route === 'claude') === (item.apiType === 'messages'))));
      const declaredIds = new Set(models.map(model => model.id));
      for (const model of catalog.models) {
        if (!declaredIds.has(model.upstreamId) && model.apiType !== entry.apiType) {
          (entry.models as unknown[]).push({ id: model.upstreamId, apiType: model.apiType });
        }
      }
      unresolvedAuto ||= strategy === 'auto' && catalog.models.length === 0;
      migratedProtocols = true;
    } else {
      // Profiles may already have a modern default while individual declarations still use the old format.
      entry.models = Array.isArray(entry.models) ? models.map(model => upgradeModel(model, entry.apiType as ApiType)) : undefined;
    }
    upgraded.push(entry);
  }
  let profiles = normalizeConnectionProfiles(upgraded);
  if (profiles.length !== previousProfiles.length) throw new Error(t('Some Relay connections are invalid. Correct them before migration.'));
  const active = profiles.findIndex(profile => profile.name === previousActiveProfile.trim());
  if (active > 0) profiles = [profiles[active], ...profiles.slice(0, active), ...profiles.slice(active + 1)];
  const migrated = previousActiveProfile !== '' || previousStrategy !== undefined || previousIdentity !== JSON.stringify(profiles);
  if (!migrated) return { migrated: false, profiles };
  for (const catalog of catalogs.values()) await catalog.verifyCurrent?.();
  if (JSON.stringify(configuration.inspect<unknown[]>('profiles')?.globalValue ?? []) !== previousIdentity
    || (configuration.inspect<string>('activeProfile')?.globalValue ?? '') !== previousActiveProfile
    || configuration.inspect<string>('openaiApiStrategy')?.globalValue !== previousStrategy) {
    throw new Error(t('Connections changed while migration was preparing. Reload to retry.'));
  }
  try {
    await configuration.update('profiles', profiles, vscode.ConfigurationTarget.Global);
    await configuration.update('activeProfile', undefined, vscode.ConfigurationTarget.Global);
    await configuration.update('openaiApiStrategy', undefined, vscode.ConfigurationTarget.Global);
    for (const profile of profiles) await catalogs.get(profile.id)?.preserve?.(profile);
  } catch (error) {
    await Promise.resolve(configuration.update('profiles', previousProfiles, vscode.ConfigurationTarget.Global)).catch(() => undefined);
    await Promise.resolve(configuration.update('activeProfile', previousActiveProfile || undefined, vscode.ConfigurationTarget.Global)).catch(() => undefined);
    await Promise.resolve(configuration.update('openaiApiStrategy', previousStrategy, vscode.ConfigurationTarget.Global)).catch(() => undefined);
    throw error;
  }
  if (migratedProtocols) void vscode.window.showInformationMessage(unresolvedAuto
    ? t('WeaveNet uses explicit APIs. Uncached auto models use Chat; check mixed-protocol connections.')
    : t('WeaveNet retained known APIs and keys. Newly discovered models inherit the connection API.'), t('Manage Connections'))
    .then(action => { if (action === t('Manage Connections')) void vscode.commands.executeCommand('weavenet-copilot.manageConnections'); });
  return { migrated: true, profiles };
}

function upgradeModel(model: Record<string, unknown>, defaultApi: ApiType, strategy?: string, cached?: RoutedModel): Record<string, unknown> {
  if (strategy === undefined && model.route === undefined && model.openaiApi === undefined) {
    const current = { ...model }; delete current.contextWindows; return current;
  }
  const apiType = isApiType(model.apiType) ? model.apiType : model.route === 'claude' ? 'messages'
    : strategy === 'chat' || model.openaiApi === 'chat' ? 'chat-completions'
    : strategy === 'responses' || model.openaiApi === 'responses' ? 'responses'
    : cached?.apiType === 'responses' ? 'responses'
    : model.route === 'openai' || model.route === 'chatgpt' ? 'chat-completions' : defaultApi;
  const result = { ...model, apiType };
  for (const key of ['route', 'openaiApi', 'contextWindows']) delete (result as Record<string, unknown>)[key];
  return result;
}

async function legacyCatalog(context: vscode.ExtensionContext, entry: Record<string, unknown>, strategy: string): Promise<LegacyCatalog> {
  const profile = { id: entry.id as string, name: entry.name as string };
  const auth = new AuthManager(context.secrets);
  const apiKey = await auth.getApiKey(profile);
  const verifyCurrent = async () => { if (await auth.getApiKey(profile) !== apiKey) throw new Error(t('The Relay credentials changed during migration. Reload to retry.')); };
  if (!apiKey) return { models: [], directory: [], verifyCurrent };
  const pepper = await auth.getCatalogArtifactPepper();
  const patterns = (value: unknown) => Array.isArray(value) ? [...new Set(value.flatMap(item => {
    try { return typeof item === 'string' && item.trim() ? [new RegExp(item.trim()).source] : []; } catch { return []; }
  }))].sort() : [];
  const oldModels = legacyConfiguredModels(entry.models);
  const oldIdentity = stable({ profileId: profile.id, baseUrl: normalizeRelayBaseUrl(entry.baseUrl as string) ?? entry.baseUrl,
    openaiApiStrategy: strategy, requestHeaders: legacyRequestHeaders(entry.requestHeaders),
    includeModels: patterns(entry.includeModels), excludeModels: patterns(entry.excludeModels), models: oldModels });
  const revision = createHmac('sha256', pepper).update('credential\0').update(apiKey).update('\0catalog\0').update(JSON.stringify(oldIdentity)).digest('hex');
  const snapshot = readLegacyCatalogSnapshot(context.globalState, profile.id, revision);
  let models: RoutedModel[];
  let directory: RoutedModel[];
  if (snapshot) { models = snapshot.models; directory = snapshot.directory; }
  else {
    const config = getConfig(normalizeConnectionProfiles([{ ...entry, models: [] }])[0]);
    const client = new RelayClient({ baseUrl: entry.baseUrl as string, apiKey, requestHeaders: config.requestHeaders,
      authScheme: 'bearer', requestTimeoutMs: config.requestTimeoutMs, streamIdleTimeoutMs: config.streamIdleTimeoutMs });
    const catalog = await client.listModels();
    directory = (catalog.data ?? []).map(model => toRoutedModel(model, model.id.toLowerCase().startsWith('claude-')
      ? 'messages' : strategy === 'responses' ? 'responses' : 'chat-completions'));
    models = directory;
  }
  return { models, directory, verifyCurrent, preserve: async newProfile => {
    const config = getConfig(newProfile);
    const revision = catalogArtifactRevision(config, apiKey, pepper);
    const converted = assignUniquePickerIds(directory.slice(0, MAX_SNAPSHOT_MODELS).map(model => {
      const declarations = config.models.filter(item => item.id === model.upstreamId);
      const sameApi = declarations.find(item => (item.apiType ?? config.apiType) === model.apiType);
      const apiType = sameApi?.apiType ?? declarations.at(-1)?.apiType ?? config.apiType;
      return { ...model, apiType, catalogSource: 'discovery' as const };
    }));
    // Keep the original verified record until a later successful directory refresh prunes it.
    await context.globalState.update(`${MODEL_SNAPSHOT_KEY_PREFIX}${newProfile.id}.${revision}`, {
      schemaVersion: 3, profileId: newProfile.id, catalogRevision: revision,
      savedAt: snapshot?.savedAt ?? Date.now(), directory: converted,
    });
  } };
}
// These rules reproduce the published v2 identity; runtime normalizers may evolve independently.
function legacyConfiguredModels(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(record).flatMap(model => {
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!id || !['openai', 'chatgpt', 'claude'].includes(model.route as string)) return [];
    const windows = Array.isArray(model.contextWindows)
      ? [...new Set(model.contextWindows.map(legacyPositiveNumber).filter((item): item is number => item !== undefined))]
        .sort((left, right) => left - right)
      : [];
    return [{
      id, route: model.route,
      name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : undefined,
      openaiApi: model.openaiApi === 'chat' || model.openaiApi === 'responses' ? model.openaiApi : undefined,
      maxInputTokens: legacyPositiveNumber(model.maxInputTokens),
      maxOutputTokens: legacyPositiveNumber(model.maxOutputTokens),
      toolCalling: typeof model.toolCalling === 'boolean' ? model.toolCalling : undefined,
      imageInput: typeof model.imageInput === 'boolean' ? model.imageInput : undefined,
      thinking: typeof model.thinking === 'boolean' ? model.thinking : undefined,
      contextWindows: windows.length ? windows : undefined,
      openai: legacyOpenAICapabilities(model.openai),
    }];
  });
}

function legacyRequestHeaders(value: unknown): Array<readonly [string, string]> {
  const headers: Record<string, string> = {};
  if (record(value)) {
    for (const [name, entry] of Object.entries(value)) {
      const key = name.trim();
      if (key && typeof entry === 'string' && !isReservedRelayHeader(key)) headers[key] = entry;
    }
  }
  return canonicalRelayHeaders(headers);
}

function legacyPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function legacyOpenAICapabilities(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return undefined;
  const efforts = Array.isArray(value.reasoningEfforts) ? [...new Set(value.reasoningEfforts.filter(isReasoningEffort))] : [];
  const result: Record<string, unknown> = {
    tokenLimitField: ['max_tokens', 'max_completion_tokens', 'omit'].includes(value.tokenLimitField as string)
      ? value.tokenLimitField : undefined,
    reasoningEfforts: efforts.length ? efforts : undefined,
    defaultReasoningEffort: isReasoningEffort(value.defaultReasoningEffort)
      && (!efforts.length || efforts.includes(value.defaultReasoningEffort)) ? value.defaultReasoningEffort : undefined,
  };
  for (const key of ['contextWindow', 'promptCacheKey', 'store', 'strictTools', 'parallelToolCalls', 'replayReasoningContent',
    'assistantPhase', 'encryptedReasoning', 'reasoningSummary', 'developerRole', 'clientRequestId']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  return Object.values(result).some(item => item !== undefined) ? result : undefined;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  return record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
