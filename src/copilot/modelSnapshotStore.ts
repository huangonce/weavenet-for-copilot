import type * as vscode from 'vscode';
import { isApiType } from '../config/config';
import type { RoutedModel } from '../relay/types';
import { MODEL_SNAPSHOT_KEY_PREFIX, MODEL_SNAPSHOT_SCHEMA_VERSION } from '../constants';
import { legacySnapshotKeys, readLegacyCatalogSnapshot } from '../migration/catalogUpgrade';

export const MAX_SNAPSHOT_MODELS = 2_000;
export interface ModelSnapshotRecord {
  readonly schemaVersion: 3;
  readonly profileId: string;
  readonly catalogRevision: string;
  readonly savedAt: number;
  /** One last-successful discovered directory; fixed/configured models are assembled on restoration. */
  readonly directory: RoutedModel[];
}

export class ModelSnapshotStore {
  private pendingMutation: Promise<void> = Promise.resolve();
  constructor(private readonly state: vscode.Memento) {}

  get(profileId: string, catalogRevision: string): ModelSnapshotRecord | undefined {
    if (!isRevision(catalogRevision)) return undefined;
    const current = parseModelSnapshot(this.state.get<unknown>(snapshotKey(profileId, catalogRevision)), profileId, catalogRevision);
    if (current) return current;
    const legacy = readLegacyCatalogSnapshot(this.state, profileId, catalogRevision);
    if (!legacy) return undefined;
    const upgraded: ModelSnapshotRecord = { schemaVersion: 3, profileId, catalogRevision, savedAt: legacy.savedAt, directory: legacy.directory };
    // Logical restoration does not wait for best-effort storage; mutations stay ordered with deletion.
    void this.update(profileId, catalogRevision, legacy.directory, legacy.savedAt).catch(() => undefined);
    return upgraded;
  }

  async update(profileId: string, catalogRevision: string, directory: readonly RoutedModel[], savedAt = Date.now()): Promise<void> {
    if (!isRevision(catalogRevision)) throw new Error('Invalid model snapshot catalog revision.');
    const record: ModelSnapshotRecord = { schemaVersion: 3, profileId, catalogRevision, savedAt,
      directory: directory.slice(0, MAX_SNAPSHOT_MODELS) };
    if (!parseModelSnapshot(record, profileId, catalogRevision)) throw new Error('Invalid model snapshot directory.');
    await this.enqueue(async () => {
      const key = snapshotKey(profileId, catalogRevision);
      await this.state.update(key, record);
      const prefix = `${MODEL_SNAPSHOT_KEY_PREFIX}${profileId}.`;
      const legacy = new Set(legacySnapshotKeys(this.state, profileId));
      await Promise.all(this.state.keys().filter(candidate => (candidate.startsWith(prefix) && candidate !== key) || legacy.has(candidate))
        .map(candidate => this.state.update(candidate, undefined)));
    });
  }

  async deleteProfile(profileId: string): Promise<void> {
    await this.enqueue(async () => {
      const prefix = `${MODEL_SNAPSHOT_KEY_PREFIX}${profileId}.`;
      const legacy = new Set(legacySnapshotKeys(this.state, profileId));
      await Promise.all(this.state.keys().filter(key => key.startsWith(prefix) || legacy.has(key)).map(key => this.state.update(key, undefined)));
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      const legacy = new Set(legacySnapshotKeys(this.state));
      await Promise.all(this.state.keys().filter(key => key.startsWith(MODEL_SNAPSHOT_KEY_PREFIX) || legacy.has(key))
        .map(key => this.state.update(key, undefined)));
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pendingMutation.then(operation);
    this.pendingMutation = result.catch(() => undefined);
    return result;
  }
}

export function snapshotKey(profileId: string, revision: string): string {
  return `${MODEL_SNAPSHOT_KEY_PREFIX}${profileId}.${revision}`;
}

export function parseModelSnapshot(value: unknown, expectedProfileId?: string, expectedRevision?: string, now = Date.now()): ModelSnapshotRecord | undefined {
  if (!record(value) || value.schemaVersion !== MODEL_SNAPSHOT_SCHEMA_VERSION || typeof value.profileId !== 'string' || !value.profileId
    || value.profileId.length > 128 || (expectedProfileId !== undefined && value.profileId !== expectedProfileId)
    || !isRevision(value.catalogRevision) || (expectedRevision !== undefined && value.catalogRevision !== expectedRevision)
    || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || value.savedAt <= 0 || value.savedAt > now + 86_400_000
    || !Array.isArray(value.directory) || value.directory.length > MAX_SNAPSHOT_MODELS) return undefined;
  const directory = value.directory.map(parseModel);
  if (directory.some(model => !model)) return undefined;
  return { schemaVersion: 3, profileId: value.profileId, catalogRevision: value.catalogRevision, savedAt: value.savedAt, directory: directory as RoutedModel[] };
}

function parseModel(value: unknown): RoutedModel | undefined {
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.upstreamId !== 'string' || !value.upstreamId
    || typeof value.pickerId !== 'string' || !value.pickerId || !isApiType(value.apiType)
    || value.protocol !== undefined || value.route !== undefined || value.openaiApi !== undefined) return undefined;
  return { ...value, catalogSource: 'discovery' } as unknown as RoutedModel;
}
function isRevision(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
