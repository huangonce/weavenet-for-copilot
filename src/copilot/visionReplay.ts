import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { createThinkingPart, hostThinkingPart } from './helpers';
import { snapshotChatRequest } from './canonicalRequest';
import type { CanonicalChatRequestSnapshot } from './canonicalRequest';
import { MAX_VISION_REPLAY_BYTES, MAX_VISION_REPLAY_ENTRIES, MAX_VISION_REPLAY_HISTORY_ENTRIES, VISION_REPLAY_METADATA_KEY } from '../relay/visionReplay';
import type { VisionReplayEntry } from '../relay/visionReplay';

/** Packs internally generated entries; raw host metadata is validated by canonical snapshotting. */
export function createVisionReplayPart(identity: string, entries: readonly VisionReplayEntry[]): vscode.LanguageModelResponsePart | undefined {
  if (!hostThinkingPart()) return undefined;
  const retained: VisionReplayEntry[] = [];
  const keys = new Set<string>();
  let bytes = Buffer.byteLength(JSON.stringify({ version: 1, identity, entries: [] }), 'utf8');
  for (let index = entries.length - 1; index >= 0 && retained.length < MAX_VISION_REPLAY_ENTRIES; index--) {
    const entry = entries[index];
    if (keys.has(entry.key)) continue;
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + Number(retained.length > 0);
    if (bytes + entryBytes > MAX_VISION_REPLAY_BYTES) continue;
    bytes += entryBytes;
    keys.add(entry.key);
    retained.unshift(entry);
  }
  if (!retained.length) return undefined;
  const candidate = createThinkingPart('', undefined, { [VISION_REPLAY_METADATA_KEY]: { version: 1, identity, entries: retained } });
  if (!candidate) return undefined;
  const snapshot = snapshotChatRequest([{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [candidate], name: undefined }]);
  const part = snapshot.messages[0].content[0];
  return part.kind === 'thinking' && part.visionReplay
    ? createThinkingPart('', undefined, { [VISION_REPLAY_METADATA_KEY]: part.visionReplay }) : undefined;
}

/** The newest matching history is bounded; conflicting copies never become evidence. */
export function collectVisionReplayEntries(snapshot: CanonicalChatRequestSnapshot, identity: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const conflicts = new Set<string>();
  const fingerprints = new Map<string, string>();
  let bytes = 0;
  for (const message of snapshot.messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.kind !== 'thinking' || part.visionReplay?.identity !== identity) continue;
      for (const entry of part.visionReplay.entries) {
        if (conflicts.has(entry.key)) continue;
        const fingerprint = createHash('sha256').update(entry.text).digest('hex');
        const priorFingerprint = fingerprints.get(entry.key);
        fingerprints.set(entry.key, fingerprint);
        const previous = entries.get(entry.key);
        if (previous !== undefined) {
          bytes -= Buffer.byteLength(previous, 'utf8');
          entries.delete(entry.key);
        }
        if (priorFingerprint !== undefined && priorFingerprint !== fingerprint) { conflicts.add(entry.key); continue; }
        entries.set(entry.key, entry.text);
        bytes += Buffer.byteLength(entry.text, 'utf8');
        while (entries.size > MAX_VISION_REPLAY_HISTORY_ENTRIES || bytes > MAX_VISION_REPLAY_BYTES) {
          const oldest = entries.entries().next().value!;
          bytes -= Buffer.byteLength(oldest[1], 'utf8');
          entries.delete(oldest[0]);
        }
      }
    }
  }
  return entries;
}
