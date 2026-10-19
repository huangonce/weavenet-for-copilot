import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { LanguageModelThinkingPart } from '../support/vscode.mock';
import { snapshotChatRequest } from '../../src/copilot/canonicalRequest';
import { matchingReplayStates } from '../../src/copilot/replayConversion';
import { PROTOCOL_REPLAY_METADATA_KEY } from '../../src/relay/replayState';
import type { ProtocolReplayState } from '../../src/relay/replayState';

describe('protocol tool history equality', () => {
  it('accepts reordered object keys but rejects reordered argument arrays', () => {
    const identity = 'a'.repeat(64);
    const replay: ProtocolReplayState = {
      version: 1, identity, apiType: 'chat-completions', displayText: 'Answer',
      chat: { role: 'assistant', content: 'Answer', reasoning_content: 'Reason', tool_calls: [{
        id: 'call', type: 'function', function: { name: 'search', arguments: '{"z":[2,1],"a":{"y":false,"x":1}}' },
      }] },
    };
    const message = (values: number[]) => snapshotChatRequest([{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      name: undefined,
      content: [new vscode.LanguageModelTextPart('Answer'),
        new vscode.LanguageModelToolCallPart('call', 'search', { a: { x: 1, y: false }, z: values }),
        new LanguageModelThinkingPart('', undefined, { [PROTOCOL_REPLAY_METADATA_KEY]: replay })],
    }]).messages[0];
    expect(matchingReplayStates(message([2, 1]), 'chat-completions', identity)).toHaveLength(1);
    expect(() => matchingReplayStates(message([1, 2]), 'chat-completions', identity)).toThrow('no longer matches');
  });
});
