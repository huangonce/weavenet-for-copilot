import * as vscode from 'vscode';
import { createHmac } from 'node:crypto';
import type { AuthManager } from '../auth/auth';
import { getConfig, getProfileConfiguration } from '../config/config';
import type { ConnectionProfile, ExtensionConfig } from '../config/config';
import {
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
  LEGACY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
  RELAY_API_KEY_SECRET,
} from '../constants';
import { connectionErrorMessage, safeHost } from './connection';
import type { ConnectionDiagnosticsSnapshot } from './connectionDiagnostics';
import { currentProfileFingerprint, diagnosticsOptions } from './connectionDiagnosticsStore';
import type { ConnectionDiagnosticsStore } from './connectionDiagnosticsStore';
import type { ModelCatalogService } from './modelCatalogService';
import type { RoutedModel } from '../relay/types';
import { catalogArtifactRevision, catalogRevision } from './catalogIdentity';
import { formatLogError } from './requestDiagnostics';

export { catalogRevision } from './catalogIdentity';

export type ModelRefreshIntent = 'passive' | 'invalidate';

const MAX_CONCURRENT_MODEL_REFRESHES = 3;

export interface ConnectionStatus {
  phase: 'unconfigured' | 'keyMissing' | 'refreshing' | 'ready' | 'degraded' | 'error';
  connectionCount: number;
  modelCount: number;
  warningCount: number;
  refreshingCount: number;
  connections: readonly ConnectionStatusEntry[];
  message?: string;
}

export interface ConnectionStatusEntry {
  profileId: string;
  connectionName: string;
  host?: string;
  phase: Exclude<ConnectionStatus['phase'], 'unconfigured'>;
  modelCount: number;
  modelRefreshedAt?: number;
  lastDiagnostics?: ConnectionDiagnosticsSnapshot;
  message?: string;
}

export interface ConnectionRuntime {
  profile: ConnectionProfile;
  revision: string;
  /** Credential-bound identity for persisted snapshots and probe verdicts. */
  artifactRevision?: string;
  /** Process-local credential identity, independent of display/catalog settings. */
  credentialRevision?: string;
  models: RoutedModel[];
  directory: RoutedModel[];
  generation: number;
  resolved: boolean;
  phase: ConnectionStatusEntry['phase'];
  refreshedAt?: number;
  message?: string;
  lastDiagnostics?: ConnectionDiagnosticsSnapshot;
  refreshTask?: Promise<void>;
  refreshToken?: vscode.CancellationToken;
}

export interface ConnectionRuntimeManagerOptions {
  readonly auth: AuthManager;
  readonly diagnosticsStore: ConnectionDiagnosticsStore;
  readonly catalog: ModelCatalogService;
  readonly debug: (config: ExtensionConfig, message: string) => void;
  /** Rebuild provider-facing bindings before observers receive the new status. */
  readonly rebuildBindings: () => void;
  /** Aggregated connection status changed (rebuildStatus). */
  readonly onStatusChanged: (status: ConnectionStatus) => void;
  /** Notify the model picker after bindings and status are both current. */
  readonly onCatalogChanged: () => void;
}

/**
 * Owns the per-connection runtime state machines: profile sync, generation/
 * revision-guarded refreshes, snapshot restore, and secret-driven invalidation.
 * Emits aggregated status and catalog changes through callbacks; the provider
 * wires those to its event emitters and the model binding registry.
 */
export class ConnectionRuntimeManager {
  private readonly runtimes = new Map<string, ConnectionRuntime>();
  private activeRefreshes = 0;
  private readonly queuedRefreshes: Array<() => void> = [];
  private connectionStatus: ConnectionStatus = {
    phase: 'unconfigured', connectionCount: 0, modelCount: 0, warningCount: 0, refreshingCount: 0, connections: [],
  };

  constructor(private readonly options: ConnectionRuntimeManagerOptions) {}

  getRuntime(profileId: string): ConnectionRuntime | undefined {
    return this.runtimes.get(profileId);
  }

  getRuntimes(): ConnectionRuntime[] {
    return [...this.runtimes.values()];
  }

  syncProfiles(): ConnectionRuntime[] {
    const profiles = getProfileConfiguration().profiles;
    const ids = new Set(profiles.map((profile) => profile.id));
    let changed = false;
    for (const [id, runtime] of this.runtimes) {
      if (ids.has(id)) continue;
      void this.options.catalog.deleteProfile(id);
      runtime.generation++;
      this.runtimes.delete(id);
      changed = true;
    }
    for (const profile of profiles) {
      const revision = catalogRevision(profile);
      const existing = this.runtimes.get(profile.id);
      if (!existing) {
        this.runtimes.set(profile.id, {
          profile, revision,
          // Snapshot restoration waits until the API key is available so the
          // store can prove the record belongs to this exact credential.
          models: [],
          directory: [],
          generation: 0, resolved: false, phase: 'refreshing',
          lastDiagnostics: this.options.diagnosticsStore.get(profile, diagnosticsOptions()),
        });
        changed = true;
      } else if (existing.revision !== revision) {
        // baseUrl, headers or fixed models changed: prior probe verdicts and
        // model snapshots no longer apply to this profile.
        void this.options.catalog.deleteProfile(profile.id);
        existing.generation++;
        existing.profile = profile;
        existing.revision = revision;
        existing.artifactRevision = undefined;
        existing.credentialRevision = undefined;
        existing.models = [];
        existing.directory = [];
        existing.resolved = false;
        existing.phase = 'refreshing';
        existing.message = undefined;
        existing.lastDiagnostics = this.options.diagnosticsStore.get(profile, diagnosticsOptions());
        changed = true;
      } else if (existing.profile.name !== profile.name) {
        // `catalogRevision` already covers baseUrl, requestHeaders, include/
        // excludeModels and models; name is the only remaining user-visible
        // field, so compare it explicitly instead of deep-serializing the
        // whole profile (which is order-sensitive and slower).
        existing.profile = profile;
        changed = true;
      }
    }
    if (changed) this.rebuildAggregates();
    return profiles.map((profile) => this.runtimes.get(profile.id)).filter((runtime): runtime is ConnectionRuntime => Boolean(runtime));
  }

  async reconcileConfiguration(): Promise<void> {
    const runtimes = this.syncProfiles().filter((runtime) => !runtime.resolved);
    if (runtimes.length) await this.refreshRuntimes(runtimes, false);
    else this.options.onCatalogChanged();
  }

  async refreshAll(force: boolean, token?: vscode.CancellationToken): Promise<void> {
    await this.refreshRuntimes(this.syncProfiles(), force, token);
  }

  /** Applies public metadata without rediscovering models or changing connection health. */
  refreshModelMetadata(): void {
    let updated = false;
    for (const runtime of this.runtimes.values()) {
      // Only credential-validated directories may supply selectable models.
      if (!runtime.artifactRevision) continue;
      const config = getConfig(runtime.profile);
      if (!config.modelMetadataEnabled) continue;
      runtime.models = this.options.catalog.assemble(config, runtime.directory);
      updated = true;
    }
    if (updated) {
      this.options.rebuildBindings();
      this.options.onCatalogChanged();
    }
  }

  async prepareCatalog(silent: boolean, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (!silent) return this.refreshAll(false, token);

    // VS Code's silent flag suppresses interaction. Serving local catalogs is
    // our latency policy: only connections without a catalog need to be awaited.
    const pending = new Set(await this.restoreLocalCatalogs());
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    await this.refreshRuntimes(this.syncProfiles().filter((runtime) => pending.has(runtime.profile.id)), false, token);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    this.startBackgroundRefresh();
  }

  async refreshConnection(profileId: string, force = true): Promise<void> {
    this.syncProfiles();
    const runtime = this.runtimes.get(profileId);
    if (runtime) await this.requestConnectionRefresh(runtime, force);
  }

  /**
   * Restores the persisted catalog of every unresolved connection without
   * contacting the Relay, so a host-driven silent enumeration can answer from
   * local state. Returns the ids of connections that still have no catalog to
   * serve; only those need the network round trip.
   */
  async restoreLocalCatalogs(): Promise<readonly string[]> {
    const pending: string[] = [];
    let changed = false;
    for (const runtime of this.syncProfiles()) {
      if (runtime.resolved) continue;
      const profile = runtime.profile;
      const generation = runtime.generation;
      const revision = runtime.revision;
      let apiKey: string | undefined;
      let artifactPepper: string | undefined;
      try {
        apiKey = await this.options.auth.getApiKey(profile);
        if (apiKey) artifactPepper = await this.options.auth.getCatalogArtifactPepper();
      } catch (error) {
        // The awaited refresh path reports an unreadable credential properly.
        this.options.debug(getConfig(profile), `[models] connection=${profile.name}, API key read failed: ${formatLogError(error)}`);
        continue;
      }
      if (runtime.resolved || !this.isCurrentRuntime(runtime, generation, revision)) continue;
      if (!apiKey || !artifactPepper) continue;
      const config = getConfig(profile);
      const artifactRevision = catalogArtifactRevision(config, apiKey, artifactPepper);
      runtime.credentialRevision = credentialRevision(apiKey, artifactPepper);
      changed = this.restoreSnapshot(runtime, config, artifactRevision) || changed;
      if (!runtime.directory.length) pending.push(profile.id);
    }
    if (changed) this.rebuildAggregates();
    return pending;
  }

  /**
   * Starts the network refresh of every unresolved connection without waiting
   * for it. The catalog-change callback re-enumerates the picker once it lands.
   */
  startBackgroundRefresh(): void {
    const runtimes = this.syncProfiles().filter((runtime) => !runtime.resolved && !runtime.refreshTask);
    void this.refreshRuntimes(runtimes, false).catch(() => undefined);
  }

  async handleSecretChange(secretKey: string): Promise<void> {
    this.syncProfiles();
    const profileId = profileIdFromSecretKey(secretKey) ?? profileIdFromLegacySecretKey(secretKey);
    if (!profileId) {
      for (const runtime of this.runtimes.values()) {
        runtime.lastDiagnostics = undefined;
        runtime.generation++;
        runtime.resolved = false;
        runtime.artifactRevision = undefined;
        runtime.credentialRevision = undefined;
        runtime.models = [];
        runtime.directory = [];
        runtime.phase = 'refreshing';
        runtime.message = undefined;
      }
      this.rebuildAggregates();
      await this.options.diagnosticsStore.clear();
      await this.options.catalog.clearAll();
      await this.refreshAll(false);
      return;
    }
    const runtime = this.runtimes.get(profileId);
    if (runtime) {
      runtime.lastDiagnostics = undefined;
      runtime.generation++;
      runtime.resolved = false;
      runtime.artifactRevision = undefined;
      runtime.credentialRevision = undefined;
      runtime.models = [];
      runtime.directory = [];
      runtime.phase = 'refreshing';
      runtime.message = undefined;
      this.rebuildAggregates();
    }
    await this.options.diagnosticsStore.deleteProfile(profileId);
    await this.options.catalog.deleteProfile(profileId);
    if (!runtime) return;
    await this.requestConnectionRefresh(runtime, false);
  }

  setTestConnectionStatus(
    profileId: string,
    fingerprint: string,
    status: Pick<ConnectionRuntime, 'phase' | 'message' | 'lastDiagnostics'>,
  ): void {
    if (currentProfileFingerprint(profileId) !== fingerprint) return;
    const runtime = this.runtimes.get(profileId);
    if (!runtime) return;
    runtime.phase = status.phase;
    runtime.message = status.message;
    if (status.lastDiagnostics !== undefined) runtime.lastDiagnostics = status.lastDiagnostics;
    this.rebuildStatus();
  }

  private requestConnectionRefresh(runtime: ConnectionRuntime, force: boolean, token?: vscode.CancellationToken): Promise<void> {
    if (token?.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
    if (runtime.refreshTask && runtime.refreshToken?.isCancellationRequested) {
      // A retry must not inherit a cancelled owner's queued or active task.
      // Its generation guard still prevents that old task from publishing.
      runtime.generation++;
      runtime.refreshTask = undefined;
      runtime.refreshToken = undefined;
    }
    if (force) {
      if (runtime.resolved || runtime.refreshTask) runtime.generation++;
      runtime.resolved = false;
    }
    if (runtime.resolved && !force) return Promise.resolve();
    if (runtime.refreshTask) {
      // A cancelled picker call stops waiting immediately; the shared refresh
      // continues for whoever started it.
      return waitForRefresh(runtime.refreshTask, token);
    }
    const task = Promise.resolve().then(() => this.runRefresh(async () => {
      if (token?.isCancellationRequested) throw new vscode.CancellationError();
      await this.refreshRuntimeUntilCurrent(runtime, token);
    }));
    const sharedTask = task.finally(() => {
      if (runtime.refreshTask === sharedTask) {
        runtime.refreshTask = undefined;
        runtime.refreshToken = undefined;
      }
    });
    runtime.refreshTask = sharedTask;
    runtime.refreshToken = token;
    return waitForRefresh(sharedTask, token);
  }

  private async refreshRuntimes(runtimes: readonly ConnectionRuntime[], force: boolean, token?: vscode.CancellationToken): Promise<void> {
    await Promise.all(runtimes.map((runtime) => this.requestConnectionRefresh(runtime, force, token)));
  }

  private async runRefresh(operation: () => Promise<void>): Promise<void> {
    if (this.activeRefreshes >= MAX_CONCURRENT_MODEL_REFRESHES) {
      await new Promise<void>((resolve) => this.queuedRefreshes.push(resolve));
    } else {
      this.activeRefreshes++;
    }
    try {
      await operation();
    } finally {
      // Transfer this slot to the next task before allowing another caller in.
      const next = this.queuedRefreshes.shift();
      if (next) next();
      else this.activeRefreshes--;
    }
  }

  private async refreshRuntimeUntilCurrent(runtime: ConnectionRuntime, token?: vscode.CancellationToken): Promise<void> {
    while (this.runtimes.get(runtime.profile.id) === runtime && !token?.isCancellationRequested) {
      const generation = runtime.generation;
      await this.refreshRuntimeOnce(runtime, generation, token);
      if (runtime.generation === generation) return;
    }
  }

  private async refreshRuntimeOnce(runtime: ConnectionRuntime, generation: number, token?: vscode.CancellationToken): Promise<void> {
    const profile = runtime.profile;
    const revision = runtime.revision;
    let apiKey: string | undefined;
    let artifactPepper: string | undefined;
    try {
      apiKey = await this.options.auth.getApiKey(profile);
      if (apiKey) artifactPepper = await this.options.auth.getCatalogArtifactPepper();
    } catch (error) {
      if (!this.isCurrentRuntime(runtime, generation, revision)) return;
      runtime.resolved = true;
      runtime.phase = runtime.models.length ? 'degraded' : 'error';
      runtime.message = `Could not read the API key: ${connectionErrorMessage(error)}`;
      runtime.refreshedAt = Date.now();
      this.options.debug(getConfig(profile), `[models] connection=${profile.name}, API key read failed: ${formatLogError(error)}`);
      this.rebuildAggregates();
      return;
    }
    if (!this.isCurrentRuntime(runtime, generation, revision)) return;
    if (!apiKey) {
      runtime.artifactRevision = undefined;
      runtime.credentialRevision = undefined;
      runtime.models = [];
      runtime.directory = [];
      await this.options.catalog.clearSnapshot(profile);
      runtime.resolved = true;
      runtime.phase = 'keyMissing';
      runtime.message = 'API key required.';
      runtime.refreshedAt = Date.now();
      this.rebuildAggregates();
      return;
    }
    if (!artifactPepper) {
      runtime.resolved = true;
      runtime.phase = runtime.models.length ? 'degraded' : 'error';
      runtime.message = 'Could not prepare secure model catalog storage.';
      runtime.refreshedAt = Date.now();
      this.rebuildAggregates();
      return;
    }
    const config = getConfig(profile);
    const artifactRevision = catalogArtifactRevision(config, apiKey, artifactPepper);
    runtime.credentialRevision = credentialRevision(apiKey, artifactPepper);
    const artifactChanged = this.restoreSnapshot(runtime, config, artifactRevision);
    runtime.phase = 'refreshing';
    runtime.message = undefined;
    if (artifactChanged) this.rebuildAggregates();
    else this.rebuildStatus();
    try {
      const result = await this.options.catalog.load(
        config,
        apiKey,
        runtime.directory,
        token,
      );
      if (!this.isCurrentRuntime(runtime, generation, revision)) return;
      runtime.models = result.models;
      runtime.directory = result.directory;
      runtime.resolved = true;
      runtime.phase = result.directoryError ? 'degraded' : 'ready';
      runtime.message = result.directoryError ? 'The Relay directory could not be refreshed; using the last catalog.' : undefined;
      runtime.refreshedAt = Date.now();
      if (!result.directoryError) await this.options.catalog.persistSnapshot(profile.id, artifactRevision, result.directory);
    } catch (error) {
      if (!this.isCurrentRuntime(runtime, generation, revision)) return;
      if (isCancellationError(error)) {
        runtime.resolved = false;
        runtime.phase = runtime.models.length ? 'degraded' : 'error';
        runtime.message = runtime.models.length
          ? 'Model refresh was cancelled; using the last saved catalog.'
          : undefined;
        this.rebuildAggregates();
        return;
      }
      runtime.resolved = true;
      runtime.phase = runtime.models.length ? 'degraded' : 'error';
      runtime.message = connectionErrorMessage(error);
      runtime.refreshedAt = Date.now();
      this.options.debug(config, `[models] connection=${profile.name}, refresh failed: ${formatLogError(error)}`);
    }
    this.rebuildAggregates();
  }

  /**
   * Applies the persisted catalog that belongs to this exact credential.
   * Returns true when the runtime's models were replaced.
   */
  private restoreSnapshot(runtime: ConnectionRuntime, config: ExtensionConfig, artifactRevision: string): boolean {
    if (runtime.artifactRevision === artifactRevision) return false;
    const restored = this.options.catalog.restore(runtime.profile.id, artifactRevision);
    runtime.artifactRevision = artifactRevision;
    runtime.directory = restored?.directory ?? [];
    runtime.models = this.options.catalog.assemble(config, runtime.directory);
    return true;
  }

  private isCurrentRuntime(runtime: ConnectionRuntime, generation: number, revision: string): boolean {
    return this.runtimes.get(runtime.profile.id) === runtime && runtime.generation === generation && runtime.revision === revision;
  }

  private rebuildAggregates(): void {
    this.options.rebuildBindings();
    this.rebuildStatus();
    this.options.onCatalogChanged();
  }

  private rebuildStatus(): void {
    const connections: ConnectionStatusEntry[] = [...this.runtimes.values()].map((runtime) => ({
      profileId: runtime.profile.id,
      connectionName: runtime.profile.name,
      host: safeHost(runtime.profile.baseUrl),
      phase: runtime.phase,
      modelCount: runtime.models.length,
      modelRefreshedAt: runtime.refreshedAt,
      lastDiagnostics: runtime.lastDiagnostics,
      message: runtime.message,
    }));
    const modelCount = connections.reduce((total, connection) => total + connection.modelCount, 0);
    const refreshingCount = connections.filter((connection) => connection.phase === 'refreshing').length;
    const warningCount = connections.filter((connection) => connection.phase === 'keyMissing' || connection.phase === 'degraded' || connection.phase === 'error').length;
    let phase: ConnectionStatus['phase'];
    if (!connections.length) phase = 'unconfigured';
    else if (refreshingCount) phase = 'refreshing';
    else if (warningCount) phase = modelCount ? 'degraded' : connections.every((entry) => entry.phase === 'keyMissing') ? 'keyMissing' : 'error';
    else phase = 'ready';
    this.connectionStatus = { phase, connectionCount: connections.length, modelCount, warningCount, refreshingCount, connections };
    this.options.onStatusChanged(this.connectionStatus);
  }
}

export function isCancellationError(error: unknown): boolean {
  return error instanceof vscode.CancellationError
    || (error instanceof Error && (error.name === 'CancellationError' || error.name === 'AbortError'));
}

function credentialRevision(apiKey: string, pepper: string): string {
  return createHmac('sha256', pepper).update('runtime-credential\0').update(apiKey).digest('hex');
}

export function waitForRefresh(task: Promise<void>, token?: vscode.CancellationToken): Promise<void> {
  if (!token) return task;
  let subscription: vscode.Disposable | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    if (token.isCancellationRequested) reject(new vscode.CancellationError());
    else if (typeof token.onCancellationRequested === 'function') {
      subscription = token.onCancellationRequested(() => reject(new vscode.CancellationError()));
    }
  });
  return Promise.race([task, cancelled]).finally(() => subscription?.dispose());
}

function profileIdFromSecretKey(key: string): string | undefined {
  const prefix = `${RELAY_API_KEY_SECRET}.profileId.`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

function profileIdFromLegacySecretKey(key: string): string | undefined {
  const prefix = `${RELAY_API_KEY_SECRET}.profile.`;
  if (!key.startsWith(prefix)) return undefined;
  try {
    const name = decodeURIComponent(key.slice(prefix.length));
    return getProfileConfiguration().profiles.find((profile) => profile.name === name)?.id;
  }
  catch { return undefined; }
}

export function isWeaveNetSecretKey(key: string): boolean {
  return key === RELAY_API_KEY_SECRET || key.startsWith(`${RELAY_API_KEY_SECRET}.profile.`) ||
    key.startsWith(`${RELAY_API_KEY_SECRET}.profileId.`) || key === LEGACY_API_KEY_SECRET || [
    OPENAI_API_KEY_SECRET,
    CHATGPT_API_KEY_SECRET,
    CLAUDE_API_KEY_SECRET,
  ].some((secretKey) => key === secretKey);
}
