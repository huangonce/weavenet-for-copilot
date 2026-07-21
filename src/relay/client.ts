import type { CancellationToken } from 'vscode';
import type {
  ChatRequest,
  ClaudeRequest,
  ModelsResponse,
  StreamCallbacks,
} from './types';
import { streamClaudeMessages } from './claude';
import { isReservedRelayHeader } from '../config/config';
import { fetchJsonWithRetry, fetchJsonWithRetryMetadata } from './http';
import { streamOpenAIChatCompletion } from './openai';
import { probeClaudeMessages, probeOpenAIChatCompletion } from './probes';
import type { RelayProtocolProbeResult } from './probes';
import { relayEndpointUrl } from './url';

export interface RelayClientOptions {
  baseUrl: string;
  apiKey: string;
  requestHeaders: Record<string, string>;
  authScheme?: 'bearer' | 'x-api-key';
  anthropicVersion?: string;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

export interface RelayEndpointTestResult {
  readonly endpoint: '/models' | '/chat/completions' | '/messages';
  readonly status: number;
  readonly responseType: string;
  readonly requestId?: string;
  readonly stream?: boolean;
  readonly termination?: '[DONE]' | 'finish_reason' | 'message_stop';
}

export class RelayClient {
  constructor(private readonly options: RelayClientOptions) {}

  async listModels(token?: CancellationToken): Promise<ModelsResponse> {
    const response = await fetchJsonWithRetry<ModelsResponse>(this.endpoint('models'), {
      headers: this.headers(),
    }, this.options.requestTimeoutMs, token);
    validateModelCatalog(response);
    return response;
  }

  async testModels(token?: CancellationToken): Promise<{ models: ModelsResponse; diagnostic: RelayEndpointTestResult }> {
    const response = await fetchJsonWithRetryMetadata<ModelsResponse>(this.endpoint('models'), {
      headers: this.headers(),
    }, this.options.requestTimeoutMs, token);
    validateModelCatalog(response.value);
    return {
      models: response.value,
      diagnostic: { endpoint: '/models', status: response.status, responseType: response.contentType, requestId: response.requestId },
    };
  }

  async testOpenAIChatCompletion(model: string, stream = false, token?: CancellationToken): Promise<RelayProtocolProbeResult> {
    return probeOpenAIChatCompletion({
      baseUrl: this.options.baseUrl,
      headers: this.headersFor('bearer'),
      requestTimeoutMs: this.options.requestTimeoutMs,
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
    }, model, stream, token);
  }

  async testClaudeMessages(model: string, stream = false, token?: CancellationToken): Promise<RelayProtocolProbeResult> {
    return probeClaudeMessages({
      baseUrl: this.options.baseUrl,
      headers: this.headersFor('x-api-key'),
      anthropicVersion: this.options.anthropicVersion,
      requestTimeoutMs: this.options.requestTimeoutMs,
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
    }, model, stream, token);
  }

  async streamChatCompletion(
    request: ChatRequest,
    callbacks: StreamCallbacks,
    token?: CancellationToken,
    sendClientRequestId = false,
  ): Promise<void> {
    await streamOpenAIChatCompletion({
      baseUrl: this.options.baseUrl,
      headers: this.headers(),
      requestTimeoutMs: this.options.requestTimeoutMs,
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
      sendClientRequestId,
    }, request, callbacks, token);
  }

  async streamClaudeMessages(
    request: ClaudeRequest,
    callbacks: StreamCallbacks,
    token?: CancellationToken,
  ): Promise<void> {
    await streamClaudeMessages({
      baseUrl: this.options.baseUrl,
      headers: this.headers(),
      anthropicVersion: this.options.anthropicVersion,
      requestTimeoutMs: this.options.requestTimeoutMs,
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
    }, request, callbacks, token);
  }

  private headers(): Record<string, string> {
    return this.headersFor(this.options.authScheme ?? 'bearer');
  }

  private headersFor(authScheme: 'bearer' | 'x-api-key'): Record<string, string> {
    const headers = new Headers();
    for (const [key, value] of Object.entries(this.options.requestHeaders)) {
      if (isReservedRelayHeader(key)) continue;
      try {
        headers.set(key, value);
      } catch {
        // Ignore malformed user-provided headers from manually edited settings.
      }
    }
    if (authScheme === 'x-api-key') {
      headers.set('x-api-key', this.options.apiKey);
      return Object.fromEntries(headers.entries());
    }

    headers.set('authorization', `Bearer ${this.options.apiKey}`);
    return Object.fromEntries(headers.entries());
  }

  private endpoint(path: string): string {
    return relayEndpointUrl(this.options.baseUrl, path);
  }
}

function validateModelCatalog(response: ModelsResponse): void {
  if (!response || typeof response !== 'object' || (
    !Array.isArray(response.data)
    || response.data.length > 10_000
    || response.data.some((model) => !model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim())
  )) {
    throw new Error('Relay model catalog has an invalid or excessive data array.');
  }
}
