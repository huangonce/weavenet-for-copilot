import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  applyLastTwoUserCacheControl,
  convertClaudeMessages as convertCanonicalClaudeMessages,
  convertClaudeTools,
  convertMessages as convertCanonicalMessages,
  convertResponsesInput as convertCanonicalResponsesInput,
  convertResponsesTools,
  convertTools,
  normalizeClaudeImageMediaType,
} from '../../src/copilot/convert';
import { clampClaudeTemperature } from '../../src/copilot/helpers';
import { snapshotChatRequest } from '../../src/copilot/canonicalRequest';
import type { ClaudeMessage } from '../../src/relay/types';

function userMessage(...content: vscode.LanguageModelInputPart[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.User, content, name: undefined };
}

function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  supportsImageInput: boolean,
  supportsDeveloperRole = false,
) {
  return convertCanonicalMessages(snapshotChatRequest(messages), supportsImageInput, supportsDeveloperRole);
}

function convertResponsesInput(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  supportsImageInput: boolean,
  replayReasoningContent = false,
  includeAssistantPhase = false,
  encryptedReasoning = false,
) {
  return convertCanonicalResponsesInput(
    snapshotChatRequest(messages),
    supportsImageInput,
    replayReasoningContent,
    includeAssistantPhase,
    encryptedReasoning,
  );
}

function convertClaudeMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: Parameters<typeof convertCanonicalClaudeMessages>[1],
) {
  return convertCanonicalClaudeMessages(snapshotChatRequest(messages), options);
}

describe('chat request conversion', () => {
  it('converts assistant text and tool calls, then emits tool results', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelTextPart('Working on it.'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', { query: 'relay' }),
      ],
    }, {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('Found it.')])],
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
      ],
    }] as never;

    expect(() => convertMessages(messages, false)).toThrow('target does not support image input');
    expect(convertMessages(messages, true)).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'auto', media_type: 'image/png' } },
      ],
    }]);
  });

  it('rejects non-image data instead of silently discarding it', () => {
    const message = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([4]), 'application/pdf')],
    } as never;

    expect(() => convertMessages([message], true)).toThrow('non-image data attachment');
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

  it('accepts compatible image-like data and rejects unsupported parts', () => {
    const imageBuffer = new Uint8Array([9, 8]).buffer;
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        { mime_type: 'image/jpeg', value: imageBuffer },
        { mediaType: 'image/webp', bytes: new Uint8Array([7]) },
      ],
    }] as never;

    expect(convertMessages(messages, true)).toEqual([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,CQg=', detail: 'auto', media_type: 'image/jpeg' } },
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,Bw==', detail: 'auto', media_type: 'image/webp' } },
      ],
    }]);
    expect(() => convertMessages(messages, false)).toThrow('target does not support image input');

    for (const part of [
      { mimeType: 'text/plain', data: new Uint8Array([6]) },
      { mimeType: 'image/png', data: 'not bytes' },
      null,
    ]) {
      const invalid = [{ role: vscode.LanguageModelChatMessageRole.User, content: [part] }] as never;
      expect(() => convertMessages(invalid, true)).toThrow();
    }
  });

  it('maps system messages and rejects unsupported tool-result containers', () => {
    const messages = [
      { role: 3, content: [new vscode.LanguageModelTextPart('system instruction')] },
      { role: vscode.LanguageModelChatMessageRole.Assistant, content: [new vscode.LanguageModelToolResultPart('call-1', [{ value: 'data' }])] },
    ] as never;

    expect(() => convertMessages(messages, false)).toThrow('unsupported tool-result container');
  });

  it('rejects assistant images instead of silently dropping them from Chat Completions', () => {
    const message = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')],
    } as never;

    expect(() => convertMessages([message], true))
      .toThrow('OpenAI Chat Completions cannot encode image attachments in assistant messages');
  });

  it('rejects system images instead of silently dropping them from Chat Completions', () => {
    const message = {
      role: 3,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')],
    } as never;

    expect(() => convertMessages([message], true))
      .toThrow('OpenAI Chat Completions cannot encode image attachments in system messages');
  });

  it('allows only OpenAI-supported image MIME types and normalizes image/jpg', () => {
    const jpeg = [userMessage(new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/jpg'))] as never;
    const svg = [userMessage(new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/svg+xml'))] as never;

    expect(convertMessages(jpeg, true)[0]).toMatchObject({
      content: [{ image_url: { url: 'data:image/jpeg;base64,AQ==', media_type: 'image/jpeg' } }],
    });
    expect(() => convertMessages(svg, true)).toThrow('accepts only JPEG, PNG, GIF, or WebP');
  });
});

describe('responses input conversion', () => {
  it('preserves assistant function calls so call_ids match tool results', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelTextPart('Calling search.'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', { query: 'relay' }),
      ],
    }, {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('Found it.')])],
    }] as never;

    expect(convertResponsesInput(messages, false)).toEqual({
      input: [
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Calling search.' }],
        },
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{"query":"relay"}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'Found it.' },
      ],
    });
  });

  it('omits the synthesized reasoning item by default', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelThinkingPart('Need to look this up.'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', {}),
      ],
    }] as never;

    expect(convertResponsesInput(messages, false)).toEqual({
      input: [
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{}' },
      ],
    });
  });

  it('replays reasoning_text in content for DeepSeek-style relays', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelThinkingPart('Need to look this up.'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', {}),
      ],
    }] as never;

    expect(convertResponsesInput(messages, false, true)).toEqual({
      input: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Need to look this up.' }], summary: [] },
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{}' },
      ],
    });
  });

  it('labels replayed assistant messages with their phase when enabled', () => {
    const preamble = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content: [
          new vscode.LanguageModelTextPart('Let me search.'),
          new vscode.LanguageModelToolCallPart('call-1', 'search', {}),
        ],
      },
      { role: vscode.LanguageModelChatMessageRole.Assistant, content: [new vscode.LanguageModelTextPart('Found it.')] },
    ] as never;

    expect(convertResponsesInput(preamble, false, false, true)).toEqual({
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: 'Let me search.' }], phase: 'commentary' },
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{}' },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Found it.' }], phase: 'final_answer' },
      ],
    });
    expect(convertResponsesInput(preamble, false)).toEqual({
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: 'Let me search.' }] },
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{}' },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Found it.' }] },
      ],
    });
  });

  it('preserves interleaved text and tool-call order', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelThinkingPart('I need to check.'),
        new vscode.LanguageModelTextPart('Checking now.'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', { query: 'relay' }),
        new vscode.LanguageModelTextPart('Found the answer.'),
      ],
    }] as never;

    expect(convertResponsesInput(messages, false, true, true)).toEqual({
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: 'Checking now.' }], phase: 'commentary' },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'I need to check.' }], summary: [] },
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{"query":"relay"}' },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Found the answer.' }], phase: 'final_answer' },
      ],
    });
  });

  it('keeps a single synthesized reasoning item in front of consecutive tool calls', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelThinkingPart('Thinking first.'),
        new vscode.LanguageModelTextPart('The answer.'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', {}),
        new vscode.LanguageModelToolCallPart('call-2', 'read', {}),
      ],
    }] as never;

    expect(convertResponsesInput(messages, false, true, true)).toEqual({
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: 'The answer.' }], phase: 'commentary' },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Thinking first.' }], summary: [] },
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{}' },
        { type: 'function_call', call_id: 'call-2', name: 'read', arguments: '{}' },
      ],
    });
  });

  it('does not synthesize reasoning for pure-text turns', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelThinkingPart('A short thought.'),
        new vscode.LanguageModelTextPart('The answer.'),
      ],
    }] as never;

    expect(convertResponsesInput(messages, false, true, true)).toEqual({
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: 'The answer.' }], phase: 'final_answer' },
      ],
    });
  });

  it('replays a carried encrypted reasoning item verbatim and in place', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelTextPart('Checking now.'),
        new vscode.LanguageModelThinkingPart('', 'rs_1', {
          weavenetResponsesReasoning: {
            encryptedContent: 'gAAAAA-opaque',
            summary: [{ type: 'summary_text', text: 'Looked it up.' }],
          },
        }),
        new vscode.LanguageModelToolCallPart('call-1', 'search', {}),
      ],
    }] as never;

    expect(convertResponsesInput(messages, false, true, false, true)).toEqual({
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: 'Checking now.' }] },
        {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'gAAAAA-opaque',
          summary: [{ type: 'summary_text', text: 'Looked it up.' }],
        },
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{}' },
      ],
    });
  });

  it('sends no reasoning item when the encrypted payload did not survive the round trip', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelThinkingPart('Plaintext only.'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', {}),
      ],
    }] as never;

    // Better to omit reasoning than to send a synthesized item the server rejects.
    expect(convertResponsesInput(messages, false, true, false, true)).toEqual({
      input: [
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

    expect(() => convertResponsesInput(messages, false)).toThrow('target does not support image input');
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
        { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{}' },
      ],
      instructions: 'system instruction',
    });
  });

  it('rejects assistant images instead of emitting invalid Responses output content', () => {
    const message = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')],
    } as never;

    expect(() => convertResponsesInput([message], true))
      .toThrow('OpenAI Responses cannot encode image attachments in assistant messages');
  });

  it('rejects system images instead of silently dropping them from Responses instructions', () => {
    const message = {
      role: 3,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')],
    } as never;

    expect(() => convertResponsesInput([message], true))
      .toThrow('OpenAI Responses cannot encode image attachments in system messages');
  });

  it('rejects unsupported OpenAI Responses image MIME types', () => {
    const message = userMessage(new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/svg+xml')) as never;
    expect(() => convertResponsesInput([message], true)).toThrow('accepts only JPEG, PNG, GIF, or WebP');
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
  it('drops empty text blocks that Anthropic rejects', () => {
    const messages = [{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelTextPart(''),
        new vscode.LanguageModelToolCallPart('call-1', 'search', { query: 'relay' }),
      ],
    }, {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('done')]),
        new vscode.LanguageModelTextPart(''),
      ],
    }] as never[];

    const { messages: converted } = convertClaudeMessages(messages, { supportsImageInput: false });
    expect(converted).toEqual([{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'search', input: { query: 'relay' } }],
    }, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }],
    }]);
  });

  it('allows only Anthropic-supported image MIME types', () => {
    expect(normalizeClaudeImageMediaType('image/jpg')).toBe('image/jpeg');
    expect(normalizeClaudeImageMediaType('image/webp')).toBe('image/webp');
    expect(normalizeClaudeImageMediaType('image/svg+xml')).toBeUndefined();
  });

  it('rejects unsupported Claude image MIME types instead of silently dropping them', () => {
    const message = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelTextPart('Inspect this image'),
        new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/svg+xml'),
      ],
    } as never;

    expect(() => convertClaudeMessages([message], { supportsImageInput: true }))
      .toThrow('Claude Messages accepts only JPEG, PNG, GIF, or WebP');
  });

  it('normalizes structurally compatible images for Claude Messages', () => {
    const message = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [{ mime_type: 'image/png', bytes: new Uint8Array([1, 2]) }],
    } as never;

    expect(convertClaudeMessages([message], { supportsImageInput: true }).messages).toEqual([{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQI=' } }],
    }]);
  });

  it('rejects assistant images instead of emitting invalid Claude content', () => {
    const message = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')],
    } as never;

    expect(() => convertClaudeMessages([message], { supportsImageInput: true }))
      .toThrow('Claude Messages cannot encode image attachments in assistant messages');
  });

  it('rejects system images instead of silently dropping them from Claude system content', () => {
    const message = {
      role: 3,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')],
    } as never;

    expect(() => convertClaudeMessages([message], { supportsImageInput: true }))
      .toThrow('Claude Messages cannot encode image attachments in system messages');
  });

  it('rejects images nested in native tool results instead of serializing their bytes', () => {
    const message = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelToolResultPart('call-1', [
        new vscode.LanguageModelTextPart('result'),
        new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
      ])],
    } as never;

    expect(() => convertMessages([message], true)).toThrow('cannot encode images inside tool results');
    expect(() => convertResponsesInput([message], true)).toThrow('cannot encode images inside tool results');
    expect(() => convertClaudeMessages([message], { supportsImageInput: true }))
      .toThrow('cannot encode images inside tool results');
  });

  it('rejects image data nested in tool-call arguments for every protocol', () => {
    const message = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelToolCallPart('call-1', 'inspect', {
        nested: { image: new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png') },
      })],
    } as never;

    expect(() => convertMessages([message], false)).toThrow('unsupported prototype');
    expect(() => convertResponsesInput([message], false)).toThrow('unsupported prototype');
    expect(() => convertClaudeMessages([message], { supportsImageInput: false }))
      .toThrow('unsupported prototype');
  });

  it('rejects image data hidden inside unsupported tool-result containers', () => {
    const message = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelToolResultPart('call-1', [{
        value: { image: { mimeType: 'image/png', data: new Uint8Array([9]) } },
      }])],
    } as never;

    expect(() => convertMessages([message], false)).toThrow('unsupported tool-result container');
    expect(() => convertResponsesInput([message], false)).toThrow('unsupported tool-result container');
    expect(() => convertClaudeMessages([message], { supportsImageInput: false }))
      .toThrow('unsupported tool-result container');
  });

  it('rejects direct images for non-visual Claude targets', () => {
    const message = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')],
    } as never;

    expect(() => convertClaudeMessages([message], { supportsImageInput: false }))
      .toThrow('target does not support image input');
  });

  it('rejects cyclic, over-wide, and custom-serialized message containers', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const wide = Object.fromEntries(Array.from({ length: 65_537 }, (_, index) => [`p${index}`, null]));
    const custom = { toJSON: () => ({ mimeType: 'image/png', data: new Uint8Array([1]) }) };
    const toolCall = (input: object) => ({
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelToolCallPart('call-1', 'inspect', input)],
    }) as never;

    expect(() => convertMessages([toolCall(cyclic)], false)).toThrow('cyclic tool input');
    expect(() => convertMessages([toolCall(wide)], false)).toThrow('too large or complex');
    expect(() => convertMessages([toolCall(custom)], false)).toThrow('not strict JSON data');
  });

  it('rejects unknown message roles rather than mapping them to user', () => {
    const message = { role: 99, content: [new vscode.LanguageModelTextPart('text')] } as never;
    expect(() => convertMessages([message], false)).toThrow('message role is not supported');
    expect(() => convertResponsesInput([message], false)).toThrow('message role is not supported');
    expect(() => convertClaudeMessages([message], { supportsImageInput: false }))
      .toThrow('message role is not supported');
  });

  it('rejects role/part combinations that each wire protocol cannot represent', () => {
    const cases = [
      { role: vscode.LanguageModelChatMessageRole.User, part: new vscode.LanguageModelToolCallPart('call', 'tool', {}) },
      { role: 3, part: new vscode.LanguageModelToolCallPart('call', 'tool', {}) },
      { role: vscode.LanguageModelChatMessageRole.Assistant, part: new vscode.LanguageModelToolResultPart('call', [new vscode.LanguageModelTextPart('result')]) },
      { role: 3, part: new vscode.LanguageModelToolResultPart('call', [new vscode.LanguageModelTextPart('result')]) },
      { role: vscode.LanguageModelChatMessageRole.User, part: new vscode.LanguageModelThinkingPart('thought') },
      { role: 3, part: new vscode.LanguageModelThinkingPart('thought') },
    ];

    for (const testCase of cases) {
      const message = [{ role: testCase.role, content: [testCase.part] }] as never;
      expect(() => convertMessages(message, false)).toThrow('cannot encode');
      expect(() => convertResponsesInput(message, false)).toThrow('cannot encode');
      expect(() => convertClaudeMessages(message, { supportsImageInput: false })).toThrow('cannot encode');
    }
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