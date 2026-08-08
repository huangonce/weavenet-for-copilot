import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { snapshotChatRequest } from '../../src/copilot/canonicalRequest';
import { convertMessages } from '../../src/copilot/convert';
import {
  createDeepSeekReplayPart,
  resolveDeepSeekChatPolicy,
} from '../../src/copilot/deepSeekChat';
import type { ExtensionConfig } from '../../src/config/config';
import type { RoutedModel } from '../../src/relay/types';

const LanguageModelThinkingPart = (vscode as unknown as {
  LanguageModelThinkingPart: new (value: string) => vscode.LanguageModelTextPart;
}).LanguageModelThinkingPart;

const model = {
  id: 'deepseek-v4-flash',
  pickerId: 'deepseek-v4-flash',
  upstreamId: 'deepseek-v4-flash',
  protocol: 'openai',
  route: 'openai',
  catalogSource: 'configured',
  thinking: true,
  openai: { dialect: 'deepseek' },
} satisfies RoutedModel;

function config(baseUrl = 'https://relay.example.test/v1'): ExtensionConfig {
  return { baseUrl } as ExtensionConfig;
}

function user(text: string) {
  return vscode.LanguageModelChatMessage.User(text);
}

describe('DeepSeek Chat adapter', () => {
  it('enables DeepSeek thinking for main requests and auto-detects the official endpoint', () => {
    const request = snapshotChatRequest([user('You are an expert AI programming assistant\nHelp me')]);

    expect(resolveDeepSeekChatPolicy(config(), model, request, ['search'], 'high')).toEqual({
      enabled: true,
      requestKind: 'main-agent',
      effort: 'high',
      thinking: { type: 'enabled' },
    });
    expect(resolveDeepSeekChatPolicy(
      config('https://api.deepseek.com'),
      { ...model, openai: undefined },
      request,
      [],
      'high',
    ).enabled).toBe(true);
  });

  it('disables thinking for Copilot helper requests without affecting standard OpenAI models', () => {
    const request = snapshotChatRequest([user('You are an expert in crafting pithy titles for chats')]);

    expect(resolveDeepSeekChatPolicy(config(), model, request, [], 'max')).toMatchObject({
      enabled: true,
      requestKind: 'chat-title',
      effort: 'none',
      thinking: { type: 'disabled' },
    });
    expect(resolveDeepSeekChatPolicy(
      config(),
      { ...model, openai: undefined },
      request,
      [],
      'max',
    )).toEqual({ enabled: false, requestKind: 'unknown', effort: 'max' });
  });

  it('prefers hidden replay metadata when rebuilding DeepSeek assistant history', () => {
    const replay = createDeepSeekReplayPart('complete hidden reasoning');
    expect(replay).toBeDefined();
    const request = snapshotChatRequest([
      vscode.LanguageModelChatMessage.Assistant([
        new LanguageModelThinkingPart('visible partial reasoning'),
        replay! as vscode.LanguageModelTextPart,
        new vscode.LanguageModelTextPart('answer'),
      ]),
    ]);

    expect(convertMessages(request, false, false, true)).toEqual([{
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'complete hidden reasoning',
    }]);
  });
});
