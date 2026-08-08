import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { createCanonicalSnapshot, snapshotChatRequest } from '../../src/copilot/canonicalRequest';
import { planToolListStabilization, type ToolActivationCall } from '../../src/copilot/toolStabilization';

function user(...content: vscode.LanguageModelInputPart[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.User, content, name: undefined };
}

function assistant(...content: vscode.LanguageModelInputPart[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.Assistant, content, name: undefined };
}

describe('DeepSeek tool-list stabilization', () => {
  it('preflights each activate_* helper once and ignores ordinary tools', () => {
    const messages = snapshotChatRequest([user(new vscode.LanguageModelTextPart('Fix the issue'))]);
    const plan = planToolListStabilization(
      messages,
      ['search', 'activate_files', 'activate_terminal', 'activate_files'],
      true,
    );

    expect(plan.round).toBe(1);
    expect(plan.calls.map((call) => call.name)).toEqual(['activate_files', 'activate_terminal']);
    expect(new Set(plan.calls.map((call) => call.callId)).size).toBe(2);
    expect(plan.messages).toBe(messages);
  });

  it('removes completed preflight control parts and only activates newly exposed helpers', () => {
    const initial = snapshotChatRequest([user(new vscode.LanguageModelTextPart('Fix the issue'))]);
    const first = planToolListStabilization(initial, ['activate_files'], true).calls[0]!;
    const messages = snapshotChatRequest([
      user(new vscode.LanguageModelTextPart('Fix the issue')),
      assistant(new vscode.LanguageModelToolCallPart(first.callId, first.name, {})),
      user(new vscode.LanguageModelToolResultPart(first.callId, [new vscode.LanguageModelTextPart('activated')])),
    ]);

    const next = planToolListStabilization(messages, ['activate_files', 'activate_terminal'], true);

    expect(next.round).toBe(2);
    expect(next.calls.map((call) => call.name)).toEqual(['activate_terminal']);
    expect(next.messages.messages).toEqual(initial.messages);
  });

  it('still strips old control-flow artifacts when the experimental option is disabled', () => {
    const initial = snapshotChatRequest([user(new vscode.LanguageModelTextPart('Fix the issue'))]);
    const call = planToolListStabilization(initial, ['activate_files'], true).calls[0]!;
    const history = snapshotChatRequest([
      ...toRequestMessages(initial),
      assistant(new vscode.LanguageModelToolCallPart(call.callId, call.name, {})),
      user(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart('activated')])),
    ]);

    const disabled = planToolListStabilization(history, ['activate_files'], false);

    expect(disabled.calls).toEqual([]);
    expect(disabled.messages.messages).toEqual(initial.messages);
  });

  it('fails closed when dynamically exposed activators do not settle after three rounds', () => {
    let transcript = snapshotChatRequest([user(new vscode.LanguageModelTextPart('Fix the issue'))]);
    for (let round = 1; round <= 3; round += 1) {
      const tools = Array.from({ length: round }, (_, index) => `activate_${index + 1}`);
      const call = planToolListStabilization(transcript, tools, true).calls[0]!;
      transcript = appendPreflight(transcript, call);
    }

    expect(() => planToolListStabilization(
      transcript,
      ['activate_1', 'activate_2', 'activate_3', 'activate_4'],
      true,
    )).toThrow('did not settle after 3 rounds');
  });
});

function appendPreflight(
  snapshot: ReturnType<typeof snapshotChatRequest>,
  call: ToolActivationCall,
): ReturnType<typeof snapshotChatRequest> {
  return createCanonicalSnapshot([
    ...snapshot.messages,
    { role: 'assistant', content: [{ kind: 'toolCall', callId: call.callId, name: call.name, inputJson: '{}' }] },
    {
      role: 'user',
      content: [{
        kind: 'toolResult',
        callId: call.callId,
        content: [{ kind: 'text', value: 'activated' }],
      }],
    },
  ]);
}

function toRequestMessages(snapshot: ReturnType<typeof snapshotChatRequest>): vscode.LanguageModelChatRequestMessage[] {
  return snapshot.messages.map((message) => ({
    role: message.role === 'assistant'
      ? vscode.LanguageModelChatMessageRole.Assistant
      : vscode.LanguageModelChatMessageRole.User,
    content: message.content.map((part) => {
      if (part.kind !== 'text') throw new Error('The test fixture only supports text parts.');
      return new vscode.LanguageModelTextPart(part.value);
    }),
    name: message.name,
  }));
}
