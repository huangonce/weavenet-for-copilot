import { describe, expect, it } from 'vitest';
import type { ExtensionConfig } from '../../src/config/config';
import { assignUniquePickerIds, filterModels, fromConfiguredModel, supportsImageInputForModel, modelTokenBudget, toChatInformation, toRoutedModel } from '../../src/relay/models';

function extensionConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    baseUrl: 'https://relay.example.test/v1',
    anthropicVersion: '2023-06-01',
    apiType: 'chat-completions',
    modelMetadataEnabled: true,
    openaiPromptCaching: true,
    openaiPromptCacheKey: '',
    claudePromptCaching: 'automatic',
    claudePromptCachingTTL: '5m',
    requestTimeoutMs: 100,
    streamIdleTimeoutMs: 100,
    debug: false,
    modelNamePrefix: 'WeaveNet',
    includeModels: [],
    excludeModels: [],
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    sendMaxTokens: false,
    supportsToolCalling: true,
    supportsImageInput: false,
    imageInputModels: [],
    disabledImageInputModels: [],
    visionProxyEnabled: false,
    visionProxyModel: '',
    visionProxyPrompt: '',
    metadataRefreshHours: 6,
    requestHeaders: {},
    models: [],
    ...overrides,
  };
}

describe('model routing', () => {
  it('creates unique picker IDs only for colliding upstream IDs', () => {
    const models = assignUniquePickerIds([
      toRoutedModel({ id: 'shared' }, 'chat-completions'),
      toRoutedModel({ id: 'shared' }, 'messages'),
      toRoutedModel({ id: 'unique' }, 'chat-completions'),
    ]);
    expect(models.map((model) => model.pickerId)).toEqual([
      'shared::chat-completions',
      'shared::messages',
      'unique',
    ]);
    expect(models.map((model) => model.upstreamId)).toEqual(['shared', 'shared', 'unique']);
  });

  it('keeps picker IDs globally unique when an upstream ID resembles a generated suffix', () => {
    const models = assignUniquePickerIds([
      toRoutedModel({ id: 'foo' }, 'chat-completions'),
      toRoutedModel({ id: 'foo' }, 'messages'),
      toRoutedModel({ id: 'foo::chat-completions' }, 'chat-completions'),
    ]);
    expect(new Set(models.map((model) => model.pickerId)).size).toBe(3);
  });

  it('preserves explicitly configured route and capabilities', () => {
    expect(fromConfiguredModel({ id: 'private-model',
name: 'Private Model',
maxInputTokens: 100_000,
maxOutputTokens: 8_000,
toolCalling: true,
imageInput: false,
thinking: true,
apiType: 'messages' as const })).toMatchObject({ pickerId: 'private-model',
upstreamId: 'private-model',
toolCalling: true,
apiType: 'messages' as const });
  });

  it('routes each model from a single discovery catalog by its protocol', () => {
    const models = [
      toRoutedModel({ id: 'gpt-5.4' }, 'chat-completions'),
      toRoutedModel({ id: 'claude-sonnet-4' }, 'messages'),
    ];
    expect(models.map((model) => model.apiType)).toEqual(['chat-completions', 'messages']);
  });

  it('keeps upstream legacy transport fields outside the runtime model', () => {
    const model = toRoutedModel({ id: 'claude-name', protocol: 'claude', route: 'claude', openaiApi: 'responses' } as never, 'chat-completions');
    expect(model.apiType).toBe('chat-completions');
    expect(model).not.toHaveProperty('protocol');
    expect(model).not.toHaveProperty('route');
    expect(model).not.toHaveProperty('openaiApi');
  });

  it('normalizes discovery capabilities and context limits', () => {
    expect(toRoutedModel({
      id: 'vision-tool-model',
      context_length: 128_000,
      max_completion_tokens: 4_096,
      capabilities: { vision: true, tool_calling: true, reasoning: true },
    }, 'chat-completions')).toMatchObject({
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      imageInput: true,
      toolCalling: true,
      thinking: true,
      metadataSources: {
        contextWindow: 'api',
        maxOutputTokens: 'api',
        imageInput: 'api',
        toolCalling: 'api',
        thinking: 'api',
      },
    });
  });

  it('normalizes explicit OpenAI request capabilities conservatively', () => {
    expect(toRoutedModel({
      id: 'modern-model',
      capabilities: {
        openai: {
          tokenLimitField: 'max_completion_tokens',
          contextWindow: true,
          reasoningEfforts: ['minimal', 'high', 'invalid'],
          defaultReasoningEffort: 'minimal',
        },
      },
    }, 'chat-completions')).toMatchObject({
      openai: {
        tokenLimitField: 'max_completion_tokens',
        reasoningEfforts: ['minimal', 'high'],
        defaultReasoningEffort: 'minimal',
      },
    });
  });

  it('filters, sorts, and formats models for the picker', () => {
    const config = extensionConfig({
      imageInputModels: [/vision/],
      disabledImageInputModels: [/disabled/],
      includeModels: [/gpt|vision/],
      excludeModels: [/beta/],
    });
    const models = [
      toRoutedModel({ id: 'z-gpt', owned_by: 'relay' }, 'chat-completions'),
      toRoutedModel({ id: 'a-vision', capabilities: { tool_calling: true, vision: true } }, 'chat-completions'),
      toRoutedModel({ id: 'gpt-beta' }, 'chat-completions'),
      toRoutedModel({ id: 'claude', capabilities: { tool_calling: true } }, 'messages'),
    ];

    expect(filterModels(models, config).map((model) => model.id)).toEqual(['a-vision', 'z-gpt']);
    expect(supportsImageInputForModel('vision-model', config)).toBe(true);
    expect(supportsImageInputForModel('disabled-vision-model', config)).toBe(false);
    expect(toChatInformation(models[1], config, true)).toMatchObject({
      id: 'a-vision',
      name: 'WeaveNet a-vision',
      detail: 'OpenAI compatible, from your relay',
      capabilities: { toolCalling: true, imageInput: true },
    });
    expect(toChatInformation(models[1], config, false)).toMatchObject({
      detail: 'API key required',
    });
  });

  it('advertises opt-in proxy vision in the picker without changing native model capability', () => {
    const config = extensionConfig({
      visionProxyEnabled: true,
      visionProxyModel: 'copilot/gpt-4o',
    });
    const model = toRoutedModel({ id: 'deepseek-chat' }, 'chat-completions');

    expect(supportsImageInputForModel(model.id, config)).toBe(false);
    expect(toChatInformation(model, config, true).capabilities.imageInput).toBe(true);
    expect(toChatInformation(model, { ...config, visionProxyEnabled: false }, true).capabilities.imageInput).toBe(false);
    expect(toChatInformation(model, { ...config, visionProxyModel: '' }, true).capabilities.imageInput).toBe(false);
    expect(toChatInformation(model, { ...config, visionProxyModel: 'gpt-4o' }, true).capabilities.imageInput).toBe(false);
    expect(toChatInformation(model, { ...config, visionProxyModel: 'copilot/gpt 4o' }, true).capabilities.imageInput).toBe(false);
  });
});

describe('catalog source and protocol helpers', () => {
  it('tags discovery models with catalogSource discovery', () => {
    expect(toRoutedModel({ id: 'gpt-5.4' }, 'chat-completions').catalogSource).toBe('discovery');
    expect(toRoutedModel({ id: 'claude-sonnet-4' }, 'messages').catalogSource).toBe('discovery');
  });

  it('tags configured models with catalogSource configured', () => {
    expect(fromConfiguredModel({ id: 'private-model',
name: 'Private Model',
apiType: 'messages' as const }).catalogSource).toBe('configured');
    expect(fromConfiguredModel({ id: 'private-gpt',
name: 'Private GPT',
apiType: 'chat-completions' as const }).catalogSource).toBe('configured');
  });
});


describe('documented input and output token budgets', () => {
  it('reserves output space in the shared context window', () => {
    const model = toRoutedModel({ id: 'small', context_length: 8192, max_completion_tokens: 4096 }, 'chat-completions');
    expect(modelTokenBudget(model, extensionConfig())).toEqual({ maxInputTokens: 4096, maxOutputTokens: 4096 });
    expect(toChatInformation(model, extensionConfig(), true)).toMatchObject({ maxInputTokens: 4096, maxOutputTokens: 4096 });
  });
  it('preserves a lower explicit input limit instead of subtracting output from it again', () => {
    const model = fromConfiguredModel({ id: 'bounded', contextWindow: 8192, maxInputTokens: 2000, maxOutputTokens: 4096 });
    expect(modelTokenBudget(model, extensionConfig())).toEqual({ maxInputTokens: 2000, maxOutputTokens: 4096 });
  });
  it('honors the global input cap for a larger shared context window', () => {
    const model = fromConfiguredModel({ id: 'large', contextWindow: 200_000, maxOutputTokens: 8000 });
    expect(modelTokenBudget(model, extensionConfig())).toEqual({ maxInputTokens: 100_000, maxOutputTokens: 8000 });
  });
  it('interprets old OpenRouter snapshots safely without requiring online metadata', () => {
    const model = { ...toRoutedModel({ id: 'cached' }, 'chat-completions'), maxInputTokens: 8192, maxOutputTokens: 4096,
      metadataSources: { maxInputTokens: 'openrouter' as const } };
    expect(modelTokenBudget(model, extensionConfig())).toEqual({ maxInputTokens: 4096, maxOutputTokens: 4096 });
  });
  it('ignores invalid or non-positive upstream token limits', () => {
    const model = toRoutedModel({ id: 'bad', context_length: -1, max_completion_tokens: 0 }, 'chat-completions');
    expect(model.contextWindow).toBeUndefined();
    expect(model.maxOutputTokens).toBeUndefined();
    expect(modelTokenBudget(model, extensionConfig())).toEqual({ maxInputTokens: 100_000, maxOutputTokens: 8000 });
  });
});


describe('latest Anthropic Models API metadata', () => {
  it('reads native display names, independent token limits and structured vision support', () => {
    const model = toRoutedModel({ id: 'native', display_name: 'Native Model', max_input_tokens: 100000, max_tokens: 8000,
      capabilities: { image_input: { supported: true }, thinking: { supported: true,
        types: { enabled: { supported: true }, adaptive: { supported: true } } } } }, 'messages');
    expect(model).toMatchObject({ name: 'Native Model', maxInputTokens: 100000, maxOutputTokens: 8000,
      imageInput: true, thinking: true });
  });
  it('uses documented adaptive mode for adaptive-only models', () => {
    const model = toRoutedModel({ id: 'adaptive-only', capabilities: { reasoning: true, image_input: { supported: false },
      thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true } } } } }, 'messages');
    expect(model.imageInput).toBe(false);
    expect(model.thinking).toBe(true);
    expect(model.claude?.thinkingMode).toBe('adaptive');
  });
});
