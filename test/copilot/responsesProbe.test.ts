import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionConfig } from '../../src/config/config';
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
  // The probing cache is module-global and keyed by relay base URL; a fresh URL
  // per test keeps cached verdicts from leaking across tests.
  config = { ...baseConfig, baseUrl: `https://relay-${relayCounter}.example.test/v1` } as unknown as ExtensionConfig;
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

  it('skips probing entirely when no OpenAI models are present', async () => {
    clientMocks.listModels.mockResolvedValue({ data: [{ id: 'claude-x' }] });

    await loadAllModels(config, 'secret-key', () => {});

    expect(clientMocks.probeResponsesEndpoint).not.toHaveBeenCalled();
    expect(clientMocks.testOpenAIResponses).not.toHaveBeenCalled();
  });
});
