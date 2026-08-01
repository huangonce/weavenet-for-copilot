import type * as vscode from 'vscode';
import type { RoutedModel } from '../relay/types';
import { MODEL_SNAPSHOT_KEY_PREFIX, MODEL_SNAPSHOT_SCHEMA_VERSION } from '../constants';

/**
 * Persists the last successful model catalog per connection profile into
 * `ExtensionContext.globalState` so a restart can restore the picker even
 * while the relay is unreachable. The store mirrors the in-memory
 * `ConnectionRuntime.snapshots` (per-route model lists used as fallback when a
 * route refresh fails) plus the final deduplicated/unique-picker-id model list
 * that feeds the picker.
 *
 * All persisted values are plain JSON — `RoutedModel` contains no functions or
 * class instances — and are validated on read so corrupt or truncated state can
 * never crash the extension.
 */
export const MAX_SNAPSHOT_MODELS = 2_000;

export interface ModelSnapshotRecord {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly savedAt: number;
  /** Per-route model lists, mirroring `ConnectionRuntime.snapshots`. */
  readonly snapshots: Record<RoutedModel['route'], RoutedModel[]>;
  /** Final deduplicated model list with unique picker ids. */
  readonly models: RoutedModel[];
}

export class ModelSnapshotStore {
  constructor(private readonly state: vscode.Memento) {}

  get(profileId: string): ModelSnapshotRecord | undefined {
    return parseModelSnapshot(this.state.get<unknown>(snapshotKey(profileId)), profileId);
  }

  async update(
    profileId: string,
    snapshots: ReadonlyMap<RoutedModel['route'], RoutedModel[]>,
    models: readonly RoutedModel[],
  ): Promise<void> {
    const record: ModelSnapshotRecord = {
      schemaVersion: 1,
      profileId,
      savedAt: Date.now(),
      snapshots: {
        openai: snapshots.get('openai') ?? [],
        chatgpt: snapshots.get('chatgpt') ?? [],
        claude: snapshots.get('claude') ?? [],
      },
      models: models.slice(0, MAX_SNAPSHOT_MODELS),
    };
    await this.state.update(snapshotKey(profileId), record);
  }

  async deleteProfile(profileId: string): Promise<void> {
    await this.state.update(snapshotKey(profileId), undefined);
  }

  async clear(): Promise<void> {
    await Promise.all(this.state.keys()
      .filter((key) => key.startsWith(MODEL_SNAPSHOT_KEY_PREFIX))
      .map((key) => this.state.update(key, undefined)));
  }
}

function snapshotKey(profileId: string): string {
  return `${MODEL_SNAPSHOT_KEY_PREFIX}${profileId}`;
}

export function parseModelSnapshot(
  value: unknown,
  expectedProfileId?: string,
  now = Date.now(),
): ModelSnapshotRecord | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== MODEL_SNAPSHOT_SCHEMA_VERSION
    || !isProfileId(value.profileId)
    || (expectedProfileId !== undefined && value.profileId !== expectedProfileId)
    || !isTimestamp(value.savedAt, now)
    || !isRecord(value.snapshots)
    || !Array.isArray(value.models)
    || value.models.length > MAX_SNAPSHOT_MODELS
  ) return undefined;
  const snapshots: Record<RoutedModel['route'], RoutedModel[]> = { openai: [], chatgpt: [], claude: [] };
  for (const route of ['openai', 'chatgpt', 'claude'] as const) {
    const list = (value.snapshots as Record<string, unknown>)[route];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > MAX_SNAPSHOT_MODELS) return undefined;
    const models = list.map(parseRoutedModel);
    if (models.some((model) => model === undefined)) return undefined;
    snapshots[route] = models as RoutedModel[];
  }
  const models = (value.models as unknown[]).map(parseRoutedModel);
  if (models.some((model) => model === undefined)) return undefined;
  return {
    schemaVersion: 1,
    profileId: value.profileId,
    savedAt: value.savedAt,
    snapshots,
    models: models as RoutedModel[],
  };
}

function parseRoutedModel(value: unknown): RoutedModel | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string' || !value.id
    || typeof value.upstreamId !== 'string' || !value.upstreamId
    || typeof value.pickerId !== 'string' || !value.pickerId
    || (value.protocol !== 'openai' && value.protocol !== 'claude')
    || (value.route !== 'openai' && value.route !== 'chatgpt' && value.route !== 'claude')
  ) return undefined;
  return {
    ...(value as unknown as RoutedModel),
    // 旧格式快照没有 catalogSource；恢复时归入 discovery（该字段不参与分派，仅作来源元数据）。
    catalogSource: value.catalogSource === 'configured' ? 'configured' : 'discovery',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isTimestamp(value: unknown, now: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= now + 24 * 60 * 60 * 1000;
}
