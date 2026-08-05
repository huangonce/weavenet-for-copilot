import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  canonicalToolInput,
  dataPartBytes,
  snapshotChatRequest,
  snapshotChatResponseOptions,
} from '../../src/copilot/canonicalRequest';
import {
  convertClaudeMessages,
  convertMessages,
  convertResponsesInput,
} from '../../src/copilot/convert';

function user(...content: vscode.LanguageModelInputPart[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.User, content, name: undefined };
}

function assistant(...content: vscode.LanguageModelInputPart[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.Assistant, content, name: undefined };
}

function accessorRecord<T extends object>(prototype: object | null, properties: readonly string[], getter: () => unknown): T {
  const record = Object.create(prototype) as T;
  for (const property of properties) {
    Object.defineProperty(record, property, {
      get: getter,
      enumerable: true,
    });
  }
  return record;
}

describe('canonical chat request snapshot', () => {
  it('accepts host-revived message and options containers with non-Object prototypes', () => {
    class HostMessage {
      role = vscode.LanguageModelChatMessageRole.User;
      content = [new vscode.LanguageModelTextPart('hello')];
      name: string | undefined = undefined;
    }
    const snapshot = snapshotChatRequest([new HostMessage() as never]);
    expect(snapshot.messages).toMatchObject([{ role: 'user', content: [{ kind: 'text', value: 'hello' }] }]);

    class HostOptions {
      toolMode = vscode.LanguageModelChatToolMode.Auto;
    }
    expect(snapshotChatResponseOptions(new HostOptions() as never)).toMatchObject({
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    });
  });

  it('accepts host-revived messages whose fields are prototype getters', () => {
    // Mirrors the extension host, which revives request objects as class instances backed by
    // prototype accessors rather than own data properties.
    class RevivedMessage {
      constructor(private readonly state: { role: number; content: unknown[]; name?: string }) {}
      get role(): number { return this.state.role; }
      get content(): unknown[] { return this.state.content; }
      get name(): string | undefined { return this.state.name; }
    }
    class RevivedTextPart {
      constructor(private readonly text: string) {}
      get value(): string { return this.text; }
    }
    Object.setPrototypeOf(RevivedTextPart.prototype, vscode.LanguageModelTextPart.prototype);

    const message = new RevivedMessage({
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new RevivedTextPart('hello')],
      name: 'user-1',
    });
    const snapshot = snapshotChatRequest([message as never]);
    expect(snapshot.messages).toMatchObject([{
      role: 'user',
      name: 'user-1',
      content: [{ kind: 'text', value: 'hello' }],
    }]);

    class RevivedOptions {
      get tools(): unknown { return undefined; }
      get toolMode(): vscode.LanguageModelChatToolMode { return vscode.LanguageModelChatToolMode.Required; }
    }
    expect(snapshotChatResponseOptions(new RevivedOptions() as never)).toMatchObject({
      toolMode: vscode.LanguageModelChatToolMode.Required,
    });
  });

  it('reads accessor-backed message, array, and part properties exactly once', () => {
    const reads: string[] = [];
    let flip = false;
    const message = {};
    Object.defineProperties(message, {
      role: { get: () => { reads.push('role'); return vscode.LanguageModelChatMessageRole.User; }, enumerable: true },
      content: {
        get: () => {
          reads.push('content');
          const parts: unknown[] = [];
          Object.defineProperty(parts, '0', {
            get: () => {
              reads.push('content[0]');
              return new vscode.LanguageModelTextPart(flip ? 'mutated' : 'stable');
            },
            enumerable: true,
            configurable: true,
          });
          parts.length = 1;
          return parts;
        },
        enumerable: true,
      },
      name: { get: () => { reads.push('name'); return 'agent'; }, enumerable: true },
    });

    const snapshot = snapshotChatRequest([message] as never);
    flip = true;

    expect(snapshot.messages).toMatchObject([{
      role: 'user',
      name: 'agent',
      content: [{ kind: 'text', value: 'stable' }],
    }]);
    expect(reads).toEqual(['role', 'content', 'name', 'content[0]']);

    for (const [prototype, properties, expected] of [
      [vscode.LanguageModelTextPart.prototype, ['value'], { kind: 'text', value: 'stable' }],
      [vscode.LanguageModelToolCallPart.prototype, ['callId', 'name', 'input'], { kind: 'toolCall' }],
    ] as const) {
      const part = accessorRecord(prototype, properties, () => 'stable');
      const partSnapshot = snapshotChatRequest([user(part as never)]);
      expect(partSnapshot.messages[0].content[0]).toMatchObject(expected);
    }
  });

  it('rejects sparse content entries', () => {
    const content: unknown[] = [];
    content.length = 1;
    expect(() => snapshotChatRequest([{
      role: vscode.LanguageModelChatMessageRole.User,
      content,
    }] as never)).toThrow('sparse entry');
  });

  it('accepts empty and whitespace-only text parts', () => {
    const snapshot = snapshotChatRequest([
      assistant(new vscode.LanguageModelTextPart(''), new vscode.LanguageModelToolCallPart('call-1', 'search', {})),
      user(new vscode.LanguageModelTextPart('   ')),
      user(new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('')])),
    ]);
    expect(snapshot.messages[0].content[0]).toMatchObject({ kind: 'text', value: '' });
    expect(snapshot.messages[1].content[0]).toMatchObject({ kind: 'text', value: '   ' });
    expect(snapshot.messages[2].content[0]).toMatchObject({ content: [{ kind: 'text', value: '' }] });
  });

  it('rejects proxies at every raw graph boundary without invoking traps', () => {
    let traps = 0;
    const proxy = (value: object) => new Proxy(value, {
      get() { traps += 1; throw new Error('get trap must not run'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('descriptor trap must not run'); },
      getPrototypeOf() { traps += 1; throw new Error('prototype trap must not run'); },
    });
    const cases: unknown[] = [
      proxy([]),
      [proxy({ role: vscode.LanguageModelChatMessageRole.User, content: [] })],
      [{ role: vscode.LanguageModelChatMessageRole.User, content: proxy([]) }],
      [user(proxy(new vscode.LanguageModelTextPart('text')) as never)],
      [assistant(new vscode.LanguageModelToolCallPart('call', 'tool', proxy({ value: 1 }) as never))],
      [user(new vscode.LanguageModelDataPart(proxy(new Uint8Array([1])) as never, 'image/png'))],
    ];

    for (const raw of cases) expect(() => snapshotChatRequest(raw as never)).toThrow(/dynamic|cannot be sent safely/u);
    expect(traps).toBe(0);

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(() => snapshotChatRequest(revoked.proxy as never)).toThrow('dynamic');
  });

  it('detaches roles, ordering, text, tool input, call IDs, MIME, and image bytes', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const input = { query: 'original', nested: { count: 1 } };
    const text = new vscode.LanguageModelTextPart('before');
    const image = new vscode.LanguageModelDataPart(bytes, 'image/png');
    const toolCall = new vscode.LanguageModelToolCallPart('call-1', 'search', input);
    const messages = [
      user(text, image),
      assistant(toolCall),
      user(new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('done')])),
    ];
    const snapshot = snapshotChatRequest(messages);

    (messages[0] as { role: number }).role = vscode.LanguageModelChatMessageRole.Assistant;
    (messages[0].content as vscode.LanguageModelInputPart[]).reverse();
    (text as { value: string }).value = 'after';
    (image as { mimeType: string }).mimeType = 'image/jpeg';
    bytes.fill(9);
    (toolCall as { callId: string }).callId = 'changed';
    input.query = 'changed';
    input.nested.count = 99;

    expect(snapshot.messages).toMatchObject([
      {
        role: 'user',
        content: [
          { kind: 'text', value: 'before' },
          { kind: 'data', mimeType: 'image/png', base64: 'AQID', byteLength: 3 },
        ],
      },
      { role: 'assistant', content: [{ kind: 'toolCall', callId: 'call-1', name: 'search' }] },
      { role: 'user', content: [{ kind: 'toolResult', callId: 'call-1' }] },
    ]);
    const canonicalCall = snapshot.messages[1].content[0];
    expect(canonicalCall.kind).toBe('toolCall');
    if (canonicalCall.kind !== 'toolCall') throw new Error('Expected tool call');
    expect(canonicalToolInput(canonicalCall)).toEqual({ query: 'original', nested: { count: 1 } });
    const canonicalImage = snapshot.messages[0].content[1];
    expect(canonicalImage.kind).toBe('data');
    if (canonicalImage.kind !== 'data') throw new Error('Expected image');
    expect(dataPartBytes(canonicalImage)).toEqual(new Uint8Array([1, 2, 3]));

    expect(convertMessages(snapshot, true)[0]).toMatchObject({ role: 'user' });
    expect(convertResponsesInput(snapshot, true).input[0]).toMatchObject({ role: 'user' });
    expect(convertClaudeMessages(snapshot, { supportsImageInput: true }).messages[0]).toMatchObject({ role: 'user' });
  });

  it('accepts only finite, acyclic, bounded plain JSON tool input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.safe = true;
    const valid = snapshotChatRequest([assistant(
      new vscode.LanguageModelToolCallPart('valid', 'tool', { nullPrototype, array: [1, true, null, 'x'] }),
    )]);
    const call = valid.messages[0].content[0];
    expect(call.kind).toBe('toolCall');
    if (call.kind !== 'toolCall') throw new Error('Expected tool call');
    expect(canonicalToolInput(call)).toEqual({ nullPrototype: { safe: true }, array: [1, true, null, 'x'] });

    for (const input of [
      cyclic,
      { value: 1n },
      { value: () => undefined },
      { value: Symbol('x') },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: new Date() },
      { value: new Map() },
      { value: new Set() },
      { value: new Uint8Array([1]) },
    ]) {
      expect(() => snapshotChatRequest([assistant(
        new vscode.LanguageModelToolCallPart('invalid', 'tool', input as never),
      )])).toThrow();
    }
  });

  it('rejects oversized dense arrays before reading their entries', () => {
    let reads = 0;
    const messages: unknown[] = [];
    messages.length = 513;
    Object.defineProperty(messages, '0', { get() { reads += 1; return undefined; } });
    expect(() => snapshotChatRequest(messages as never)).toThrow('too large or complex');
    expect(reads).toBe(0);

    const input: unknown[] = [];
    input.length = 16_384;
    Object.defineProperty(input, '0', { get() { reads += 1; return undefined; } });
    expect(() => snapshotChatRequest([assistant(
      new vscode.LanguageModelToolCallPart('invalid', 'tool', input as never),
    )])).toThrow('too large or complex');
    expect(reads).toBe(0);
  });
});

describe('canonical response options snapshot', () => {
  it('detaches tools, schemas, tool mode, and consumed model options', () => {
    const schema = { type: 'object', properties: { query: { type: 'string' } } };
    const tool = { name: 'search', description: 'Search docs', inputSchema: schema };
    const options = {
      tools: [tool],
      toolMode: vscode.LanguageModelChatToolMode.Required,
      modelOptions: { reasoningEffort: 'max', contextWindow: '400000', ignored: { mutable: true } },
    };
    const snapshot = snapshotChatResponseOptions(options);

    tool.name = 'changed';
    tool.description = 'changed';
    schema.properties.query.type = 'number';
    options.tools.reverse();
    options.modelOptions.reasoningEffort = 'none';
    options.modelOptions.contextWindow = 'default';

    expect(snapshot).toEqual({
      tools: [{ name: 'search', description: 'Search docs', inputSchema: {
        type: 'object', properties: { query: { type: 'string' } },
      } }],
      toolMode: vscode.LanguageModelChatToolMode.Required,
      modelOptions: { reasoningEffort: 'max', contextWindow: '400000' },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(Object.isFrozen(snapshot.tools?.[0].inputSchema)).toBe(true);
  });

  it('reads accessor-backed options once and rejects dynamic or cyclic schema graphs', () => {
    let calls = 0;
    const options = Object.create(null);
    Object.defineProperty(options, 'tools', { get() { calls += 1; return []; } });
    expect(snapshotChatResponseOptions(options)).toMatchObject({
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    });
    expect(calls).toBe(1);

    let traps = 0;
    const proxy = new Proxy({ type: 'object' }, {
      get() { traps += 1; throw new Error('must not run'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('must not run'); },
      getPrototypeOf() { traps += 1; throw new Error('must not run'); },
    });
    expect(() => snapshotChatResponseOptions({
      tools: [{ name: 'search', description: 'Search', inputSchema: proxy }],
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    })).toThrow('dynamic');

    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;
    expect(() => snapshotChatResponseOptions({
      tools: [{ name: 'search', description: 'Search', inputSchema: cyclic }],
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    })).toThrow('cyclic tool input schema');
    expect(traps).toBe(0);
  });

  it('enforces pre-serialization string and aggregate tool-definition budgets', () => {
    expect(() => snapshotChatResponseOptions({
      tools: [{
        name: 'oversized-schema-string',
        description: '',
        inputSchema: { type: 'string', const: 'x'.repeat(1024 * 1024 + 1) },
      }],
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    })).toThrow('at most 1048576 UTF-8 bytes');

    const escapedDescription = '\n'.repeat(1024 * 1024);
    expect(() => snapshotChatResponseOptions({
      tools: [1, 2, 3].map((index) => ({
        name: `tool-${index}`,
        description: escapedDescription,
        inputSchema: { type: 'object', properties: {} },
      })),
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    })).toThrow('too large or complex');
  });
});
