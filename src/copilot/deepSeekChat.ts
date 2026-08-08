import * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import type { ReasoningEffort, RoutedModel } from '../relay/types';
import type {
  CanonicalChatRequestSnapshot,
  CanonicalInputPart,
} from './canonicalRequest';

export const DEEPSEEK_REASONING_METADATA_KEY = 'weavenetDeepSeekReasoning';
const DEEPSEEK_REPLAY_ID = 'weavenet-deepseek-replay';

export type CopilotRequestKind =
  | 'main-agent'
  | 'terminal-steering'
  | 'todo-tracker'
  | 'settings-resolver'
  | 'prompt-categorizer'
  | 'chat-title'
  | 'inline-progress-message'
  | 'git-branch-name'
  | 'git-commit-message'
  | 'rename-suggestions'
  | 'background'
  | 'unknown';

const THINKING_DISABLED_REQUESTS = new Set<CopilotRequestKind>([
  'todo-tracker',
  'settings-resolver',
  'prompt-categorizer',
  'chat-title',
  'inline-progress-message',
  'git-branch-name',
  'git-commit-message',
  'rename-suggestions',
]);

const PREFIXES: ReadonlyArray<readonly [CopilotRequestKind, string]> = [
  ['todo-tracker', 'You are a background task tracker'],
  ['settings-resolver', 'You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings'],
  ['prompt-categorizer', 'You are an expert classifier for AI coding assistant prompts'],
  ['chat-title', 'You are an expert in crafting ultra-compact titles'],
  ['chat-title', 'You are an expert in crafting pithy titles'],
  ['inline-progress-message', 'You are an expert in writing short, catchy, and encouraging progress messages'],
  ['git-branch-name', 'You are an expert in crafting pithy branch names'],
  ['git-commit-message', 'You are an AI programming assistant, helping a software developer to come with the best git commit message'],
  ['rename-suggestions', 'You are a distinguished software engineer'],
];

export interface DeepSeekChatPolicy {
  readonly enabled: boolean;
  readonly requestKind: CopilotRequestKind;
  readonly effort?: ReasoningEffort;
  readonly thinking?: { readonly type: 'enabled' | 'disabled' };
}

export function resolveDeepSeekChatPolicy(
  config: ExtensionConfig,
  model: RoutedModel,
  request: CanonicalChatRequestSnapshot,
  toolNames: readonly string[],
  configuredEffort: ReasoningEffort | undefined,
): DeepSeekChatPolicy {
  if (!usesDeepSeekChatDialect(config, model)) {
    return { enabled: false, requestKind: 'unknown', effort: configuredEffort };
  }
  const requestKind = classifyCopilotRequest(request, toolNames);
  const effort = THINKING_DISABLED_REQUESTS.has(requestKind) ? 'none' : configuredEffort;
  return {
    enabled: true,
    requestKind,
    effort,
    thinking: { type: !effort || effort === 'none' ? 'disabled' : 'enabled' },
  };
}

export function deepSeekReasoningContent(parts: readonly CanonicalInputPart[]): string {
  const thinking = parts.filter(
    (part): part is Extract<CanonicalInputPart, { kind: 'thinking' }> => part.kind === 'thinking',
  );
  const carried = thinking.findLast((part) => Boolean(part.deepSeekContent))?.deepSeekContent;
  if (carried) return carried;
  return thinking.map((part) => part.value).join('');
}

export function createDeepSeekReplayPart(reasoning: string): vscode.LanguageModelResponsePart | undefined {
  if (!reasoning) return undefined;
  const ThinkingPart = (vscode as unknown as {
    LanguageModelThinkingPart?: new (
      value: string,
      id?: string,
      metadata?: Record<string, unknown>,
    ) => vscode.LanguageModelResponsePart;
  }).LanguageModelThinkingPart;
  if (!ThinkingPart) return undefined;
  return new ThinkingPart('', DEEPSEEK_REPLAY_ID, {
    [DEEPSEEK_REASONING_METADATA_KEY]: { content: reasoning },
  });
}

function usesDeepSeekChatDialect(config: ExtensionConfig, model: RoutedModel): boolean {
  if (model.openai?.dialect === 'deepseek') return true;
  try {
    return new URL(config.baseUrl).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

function classifyCopilotRequest(
  request: CanonicalChatRequestSnapshot,
  toolNames: readonly string[],
): CopilotRequestKind {
  const firstText = messageText(request.messages[0]?.content ?? []).trimStart();
  const latestUserText = [...request.messages]
    .reverse()
    .find((message) => message.role === 'user');
  if (/^\[Terminal\s+\S+\s+notification:/u.test(messageText(latestUserText?.content ?? []).trimStart())) {
    return 'terminal-steering';
  }
  if (toolNames.length === 1 && toolNames[0] === 'manage_todo_list') return 'todo-tracker';
  if (toolNames.length === 1 && toolNames[0] === 'categorize_prompt') return 'prompt-categorizer';
  const matched = PREFIXES.find(([, prefix]) => firstText.startsWith(prefix));
  if (matched) return matched[0];
  if (firstText.startsWith('You are an expert AI programming assistant')
    || firstText.includes('<skills>')
    || firstText.includes('<agents>')) {
    return 'main-agent';
  }
  return toolNames.length > 0 || firstText ? 'background' : 'unknown';
}

function messageText(parts: readonly CanonicalInputPart[]): string {
  return parts
    .filter((part): part is Extract<CanonicalInputPart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.value)
    .join('');
}
