import { randomUUID } from 'node:crypto';
import { MAX_PROTOCOL_REPLAY_BYTES, PROTOCOL_REPLAY_METADATA_KEY } from '../relay/replayState';
import { MAX_VISION_REPLAY_BYTES, VISION_REPLAY_METADATA_KEY } from '../relay/visionReplay';

const PREFIX = 'weavenet-replay:v1:';
const RESERVED_PREFIX = 'weavenet-replay:';
const MAX_PAYLOAD_BYTES = MAX_PROTOCOL_REPLAY_BYTES + MAX_VISION_REPLAY_BYTES + 256;
const MAX_ENCODED_LENGTH = PREFIX.length + 4 * Math.ceil(MAX_PAYLOAD_BYTES / 3);

/** Agent Host preserves encrypted_content, but drops arbitrary thinking metadata. This envelope is opaque, not encrypted. */
export function hostReplayMetadata(metadata: Readonly<Record<string, unknown>>): {
  id: string; metadata: Record<string, unknown>;
} {
  const json = JSON.stringify({ version: 1, metadata });
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('Host replay metadata exceeds the bounded response limit.');
  return { id: `weavenet-replay-${randomUUID()}`, metadata: {
    ...metadata, encrypted_content: PREFIX + Buffer.from(json, 'utf8').toString('base64'),
  } };
}

/** Decoded fields still require the same strict, identity-bound snapshot validation as ordinary metadata. */
export function decodeHostReplayMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value.startsWith(RESERVED_PREFIX)) return undefined;
  if (!value.startsWith(PREFIX) || value.length > MAX_ENCODED_LENGTH) throw new Error('Invalid host replay envelope.');
  const encoded = value.slice(PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error('Invalid host replay envelope.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_PAYLOAD_BYTES || bytes.toString('base64') !== encoded) throw new Error('Invalid host replay envelope.');
  const envelope: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record(envelope) || envelope.version !== 1 || Object.keys(envelope).some(key => key !== 'version' && key !== 'metadata')
    || !record(envelope.metadata)) throw new Error('Invalid host replay envelope.');
  const metadata = envelope.metadata;
  const keys = Object.keys(metadata);
  if (keys.length !== 1 || ![PROTOCOL_REPLAY_METADATA_KEY, VISION_REPLAY_METADATA_KEY].includes(keys[0])) {
    throw new Error('Invalid host replay envelope.');
  }
  return metadata;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
