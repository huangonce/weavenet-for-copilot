import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  _resetMetadataCacheForTests,
  getCachedData,
  getCachedFetchedAt,
  initMetadataCache,
  scheduleRefresh,
} from '../../src/metadata/metadataCache';
import { enrichModelsWithOpenRouter, OPENROUTER_CACHE_KEY, OPENROUTER_MAX_ENTRIES, parseOpenRouterResponse } from '../../src/metadata/openrouterFallback';

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

  it('parses OpenRouter capabilities and per-million reference pricing', () => {
    expect(parseOpenRouterResponse({
      data: [{
        id: 'vendor/vision-model',
        context_length: 400_000,
        top_provider: { max_completion_tokens: 8_000 },
        architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: ['tools', 'reasoning_effort'],
        pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.000001' },
      }],
    })).toEqual([expect.objectContaining({
      id: 'vision-model',
      fullId: 'vendor/vision-model',
      maxInputTokens: 400_000,
      maxOutputTokens: 8_000,
      vision: true,
      toolCalling: true,
      reasoning: true,
      referencePricing: { currencyCode: 'USD', inputPer1M: 2, outputPer1M: 10, cacheHitPer1M: 1 },
    })]);
  });

  it('enriches only unambiguous models and never overwrites relay metadata', async () => {
    const context = contextWith();
    initMetadataCache(context as unknown as vscode.ExtensionContext);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: 'vendor/unique', context_length: 200_000, architecture: { input_modalities: ['image'] } },
        { id: 'vendor-a/ambiguous', context_length: 100_000 },
        { id: 'vendor-b/ambiguous', context_length: 200_000 },
      ],
    }), { headers: { etag: 'catalog-v1' } }));
    await scheduleRefresh({
      key: OPENROUTER_CACHE_KEY,
      url: 'https://example.test/openrouter',
      ttlMs: 0,
      parse: (body) => parseOpenRouterResponse(JSON.parse(body)),
    }, { force: true });

    const [enriched, preserved, ambiguous] = enrichModelsWithOpenRouter([
      { id: 'unique', pickerId: 'unique', upstreamId: 'unique', protocol: 'openai', route: 'openai', metadataSources: {} },
      { id: 'vendor/unique', pickerId: 'vendor/unique', upstreamId: 'vendor/unique', protocol: 'openai', route: 'openai', maxInputTokens: 8_192, metadataSources: { maxInputTokens: 'api' } },
      { id: 'ambiguous', pickerId: 'ambiguous', upstreamId: 'ambiguous', protocol: 'openai', route: 'openai', metadataSources: {} },
    ]);
    expect(enriched).toMatchObject({ maxInputTokens: 200_000, imageInput: true, contextWindows: [200_000], metadataSources: { maxInputTokens: 'openrouter' } });
    expect(preserved).toMatchObject({ maxInputTokens: 8_192, metadataSources: { maxInputTokens: 'api' } });
    expect(ambiguous.maxInputTokens).toBeUndefined();
  });

  it('uses validators for TTL refreshes but bypasses them for forced refreshes', async () => {
    const context = contextWith({
      catalog: { data: ['old'], etag: 'etag-1', lastModified: 'yesterday', fetchedAt: 0 },
    });
    initMetadataCache(context as unknown as vscode.ExtensionContext);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(['fresh'])));
    const spec = { key: 'catalog', url: 'https://example.test/catalog', ttlMs: 0, parse: JSON.parse };

    await scheduleRefresh(spec);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('if-none-match')).toBe('etag-1');
    await scheduleRefresh(spec, { force: true });
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('if-none-match')).toBeNull();
    expect(getCachedData('catalog')).toEqual(['fresh']);
  });

  it('does not schedule refreshes before initialization or for fresh cache entries', () => {
    const spec = { key: 'catalog', url: 'https://example.test/catalog', ttlMs: 60_000, parse: JSON.parse };
    expect(scheduleRefresh(spec)).toBeUndefined();

    const fetchedAt = Date.now();
    const context = contextWith({ catalog: { data: ['fresh'], fetchedAt } });
    initMetadataCache(context as unknown as vscode.ExtensionContext);
    expect(scheduleRefresh(spec)).toBeUndefined();
    expect(getCachedFetchedAt('catalog')).toBe(fetchedAt);
  });

  it('keeps cached values and records useful diagnostics for HTTP and parse failures', async () => {
    const old = { data: ['old'], fetchedAt: 0 };
    const context = contextWith({ catalog: old });
    const log = vi.fn();
    initMetadataCache(context as unknown as vscode.ExtensionContext, log);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('not json'));
    const spec = { key: 'catalog', url: 'https://example.test/catalog', ttlMs: 0, parse: JSON.parse, label: 'Catalog' };

    await scheduleRefresh(spec, { force: true });
    await scheduleRefresh(spec, { force: true });

    expect(context.values.get('catalog')).toBe(old);
    expect(log).toHaveBeenCalledWith('[Catalog] HTTP 503');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[Catalog] parse failed:'));
  });

  it('shares concurrent refresh work for one catalog key', async () => {
    const context = contextWith();
    initMetadataCache(context as unknown as vscode.ExtensionContext);
    let complete: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => { complete = resolve; }));
    const spec = { key: 'catalog', url: 'https://example.test/catalog', ttlMs: 0, parse: JSON.parse };

    const first = scheduleRefresh(spec, { force: true });
    const second = scheduleRefresh(spec, { force: true });
    expect(second).toBe(first);
    complete?.(new Response(JSON.stringify(['fresh'])));
    await first;
    expect(getCachedData('catalog')).toEqual(['fresh']);
  });
});