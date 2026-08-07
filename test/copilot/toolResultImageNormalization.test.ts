import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { snapshotChatRequest } from '../../src/copilot/canonicalRequest';
import { promoteNativeToolResultImages } from '../../src/copilot/toolResultImageNormalization';

function user(...content: vscode.LanguageModelInputPart[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.User, content, name: undefined };
}

function assistant(...content: vscode.LanguageModelInputPart[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.Assistant, content, name: undefined };
}

function image(value: number): vscode.LanguageModelDataPart {
  return new vscode.LanguageModelDataPart(new Uint8Array([value]), 'image/png');
}

describe('native tool-result image normalization', () => {
  it('keeps tool text and promotes ordered images after the tool output', () => {
    const snapshot = snapshotChatRequest([
      assistant(new vscode.LanguageModelToolCallPart('call-1', 'inspect', {})),
      user(new vscode.LanguageModelToolResultPart('call-1', [
        new vscode.LanguageModelTextPart('Screenshot:'),
        image(1),
        image(2),
      ])),
    ]);

    const normalized = promoteNativeToolResultImages(snapshot);

    expect(normalized.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: [expect.objectContaining({ callId: 'call-1' })] }),
      expect.objectContaining({ role: 'user', content: [{
        kind: 'toolResult',
        callId: 'call-1',
        content: [{ kind: 'text', value: 'Screenshot:' }],
      }] }),
      expect.objectContaining({ role: 'user', content: [
        expect.objectContaining({ kind: 'data', base64: 'AQ==' }),
        expect.objectContaining({ kind: 'data', base64: 'Ag==' }),
      ] }),
    ]);
    expect(snapshot.messages[1].content[0]).toMatchObject({
      kind: 'toolResult',
      content: [expect.objectContaining({ kind: 'text' }), expect.objectContaining({ kind: 'data' }), expect.objectContaining({ kind: 'data' })],
    });
  });

  it('uses a safe text marker for image-only tool results', () => {
    const normalized = promoteNativeToolResultImages(snapshotChatRequest([
      assistant(new vscode.LanguageModelToolCallPart('call-1', 'screenshot', {})),
      user(new vscode.LanguageModelToolResultPart('call-1', [
        new vscode.LanguageModelTextPart('   '),
        image(3),
      ])),
    ]));

    expect(normalized.messages[1].content[0]).toMatchObject({
      kind: 'toolResult',
      content: [
        { kind: 'text', value: '   ' },
        { kind: 'text', value: expect.stringContaining('following user message') },
      ],
    });
    expect(JSON.stringify(normalized.messages[1])).not.toContain('Aw==');
  });

  it('waits for every parallel tool output across messages before promoting all images', () => {
    const normalized = promoteNativeToolResultImages(snapshotChatRequest([
      assistant(
        new vscode.LanguageModelToolCallPart('call-1', 'first', {}),
        new vscode.LanguageModelToolCallPart('call-2', 'second', {}),
      ),
      user(new vscode.LanguageModelToolResultPart('call-1', [image(1)])),
      user(new vscode.LanguageModelToolResultPart('call-2', [
        new vscode.LanguageModelTextPart('second result'),
        image(2),
      ])),
    ]));

    expect(normalized.messages.map((message) => message.content.map((part) => part.kind))).toEqual([
      ['toolCall', 'toolCall'],
      ['toolResult'],
      ['toolResult'],
      ['data'],
      ['data'],
    ]);
    expect(normalized.messages[3].content).toMatchObject([{ base64: 'AQ==' }]);
    expect(normalized.messages[4].content).toMatchObject([{ base64: 'Ag==' }]);
  });

  it('removes unanswered calls and flushes available images at the end of a truncated parallel batch', () => {
    const normalized = promoteNativeToolResultImages(snapshotChatRequest([
      assistant(
        new vscode.LanguageModelToolCallPart('call-1', 'first', {}),
        new vscode.LanguageModelToolCallPart('call-2', 'second', {}),
      ),
      user(new vscode.LanguageModelToolResultPart('call-1', [image(1)])),
    ]));

    expect(normalized.messages.map((message) => message.content.map((part) => part.kind))).toEqual([
      ['toolCall'],
      ['toolResult'],
      ['data'],
    ]);
    expect(normalized.messages[0].content[0]).toMatchObject({ callId: 'call-1' });
    expect(normalized.messages[2].content[0]).toMatchObject({ base64: 'AQ==' });
  });

  it('removes unanswered calls and flushes an abandoned batch before a new assistant turn', () => {
    const normalized = promoteNativeToolResultImages(snapshotChatRequest([
      assistant(
        new vscode.LanguageModelToolCallPart('call-1', 'first', {}),
        new vscode.LanguageModelToolCallPart('call-2', 'second', {}),
      ),
      user(new vscode.LanguageModelToolResultPart('call-1', [image(1)])),
      assistant(new vscode.LanguageModelTextPart('Start a new turn.')),
    ]));

    expect(normalized.messages.map((message) => message.content.map((part) => part.kind))).toEqual([
      ['toolCall'],
      ['toolResult'],
      ['data'],
      ['text'],
    ]);
    expect(normalized.messages[0].content[0]).toMatchObject({ callId: 'call-1' });
  });

  it('moves mixed top-level and tool-result images after every parallel tool output in source order', () => {
    const snapshot = snapshotChatRequest([
      assistant(
        new vscode.LanguageModelToolCallPart('call-1', 'first', {}),
        new vscode.LanguageModelToolCallPart('call-2', 'second', {}),
      ),
      user(
        image(9),
        new vscode.LanguageModelToolResultPart('call-1', [image(1)]),
        new vscode.LanguageModelToolResultPart('call-2', [image(2)]),
      ),
    ]);

    const normalized = promoteNativeToolResultImages(snapshot);

    expect(normalized.messages.map((message) => message.content.map((part) => part.kind))).toEqual([
      ['toolCall', 'toolCall'],
      ['toolResult', 'toolResult'],
      ['data', 'data', 'data'],
    ]);
    expect(normalized.messages[2].content).toMatchObject([
      { base64: 'CQ==' },
      { base64: 'AQ==' },
      { base64: 'Ag==' },
    ]);
    expect(snapshot.messages[1].content[0]).toMatchObject({ kind: 'data', base64: 'CQ==' });
  });

  it('delays ordinary user text and images until after tool outputs', () => {
    const normalized = promoteNativeToolResultImages(snapshotChatRequest([
      assistant(new vscode.LanguageModelToolCallPart('call-1', 'inspect', {})),
      user(
        new vscode.LanguageModelTextPart('Context before the screenshot.'),
        image(9),
        new vscode.LanguageModelToolResultPart('call-1', [image(1)]),
      ),
    ]));

    expect(normalized.messages[1].content).toMatchObject([
      { kind: 'toolResult', callId: 'call-1' },
    ]);
    expect(normalized.messages[2].content).toMatchObject([
      { kind: 'text', value: 'Context before the screenshot.' },
      { base64: 'CQ==' },
      { base64: 'AQ==' },
    ]);
  });

  it('preserves separate deferred user message boundaries and names', () => {
    const normalized = promoteNativeToolResultImages(snapshotChatRequest([
      assistant(
        new vscode.LanguageModelToolCallPart('call-1', 'first', {}),
        new vscode.LanguageModelToolCallPart('call-2', 'second', {}),
      ),
      { ...user(
        new vscode.LanguageModelTextPart('First context.'),
        new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('one')]),
      ), name: 'first-user' },
      { ...user(
        new vscode.LanguageModelTextPart('Second context.'),
        new vscode.LanguageModelToolResultPart('call-2', [new vscode.LanguageModelTextPart('two')]),
      ), name: 'second-user' },
    ]));

    expect(normalized.messages.slice(-2)).toMatchObject([
      { role: 'user', name: 'first-user', content: [{ value: 'First context.' }] },
      { role: 'user', name: 'second-user', content: [{ value: 'Second context.' }] },
    ]);
  });

  it('rejects orphan, repeated, and stale tool results', () => {
    const cases = [
      [user(new vscode.LanguageModelToolResultPart('orphan', [new vscode.LanguageModelTextPart('bad')]))],
      [
        assistant(new vscode.LanguageModelToolCallPart('call-1', 'inspect', {})),
        user(new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('one')])),
        user(new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('two')])),
      ],
      [
        assistant(new vscode.LanguageModelToolCallPart('call-1', 'inspect', {})),
        assistant(new vscode.LanguageModelTextPart('A new turn.')),
        user(new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('late')])),
      ],
    ];

    for (const messages of cases) {
      expect(() => promoteNativeToolResultImages(snapshotChatRequest(messages))).toThrow('must match one earlier');
    }
  });

  it('orders a top-level-only image after its tool output', () => {
    const normalized = promoteNativeToolResultImages(snapshotChatRequest([
      assistant(new vscode.LanguageModelToolCallPart('call-1', 'inspect', {})),
      user(
        image(9),
        new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('done')]),
      ),
    ]));

    expect(normalized.messages.map((message) => message.content.map((part) => part.kind))).toEqual([
      ['toolCall'],
      ['toolResult'],
      ['data'],
    ]);
    expect(normalized.messages[2].content[0]).toMatchObject({ base64: 'CQ==' });
  });

  it('returns deeply frozen new containers and leaves tool-call-free snapshots untouched', () => {
    const source = snapshotChatRequest([
      assistant(new vscode.LanguageModelToolCallPart('call-1', 'inspect', {})),
      user(new vscode.LanguageModelToolResultPart('call-1', [image(1)])),
    ]);
    const normalized = promoteNativeToolResultImages(source);
    const normalizedResult = normalized.messages[1].content[0];

    expect(normalized).not.toBe(source);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.messages)).toBe(true);
    expect(Object.isFrozen(normalized.messages[1])).toBe(true);
    expect(Object.isFrozen(normalized.messages[1].content)).toBe(true);
    expect(Object.isFrozen(normalizedResult)).toBe(true);
    expect(normalizedResult.kind).toBe('toolResult');
    if (normalizedResult.kind !== 'toolResult') throw new Error('Expected a tool result');
    expect(Object.isFrozen(normalizedResult.content)).toBe(true);

    const toolCallFree = snapshotChatRequest([user(new vscode.LanguageModelTextPart('hello'))]);
    expect(promoteNativeToolResultImages(toolCallFree)).toBe(toolCallFree);
  });
});