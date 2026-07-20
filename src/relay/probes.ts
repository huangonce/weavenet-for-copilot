import type { CancellationToken } from 'vscode';
import { processClaudeFullResponse, processClaudeStream } from './claude';
import { createIncompleteStreamError, createRelayStreamError } from './errors';
import {
  fetchWithResponseTimeout,
  safeResponseMetadata,
  throwIfNotOk,
} from './http';
import { processOpenAIFullResponse, processOpenAIStream } from './openai';
import type { StreamCallbacks } from './types';
import { relayEndpointUrl } from './url';

const MAX_PROBE_RESPONSE_BYTES = 256 * 1024;
const MAX_PROBE_EVENT_BYTES = 64 * 1024;

export interface RelayProtocolProbeResult {
  readonly endpoint: '/chat/completions' | '/messages';
  readonly status: number;
  readonly responseType: string;
  readonly requestId?: string;
  readonly stream: boolean;
  readonly termination?: '[DONE]' | 'finish_reason' | 'message_stop';
}

interface ProtocolProbeOptions {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly requestTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
}

interface ClaudeProbeOptions extends ProtocolProbeOptions {
  readonly anthropicVersion?: string;
}

export async function probeOpenAIChatCompletion(
  options: ProtocolProbeOptions,
  model: string,
  stream: boolean,
  token?: CancellationToken,
): Promise<RelayProtocolProbeResult> {
  const response = await fetchWithResponseTimeout(relayEndpointUrl(options.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: {
      ...options.headers,
      Accept: stream ? 'text/event-stream' : 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 1, stream, messages: [{ role: 'user', content: 'OK' }] }),
  }, options.requestTimeoutMs, token);
  const metadata = safeResponseMetadata(response);
  await throwIfNotOk(response, options.streamIdleTimeoutMs, token);
  const callbacks = emptyProbeCallbacks();
  if (!stream) {
    await processOpenAIFullResponse(response, callbacks, options.streamIdleTimeoutMs, token, MAX_PROBE_RESPONSE_BYTES);
    return { endpoint: '/chat/completions', ...metadata, stream: false, termination: 'finish_reason' };
  }
  requireEventStream(metadata.responseType, 'OpenAI');
  const outcome = await processOpenAIStream(response, callbacks, options.streamIdleTimeoutMs, token, MAX_PROBE_EVENT_BYTES);
  if (!outcome.terminal && !outcome.sawFinishReason) {
    throw createIncompleteStreamError('OpenAI', outcome.responseParts === 0 ? 'missing-terminal-empty-response' : 'missing-terminal-event');
  }
  return {
    endpoint: '/chat/completions',
    ...metadata,
    stream: true,
    termination: outcome.terminal ? '[DONE]' : 'finish_reason',
  };
}

export async function probeClaudeMessages(
  options: ClaudeProbeOptions,
  model: string,
  stream: boolean,
  token?: CancellationToken,
): Promise<RelayProtocolProbeResult> {
  const response = await fetchWithResponseTimeout(relayEndpointUrl(options.baseUrl, 'messages'), {
    method: 'POST',
    headers: {
      ...options.headers,
      Accept: stream ? 'text/event-stream' : 'application/json',
      'Content-Type': 'application/json',
      'anthropic-version': options.anthropicVersion ?? '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 1, stream, messages: [{ role: 'user', content: 'OK' }] }),
  }, options.requestTimeoutMs, token);
  const metadata = safeResponseMetadata(response);
  await throwIfNotOk(response, options.streamIdleTimeoutMs, token);
  const callbacks = emptyProbeCallbacks();
  if (!stream) {
    await processClaudeFullResponse(response, callbacks, options.streamIdleTimeoutMs, token, MAX_PROBE_RESPONSE_BYTES);
    return { endpoint: '/messages', ...metadata, stream: false, termination: 'message_stop' };
  }
  requireEventStream(metadata.responseType, 'Claude');
  const outcome = await processClaudeStream(response, callbacks, options.streamIdleTimeoutMs, token, MAX_PROBE_EVENT_BYTES);
  if (!outcome.terminal) {
    throw createIncompleteStreamError('Claude', outcome.parts === 0 ? 'missing-terminal-empty-response' : 'missing-terminal-event');
  }
  return { endpoint: '/messages', ...metadata, stream: true, termination: 'message_stop' };
}

function requireEventStream(contentType: string, protocol: 'OpenAI' | 'Claude'): void {
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    throw createRelayStreamError(protocol, 'streaming probe did not return text/event-stream');
  }
}

function emptyProbeCallbacks(): StreamCallbacks {
  return {
    onContent() {},
    onReasoning() {},
    onToolCall() {},
  };
}
