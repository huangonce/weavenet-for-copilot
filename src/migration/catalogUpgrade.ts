import type * as vscode from 'vscode';
import type { RoutedModel } from '../relay/types';

// Only this upgrade boundary knows the old persisted transport representation.
const V2_PREFIX = 'weavenet-copilot.modelSnapshots.v2.';
const V1_PREFIX = 'weavenet-copilot.modelSnapshots.v1.';
const MAX_MODELS = 2_000;

export interface LegacyCatalogSnapshot {
  readonly savedAt: number;
  readonly directory: RoutedModel[];
  readonly models: RoutedModel[];
}

export function legacySnapshotKeys(state: vscode.Memento, profileId?: string): readonly string[] {
  return state.keys().filter(key => profileId
    ? key.startsWith(`${V2_PREFIX}${profileId}.`) || key === `${V1_PREFIX}${profileId}`
    : key.startsWith(V2_PREFIX) || key.startsWith(V1_PREFIX));
}

/** The caller supplies the current credential-bound revision; v1 has no such proof and is never read. */
export function readLegacyCatalogSnapshot(state: vscode.Memento, profileId: string, revision: string, now = Date.now()): LegacyCatalogSnapshot | undefined {
  if (!/^[a-f0-9]{64}$/.test(revision)) return undefined;
  const value = state.get<unknown>(`${V2_PREFIX}${profileId}.${revision}`);
  if (!record(value) || value.schemaVersion !== 2 || value.profileId !== profileId || value.catalogRevision !== revision
    || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || value.savedAt <= 0 || value.savedAt > now + 86_400_000
    || !Array.isArray(value.models) || value.models.length > MAX_MODELS || !record(value.snapshots)) return undefined;
  const models = value.models.map(upgradePersistedModel);
  if (models.some(model => !model)) return undefined;
  const directory: RoutedModel[] = [];
  for (const key of ['openai', 'chatgpt', 'claude']) {
    const list = value.snapshots[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > MAX_MODELS) return undefined;
    const converted = list.map(upgradePersistedModel);
    if (converted.some(model => !model)) return undefined;
    directory.push(...converted as RoutedModel[]);
  }
  const unique = new Map<string, RoutedModel>();
  const candidates = directory.length ? directory : (models as RoutedModel[]).filter(model => model.catalogSource === 'discovery');
  for (const model of candidates) unique.set(`${model.apiType}:${model.upstreamId}`, { ...model, catalogSource: 'discovery' });
  return { savedAt: value.savedAt, directory: [...unique.values()].slice(0, MAX_MODELS), models: models as RoutedModel[] };
}

function upgradePersistedModel(value: unknown): RoutedModel | undefined {
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.upstreamId !== 'string' || !value.upstreamId
    || typeof value.pickerId !== 'string' || !value.pickerId) return undefined;
  const apiType = value.apiType === 'messages' || value.apiType === 'responses' || value.apiType === 'chat-completions' ? value.apiType
    : value.protocol === 'claude' ? 'messages' : value.protocol === 'openai' ? value.openaiApi === 'responses' ? 'responses' : 'chat-completions' : undefined;
  if (!apiType) return undefined;
  const model = { ...value };
  for (const key of ['protocol', 'route', 'openaiApi', 'contextWindows']) delete model[key];
  if (record(model.metadataSources)) { model.metadataSources = { ...model.metadataSources }; delete (model.metadataSources as Record<string, unknown>).contextWindows; }
  return { ...model, apiType, catalogSource: value.catalogSource === 'configured' ? 'configured' : 'discovery' } as unknown as RoutedModel;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
