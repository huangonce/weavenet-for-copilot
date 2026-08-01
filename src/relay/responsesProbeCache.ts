/**
 * In-memory cache for the OpenAI Responses API probing results.
 *
 * Probing runs only during user-triggered model refresh/test. Caching by
 * `connectionKey` (the relay base URL) plus model id keeps repeated passive
 * picker refreshes from issuing paid `POST /responses` probes before the TTL
 * (aligned with `metadataRefreshHours`) expires.
 */
export interface ResponsesProbeCacheEntry {
  readonly protocol: 'chat' | 'responses';
  readonly expiresAt: number;
}

export class ResponsesProbeCache {
  private readonly entries = new Map<string, ResponsesProbeCacheEntry>();

  /** Returns the cached protocol verdict or undefined when absent/expired. */
  get(modelId: string, connectionKey: string, now = Date.now()): 'chat' | 'responses' | undefined {
    const entry = this.entries.get(this.key(modelId, connectionKey));
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(this.key(modelId, connectionKey));
      return undefined;
    }
    return entry.protocol;
  }

  set(modelId: string, connectionKey: string, protocol: 'chat' | 'responses', ttlMs: number, now = Date.now()): void {
    this.entries.set(this.key(modelId, connectionKey), {
      protocol,
      expiresAt: now + Math.max(0, ttlMs),
    });
  }

  /** Removes every cached verdict (e.g. when a connection is removed or keyed differently). */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private key(modelId: string, connectionKey: string): string {
    return `${connectionKey}::${modelId}`;
  }
}
