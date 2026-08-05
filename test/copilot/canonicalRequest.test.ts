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

  it('rejects accessors without invoking message, array, or part getters', () => {
    let calls = 0;
    const getter = () => { calls += 1; return undefined; };
    const message = {};
    Object.defineProperties(message, {
      role: { get: getter, enumerable: true },
      content: { get: getter, enumerable: true },
      name: { get: getter, enumerable: true },
    });
    expect(() => snapshotChatRequest([message] as never)).toThrow('direct data property');

    const content: unknown[] = [];
    content.length = 1;
    Object.defineProperty(content, '0', { get: getter, enumerable: true });
    expect(() => snapshotChatRequest([{
      role: vscode.LanguageModelChatMessageRole.User,
      content,
    }] as never)).toThrow('sparse or dynamic entry');

    for (const [prototype, properties] of [
      [vscode.LanguageModelTextPart.prototype, ['value']],
      [vscode.LanguageModelDataPart.prototype, ['data', 'mimeType']],
      [vscode.LanguageModelToolCallPart.prototype, ['callId', 'name', 'input']],
      [vscode.LanguageModelToolResultPart.prototype, ['callId', 'content']],
    ] as const) {
      const part = accessorRecord(prototype, properties, getter);
      expect(() => snapshotChatRequest([user(part as never)])).toThrow('direct data property');
    }
    expect(calls).toBe(0);
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

  it('rejects dynamic and cyclic option graphs without invoking accessors or proxy traps', () => {
    let calls = 0;
    const options = Object.create(null);
    Object.defineProperty(options, 'tools', { get() { calls += 1; return []; } });
    expect(() => snapshotChatResponseOptions(options)).toThrow('direct data property');

    const proxy = new Proxy({ type: 'object' }, {
      get() { calls += 1; throw new Error('must not run'); },
      getOwnPropertyDescriptor() { calls += 1; throw new Error('must not run'); },
      getPrototypeOf() { calls += 1; throw new Error('must not run'); },
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
    expect(calls).toBe(0);
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
