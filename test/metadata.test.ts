import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  _resetMetadataCacheForTests,
  getCachedData,
  initMetadataCache,
  scheduleRefresh,
} from '../src/metadata/metadataCache';
import { OPENROUTER_MAX_ENTRIES, parseOpenRouterResponse } from '../src/metadata/openrouterFallback';

afterEach(() => {
  vi.restoreAllMocks();
  _resetMetadataCacheForTests();
});

function contextWith(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    subscriptions: [],
    globalState: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { values.set(key, value); },
    },
    values,
  };
}

describe('metadata safety', () => {
  it('ignores corrupt cache envelopes', () => {
    const context = contextWith({
      missingTimestamp: { data: ['bad'] },
      invalidTimestamp: { data: ['bad'], fetchedAt: Number.NaN },
      futureTimestamp: { data: ['bad'], fetchedAt: Date.now() + 60 * 60_000 },
    });
    initMetadataCache(context as unknown as vscode.ExtensionContext);
    expect(getCachedData('missingTimestamp')).toBeUndefined();
    expect(getCachedData('invalidTimestamp')).toBeUndefined();
    expect(getCachedData('futureTimestamp')).toBeUndefined();
  });

  it('keeps an old snapshot when a refresh body exceeds its limit', async () => {
    const old = { data: ['old'], fetchedAt: 0 };
    const context = contextWith({ catalog: old });
    initMetadataCache(context as unknown as vscode.ExtensionContext);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('oversized'));
    await scheduleRefresh({
      key: 'catalog',
      url: 'https://example.test/catalog',
      ttlMs: 0,
      maxBodyBytes: 4,
      parse: JSON.parse,
    }, { force: true });
    expect(context.values.get('catalog')).toBe(old);
  });

  it('prefers root context length and rejects oversized catalogs', () => {
    const parsed = parseOpenRouterResponse({
      data: [{ id: 'vendor/model', context_length: 200_000, top_provider: { context_length: 100_000 } }],
    });
    expect(parsed[0]).toMatchObject({ maxInputTokens: 200_000 });
    expect(() => parseOpenRouterResponse({
      data: Array.from({ length: OPENROUTER_MAX_ENTRIES + 1 }, (_, index) => ({ id: `vendor/model-${index}` })),
    })).toThrow('exceeds');
  });
});