import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionConfig } from '../../src/config/config';
import { RelayRequestError } from '../../src/relay/errors';
import type { RoutedModel } from '../../src/relay/types';
import type * as OpenRouterFallbackModule from '../../src/metadata/openrouterFallback';

const { clientMocks } = vi.hoisted(() => ({
  clientMocks: {
    listModels: vi.fn(),
    probeResponsesEndpoint: vi.fn(),
    testOpenAIResponses: vi.fn(),
  },
}));

vi.mock('../../src/relay/client', () => ({
  RelayClient: class {
    listModels = clientMocks.listModels;
    probeResponsesEndpoint = clientMocks.probeResponsesEndpoint;
    testOpenAIResponses = clientMocks.testOpenAIResponses;
  },
}));

vi.mock('../../src/metadata/openrouterFallback', async (importOriginal) => {
  const actual = await importOriginal<OpenRouterFallbackModule>();
  return { ...actual, scheduleOpenRouterRefresh: vi.fn() };
});

import { loadAllModels } from '../../src/copilot/modelRegistry';

const baseConfig = {
  profileId: 'profile-0',
  baseUrl: 'https://relay.example.test/v1',
  requestHeaders: {},
  anthropicVersion: '2023-06-01',
  requestTimeoutMs: 100,
  streamIdleTimeoutMs: 100,
  metadataRefreshHours: 6,
  models: [],
  includeModels: [],
  excludeModels: [],
  disabledImageInputModels: [],
  imageInputModels: [],
  supportsImageInput: true,
  supportsToolCalling: true,
  modelNamePrefix: 'WeaveNet',
  maxInputTokens: 128_000,
  maxOutputTokens: 8_192,
} as unknown as ExtensionConfig;

function openaiModels(models: readonly RoutedModel[]): RoutedModel[] {
  return models.filter((model) => model.upstreamId.startsWith('gpt-'));
}

let config: ExtensionConfig;
let relayCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  relayCounter++;
  // The probing cache is module-global and keyed by profile id; a fresh id
  // per test keeps cached verdicts from leaking across tests.
  config = {
    ...baseConfig,
    baseUrl: `https://relay-${relayCounter}.example.test/v1`,
    profileId: `profile-${relayCounter}`,
  } as unknown as ExtensionConfig;
  clientMocks.listModels.mockResolvedValue({
    data: [
      { id: 'gpt-a' },
      { id: 'gpt-b' },
      { id: 'claude-x' },
    ],
  });
  clientMocks.probeResponsesEndpoint.mockResolvedValue('supported');
  clientMocks.testOpenAIResponses.mockResolvedValue(undefined);
});

describe('Responses endpoint probing during model load', () => {
  it('short-circuits with zero POST probes when the endpoint is unsupported', async () => {
    clientMocks.probeResponsesEndpoint.mockResolvedValue('unsupported');

    const { models } = await loadAllModels(config, 'secret-key', () => {});

    expect(clientMocks.probeResponsesEndpoint).toHaveBeenCalledOnce();
    expect(clientMocks.testOpenAIResponses).not.toHaveBeenCalled();
    expect(openaiModels(models).every((model) => model.openaiApi === undefined)).toBe(true);
  });

  it('probes each uncached OpenAI model and marks supported ones as responses', async () => {
    const { models } = await loadAllModels(config, 'secret-key', () => {});

    const openai = openaiModels(models);
    expect(openai).toHaveLength(2);
    expect(openai.every((model) => model.openaiApi === 'responses')).toBe(true);
    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);
    const probedModels = clientMocks.testOpenAIResponses.mock.calls.map((call) => call[0]);
    expect(probedModels.sort()).toEqual(['gpt-a', 'gpt-b']);
  });

  it('keeps Claude models untouched by probing', async () => {
    const { models } = await loadAllModels(config, 'secret-key', () => {});

    const claude = models.filter((model) => model.upstreamId.startsWith('claude-'));
    expect(claude).toHaveLength(1);
    expect(claude[0].openaiApi).toBeUndefined();
    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);
  });

  it('falls back to chat when a per-model probe fails', async () => {
    clientMocks.testOpenAIResponses.mockRejectedValue(new Error('unsupported model'));

    const { models } = await loadAllModels(config, 'secret-key', () => {});

    expect(openaiModels(models).every((model) => model.openaiApi === undefined)).toBe(true);
    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);
  });

  it('reuses cached verdicts and skips POST probes on refresh', async () => {
    await loadAllModels(config, 'secret-key', () => {});
    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);
    clientMocks.testOpenAIResponses.mockClear();

    const { models } = await loadAllModels(config, 'secret-key', () => {});

    expect(clientMocks.testOpenAIResponses).not.toHaveBeenCalled();
    expect(openaiModels(models).every((model) => model.openaiApi === 'responses')).toBe(true);
  });

  it('still probes when the endpoint availability is unknown', async () => {
    clientMocks.probeResponsesEndpoint.mockResolvedValue('unknown');

    const { models } = await loadAllModels(config, 'secret-key', () => {});

    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);
    expect(openaiModels(models).every((model) => model.openaiApi === 'responses')).toBe(true);
  });

  it('retries transient probe failures on the next refresh instead of caching chat', async () => {
    clientMocks.testOpenAIResponses.mockRejectedValue(new TypeError('network down'));

    await loadAllModels(config, 'secret-key', () => {});
    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);

    clientMocks.testOpenAIResponses.mockResolvedValue(undefined);
    const { models } = await loadAllModels(config, 'secret-key', () => {});

    // Nothing was cached, so the retry re-probes and now succeeds.
    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(4);
    expect(openaiModels(models).every((model) => model.openaiApi === 'responses')).toBe(true);
  });

  it('caches definitive rejections so the next refresh skips probing', async () => {
    clientMocks.testOpenAIResponses.mockRejectedValue(
      new RelayRequestError('unsupported model', 400, 'json'),
    );

    await loadAllModels(config, 'secret-key', () => {});
    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);

    clientMocks.testOpenAIResponses.mockClear();
    await loadAllModels(config, 'secret-key', () => {});

    expect(clientMocks.testOpenAIResponses).not.toHaveBeenCalled();
  });

  it('re-probes when a user-invoked refresh forces cache invalidation', async () => {
    await loadAllModels(config, 'secret-key', () => {});
    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);
    clientMocks.testOpenAIResponses.mockClear();

    const { models } = await loadAllModels(config, 'secret-key', () => {}, new Map(), undefined, true);

    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);
    expect(openaiModels(models).every((model) => model.openaiApi === 'responses')).toBe(true);
  });

  it('keeps probe verdicts per profile even when two profiles share a relay URL', async () => {
    const sharedUrl = 'https://shared.example.test/v1';
    const first = { ...config, baseUrl: sharedUrl, profileId: 'profile-a' } as unknown as ExtensionConfig;
    const second = { ...config, baseUrl: sharedUrl, profileId: 'profile-b' } as unknown as ExtensionConfig;
    clientMocks.testOpenAIResponses.mockResolvedValue(undefined);

    await loadAllModels(first, 'key-a', () => {});
    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);

    clientMocks.testOpenAIResponses.mockRejectedValue(
      new RelayRequestError('unsupported model', 400, 'json'),
    );
    clientMocks.testOpenAIResponses.mockClear();
    const { models } = await loadAllModels(second, 'key-b', () => {});

    // profile-a's positive verdict must not leak into profile-b.
    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(2);
    expect(openaiModels(models).every((model) => model.openaiApi === undefined)).toBe(true);
  });

  it('probes each unique model id only once when the catalog repeats ids', async () => {
    clientMocks.listModels.mockResolvedValue({
      data: [{ id: 'gpt-a' }, { id: 'gpt-a' }, { id: 'claude-x' }],
    });

    const { models } = await loadAllModels(config, 'secret-key', () => {});

    expect(clientMocks.testOpenAIResponses).toHaveBeenCalledTimes(1);
    const matched = openaiModels(models).filter((model) => model.openaiApi === 'responses');
    expect(matched).toHaveLength(1);
    expect(matched[0].upstreamId).toBe('gpt-a');
  });

  it('skips probing entirely when no OpenAI models are present', async () => {
    clientMocks.listModels.mockResolvedValue({ data: [{ id: 'claude-x' }] });

    await loadAllModels(config, 'secret-key', () => {});

    expect(clientMocks.probeResponsesEndpoint).not.toHaveBeenCalled();
    expect(clientMocks.testOpenAIResponses).not.toHaveBeenCalled();
  });
});
