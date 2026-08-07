import type * as vscode from 'vscode';
import {
  LEGACY_RESPONSES_PROBE_KEY_PREFIX,
  RESPONSES_PROBE_KEY_PREFIX,
} from '../constants';

/**
 * Cache for the OpenAI Responses API probing results.
 *
 * Probing runs during model refresh/test. Caching by stable `profileId`, an
 * opaque credential-bound catalog revision, and model id keeps repeated
 * passive picker refreshes from issuing paid
 * `POST /responses` probes before the TTL (aligned with `metadataRefreshHours`)
 * expires, while keeping separate connections that share a relay URL (or a
 * profile whose credentials/headers changed) from reusing each other's
 * verdicts. The profile id is a stable UUID; the raw API key is never part of
 * the cache key.
 *
 * The cache can optionally persist verdicts into `ExtensionContext.globalState`
 * (via {@link ResponsesProbeCache.attach}) so a restart does not immediately
 * re-probe every model. Expired or corrupt persisted entries are dropped.
 */
export interface ResponsesProbeCacheEntry {
  readonly protocol: 'chat' | 'responses';
  readonly expiresAt: number;
}

export interface ResponsesProbeScope {
  readonly profileId?: string;
  readonly catalogRevision: string;
}

export class ResponsesProbeCache {
  private readonly entries = new Map<string, ResponsesProbeCacheEntry>();
  private readonly blockedPersistentProfiles = new Set<string>();
  private blockAllPersistentReads = false;
  private state: vscode.Memento | undefined;
  private pendingMutation: Promise<void> = Promise.resolve();

  /** Attaches the extension-global state so verdicts survive restarts. */
  attach(state: vscode.Memento): void {
    this.entries.clear();
    this.blockedPersistentProfiles.clear();
    this.blockAllPersistentReads = false;
    this.state = state;
  }

  /** Returns the cached protocol verdict or undefined when absent/expired. */
  get(scope: ResponsesProbeScope, modelId: string, now = Date.now()): 'chat' | 'responses' | undefined {
    if (!isCatalogRevision(scope.catalogRevision)) return undefined;
    const key = this.key(scope, modelId);
    const entry = this.entries.get(key);
    if (entry) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.persist(key, undefined);
        return undefined;
      }
      return entry.protocol;
    }
    // Restart recovery: read a still-valid persisted verdict back into memory.
    if (this.blockAllPersistentReads || this.blockedPersistentProfiles.has(this.scope(scope.profileId))) {
      return undefined;
    }
    const persisted = this.state?.get<unknown>(this.persistedKey(key));
    const parsed = parsePersistedEntry(persisted);
    if (!parsed) return undefined;
    if (parsed.expiresAt <= now) {
      this.persist(key, undefined);
      return undefined;
    }
    this.entries.set(key, parsed);
    return parsed.protocol;
  }

  set(
    scope: ResponsesProbeScope,
    modelId: string,
    protocol: 'chat' | 'responses',
    ttlMs: number,
    now = Date.now(),
  ): void {
    if (!isCatalogRevision(scope.catalogRevision)) throw new Error('Invalid Responses probe catalog revision.');
    const key = this.key(scope, modelId);
    const entry: ResponsesProbeCacheEntry = { protocol, expiresAt: now + Math.max(0, ttlMs) };
    this.entries.set(key, entry);
    this.persist(key, entry);
  }

  /** Drops every verdict for one profile (e.g. connection edited or re-keyed). */
  clearProfile(profileId: string | undefined): Promise<void> {
    const profileScope = this.scope(profileId);
    const prefix = `${profileScope}::`;
    // Logical invalidation is authoritative even if best-effort Memento
    // cleanup fails. This prevents force-refresh from rehydrating old data.
    this.blockedPersistentProfiles.add(profileScope);
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    const state = this.state;
    if (!state) return Promise.resolve();
    return this.queueMutation(async () => {
      const prefixes = [
        `${RESPONSES_PROBE_KEY_PREFIX}${prefix}`,
        `${LEGACY_RESPONSES_PROBE_KEY_PREFIX}${prefix}`,
      ];
      await Promise.all(state.keys()
        .filter((key) => prefixes.some((persistedPrefix) => key.startsWith(persistedPrefix)))
        .map((key) => state.update(key, undefined)));
    });
  }

  /** Removes every cached verdict (e.g. when all connections are removed). */
  clear(): Promise<void> {
    this.entries.clear();
    this.blockAllPersistentReads = true;
    const state = this.state;
    if (!state) return Promise.resolve();
    return this.queueMutation(async () => {
      await Promise.all(state.keys()
        .filter((key) => key.startsWith(RESPONSES_PROBE_KEY_PREFIX)
          || key.startsWith(LEGACY_RESPONSES_PROBE_KEY_PREFIX))
        .map((key) => state.update(key, undefined)));
    });
  }

  get size(): number {
    return this.entries.size;
  }

  private persist(key: string, entry: ResponsesProbeCacheEntry | undefined): void {
    const state = this.state;
    if (!state) return;
    this.queueMutation(() => state.update(this.persistedKey(key), entry));
  }

  private persistedKey(key: string): string {
    return `${RESPONSES_PROBE_KEY_PREFIX}${key}`;
  }

  private key(scope: ResponsesProbeScope, modelId: string): string {
    return `${this.scope(scope.profileId)}::revision:${scope.catalogRevision}::${modelId}`;
  }

  private scope(profileId: string | undefined): string {
    return profileId ? `profile:${profileId}` : 'global';
  }

  private queueMutation(operation: () => PromiseLike<void>): Promise<void> {
    const result = this.pendingMutation.then(() => operation());
    this.pendingMutation = result.then(() => undefined, () => undefined);
    // Cache persistence is opportunistic and must never break model loading.
    return result.then(() => undefined, () => undefined);
  }
}

function isCatalogRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function parsePersistedEntry(value: unknown): ResponsesProbeCacheEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.protocol !== 'chat' && record.protocol !== 'responses') return undefined;
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) return undefined;
  return { protocol: record.protocol, expiresAt: record.expiresAt };
}

/** Module-wide single instance shared by model discovery and connection management. */
export const responsesProbeCache = new ResponsesProbeCache();

/** Attaches the extension-global state once during `activate`. */
export function initResponsesProbeCache(context: vscode.ExtensionContext): void {
  responsesProbeCache.attach(context.globalState);
}
