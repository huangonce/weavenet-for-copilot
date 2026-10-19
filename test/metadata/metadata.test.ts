import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { RoutedModel } from '../../src/relay/types';
import {
  _resetMetadataCacheForTests,
  getCachedData,
  getCachedFetchedAt,
  initMetadataCache,
  onMetadataChanged,
  scheduleRefresh,
} from '../../src/metadata/metadataCache';
import { enrichModelsWithOpenRouter, OPENROUTER_CACHE_KEY, OPENROUTER_MAX_ENTRIES, parseOpenRouterResponse, scheduleOpenRouterRefresh } from '../../src/metadata/openrouterFallback';

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

function routedModel(id: string, overrides: Partial<RoutedModel> = {}): RoutedModel {
  return { id, upstreamId: id, pickerId: id, apiType: 'chat-completions', catalogSource: 'discovery', ...overrides };
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
    expect(parsed[0]).toMatchObject({ contextWindow: 200_000 });
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
      contextWindow: 400_000,
      maxOutputTokens: 8_000,
      vision: true,
      toolCalling: true,
      reasoning: true,
      referencePricing: { currencyCode: 'USD', inputPer1M: 2, outputPer1M: 10, cacheHitPer1M: 1 },
    })]);
  });

  it.each([undefined, null, {}, { data: null }, { data: {} }, { error: { message: 'unavailable' } }])('rejects malformed OpenRouter catalog envelopes %#', payload => {
    expect(() => parseOpenRouterResponse(payload as never)).toThrow('must contain a data array');
  });

  it('retains the last catalog on a malformed successful response but accepts a genuinely empty directory', async () => {
    const old = { data: parseOpenRouterResponse({ data: [{ id: 'vendor/model', context_length: 100_000 }] }), fetchedAt: 0 };
    const context = contextWith({ [OPENROUTER_CACHE_KEY]: old });
    initMetadataCache(context as unknown as vscode.ExtensionContext);
    const changed = vi.fn();
    const subscription = onMetadataChanged(changed);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":{"message":"temporarily unavailable"}}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"data":[]}', { status: 200 }));
    try {
      await scheduleOpenRouterRefresh(0, true);
      expect(context.values.get(OPENROUTER_CACHE_KEY)).toBe(old);
      expect(changed).not.toHaveBeenCalled();
      await scheduleOpenRouterRefresh(0, true);
      expect(getCachedData(OPENROUTER_CACHE_KEY)).toEqual([]);
      expect(context.values.get(OPENROUTER_CACHE_KEY)).not.toBe(old);
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      subscription.dispose();
    }
  });

  it.each([undefined, null, '', '   ', 'invalid', '-0.01', 'Infinity', 'NaN', '1e308', 0, false, {}, [], ['0']]
    .map(value => ({ value })))('keeps invalid or overflowing prices unknown %#', ({ value }) => {
    const [model] = parseOpenRouterResponse({ data: [{ id: 'vendor/model', supported_parameters: ['tools'],
      pricing: { prompt: value, completion: value, input_cache_read: value, input_cache_write: value } as never,
    }] });
    expect(model.referencePricing).toBeUndefined();
    expect(model.toolCalling).toBe(true);
  });

  it('preserves free pricing and independently retains valid rate fields', () => {
    const models = parseOpenRouterResponse({ data: [
      { id: 'vendor/free', pricing: { prompt: '0', completion: ' 0 ', input_cache_read: '2e-6', input_cache_write: '0.000001' } },
      { id: 'vendor/partial', pricing: { prompt: null, completion: '0.000004' } as never },
    ] });
    expect(models[0].referencePricing).toEqual({ currencyCode: 'USD', inputPer1M: 0, outputPer1M: 0,
      cacheHitPer1M: 2, cacheCreationPer1M: 1 });
    expect(models[1].referencePricing).toMatchObject({ currencyCode: 'USD', inputPer1M: undefined, outputPer1M: 4 });
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
      { id: 'unique',
pickerId: 'unique',
upstreamId: 'unique',
catalogSource: 'discovery',
metadataSources: {},
apiType: 'chat-completions' as const },
      { id: 'vendor/unique',
pickerId: 'vendor/unique',
upstreamId: 'vendor/unique',
catalogSource: 'discovery',
maxInputTokens: 8_192,
metadataSources: { maxInputTokens: 'api' },
apiType: 'chat-completions' as const },
      { id: 'ambiguous',
pickerId: 'ambiguous',
upstreamId: 'ambiguous',
catalogSource: 'discovery',
metadataSources: {},
apiType: 'chat-completions' as const },
    ]);
    expect(enriched).toMatchObject({ contextWindow: 200_000, imageInput: true, metadataSources: { contextWindow: 'openrouter' } });
    expect(preserved).toMatchObject({ maxInputTokens: 8_192, metadataSources: { maxInputTokens: 'api' } });
    expect(ambiguous.maxInputTokens).toBeUndefined();
  });

  it('matches case-insensitively, prefers full IDs and keeps the first duplicate full ID', () => {
    const data = parseOpenRouterResponse({ data: [
      { id: 'vendor-a/Shared', context_length: 100 },
      { id: 'VENDOR-A/SHARED', context_length: 200 },
      { id: 'vendor-b/shared', context_length: 300 },
      { id: 'vendor/Unique', context_length: 400 },
      { id: 'Same', context_length: 500 },
      { id: 'other/same', context_length: 600 },
      { id: 'vendor/Duplicate', context_length: 700 },
      { id: 'vendor/Duplicate', context_length: 800 },
    ] });
    initMetadataCache(contextWith({ [OPENROUTER_CACHE_KEY]: { data, fetchedAt: Date.now() } }) as unknown as vscode.ExtensionContext);
    const models = ['VeNdOr-A/sHaReD', 'SHARED', 'uNiQuE', 'same', 'vendor/Duplicate', 'duplicate', 'missing/unique'].map(id => routedModel(id));
    const result = enrichModelsWithOpenRouter(models);

    expect(result.map(model => model.contextWindow)).toEqual([100, undefined, 400, 500, 700, undefined, undefined]);
    for (const index of [1, 5, 6]) expect(result[index]).toBe(models[index]);
    expect(models.every(model => model.contextWindow === undefined)).toBe(true);
  });

  it('preserves declared values, false capabilities and their metadata sources', () => {
    const data = parseOpenRouterResponse({ data: [{
      id: 'vendor/model', context_length: 200_000, top_provider: { max_completion_tokens: 16_384 },
      architecture: { input_modalities: ['image'] }, supported_parameters: ['tools', 'reasoning'],
      pricing: { prompt: '0.000002', completion: '0.000004' },
    }] });
    initMetadataCache(contextWith({ [OPENROUTER_CACHE_KEY]: { data, fetchedAt: Date.now() } }) as unknown as vscode.ExtensionContext);
    const declared = routedModel('model', {
      catalogSource: 'configured', contextWindow: 64_000, maxOutputTokens: 8_192,
      imageInput: false, toolCalling: false, thinking: false,
      referencePricing: { currencyCode: 'USD', inputPer1M: 1 },
      metadataSources: { contextWindow: 'api', imageInput: 'api', toolCalling: 'api', referencePricing: 'api' },
    });
    const partial = routedModel('model', { imageInput: false, metadataSources: { imageInput: 'api' } });
    const result = enrichModelsWithOpenRouter([declared, partial]);

    expect(result[0]).toBe(declared);
    expect(result[1]).toMatchObject({ imageInput: false, toolCalling: true, thinking: true, contextWindow: 200_000,
      metadataSources: { imageInput: 'api', toolCalling: 'openrouter', contextWindow: 'openrouter' } });
  });

  it.each([
    undefined, {}, [{ id: 'model', fullId: '' }], [{ id: 'model', fullId: 'vendor/model', contextWindow: 0 }],
    [{ id: 'model', fullId: 'vendor/model', vision: 'true' }],
    Array.from({ length: OPENROUTER_MAX_ENTRIES + 1 }, () => ({ id: 'model', fullId: 'vendor/model' })),
  ].map(data => ({ data })))('ignores an invalid cached catalog without changing the model list %#', ({ data }) => {
    initMetadataCache(contextWith({ [OPENROUTER_CACHE_KEY]: { data, fetchedAt: Date.now() } }) as unknown as vscode.ExtensionContext);
    const models = [routedModel('model')];
    expect(enrichModelsWithOpenRouter(models)).toBe(models);
  });

  it('rebuilds matching for every batch after cached entries change', () => {
    const data = parseOpenRouterResponse({ data: [{ id: 'vendor/model', context_length: 100 }] });
    const context = contextWith({ [OPENROUTER_CACHE_KEY]: { data, fetchedAt: Date.now() } });
    initMetadataCache(context as unknown as vscode.ExtensionContext);
    const model = routedModel('model');
    expect(enrichModelsWithOpenRouter([model])[0].contextWindow).toBe(100);

    data.push(...parseOpenRouterResponse({ data: [{ id: 'other/model', context_length: 200 }] }));
    expect(enrichModelsWithOpenRouter([model])[0]).toBe(model);
    context.values.set(OPENROUTER_CACHE_KEY, { data: parseOpenRouterResponse({ data: [
      { id: 'new/model', context_length: 300 },
    ] }), fetchedAt: Date.now() });
    expect(enrichModelsWithOpenRouter([model])[0].contextWindow).toBe(300);
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
