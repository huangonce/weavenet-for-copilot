import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  applyLastTwoUserCacheControl,
  convertClaudeMessages,
  convertClaudeTools,
  convertMessages,
  convertResponsesInput,
  convertResponsesTools,
  convertTools,
  normalizeClaudeImageMediaType,
} from '../../src/copilot/convert';
import { clampClaudeTemperature } from '../../src/copilot/helpers';
import type { ClaudeMessage } from '../../src/relay/types';

describe('chat request conversion', () => {
  it('converts assistant text and tool calls, then emits tool results', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelTextPart('Working on it.'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', { query: 'relay' }),
        new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('Found it.')]),
      ],
    }] as never;

    expect(convertMessages(messages, false)).toEqual([
      {
        role: 'assistant',
        content: 'Working on it.',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'search', arguments: '{"query":"relay"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'Found it.' },
    ]);
  });

  it('preserves image data only for relays that support images', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelTextPart('Describe this'),
        new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
        new vscode.LanguageModelDataPart(new Uint8Array([4]), 'application/pdf'),
      ],
    }] as never;

    expect(convertMessages(messages, false)).toEqual([{ role: 'user', content: 'Describe this' }]);
    expect(convertMessages(messages, true)).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'auto', media_type: 'image/png' } },
      ],
    }]);
  });

  it('sanitizes tool schemas and returns undefined when no tools are provided', () => {
    expect(convertTools(undefined)).toBeUndefined();
    expect(convertTools([{
      name: 'search',
      description: 'Search indexed docs',
      inputSchema: { type: 'object', properties: { query: { type: 'string', markdownDescription: 'editor-only' } } },
    }] as never)).toEqual([{
      type: 'function',
      function: {
        name: 'search',
        description: 'Search indexed docs',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    }]);
  });

  it('accepts compatible image-like data and safely ignores unsupported parts', () => {
    const imageBuffer = new Uint8Array([9, 8]).buffer;
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        { mime_type: 'image/jpeg', value: imageBuffer },
        { mediaType: 'image/webp', bytes: new Uint8Array([7]) },
        { mimeType: 'text/plain', data: new Uint8Array([6]) },
        { mimeType: 'image/png', data: 'not bytes' },
        null,
      ],
    }] as never;

    expect(convertMessages(messages, true)).toEqual([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,CQg=', detail: 'auto', media_type: 'image/jpeg' } },
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,Bw==', detail: 'auto', media_type: 'image/webp' } },
      ],
    }]);
    expect(convertMessages(messages, false)).toEqual([]);
  });

  it('maps system messages and preserves non-text tool results as JSON', () => {
    const messages = [
      { role: 3, content: [new vscode.LanguageModelTextPart('system instruction')] },
      { role: vscode.LanguageModelChatMessageRole.Assistant, content: [new vscode.LanguageModelToolResultPart('call-1', [{ value: 'data' }])] },
    ] as never;

    expect(convertMessages(messages, false)).toEqual([
      { role: 'system', content: 'system instruction' },
      { role: 'tool', tool_call_id: 'call-1', content: '[{"value":"data"}]' },
    ]);
  });
});

describe('responses input conversion', () => {
  it('preserves assistant function calls so call_ids match tool results', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelTextPart('Calling search.'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', { query: 'relay' }),
        new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('Found it.')]),
      ],
    }] as never;

    expect(convertResponsesInput(messages, false)).toEqual({
      input: [
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Calling search.' }],
        },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: '(reasoning omitted)' }], summary: [] },
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{"query":"relay"}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'Found it.' },
      ],
    });
  });

  it('reuses thinking content as the reasoning item preceding tool calls', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelThinkingPart('Need to look this up.'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', {}),
      ],
    }] as never;

    expect(convertResponsesInput(messages, false)).toEqual({
      input: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Need to look this up.' }], summary: [] },
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{}' },
      ],
    });
  });

  it('preserves images as input_image parts only when supported', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelTextPart('What is this?'),
        new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
      ],
    }] as never;

    expect(convertResponsesInput(messages, false)).toEqual({ input: [{ role: 'user', content: 'What is this?' }] });
    expect(convertResponsesInput(messages, true)).toEqual({
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is this?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'auto' },
        ],
      }],
    });
  });

  it('maps system messages to top-level instructions', () => {
    const messages = [
      { role: 3, content: [new vscode.LanguageModelTextPart('system instruction')] },
      { role: vscode.LanguageModelChatMessageRole.Assistant, content: [new vscode.LanguageModelToolCallPart('call-1', 'search', {})] },
    ] as never;

    expect(convertResponsesInput(messages, false)).toEqual({
      input: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: '(reasoning omitted)' }], summary: [] },
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{}' },
      ],
      instructions: 'system instruction',
    });
  });

  it('sanitizes tool schemas into flat Responses tool definitions', () => {
    expect(convertResponsesTools(undefined)).toBeUndefined();
    expect(convertResponsesTools([{
      name: 'search',
      description: 'Search indexed docs',
      inputSchema: { type: 'object', properties: { query: { type: 'string', markdownDescription: 'editor-only' } } },
    }] as never)).toEqual([{
      type: 'function',
      name: 'search',
      description: 'Search indexed docs',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    }]);
    expect(convertResponsesTools([{
      name: 'search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }] as never, true)).toEqual([{
      type: 'function',
      name: 'search',
      description: undefined,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      strict: true,
    }]);
  });
});

describe('Claude conversion helpers', () => {
  it('allows only Anthropic-supported image MIME types', () => {
    expect(normalizeClaudeImageMediaType('image/jpg')).toBe('image/jpeg');
    expect(normalizeClaudeImageMediaType('image/webp')).toBe('image/webp');
    expect(normalizeClaudeImageMediaType('image/svg+xml')).toBeUndefined();
  });

  it('places cache breakpoints on only the latest two user messages', () => {
    const messages: ClaudeMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ];
    applyLastTwoUserCacheControl(messages, '1h');
    expect((messages[0].content[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((messages[2].content[0] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect((messages[3].content[0] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('drops orphan and interrupted Claude tool chains while preserving matched parallel results', () => {
    const assistant = (parts: unknown[]) => ({
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: parts,
    }) as vscode.LanguageModelChatRequestMessage;
    const user = (parts: unknown[]) => ({
      role: vscode.LanguageModelChatMessageRole.User,
      content: parts,
    }) as vscode.LanguageModelChatRequestMessage;
    const converted = convertClaudeMessages([
      user([new vscode.LanguageModelToolResultPart('orphan', [new vscode.LanguageModelTextPart('ignored')])]),
      assistant([
        new vscode.LanguageModelToolCallPart('call_1', 'first', {}),
        new vscode.LanguageModelToolCallPart('call_2', 'second', {}),
      ]),
      user([new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('done')])]),
      user([new vscode.LanguageModelTextPart('continue without second result')]),
    ], { supportsImageInput: false });

    expect(converted.messages).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'first', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'done' },
        { type: 'text', text: 'continue without second result' },
      ] },
    ]);
  });

  it('clamps Claude temperature to its supported range', () => {
    expect(clampClaudeTemperature(-0.5)).toBe(0);
    expect(clampClaudeTemperature(0.7)).toBe(0.7);
    expect(clampClaudeTemperature(1.5)).toBe(1);
    expect(clampClaudeTemperature(undefined)).toBeUndefined();
  });

  it('converts system text, images, and cached Claude tools', () => {
    const system = { role: 3, content: [new vscode.LanguageModelTextPart('system rules')] } as never;
    const user = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([1, 2]), 'image/jpg')],
    } as never;
    expect(convertClaudeMessages([system, user], { supportsImageInput: true, promptCaching: true, cacheTTL: '1h' }))
      .toMatchObject({
        system: [{ type: 'text', text: 'system rules', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: [{ type: 'image', source: { media_type: 'image/jpeg', data: 'AQI=' }, cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
      });
    expect(convertClaudeTools([{ name: 'search', description: 'Search', inputSchema: {} }] as never, true, '1h'))
      .toMatchObject([{ name: 'search', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  });
});