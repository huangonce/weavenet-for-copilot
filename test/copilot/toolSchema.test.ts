import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { convertClaudeTools, convertResponsesTools, convertTools } from '../../src/copilot/convert';

describe('tool schema parameter-name preservation', () => {
  it.each([
    { api: 'Chat', convert: (tools: vscode.LanguageModelChatTool[]) => convertTools(tools, true)?.[0].function.parameters },
    { api: 'Responses', convert: (tools: vscode.LanguageModelChatTool[]) => convertResponsesTools(tools, true)?.[0].parameters },
    { api: 'Messages', convert: (tools: vscode.LanguageModelChatTool[]) => convertClaudeTools(tools)?.[0].input_schema },
  ])('preserves annotation-like business fields in $api tool parameters', ({ convert }) => {
    const inputSchema = { type: 'object', properties: {
      errorMessage: { type: 'string', markdownDescription: 'editor-only' },
      $id: { type: 'string' },
    }, required: ['errorMessage', '$id'], additionalProperties: false,
    examples: [{ errorMessage: 'operation failed', $id: 'record-1' }] };
    expect(convert([{ name: 'record_error', description: 'Record an error', inputSchema }])).toEqual({
      ...inputSchema, properties: { errorMessage: { type: 'string' }, $id: { type: 'string' } },
    });
    expect(inputSchema.properties.errorMessage.markdownDescription).toBe('editor-only');
  });

  it.each([
    { api: 'Chat', convert: (tools: vscode.LanguageModelChatTool[]) => convertTools(tools, true)?.[0].function },
    { api: 'Responses', convert: (tools: vscode.LanguageModelChatTool[]) => convertResponsesTools(tools, true)?.[0] },
  ])('preserves unsupported constraints in the $api non-strict fallback', ({ api, convert }) => {
    const inputSchema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'],
      allOf: [{ type: 'object', properties: { b: { type: 'string' } }, required: ['b'] }] };
    const tool = convert([{ name: 'composed', description: 'Use both fields', inputSchema }]);
    expect(tool?.parameters).toEqual(inputSchema);
    if (api === 'Responses') expect(tool?.strict).toBe(false);
    else expect(tool).not.toHaveProperty('strict');
    expect(tool?.parameters).not.toHaveProperty('additionalProperties');
  });
});
