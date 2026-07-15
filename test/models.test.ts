import { describe, expect, it } from 'vitest';
import { assignUniquePickerIds, fromConfiguredModel, toRoutedModel } from '../src/relay/models';

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
});
