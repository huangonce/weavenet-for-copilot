import * as vscode from 'vscode';

/**
 * Shared singleton cache for remote metadata snapshots such as OpenRouter.
 *
 * Stores parsed entries in `ExtensionContext.globalState` with optional ETag and
 * fetch timestamp so refreshes can short-circuit via HTTP 304. All network work
 * is fire-and-forget — callers never block waiting for fresh data; consumers
 * subscribe to {@link onMetadataChanged} to react when a refresh actually
 * delivers new content.
 */

const FETCH_TIMEOUT_MS = 30_000;

interface CacheEntry<T> {
  readonly data: T;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly fetchedAt: number;
}

export interface RefreshSpec<T> {
  /** Stable cache key used for `globalState` storage. */
  readonly key: string;
  /** HTTPS URL to fetch. */
  readonly url: string;
  /** Maximum cache age before a refresh is attempted. */
  readonly ttlMs: number;
  /** Parses the response body into the cached shape. Must be synchronous and fast. */
  readonly parse: (body: string) => T;
  /** Optional label for log lines. */
  readonly label?: string;
}

let extensionContext: vscode.ExtensionContext | undefined;
const changeEmitter = new vscode.EventEmitter<void>();
const inflight = new Map<string, Promise<void>>();
let debugLog: ((message: string) => void) | undefined;

/** Subscribes to refresh-completed notifications. */
export const onMetadataChanged: vscode.Event<void> = changeEmitter.event;

/** Initializes the cache with the extension context. Call once during `activate`. */
export function initMetadataCache(context: vscode.ExtensionContext, debug?: (message: string) => void): void {
  extensionContext = context;
  debugLog = debug;
  context.subscriptions.push(changeEmitter);
}

/** Reads the cached payload for {@link key}, or `undefined` if not yet populated. */
export function getCachedData<T>(key: string): T | undefined {
  return extensionContext?.globalState.get<CacheEntry<T>>(key)?.data;
}

/** Returns the cache timestamp for diagnostic logging. */
export function getCachedFetchedAt(key: string): number | undefined {
  return extensionContext?.globalState.get<CacheEntry<unknown>>(key)?.fetchedAt;
}

/**
 * Fires a fire-and-forget background refresh if the cached entry is missing or
 * older than `spec.ttlMs`. Concurrent calls for the same key share a single
 * inflight request. Returns the inflight Promise (or `undefined` when no
 * refresh was scheduled) so callers that want to await completion (e.g. a
 * user-initiated force refresh) can do so.
 *
 * Pass `options.force = true` to bypass both the TTL check and the cached
 * ETag / If-Modified-Since headers, guaranteeing a fresh body.
 */
export function scheduleRefresh<T>(spec: RefreshSpec<T>, options?: { force?: boolean }): Promise<void> | undefined {
  if (!extensionContext) return undefined;

  // Share an inflight task so a force-refresh kicked off while a TTL refresh
  // is in progress still receives the result.
  const existing = inflight.get(spec.key);
  if (existing) return existing;

  const stored = extensionContext.globalState.get<CacheEntry<T>>(spec.key);
  const isStale = !stored || Date.now() - stored.fetchedAt > spec.ttlMs;
  if (!isStale && !options?.force) return undefined;

  const task = runRefresh(spec, stored, options?.force === true)
    .catch((error) => {
      debugLog?.(`[${spec.label ?? spec.key}] refresh error: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      inflight.delete(spec.key);
    });
  inflight.set(spec.key, task);
  return task;
}

async function runRefresh<T>(spec: RefreshSpec<T>, stored: CacheEntry<T> | undefined, force: boolean): Promise<void> {
  if (!extensionContext) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    // Skip conditional-GET headers on forced refresh so the server always
    // returns a fresh 200 body instead of a 304.
    if (!force && stored?.etag) headers['If-None-Match'] = stored.etag;
    if (!force && stored?.lastModified) headers['If-Modified-Since'] = stored.lastModified;

    const response = await fetch(spec.url, { headers, signal: controller.signal });

    if (response.status === 304 && stored) {
      // Body unchanged — refresh only the timestamp so we don't re-fetch
      // again until the next TTL window.
      await extensionContext.globalState.update(spec.key, { ...stored, fetchedAt: Date.now() });
      debugLog?.(`[${spec.label ?? spec.key}] 304 not modified`);
      return;
    }

    if (!response.ok) {
      debugLog?.(`[${spec.label ?? spec.key}] HTTP ${response.status}`);
      return;
    }

    const body = await response.text();
    let parsed: T;
    try {
      parsed = spec.parse(body);
    } catch (error) {
      debugLog?.(`[${spec.label ?? spec.key}] parse failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const entry: CacheEntry<T> = {
      data: parsed,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      fetchedAt: Date.now(),
    };
    await extensionContext.globalState.update(spec.key, entry);
    debugLog?.(`[${spec.label ?? spec.key}] refreshed`);
    changeEmitter.fire();
  } finally {
    clearTimeout(timeout);
  }
}

/** Test-only reset hook. Do not call from production code. */
export function _resetMetadataCacheForTests(): void {
  extensionContext = undefined;
  debugLog = undefined;
  inflight.clear();
}
