import * as vscode from 'vscode';
import { createThinkingPart, parseToolArguments } from './helpers';
import { t } from '../l10n';
import type { ToolCall } from '../relay/types';
import { snapshotChatRequest } from './canonicalRequest';
import type { ResponsePartEmitter } from './responsePartEmitter';
import type { ProtocolReplayState } from '../relay/replayState';
import { cloneReplayState, PROTOCOL_REPLAY_METADATA_KEY, replayDisplayText } from '../relay/replayState';

const THINKING_PART_CARRIER = 'LanguageModelThinkingPart';

/**
 * The thinking part class is the only carrier that can move protocol state
 * through host history. It is a proposed API surface, so availability is a host
 * capability rather than a build-time guarantee: it has been verified present
 * from the declared minimum host (1.116.0) through current stable, but a future
 * or trimmed-down host may not expose it. Callers must degrade explicitly
 * instead of failing the whole request.
 */
export function hasProtocolReplayCarrier(): boolean {
  try {
    // A host module may also throw on unknown properties instead of returning
    // undefined, which must degrade exactly like an absent class.
    return typeof (vscode as unknown as Record<string, unknown>)[THINKING_PART_CARRIER] === 'function';
  } catch {
    return false;
  }
}

let warnedMissingCarrier = false;

/** One-shot notice so degraded replay is never silent. */
export function warnProtocolReplayUnavailable(protocol: 'OpenAI' | 'Responses' | 'Claude'): void {
  if (warnedMissingCarrier) return;
  warnedMissingCarrier = true;
  try {
    void Promise.resolve(vscode.window.showWarningMessage(
      t('This VS Code host cannot carry {0} protocol state, so native thinking and reasoning replay are disabled for this session. Update VS Code to restore them.', protocol),
    )).catch(() => undefined);
  } catch {
    // A host without a usable notification surface must not break the request.
  }
}

export function prepareProtocolTools(calls: readonly ToolCall[]): vscode.LanguageModelToolCallPart[] {
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.id || ids.has(call.id)) throw new vscode.LanguageModelError('Protocol tool call IDs must be non-empty and unique.');
    ids.add(call.id);
  }
  const parts = calls.map((call) => new vscode.LanguageModelToolCallPart(call.id, call.function.name, parseToolArguments(call.function.arguments)));
  snapshotChatRequest([{ role: vscode.LanguageModelChatMessageRole.Assistant, content: parts, name: undefined }]);
  return parts;
}

export function reconcileProtocolText(output: ResponsePartEmitter, displayed: string, actual: string): string {
  if (displayed === actual) return displayed;
  if (!actual.startsWith(displayed)) throw new vscode.LanguageModelError('The Relay stream disagrees with its completed response text. No tools were published.');
  output.text(actual.slice(displayed.length));
  return actual;
}

export function reportProtocolReplay(output: ResponsePartEmitter, state: ProtocolReplayState): void {
  if (replayDisplayText(state) !== state.displayText) throw new vscode.LanguageModelError('The Relay response text does not match its protocol replay payload. No tools were published.');
  const part = createThinkingPart('', undefined, { [PROTOCOL_REPLAY_METADATA_KEY]: cloneReplayState(state) });
  if (!part) throw new vscode.LanguageModelError('This VS Code host cannot preserve protocol replay metadata.');
  snapshotChatRequest([{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [part], name: undefined }]);
  output.report(part);
}
