import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { convertMessages, convertTools } from '../../src/copilot/convert';

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