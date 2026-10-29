import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { LanguageModelThinkingPart } from '../support/vscode.mock';
import { snapshotChatRequest } from '../../src/copilot/canonicalRequest';
import { convertClaudeMessages, convertMessages, convertResponsesInput } from '../../src/copilot/convert';
import { collectVisionReplayEntries, createVisionReplayPart } from '../../src/copilot/visionReplay';
import { MAX_VISION_REPLAY_BYTES, MAX_VISION_REPLAY_ENTRY_BYTES, VISION_REPLAY_METADATA_KEY } from '../../src/relay/visionReplay';
import type { VisionReplayState } from '../../src/relay/visionReplay';
import { PROTOCOL_REPLAY_METADATA_KEY } from '../../src/relay/replayState';

const identity = 'a'.repeat(64);
const key = 'b'.repeat(64);
const description = '[Untrusted image description data]\nVisible label: Settings';
const assistant = (...parts: unknown[]): vscode.LanguageModelChatRequestMessage => ({
  role: vscode.LanguageModelChatMessageRole.Assistant, content: parts, name: undefined,
});
const state = (text = description): VisionReplayState => ({ version: 1, identity, entries: [{ key, text }] });
const carrier = (value: unknown) => new LanguageModelThinkingPart('', undefined, { [VISION_REPLAY_METADATA_KEY]: value });
const snapshot = (value: unknown) => snapshotChatRequest([assistant(carrier(value))]);
const digest = (index: number) => index.toString(16).padStart(64, '0');

describe('vision replay metadata', () => {
  it('detaches and freezes descriptions without emitting them into model text', () => {
    const entries = [{ key, text: description }];
    const part = createVisionReplayPart(identity, entries);
    expect(part).toBeDefined();
    entries[0].text = 'changed';
    const history = snapshotChatRequest([assistant(part)]);
    const thinking = history.messages[0].content[0];
    expect(thinking).toMatchObject({ kind: 'thinking', value: '', visionReplay: state() });
    if (thinking.kind !== 'thinking') throw new Error('Expected metadata carrier');
    expect(Object.isFrozen(thinking.visionReplay?.entries[0])).toBe(true);
    expect(collectVisionReplayEntries(history, identity).get(key)).toBe(description);
    expect(convertMessages(history, false)).toEqual([]);
    expect(convertResponsesInput(history, false)).toEqual({ input: [] });
    expect(convertClaudeMessages(history, { supportsImageInput: false }).messages).toEqual([]);
    expect(createVisionReplayPart(identity, [])).toBeUndefined();
  });

  it('keeps existing native protocol state separate and byte-identical', () => {
    const protocolReplay = { version: 1, identity, apiType: 'messages', displayText: 'answer',
      claude: [{ type: 'thinking', thinking: '', signature: 'OPAQUE' }, { type: 'text', text: 'answer' }] };
    const native = new LanguageModelThinkingPart('', undefined, {
      [PROTOCOL_REPLAY_METADATA_KEY]: protocolReplay, [VISION_REPLAY_METADATA_KEY]: state(),
    });
    const history = snapshotChatRequest([assistant(new vscode.LanguageModelTextPart('answer'), native)]);
    const thinking = history.messages[0].content[1];
    expect(thinking).toMatchObject({ protocolReplay, visionReplay: state() });
    expect(convertClaudeMessages(history, { supportsImageInput: false, protocolIdentity: identity }).messages[0].content)
      .toEqual(protocolReplay.claude);
  });

  it('only reads matching assistant metadata, never a textual marker', () => {
    const history = snapshotChatRequest([
      { role: vscode.LanguageModelChatMessageRole.User, content: [carrier(state())], name: undefined },
      assistant(carrier({ ...state(), identity: 'c'.repeat(64) })),
      assistant(new vscode.LanguageModelTextPart(JSON.stringify({ [VISION_REPLAY_METADATA_KEY]: state() }))),
    ]);
    expect(collectVisionReplayEntries(history, identity).size).toBe(0);
  });

  it.each([
    { ...state(), version: 2 }, { ...state(), identity: 'not-a-digest' },
    { ...state(), entries: [{ key: 'bad', text: description }] },
    { ...state(), entries: [{ key, text: '' }] },
    { ...state(), entries: [{ key, text: description, source: 'unexpected' }] },
    { ...state(), extra: true },
    { ...state(), entries: [{ key, text: description }, { key, text: description }] },
    { ...state(), entries: Array.from({ length: 9 }, (_, index) => ({ key: digest(index), text: description })) },
  ])('rejects invalid metadata shapes', value => {
    expect(() => snapshot(value)).toThrow('Invalid vision replay metadata');
  });

  it('enforces per-entry UTF-8 and total serialized payload budgets', () => {
    expect(() => snapshot(state('汉'.repeat(MAX_VISION_REPLAY_ENTRY_BYTES / 3)))).not.toThrow();
    expect(() => snapshot(state('汉'.repeat(MAX_VISION_REPLAY_ENTRY_BYTES / 3 + 1)))).toThrow('Invalid vision replay metadata');
    const entries = Array.from({ length: 8 }, (_, index) => ({ key: digest(index), text: 'x'.repeat(MAX_VISION_REPLAY_ENTRY_BYTES) }));
    expect(() => snapshot({ ...state(), entries })).toThrow('too large or complex');
    const output = createVisionReplayPart(identity, entries);
    const history = snapshotChatRequest([assistant(output)]);
    const retained = collectVisionReplayEntries(history, identity);
    expect(retained.size).toBe(7);
    expect(retained.has(digest(0))).toBe(false);
    expect(retained.get(digest(7))).toBe(entries[7].text);
  });

  it('limits emitted metadata to the latest unique entries without changing their text', () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({ key: digest(index), text: `original ${index}` }));
    const output = createVisionReplayPart(identity, [...entries, entries[11]]);
    const retained = collectVisionReplayEntries(snapshotChatRequest([assistant(output)]), identity);
    expect([...retained.keys()]).toEqual(entries.slice(-8).map(entry => entry.key));
    expect([...retained.values()]).toEqual(entries.slice(-8).map(entry => entry.text));
  });

  it('rejects proxies and accessors throughout payloads without running them', () => {
    let reads = 0;
    const trap = () => { reads++; throw new Error('must not run'); };
    const dynamic = new Proxy(state(), { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
    const accessorEntry = Object.defineProperty({ key }, 'text', { get: trap, enumerable: true });
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, '0', { get: trap, enumerable: true });
    accessorArray.length = 1;
    const dynamicEntries = new Proxy([], { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
    const metadata = Object.defineProperty({}, VISION_REPLAY_METADATA_KEY, { get: trap, enumerable: true });
    for (const value of [dynamic, { ...state(), entries: [accessorEntry] }, { ...state(), entries: accessorArray },
      { ...state(), entries: dynamicEntries }]) {
      expect(() => snapshot(value)).toThrow();
    }
    expect(() => snapshotChatRequest([assistant(new LanguageModelThinkingPart('', undefined, metadata))])).toThrow();
    expect(reads).toBe(0);
  });

  it('rejects cyclic metadata', () => {
    const value: Record<string, unknown> = { ...state() }; value.self = value;
    expect(() => snapshot(value)).toThrow('Vision replay state cannot be cyclic');
  });

  it('retains at most the latest 64 entries without rejecting a long history', () => {
    const history = snapshotChatRequest(Array.from({ length: 70 }, (_, index) => assistant(carrier({
      version: 1, identity, entries: [{ key: digest(index), text: `description ${index}` }],
    }))));
    const entries = collectVisionReplayEntries(history, identity);
    expect(entries.size).toBe(64);
    expect(entries.has(digest(0))).toBe(false);
    expect(entries.get(digest(69))).toBe('description 69');
  });

  it('bounds the collected text budget and ignores conflicting keys even after eviction', () => {
    const history = snapshotChatRequest([
      assistant(carrier(state())),
      ...Array.from({ length: 70 }, (_, index) => assistant(carrier({ version: 1, identity,
        entries: [{ key: digest(index), text: 'x'.repeat(MAX_VISION_REPLAY_ENTRY_BYTES) }] }))),
      assistant(carrier(state('conflicting description'))), assistant(carrier(state())),
    ]);
    const entries = collectVisionReplayEntries(history, identity);
    expect(entries.has(key)).toBe(false);
    expect([...entries.values()].reduce((bytes, text) => bytes + Buffer.byteLength(text, 'utf8'), 0)).toBeLessThanOrEqual(MAX_VISION_REPLAY_BYTES);
  });
});
