import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { LanguageModelThinkingPart } from '../support/vscode.mock';
import { hostReplayMetadata, decodeHostReplayMetadata } from '../../src/copilot/hostReplayCarrier';
import { snapshotChatRequest } from '../../src/copilot/canonicalRequest';
import { convertMessages, convertResponsesInput } from '../../src/copilot/convert';
import { PROTOCOL_REPLAY_METADATA_KEY, MAX_PROTOCOL_REPLAY_BYTES } from '../../src/relay/replayState';
import { VISION_REPLAY_METADATA_KEY } from '../../src/relay/visionReplay';

const identity = 'a'.repeat(64);
const protocol = { version: 1, identity, apiType: 'chat-completions', displayText: 'answer',
  chat: { role: 'assistant', content: 'answer', reasoning_content: 'original thought' } };
function snapshot(metadata: Record<string, unknown>) {
  return snapshotChatRequest([{ role: vscode.LanguageModelChatMessageRole.Assistant,
    content: [new vscode.LanguageModelTextPart('answer'), new LanguageModelThinkingPart('', 'carrier', metadata)], name: undefined }]);
}

describe('Agent Host opaque replay carrier', () => {
  it('restores protocol state when the bridge only retains encrypted_content', () => {
    const carrier = hostReplayMetadata({ [PROTOCOL_REPLAY_METADATA_KEY]: protocol });
    const history = snapshot({ encrypted_content: carrier.metadata.encrypted_content });
    expect(history.messages[0].content[1]).toMatchObject({ protocolReplay: protocol });
    expect(history.messages[0].content[1]).not.toHaveProperty('encryptedContent');
    expect(convertMessages(history, false, false, true, identity)).toEqual([protocol.chat]);
    const metadata = decodeHostReplayMetadata(carrier.metadata.encrypted_content);
    expect(metadata).toEqual({ [PROTOCOL_REPLAY_METADATA_KEY]: protocol });
    expect(hostReplayMetadata({ [PROTOCOL_REPLAY_METADATA_KEY]: protocol }).id).not.toBe(carrier.id);
  });

  it('restores vision metadata without leaking the envelope to any remote request', () => {
    const vision = { version: 1, identity, entries: [{ key: 'b'.repeat(64), text: 'original description' }] };
    const carrier = hostReplayMetadata({ [VISION_REPLAY_METADATA_KEY]: vision });
    const history = snapshot({ encrypted_content: carrier.metadata.encrypted_content });
    expect(history.messages[0].content[1]).toMatchObject({ visionReplay: vision });
    expect(JSON.stringify(convertResponsesInput(history, false))).not.toContain('weavenet-replay');
    expect(JSON.stringify(convertMessages(history, false))).not.toContain('original description');
  });

  it('keeps native encrypted reasoning distinct from the extension envelope', () => {
    const history = snapshot({ encrypted_content: 'upstream-encrypted-payload' });
    expect(history.messages[0].content[1]).toMatchObject({ encryptedContent: 'upstream-encrypted-payload' });
    expect(decodeHostReplayMetadata('upstream-encrypted-payload')).toBeUndefined();
  });

  it('rejects conflicts and validates decoded state rather than trusting an opaque string', () => {
    const carrier = hostReplayMetadata({ [PROTOCOL_REPLAY_METADATA_KEY]: protocol });
    expect(() => snapshot({ ...carrier.metadata, [PROTOCOL_REPLAY_METADATA_KEY]: { ...protocol, identity: 'b'.repeat(64) } }))
      .toThrow('Conflicting host protocol replay');
    const invalid = hostReplayMetadata({ [PROTOCOL_REPLAY_METADATA_KEY]: { ...protocol, identity: 'bad' } });
    expect(() => snapshot({ encrypted_content: invalid.metadata.encrypted_content })).toThrow('Invalid protocol replay');
  });

  it.each(['weavenet-replay:v2:AAAA', 'weavenet-replay:v1:not_base64', 'weavenet-replay:v1:====',
    'weavenet-replay:v1:' + Buffer.from('{"version":2,"metadata":{}}').toString('base64'),
    'weavenet-replay:v1:' + Buffer.from('{"version":1,"metadata":{"unknown":{}}}').toString('base64'),
  ])('rejects malformed or unsupported envelopes', value => {
    expect(() => snapshot({ encrypted_content: value })).toThrow('Invalid host replay');
  });

  it('bounds payload size before decoding or emitting', () => {
    expect(() => decodeHostReplayMetadata('weavenet-replay:v1:' + 'A'.repeat(7 * 1024 * 1024))).toThrow();
    expect(() => hostReplayMetadata({ [PROTOCOL_REPLAY_METADATA_KEY]: 'x'.repeat(MAX_PROTOCOL_REPLAY_BYTES + 512 * 1024) })).toThrow();
  });
});
