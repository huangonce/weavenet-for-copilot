export const VISION_REPLAY_METADATA_KEY = 'weavenetVisionReplay';
export const MAX_VISION_REPLAY_ENTRY_BYTES = 48 * 1024;
export const MAX_VISION_REPLAY_ENTRIES = 8;
export const MAX_VISION_REPLAY_BYTES = 384 * 1024;
export const MAX_VISION_REPLAY_HISTORY_ENTRIES = 64;

export interface VisionReplayEntry {
  readonly key: string;
  readonly text: string;
}

/** Descriptions are bound to the target route and the original image/context key. */
export interface VisionReplayState {
  readonly version: 1;
  readonly identity: string;
  readonly entries: readonly VisionReplayEntry[];
}

/** Only call after strict JSON snapshotting has removed dynamic graph behavior. */
export function isVisionReplayState(value: unknown): value is VisionReplayState {
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const digest = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  if (!record(value) || Object.keys(value).some(key => !['version', 'identity', 'entries'].includes(key))
    || value.version !== 1 || !digest(value.identity) || !Array.isArray(value.entries)
    || value.entries.length > MAX_VISION_REPLAY_ENTRIES) return false;
  const keys = new Set<string>();
  for (const entry of value.entries) {
    if (!record(entry) || Object.keys(entry).some(key => key !== 'key' && key !== 'text')
      || !digest(entry.key) || keys.has(entry.key) || typeof entry.text !== 'string' || !entry.text.trim()
      || Buffer.byteLength(entry.text, 'utf8') > MAX_VISION_REPLAY_ENTRY_BYTES) return false;
    keys.add(entry.key);
  }
  return true;
}
