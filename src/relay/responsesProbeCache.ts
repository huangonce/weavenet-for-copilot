import type * as vscode from 'vscode';
import { RESPONSES_PROBE_KEY_PREFIX } from '../constants';

/**
 * Cache for the OpenAI Responses API probing results.
 *
 * Probing runs during model refresh/test. Caching by stable `profileId` plus
 * model id keeps repeated passive picker refreshes from issuing paid
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

export class ResponsesProbeCache {
  private readonly entries = new Map<string, ResponsesProbeCacheEntry>();
  private state: vscode.Memento | undefined;

  /** Attaches the extension-global state so verdicts survive restarts. */
  attach(state: vscode.Memento): void {
    this.state = state;
  }

  /** Returns the cached protocol verdict or undefined when absent/expired. */
  get(profileId: string | undefined, modelId: string, now = Date.now()): 'chat' | 'responses' | undefined {
    const key = this.key(profileId, modelId);
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

  set(profileId: string | undefined, modelId: string, protocol: 'chat' | 'responses', ttlMs: number, now = Date.now()): void {
    const key = this.key(profileId, modelId);
    const entry: ResponsesProbeCacheEntry = { protocol, expiresAt: now + Math.max(0, ttlMs) };
    this.entries.set(key, entry);
    this.persist(key, entry);
  }

  /** Drops every verdict for one profile (e.g. connection edited or re-keyed). */
  clearProfile(profileId: string | undefined): void {
    const prefix = `${this.scope(profileId)}::`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    if (this.state) {
      const persistedPrefix = `${RESPONSES_PROBE_KEY_PREFIX}${prefix}`;
      for (const key of this.state.keys()) {
        if (key.startsWith(persistedPrefix)) this.persist(key.slice(RESPONSES_PROBE_KEY_PREFIX.length), undefined);
      }
    }
  }

  /** Removes every cached verdict (e.g. when all connections are removed). */
  clear(): void {
    this.entries.clear();
    if (this.state) {
      for (const key of this.state.keys()) {
        if (key.startsWith(RESPONSES_PROBE_KEY_PREFIX)) this.persist(key.slice(RESPONSES_PROBE_KEY_PREFIX.length), undefined);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private persist(key: string, entry: ResponsesProbeCacheEntry | undefined): void {
    if (!this.state) return;
    void this.state.update(this.persistedKey(key), entry).then(() => undefined, () => undefined);
  }

  private persistedKey(key: string): string {
    return `${RESPONSES_PROBE_KEY_PREFIX}${key}`;
  }

  private key(profileId: string | undefined, modelId: string): string {
    return `${this.scope(profileId)}::${modelId}`;
  }

  private scope(profileId: string | undefined): string {
    return profileId ? `profile:${profileId}` : 'global';
  }
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
