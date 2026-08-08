import { types as utilTypes } from 'node:util';
import * as vscode from 'vscode';

const SYSTEM_ROLE = 3;
const MAX_MESSAGES = 512;
const MAX_PARTS = 8_192;
const MAX_TOOLS = 128;
const MAX_JSON_NODES = 16_384;
const MAX_JSON_PROPERTIES = 65_536;
const MAX_JSON_DEPTH = 24;
const MAX_CALL_ID_BYTES = 512;
const MAX_TOOL_NAME_BYTES = 512;
const MAX_TOOL_DESCRIPTION_BYTES = 1024 * 1024;
const MAX_TOOL_JSON_STRING_BYTES = 1024 * 1024;
const MAX_TOOL_JSON_KEY_BYTES = 16 * 1024;
const MAX_MIME_TYPE_BYTES = 256;
const MAX_MESSAGE_NAME_BYTES = 512;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_JSON_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_TOOL_DEFINITION_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_TOOL_JSON_BYTES = 16 * 1024 * 1024;
const MAX_REASONING_SUMMARIES = 1_024;
const MAX_VISION_IMAGES = 8;
const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VISION_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const RESPONSES_REASONING_METADATA_KEY = 'weavenetResponsesReasoning';
const DEEPSEEK_REASONING_METADATA_KEY = 'weavenetDeepSeekReasoning';

const SNAPSHOT_BRAND: unique symbol = Symbol('CanonicalChatRequestSnapshot');

export type CanonicalMessageRole = 'user' | 'assistant' | 'system';

export interface CanonicalTextPart {
  readonly kind: 'text';
  readonly value: string;
}

export interface CanonicalDataPart {
  readonly kind: 'data';
  readonly mimeType: string;
  readonly base64: string;
  readonly byteLength: number;
}

export interface CanonicalToolCallPart {
  readonly kind: 'toolCall';
  readonly callId: string;
  readonly name: string;
  readonly inputJson: string;
}

export interface CanonicalToolResultPart {
  readonly kind: 'toolResult';
  readonly callId: string;
  readonly content: readonly CanonicalToolResultContentPart[];
}

export interface CanonicalThinkingPart {
  readonly kind: 'thinking';
  readonly value: string;
  readonly id?: string;
  readonly encryptedContent?: string;
  readonly summary: readonly CanonicalReasoningSummary[];
  readonly deepSeekContent?: string;
}

export interface CanonicalReasoningSummary {
  readonly type: 'summary_text';
  readonly text: string;
}

export type CanonicalToolResultContentPart = CanonicalTextPart | CanonicalDataPart;
export type CanonicalInputPart =
  | CanonicalTextPart
  | CanonicalDataPart
  | CanonicalToolCallPart
  | CanonicalToolResultPart
  | CanonicalThinkingPart;

export interface CanonicalChatMessage {
  readonly role: CanonicalMessageRole;
  readonly content: readonly CanonicalInputPart[];
  readonly name?: string;
}

export interface CanonicalChatRequestSnapshot {
  readonly [SNAPSHOT_BRAND]: true;
  readonly messages: readonly CanonicalChatMessage[];
  readonly hasImages: boolean;
}

export interface CanonicalChatResponseOptions {
  readonly tools?: readonly vscode.LanguageModelChatTool[];
  readonly toolMode: vscode.LanguageModelChatToolMode;
  readonly modelOptions?: Readonly<Record<string, unknown>>;
}

interface SnapshotState {
  parts: number;
  jsonNodes: number;
  jsonProperties: number;
  imageCount: number;
  imageBytes: number;
  textBytes: number;
  toolJsonBytes: number;
  hasImages: boolean;
}

export function snapshotChatRequest(
  rawMessages: readonly vscode.LanguageModelChatRequestMessage[],
): CanonicalChatRequestSnapshot {
  assertNotProxy(rawMessages, 'The message list');
  const messageValues = readDenseArray(rawMessages, 'The message list', MAX_MESSAGES);
  const state: SnapshotState = {
    parts: 0,
    jsonNodes: 0,
    jsonProperties: 0,
    imageCount: 0,
    imageBytes: 0,
    textBytes: 0,
    toolJsonBytes: 0,
    hasImages: false,
  };
  const messages = messageValues.map((raw, index) => snapshotMessage(raw, index, state));
  return Object.freeze({
    [SNAPSHOT_BRAND]: true as const,
    messages: Object.freeze(messages),
    hasImages: state.hasImages,
  });
}

export function snapshotChatResponseOptions(
  rawOptions: vscode.ProvideLanguageModelChatResponseOptions & {
    readonly modelConfiguration?: Record<string, unknown>;
    readonly configuration?: Record<string, unknown>;
  },
): CanonicalChatResponseOptions {
  assertHostRecord(rawOptions, 'The response options');
  const rawTools = readHostProperty(rawOptions, 'tools', 'The response options');
  const rawToolMode = readHostProperty(rawOptions, 'toolMode', 'The response options');
  const tools = rawTools === undefined || rawTools === null
    ? undefined
    : snapshotTools(rawTools);
  if (
    rawToolMode !== undefined
    && rawToolMode !== null
    && rawToolMode !== vscode.LanguageModelChatToolMode.Auto
    && rawToolMode !== vscode.LanguageModelChatToolMode.Required
  ) {
    throw new vscode.LanguageModelError('The response tool mode is invalid and cannot be sent safely.');
  }
  const reasoningEffort = snapshotSelectedModelOption(rawOptions, 'reasoningEffort');
  const contextWindow = snapshotSelectedModelOption(rawOptions, 'contextWindow');
  const modelOptions = reasoningEffort === undefined && contextWindow === undefined
    ? undefined
    : Object.freeze({
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    });
  return Object.freeze({
    ...(tools === undefined ? {} : { tools }),
    toolMode: (rawToolMode ?? vscode.LanguageModelChatToolMode.Auto) as vscode.LanguageModelChatToolMode,
    ...(modelOptions === undefined ? {} : { modelOptions }),
  });
}

export function isCanonicalChatRequestSnapshot(value: unknown): value is CanonicalChatRequestSnapshot {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, SNAPSHOT_BRAND);
    return !!descriptor && 'value' in descriptor && descriptor.value === true;
  } catch {
    return false;
  }
}

export function createCanonicalSnapshot(
  messages: readonly CanonicalChatMessage[],
): CanonicalChatRequestSnapshot {
  const frozenMessages = Object.freeze([...messages]);
  return Object.freeze({
    [SNAPSHOT_BRAND]: true as const,
    messages: frozenMessages,
    hasImages: frozenMessages.some((message) => message.content.some((part) =>
      isCanonicalImagePart(part)
      || (part.kind === 'toolResult' && part.content.some(isCanonicalImagePart)))),
  });
}

export function dataPartBytes(part: CanonicalDataPart): Uint8Array {
  return Uint8Array.from(Buffer.from(part.base64, 'base64'));
}

export function isCanonicalImagePart(part: CanonicalInputPart | CanonicalToolResultContentPart): part is CanonicalDataPart {
  return part.kind === 'data' && part.mimeType.startsWith('image/');
}

export function canonicalToolInput(part: CanonicalToolCallPart): unknown {
  return JSON.parse(part.inputJson) as unknown;
}

function snapshotMessage(raw: unknown, index: number, state: SnapshotState): CanonicalChatMessage {
  assertHostRecord(raw, `Message ${index + 1}`);
  const roleValue = readHostProperty(raw, 'role', `Message ${index + 1}`);
  const contentValue = readHostProperty(raw, 'content', `Message ${index + 1}`);
  const nameValue = readHostProperty(raw, 'name', `Message ${index + 1}`);
  const role = snapshotRole(roleValue);
  if (nameValue !== undefined) assertBoundedString(nameValue, 'Message name', MAX_MESSAGE_NAME_BYTES, true);
  assertNotProxy(contentValue, `Message ${index + 1} content`);
  const rawParts = readDenseArray(contentValue, `Message ${index + 1} content`, MAX_PARTS - state.parts);
  state.parts += rawParts.length;
  if (state.parts > MAX_PARTS) throw snapshotLimitError();
  const content = rawParts.map((part, partIndex) => snapshotPart(part, state, `Message ${index + 1} part ${partIndex + 1}`));
  return Object.freeze({
    role,
    content: Object.freeze(content),
    ...(nameValue === undefined ? {} : { name: nameValue }),
  });
}

function snapshotRole(value: unknown): CanonicalMessageRole {
  if (value === vscode.LanguageModelChatMessageRole.User) return 'user';
  if (value === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
  if (value === SYSTEM_ROLE) return 'system';
  throw new vscode.LanguageModelError('This message role is not supported and cannot be sent safely.');
}

function snapshotPart(raw: unknown, state: SnapshotState, subject: string): CanonicalInputPart {
  assertNotProxy(raw, subject);
  if (raw instanceof vscode.LanguageModelTextPart) return snapshotTextPart(raw, subject, state);
  if (raw instanceof vscode.LanguageModelDataPart) return snapshotDataPart(raw, state, subject);
  if (raw instanceof vscode.LanguageModelToolCallPart) return snapshotToolCallPart(raw, state, subject);
  if (raw instanceof vscode.LanguageModelToolResultPart) return snapshotToolResultPart(raw, state, subject);
  if (isThinkingPart(raw)) return snapshotThinkingPart(raw, state, subject);
  return snapshotStructuralImagePart(raw, state, subject);
}

function snapshotTextPart(raw: vscode.LanguageModelTextPart, subject: string, state?: SnapshotState): CanonicalTextPart {
  const value = readHostProperty(raw, 'value', subject);
  // Empty text parts are API-legal: tool-call-only assistant turns and tools returning '' produce them.
  assertBoundedString(value, `${subject} text`, MAX_TEXT_BYTES, true);
  if (state) consumeTextBudget(state, value);
  return Object.freeze({ kind: 'text' as const, value });
}

function snapshotDataPart(raw: vscode.LanguageModelDataPart, state: SnapshotState, subject: string): CanonicalDataPart {
  return snapshotDataValues(
    readHostProperty(raw, 'data', subject),
    readHostProperty(raw, 'mimeType', subject),
    state,
    subject,
  );
}

function snapshotStructuralImagePart(raw: unknown, state: SnapshotState, subject: string): CanonicalDataPart {
  assertPlainRecord(raw, subject);
  const allowed = new Set(['mimeType', 'mime_type', 'mediaType', 'data', 'value', 'bytes']);
  const keys = readOwnEnumerableKeys(raw, subject);
  if (keys.some((key) => !allowed.has(key))) throw unsupportedPartError(subject);
  const mime = readSingleAlias(raw, ['mimeType', 'mime_type', 'mediaType'], subject);
  const data = readSingleAlias(raw, ['data', 'value', 'bytes'], subject);
  if (typeof mime !== 'string' || !mime.trim().toLowerCase().startsWith('image/')) throw unsupportedPartError(subject);
  return snapshotDataValues(data, mime, state, subject);
}

function snapshotDataValues(data: unknown, mime: unknown, state: SnapshotState, subject: string): CanonicalDataPart {
  assertBoundedString(mime, `${subject} MIME type`, MAX_MIME_TYPE_BYTES, false);
  const mimeType = mime.trim().toLowerCase();
  if (!mimeType || /[\r\n;,]/u.test(mimeType)) {
    throw new vscode.LanguageModelError(`${subject} has an invalid MIME type and cannot be sent safely.`);
  }
  if (!mimeType.startsWith('image/')) {
    throw new vscode.LanguageModelError(
      `${subject} is a non-image data attachment and cannot be sent safely. Convert the data to text before sending it.`,
    );
  }
  const byteLength = binaryByteLength(data, subject);
  state.imageCount += 1;
  if (state.imageCount > MAX_VISION_IMAGES) {
    throw new vscode.LanguageModelError('Vision proxy requests may contain at most 8 images.');
  }
  if (byteLength > MAX_VISION_IMAGE_BYTES) {
    throw new vscode.LanguageModelError('Each vision proxy image may be at most 10 MiB.');
  }
  state.imageBytes += byteLength;
  if (state.imageBytes > MAX_VISION_TOTAL_IMAGE_BYTES) {
    throw new vscode.LanguageModelError('Vision proxy image data may total at most 20 MiB per request.');
  }
  const bytes = copyBytes(data, subject, byteLength);
  state.hasImages = true;
  return Object.freeze({
    kind: 'data' as const,
    mimeType,
    base64: Buffer.from(bytes).toString('base64'),
    byteLength: bytes.byteLength,
  });
}

function snapshotToolCallPart(
  raw: vscode.LanguageModelToolCallPart,
  state: SnapshotState,
  subject: string,
): CanonicalToolCallPart {
  const callId = readHostProperty(raw, 'callId', subject);
  const name = readHostProperty(raw, 'name', subject);
  const input = readHostProperty(raw, 'input', subject);
  assertBoundedString(callId, `${subject} call ID`, MAX_CALL_ID_BYTES, false);
  assertBoundedString(name, `${subject} tool name`, MAX_TOOL_NAME_BYTES, false);
  const inputJson = canonicalizeToolJson(input, state, `${subject} input`);
  return Object.freeze({ kind: 'toolCall' as const, callId, name, inputJson });
}

function snapshotToolResultPart(
  raw: vscode.LanguageModelToolResultPart,
  state: SnapshotState,
  subject: string,
): CanonicalToolResultPart {
  const callId = readHostProperty(raw, 'callId', subject);
  const contentValue = readHostProperty(raw, 'content', subject);
  assertBoundedString(callId, `${subject} call ID`, MAX_CALL_ID_BYTES, false);
  assertNotProxy(contentValue, `${subject} content`);
  const rawContent = readDenseArray(contentValue, `${subject} content`, MAX_PARTS - state.parts);
  state.parts += rawContent.length;
  if (state.parts > MAX_PARTS) throw snapshotLimitError();
  const content = rawContent.map((part, index): CanonicalToolResultContentPart => {
    const nestedSubject = `${subject} content ${index + 1}`;
    assertNotProxy(part, nestedSubject);
    if (part instanceof vscode.LanguageModelTextPart) return snapshotTextPart(part, nestedSubject, state);
    if (part instanceof vscode.LanguageModelDataPart) return snapshotDataPart(part, state, nestedSubject);
    try {
      return snapshotStructuralImagePart(part, state, nestedSubject);
    } catch (error) {
      if (error instanceof vscode.LanguageModelError && (
        error.message.includes('unsupported message part')
        || error.message.includes('unsupported prototype')
        || error.message.includes('invalid binary data')
        || error.message.includes('invalid MIME type')
      )) {
        throw new vscode.LanguageModelError(
          'An unsupported tool-result container cannot be inspected or sent safely. Return direct text or data parts instead.',
        );
      }
      throw error;
    }
  });
  return Object.freeze({ kind: 'toolResult' as const, callId, content: Object.freeze(content) });
}

function snapshotThinkingPart(raw: object, state: SnapshotState, subject: string): CanonicalThinkingPart {
  const value = readHostProperty(raw, 'value', subject);
  const id = readHostProperty(raw, 'id', subject);
  const metadata = readHostProperty(raw, 'metadata', subject);
  assertBoundedString(value, `${subject} thinking text`, MAX_TEXT_BYTES, true);
  consumeTextBudget(state, value);
  if (id !== undefined && id !== '') assertBoundedString(id, `${subject} thinking ID`, MAX_CALL_ID_BYTES, false);
  let encryptedContent: string | undefined;
  let deepSeekContent: string | undefined;
  const summary: CanonicalReasoningSummary[] = [];
  if (metadata !== undefined && metadata !== null) {
    assertHostRecord(metadata, `${subject} metadata`);
    const carried = readHostProperty(metadata, RESPONSES_REASONING_METADATA_KEY, `${subject} metadata`);
    if (carried !== undefined && carried !== null) {
      assertHostRecord(carried, `${subject} reasoning metadata`);
      const encrypted = readHostProperty(carried, 'encryptedContent', `${subject} reasoning metadata`);
      if (typeof encrypted === 'string' && encrypted) {
        assertBoundedString(encrypted, `${subject} encrypted reasoning`, MAX_TEXT_BYTES, false);
        consumeTextBudget(state, encrypted);
        encryptedContent = encrypted;
      }
      const rawSummary = readHostProperty(carried, 'summary', `${subject} reasoning metadata`);
      if (rawSummary !== undefined && rawSummary !== null) {
        assertNotProxy(rawSummary, `${subject} reasoning summary`);
        const entries = readDenseArray(rawSummary, `${subject} reasoning summary`, MAX_REASONING_SUMMARIES);
        for (const entry of entries) {
          assertHostRecord(entry, `${subject} reasoning summary entry`);
          const type = readHostProperty(entry, 'type', `${subject} reasoning summary entry`);
          const text = readHostProperty(entry, 'text', `${subject} reasoning summary entry`);
          if (type === 'summary_text' && typeof text === 'string') {
            assertBoundedString(text, `${subject} reasoning summary text`, MAX_TEXT_BYTES, true);
            consumeTextBudget(state, text);
            summary.push(Object.freeze({ type: 'summary_text', text }));
          }
        }
      }
    }
    const deepSeek = readHostProperty(metadata, DEEPSEEK_REASONING_METADATA_KEY, `${subject} metadata`);
    if (deepSeek !== undefined && deepSeek !== null) {
      assertHostRecord(deepSeek, `${subject} DeepSeek reasoning metadata`);
      const content = readHostProperty(deepSeek, 'content', `${subject} DeepSeek reasoning metadata`);
      if (typeof content === 'string' && content) {
        assertBoundedString(content, `${subject} DeepSeek reasoning content`, MAX_TEXT_BYTES, false);
        consumeTextBudget(state, content);
        deepSeekContent = content;
      }
    }
  }
  return Object.freeze({
    kind: 'thinking' as const,
    value,
    ...(id === undefined || id === '' ? {} : { id }),
    ...(encryptedContent === undefined ? {} : { encryptedContent }),
    ...(deepSeekContent === undefined ? {} : { deepSeekContent }),
    summary: Object.freeze(summary),
  });
}

function isThinkingPart(value: unknown): value is object {
  const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (...args: never[]) => object })
    .LanguageModelThinkingPart;
  return !!ThinkingPart && value instanceof ThinkingPart;
}

function canonicalizeToolJson(value: unknown, state: SnapshotState, subject: string): string {
  return snapshotStrictJson(value, state, subject, 'A cyclic tool input cannot be sent safely.').json;
}

function snapshotStrictJson(
  value: unknown,
  state: Pick<SnapshotState, 'jsonNodes' | 'jsonProperties' | 'toolJsonBytes'>,
  subject: string,
  cycleMessage: string,
): { readonly value: unknown; readonly json: string } {
  const active = new WeakSet<object>();
  let estimatedJsonBytes = 0;
  const consumeJsonBytes = (bytes: number): void => {
    estimatedJsonBytes += bytes;
    if (estimatedJsonBytes > MAX_TOOL_JSON_BYTES) throw snapshotLimitError();
  };
  const visit = (candidate: unknown, depth: number, path: string): unknown => {
    if (candidate === null) {
      consumeJsonBytes(4);
      return candidate;
    }
    if (typeof candidate === 'string') {
      assertBoundedString(candidate, path, MAX_TOOL_JSON_STRING_BYTES, true);
      consumeJsonBytes(jsonStringBytes(candidate));
      return candidate;
    }
    if (typeof candidate === 'boolean') {
      consumeJsonBytes(candidate ? 4 : 5);
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw unsupportedToolJsonError(path);
      consumeJsonBytes(Buffer.byteLength(JSON.stringify(candidate), 'utf8'));
      return candidate;
    }
    if (!candidate || typeof candidate !== 'object') throw unsupportedToolJsonError(path);
    assertNotProxy(candidate, path);
    if (active.has(candidate)) throw new vscode.LanguageModelError(cycleMessage);
    if (depth >= MAX_JSON_DEPTH) throw snapshotLimitError();
    state.jsonNodes += 1;
    if (state.jsonNodes > MAX_JSON_NODES) throw snapshotLimitError();
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const items = readDenseArray(candidate, path, MAX_JSON_NODES - state.jsonNodes);
        state.jsonProperties += items.length;
        if (state.jsonProperties > MAX_JSON_PROPERTIES) throw snapshotLimitError();
        consumeJsonBytes(2 + Math.max(0, items.length - 1));
        return Object.freeze(items.map((item, index) => visit(item, depth + 1, `${path}[${index}]`)));
      }
      assertPlainRecord(candidate, path);
      const keys = readOwnEnumerableKeys(candidate, path);
      state.jsonProperties += keys.length;
      if (state.jsonProperties > MAX_JSON_PROPERTIES) throw snapshotLimitError();
      consumeJsonBytes(2 + Math.max(0, keys.length - 1));
      const clone = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        assertBoundedString(key, `${path} property name`, MAX_TOOL_JSON_KEY_BYTES, true);
        consumeJsonBytes(jsonStringBytes(key) + 1);
        Object.defineProperty(clone, key, {
          value: visit(readOwnData(candidate, key, path), depth + 1, `${path}.${key}`),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(clone);
    } finally {
      active.delete(candidate);
    }
  };
  const snapshot = visit(value, 0, subject);
  const json = JSON.stringify(snapshot);
  const jsonBytes = Buffer.byteLength(json, 'utf8');
  if (jsonBytes > MAX_TOOL_JSON_BYTES) throw snapshotLimitError();
  state.toolJsonBytes += jsonBytes;
  if (state.toolJsonBytes > MAX_TOTAL_TOOL_JSON_BYTES) throw snapshotLimitError();
  return { value: snapshot, json };
}

function snapshotTools(value: unknown): readonly vscode.LanguageModelChatTool[] {
  assertNotProxy(value, 'The response tool list');
  const values = readDenseArray(value, 'The response tool list', MAX_TOOLS);
  const state = { jsonNodes: 0, jsonProperties: 0, toolJsonBytes: 0 };
  let definitionBytes = 2 + Math.max(0, values.length - 1);
  return Object.freeze(values.map((raw, index) => {
    const subject = `Tool definition ${index + 1}`;
    assertHostRecord(raw, subject);
    const name = readHostProperty(raw, 'name', subject);
    const description = readHostProperty(raw, 'description', subject) ?? '';
    const inputSchema = readHostProperty(raw, 'inputSchema', subject);
    assertBoundedString(name, `${subject} name`, MAX_TOOL_NAME_BYTES, false);
    assertBoundedString(description, `${subject} description`, MAX_TOOL_DESCRIPTION_BYTES, true);
    definitionBytes += jsonStringBytes(name) + jsonStringBytes(description) + 64;
    let canonicalSchema: object | undefined;
    if (inputSchema !== undefined && inputSchema !== null) {
      const result = snapshotStrictJson(
        inputSchema,
        state,
        `${subject} input schema`,
        'A cyclic tool input schema cannot be sent safely.',
      ).value;
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new vscode.LanguageModelError(`${subject} input schema must be a strict JSON object.`);
      }
      definitionBytes += Buffer.byteLength(JSON.stringify(result), 'utf8');
      canonicalSchema = result;
    }
    if (definitionBytes > MAX_TOTAL_TOOL_DEFINITION_BYTES) throw snapshotLimitError();
    return Object.freeze({
      name,
      description,
      ...(canonicalSchema === undefined ? {} : { inputSchema: canonicalSchema }),
    });
  }));
}

function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function snapshotSelectedModelOption(
  options: object,
  key: 'reasoningEffort' | 'contextWindow',
): unknown {
  for (const containerKey of ['modelOptions', 'modelConfiguration', 'configuration'] as const) {
    const container = readHostProperty(options, containerKey, 'The response options');
    if (container === undefined || container === null) continue;
    assertHostRecord(container, `The response options.${containerKey}`);
    const value = readHostProperty(container, key, `The response options.${containerKey}`);
    if (value === undefined || value === null) continue;
    // Only strings are consumed by the provider. An inert primitive preserves
    // the precedence of an invalid non-null value without retaining caller data.
    return typeof value === 'string' ? value : false;
  }
  return undefined;
}

function binaryByteLength(value: unknown, subject: string): number {
  assertNotProxy(value, `${subject} bytes`);
  if (typeof SharedArrayBuffer !== 'undefined' && utilTypes.isSharedArrayBuffer(value)) {
    throw new vscode.LanguageModelError(`${subject} uses shared binary memory and cannot be sent safely.`);
  }
  try {
    if (value instanceof Uint8Array) {
      return typedArrayByteLength(value);
    }
    if (value instanceof ArrayBuffer) {
      return arrayBufferByteLength(value);
    }
  } catch {
    throw new vscode.LanguageModelError(`${subject} binary data cannot be inspected safely.`);
  }
  throw new vscode.LanguageModelError(`${subject} has invalid binary data and cannot be sent safely.`);
}

function copyBytes(value: unknown, subject: string, expectedLength: number): Uint8Array {
  try {
    const copy = new Uint8Array(expectedLength);
    if (value instanceof Uint8Array) {
      Uint8Array.prototype.set.call(copy, value);
    } else {
      Uint8Array.prototype.set.call(copy, new Uint8Array(value as ArrayBuffer));
    }
    return copy;
  } catch {
    throw new vscode.LanguageModelError(`${subject} binary data cannot be copied safely.`);
  }
}

function readSingleAlias(record: object, names: readonly string[], subject: string): unknown {
  const present = names.filter((name) => Object.prototype.hasOwnProperty.call(record, name));
  if (present.length !== 1) throw unsupportedPartError(subject);
  return readOwnData(record, present[0], subject);
}

function readDenseArray(value: unknown, subject: string, maxLength: number): unknown[] {
  if (!Array.isArray(value)) throw new vscode.LanguageModelError(`${subject} must be an array and cannot be sent safely.`);
  assertNotProxy(value, subject);
  const length = (value as unknown[]).length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) throw snapshotLimitError();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new vscode.LanguageModelError(`${subject} contains a sparse entry and cannot be sent safely.`);
    }
    result.push(readHostProperty(value, String(index), subject));
  }
  return result;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;

function typedArrayByteLength(value: Uint8Array): number {
  if (!typedArrayByteLengthGetter) throw new TypeError('Typed array byteLength getter unavailable');
  if (!typedArrayBufferGetter) throw new TypeError('Typed array buffer getter unavailable');
  const buffer = typedArrayBufferGetter.call(value) as ArrayBufferLike;
  if (typeof SharedArrayBuffer !== 'undefined' && utilTypes.isSharedArrayBuffer(buffer)) {
    throw new TypeError('Shared typed-array backing is unsupported');
  }
  return typedArrayByteLengthGetter.call(value) as number;
}

function arrayBufferByteLength(value: ArrayBuffer): number {
  if (!arrayBufferByteLengthGetter) throw new TypeError('ArrayBuffer byteLength getter unavailable');
  return arrayBufferByteLengthGetter.call(value) as number;
}

function consumeTextBudget(state: SnapshotState, value: string): void {
  state.textBytes += Buffer.byteLength(value, 'utf8');
  if (state.textBytes > MAX_TOTAL_TEXT_BYTES) throw snapshotLimitError();
}

function readOwnEnumerableKeys(record: object, subject: string): string[] {
  assertNotProxy(record, subject);
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(record);
  } catch {
    throw new vscode.LanguageModelError(`${subject} is dynamic and cannot be inspected safely.`);
  }
  const keys: string[] = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor)) throw new vscode.LanguageModelError(`${subject} contains an accessor and cannot be sent safely.`);
    keys.push(key);
  }
  return keys;
}

function readOwnData(record: unknown, key: string, subject: string): unknown {
  if (!record || typeof record !== 'object') throw new vscode.LanguageModelError(`${subject} is invalid and cannot be sent safely.`);
  assertNotProxy(record, subject);
  const descriptor = safeDescriptor(record, key, subject);
  if (!descriptor || !('value' in descriptor)) {
    throw new vscode.LanguageModelError(`${subject}.${key} must be a direct data property and cannot be sent safely.`);
  }
  return descriptor.value;
}

// The extension host revives request objects as class instances whose fields are prototype
// accessors, so each property is read exactly once here and immediately snapshotted; that single
// read is what prevents a later value from differing, and Proxies are still rejected outright.
function readHostProperty(record: unknown, key: string, subject: string): unknown {
  if (!record || typeof record !== 'object') throw new vscode.LanguageModelError(`${subject} is invalid and cannot be sent safely.`);
  assertNotProxy(record, subject);
  try {
    return (record as Record<string, unknown>)[key];
  } catch {
    throw new vscode.LanguageModelError(`${subject}.${key} cannot be read safely.`);
  }
}

function safeDescriptor(record: object, key: string, subject: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(record, key);
  } catch {
    throw new vscode.LanguageModelError(`${subject} is dynamic and cannot be inspected safely.`);
  }
}

function assertRecordPrototype(value: unknown, subject: string): asserts value is object {
  if (!value || typeof value !== 'object') throw new vscode.LanguageModelError(`${subject} is invalid and cannot be sent safely.`);
  assertNotProxy(value, subject);
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new vscode.LanguageModelError(`${subject} is dynamic and cannot be inspected safely.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new vscode.LanguageModelError(`${subject} has an unsupported prototype and cannot be sent safely.`);
  }
}

// Host-supplied top-level containers (the request message array, response options) may legitimately
// be class instances from the extension host's own RPC revival, so only Proxies are rejected here;
// every property is still read via own-descriptor lookups, never through the prototype chain.
function assertHostRecord(value: unknown, subject: string): asserts value is object {
  if (!value || typeof value !== 'object') throw new vscode.LanguageModelError(`${subject} is invalid and cannot be sent safely.`);
  assertNotProxy(value, subject);
}

function assertPlainRecord(value: unknown, subject: string): asserts value is object {
  assertRecordPrototype(value, subject);
}

function assertNotProxy(value: unknown, subject: string): void {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
  try {
    if (utilTypes.isProxy(value)) throw new vscode.LanguageModelError(`${subject} is dynamic and cannot be sent safely.`);
  } catch (error) {
    if (error instanceof vscode.LanguageModelError) throw error;
    throw new vscode.LanguageModelError(`${subject} is dynamic and cannot be inspected safely.`);
  }
}

function assertBoundedString(
  value: unknown,
  subject: string,
  maxBytes: number,
  allowEmpty: boolean,
): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new vscode.LanguageModelError(`${subject} must be ${allowEmpty ? 'a string' : 'a non-empty string'} of at most ${maxBytes} UTF-8 bytes.`);
  }
}

function unsupportedPartError(subject: string): vscode.LanguageModelError {
  return new vscode.LanguageModelError(
    `${subject} is an unsupported message part and cannot be inspected or sent safely. Use direct text, data, tool call, or tool result parts.`,
  );
}

function unsupportedToolJsonError(subject: string): vscode.LanguageModelError {
  return new vscode.LanguageModelError(`${subject} is not strict JSON data and cannot be sent safely.`);
}

function snapshotLimitError(): vscode.LanguageModelError {
  return new vscode.LanguageModelError(
    'The message is too large or complex to snapshot safely. Reduce its size and try again.',
  );
}
