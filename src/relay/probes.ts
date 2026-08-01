import type { CancellationToken } from 'vscode';
import { processClaudeFullResponse, processClaudeStream } from './claude';
import { createIncompleteStreamError, createRelayStreamError } from './errors';
import {
  fetchWithResponseTimeout,
  safeResponseMetadata,
  throwIfNotOk,
} from './http';
import { processOpenAIFullResponse, processOpenAIStream } from './openai';
import { processResponsesFullResponse, processResponsesStream } from './openaiResponses';
import type { RelayProtocol, StreamCallbacks } from './types';
import { relayEndpointUrl } from './url';

const MAX_PROBE_RESPONSE_BYTES = 256 * 1024;
const MAX_PROBE_EVENT_BYTES = 64 * 1024;

export interface RelayProtocolProbeResult {
  readonly endpoint: '/chat/completions' | '/responses' | '/messages';
  readonly status: number;
  readonly responseType: string;
  readonly requestId?: string;
  readonly stream: boolean;
  readonly termination?: '[DONE]' | 'finish_reason' | 'message_stop' | 'completed' | 'incomplete';
}

export type ResponsesEndpointAvailability = 'supported' | 'unsupported' | 'unknown';

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

/**
 * Minimal `POST /responses` probe. Runs during model discovery and explicit
 * connection tests; each call is a paid request, so results are cached.
 */
export async function probeOpenAIResponses(
  options: ProtocolProbeOptions,
  model: string,
  stream: boolean,
  token?: CancellationToken,
): Promise<RelayProtocolProbeResult> {
  const response = await fetchWithResponseTimeout(relayEndpointUrl(options.baseUrl, 'responses'), {
    method: 'POST',
    headers: {
      ...options.headers,
      Accept: stream ? 'text/event-stream' : 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: 'OK' }],
      max_output_tokens: 1,
      stream,
      store: false,
    }),
  }, options.requestTimeoutMs, token);
  const metadata = safeResponseMetadata(response);
  await throwIfNotOk(response, options.streamIdleTimeoutMs, token);
  const callbacks = emptyProbeCallbacks();
  if (!stream) {
    // `max_output_tokens: 1` makes truncation the common case for tiny replies;
    // a valid envelope with zero visible parts (thinking consumed the budget)
    // still proves capability, so empty output is accepted.
    const termination = await processResponsesFullResponse(response, callbacks, options.streamIdleTimeoutMs, token, MAX_PROBE_RESPONSE_BYTES, true);
    return { endpoint: '/responses', ...metadata, stream: false, termination };
  }
  requireEventStream(metadata.responseType, 'Responses');
  const outcome = await processResponsesStream(response, callbacks, options.streamIdleTimeoutMs, token, MAX_PROBE_EVENT_BYTES);
  if (!outcome.terminal) {
    throw createIncompleteStreamError('Responses', outcome.parts === 0 ? 'missing-terminal-empty-response' : 'missing-terminal-event');
  }
  return { endpoint: '/responses', ...metadata, stream: true, termination: outcome.termination ?? 'completed' };
}

/**
 * Free `GET /responses` availability probe.
 *
 * - `200` → `supported`
 * - `405` → `supported` — the route exists but only accepts POST, which is
 *   exactly what the Responses API requires (GET is never part of the spec).
 * - `404` → `unsupported` — the relay does not implement the endpoint at all;
 *   every OpenAI model falls back to Chat Completions with zero cost.
 * - Anything else (auth errors, `426` upgrade demands, network failures) →
 *   `unknown`, and per-model POST probes decide. This GET carries no `model`,
 *   so gateways that route each model to a different upstream answer it from
 *   their default group only, and its verdict cannot be generalised.
 */
export async function probeResponsesEndpoint(
  options: ProtocolProbeOptions,
  token?: CancellationToken,
): Promise<ResponsesEndpointAvailability> {
  let response: Response;
  try {
    response = await fetchWithResponseTimeout(relayEndpointUrl(options.baseUrl, 'responses'), {
      method: 'GET',
      headers: options.headers,
    }, options.requestTimeoutMs, token);
  } catch {
    return 'unknown';
  }
  if (response.ok || response.status === 405) return 'supported';
  if (response.status === 404) return 'unsupported';
  return 'unknown';
}

function requireEventStream(contentType: string, protocol: RelayProtocol): void {
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
