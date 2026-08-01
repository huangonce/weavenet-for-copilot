/**
 * In-memory cache for the OpenAI Responses API probing results.
 *
 * Probing runs during model refresh/test. Caching by stable `profileId` plus
 * model id keeps repeated passive picker refreshes from issuing paid
 * `POST /responses` probes before the TTL (aligned with `metadataRefreshHours`)
 * expires, while keeping separate connections that share a relay URL (or a
 * profile whose credentials/headers changed) from reusing each other's
 * verdicts. The profile id is a stable UUID; the raw API key is never part of
 * the cache key.
 */
export interface ResponsesProbeCacheEntry {
  readonly protocol: 'chat' | 'responses';
  readonly expiresAt: number;
}

export class ResponsesProbeCache {
  private readonly entries = new Map<string, ResponsesProbeCacheEntry>();

  /** Returns the cached protocol verdict or undefined when absent/expired. */
  get(profileId: string | undefined, modelId: string, now = Date.now()): 'chat' | 'responses' | undefined {
    const entry = this.entries.get(this.key(profileId, modelId));
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(this.key(profileId, modelId));
      return undefined;
    }
    return entry.protocol;
  }

  set(profileId: string | undefined, modelId: string, protocol: 'chat' | 'responses', ttlMs: number, now = Date.now()): void {
    this.entries.set(this.key(profileId, modelId), {
      protocol,
      expiresAt: now + Math.max(0, ttlMs),
    });
  }

  /** Drops every verdict for one profile (e.g. connection edited or re-keyed). */
  clearProfile(profileId: string | undefined): void {
    const prefix = `${this.scope(profileId)}::`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Removes every cached verdict (e.g. when all connections are removed). */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private key(profileId: string | undefined, modelId: string): string {
    return `${this.scope(profileId)}::${modelId}`;
  }

  private scope(profileId: string | undefined): string {
    return profileId ? `profile:${profileId}` : 'global';
  }
}

/** Module-wide single instance shared by model discovery and connection management. */
export const responsesProbeCache = new ResponsesProbeCache();
