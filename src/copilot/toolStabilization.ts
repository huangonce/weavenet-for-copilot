import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
  createCanonicalSnapshot,
  type CanonicalChatMessage,
  type CanonicalChatRequestSnapshot,
  type CanonicalInputPart,
} from './canonicalRequest';

const ACTIVATOR_PREFIX = 'activate_';
const PREFLIGHT_CALL_PREFIX = 'weavenet_deepseek_preflight_activate_';
const MAX_PREFLIGHT_ROUNDS = 3;

export interface ToolActivationCall {
  readonly callId: string;
  readonly name: string;
}

export interface ToolStabilizationPlan {
  readonly messages: CanonicalChatRequestSnapshot;
  readonly calls: readonly ToolActivationCall[];
  readonly round: number;
}

/**
 * Keeps DeepSeek's tool schema stable by completing Copilot's activate_* control
 * flow before any user request reaches the upstream model. Synthetic control
 * parts are removed from the model-visible transcript on the following turn.
 */
export function planToolListStabilization(
  messages: CanonicalChatRequestSnapshot,
  toolNames: readonly string[],
  enabled: boolean,
): ToolStabilizationPlan {
  const history = readPreflightHistory(messages);
  const sanitized = sanitizePreflightHistory(messages);
  if (!enabled) return { messages: sanitized, calls: [], round: history.rounds };

  const activators = [...new Set(toolNames.filter((name) => name.startsWith(ACTIVATOR_PREFIX)))];
  const pending = activators.filter((name) => !history.activated.has(name));
  if (pending.length === 0) return { messages: sanitized, calls: [], round: history.rounds };
  if (history.rounds >= MAX_PREFLIGHT_ROUNDS) {
    throw new vscode.LanguageModelError(
      'DeepSeek tool activation did not settle after 3 rounds. Disable the experimental tool-list stabilization setting or retry the chat.',
    );
  }

  const round = history.rounds + 1;
  return {
    messages: sanitized,
    calls: pending.map((name) => ({ callId: preflightCallId(round, name), name })),
    round,
  };
}

export function isToolStabilizationCallId(callId: string): boolean {
  return callId.startsWith(PREFLIGHT_CALL_PREFIX);
}

function readPreflightHistory(messages: CanonicalChatRequestSnapshot): {
  readonly activated: ReadonlySet<string>;
  readonly rounds: number;
} {
  const activated = new Set<string>();
  const rounds = new Set<string>();
  const start = latestUserRequestIndex(messages.messages);
  for (const message of messages.messages.slice(start + 1)) {
    for (const part of message.content) {
      if (part.kind !== 'toolCall' || !isToolStabilizationCallId(part.callId)) continue;
      if (part.name.startsWith(ACTIVATOR_PREFIX)) activated.add(part.name);
      rounds.add(roundFromCallId(part.callId));
    }
  }
  return { activated, rounds: rounds.size };
}

function latestUserRequestIndex(messages: readonly CanonicalChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && message.content.some((part) => part.kind !== 'toolResult')) return index;
  }
  return -1;
}

function sanitizePreflightHistory(messages: CanonicalChatRequestSnapshot): CanonicalChatRequestSnapshot {
  let changed = false;
  const sanitized: CanonicalChatMessage[] = [];
  for (const message of messages.messages) {
    const content = message.content.filter(keepModelVisiblePart);
    if (content.length !== message.content.length) changed = true;
    if (content.length === 0) {
      changed = true;
      continue;
    }
    sanitized.push(content.length === message.content.length
      ? message
      : Object.freeze({ ...message, content: Object.freeze(content) }));
  }
  return changed ? createCanonicalSnapshot(sanitized) : messages;
}

function keepModelVisiblePart(part: CanonicalInputPart): boolean {
  return (part.kind !== 'toolCall' && part.kind !== 'toolResult')
    || !isToolStabilizationCallId(part.callId);
}

function preflightCallId(round: number, name: string): string {
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 20);
  return `${PREFLIGHT_CALL_PREFIX}${round}_${digest}`;
}

function roundFromCallId(callId: string): string {
  return callId.slice(PREFLIGHT_CALL_PREFIX.length).split('_', 1)[0] ?? callId;
}
