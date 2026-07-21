import { describe, expect, it } from 'vitest';
import { assignUniquePickerIds, filterModels, fromConfiguredModel, supportsImageInputForModel, toChatInformation, toRoutedModel } from '../../src/relay/models';

describe('model routing', () => {
  it('creates unique picker IDs only for colliding upstream IDs', () => {
    const models = assignUniquePickerIds([
      toRoutedModel({ id: 'shared' }, 'openai', 'openai'),
      toRoutedModel({ id: 'shared' }, 'claude', 'claude'),
      toRoutedModel({ id: 'unique' }, 'openai', 'chatgpt'),
    ]);
    expect(models.map((model) => model.pickerId)).toEqual([
      'shared::openai',
      'shared::claude',
      'unique',
    ]);
    expect(models.map((model) => model.upstreamId)).toEqual(['shared', 'shared', 'unique']);
  });

  it('keeps picker IDs globally unique when an upstream ID resembles a generated suffix', () => {
    const models = assignUniquePickerIds([
      toRoutedModel({ id: 'foo' }, 'openai', 'openai'),
      toRoutedModel({ id: 'foo' }, 'claude', 'claude'),
      toRoutedModel({ id: 'foo::openai' }, 'openai', 'chatgpt'),
    ]);
    expect(new Set(models.map((model) => model.pickerId)).size).toBe(3);
  });

  it('preserves explicitly configured route and capabilities', () => {
    expect(fromConfiguredModel({
      id: 'private-model',
      name: 'Private Model',
      route: 'claude',
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      toolCalling: true,
      imageInput: false,
      thinking: true,
    })).toMatchObject({
      pickerId: 'private-model',
      upstreamId: 'private-model',
      protocol: 'claude',
      route: 'claude',
      toolCalling: true,
    });
  });

  it('routes each model from a single discovery catalog by its protocol', () => {
    const models = [
      toRoutedModel({ id: 'gpt-5.4' }, 'openai', 'openai'),
      toRoutedModel({ id: 'claude-sonnet-4' }, 'claude', 'openai'),
    ];
    expect(models.map((model) => model.protocol)).toEqual(['openai', 'claude']);
    expect(models.map((model) => model.route)).toEqual(['openai', 'openai']);
  });

  it('normalizes discovery capabilities and context limits', () => {
    expect(toRoutedModel({
      id: 'vision-tool-model',
      context_length: 128_000,
      max_completion_tokens: 4_096,
      capabilities: { vision: true, tool_calling: true, reasoning: true },
    }, 'openai')).toMatchObject({
      maxInputTokens: 128_000,
      maxOutputTokens: 4_096,
      imageInput: true,
      toolCalling: true,
      thinking: true,
      metadataSources: {
        maxInputTokens: 'api',
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
    }, 'openai')).toMatchObject({
      openai: {
        tokenLimitField: 'max_completion_tokens',
        contextWindow: true,
        reasoningEfforts: ['minimal', 'high'],
        defaultReasoningEffort: 'minimal',
      },
    });
  });

  it('filters, sorts, and formats models for the picker', () => {
    const config = {
      modelNamePrefix: 'WeaveNet',
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      supportsToolCalling: true,
      supportsImageInput: false,
      imageInputModels: [/vision/],
      disabledImageInputModels: [/disabled/],
      includeModels: [/gpt|vision/],
      excludeModels: [/beta/],
    } as never;
    const models = [
      toRoutedModel({ id: 'z-gpt', owned_by: 'relay' }, 'openai'),
      toRoutedModel({ id: 'a-vision', capabilities: { tool_calling: true, vision: true } }, 'openai'),
      toRoutedModel({ id: 'gpt-beta' }, 'openai'),
      toRoutedModel({ id: 'claude', capabilities: { tool_calling: true } }, 'claude'),
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
      statusIcon: { id: 'warning' },
    });
  });
});
