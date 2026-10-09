import type { CancellationToken } from 'vscode';
import type {
  ChatRequest,
  ClaudeRequest,
  ModelsResponse,
  ResponsesRequest,
  StreamCallbacks,
} from './types';
import { streamClaudeMessages } from './claude';
import { canonicalRelayHeaders } from './headers';
import { fetchJsonWithRetryMetadata } from './http';
import { streamOpenAIChatCompletion } from './openai';
import { streamOpenAIResponses } from './openaiResponses';
import {
  probeClaudeMessages,
  probeOpenAIChatCompletion,
  probeOpenAIResponses,
} from './probes';
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
  readonly endpoint: '/models' | '/chat/completions' | '/responses' | '/messages';
  readonly status: number;
  readonly responseType: string;
  readonly requestId?: string;
  readonly stream?: boolean;
  readonly termination?: '[DONE]' | 'finish_reason' | 'message_stop' | 'completed' | 'incomplete';
}

export class RelayClient {
  constructor(private readonly options: RelayClientOptions) {}

  async listModels(token?: CancellationToken): Promise<ModelsResponse> {
    return (await this.readCatalog(token)).value;
  }

  async testModels(token?: CancellationToken): Promise<{ models: ModelsResponse; diagnostic: RelayEndpointTestResult }> {
    const response = await this.readCatalog(token);
    return {
      models: response.value,
      diagnostic: { endpoint: '/models', status: response.status, responseType: response.contentType, requestId: response.requestId },
    };
  }

  async testOpenAIChatCompletion(model: string, stream = false, token?: CancellationToken, tokenLimitField: 'max_tokens' | 'max_completion_tokens' = 'max_tokens'): Promise<RelayProtocolProbeResult> {
    return probeOpenAIChatCompletion({
      baseUrl: this.options.baseUrl,
      headers: this.headersFor('bearer'),
      requestTimeoutMs: this.options.requestTimeoutMs,
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
    }, model, stream, token, tokenLimitField);
  }

  async testOpenAIResponses(model: string, stream = false, token?: CancellationToken): Promise<RelayProtocolProbeResult> {
    return probeOpenAIResponses({
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

  async streamResponses(
    request: ResponsesRequest,
    callbacks: StreamCallbacks,
    token?: CancellationToken,
    sendClientRequestId = false,
  ): Promise<void> {
    await streamOpenAIResponses({
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
    for (const [key, value] of canonicalRelayHeaders(this.options.requestHeaders)) headers.set(key, value);
    if (authScheme === 'x-api-key') {
      headers.set('x-api-key', this.options.apiKey);
      headers.set('anthropic-version', this.options.anthropicVersion ?? '2023-06-01');
      return Object.fromEntries(headers.entries());
    }

    headers.set('authorization', `Bearer ${this.options.apiKey}`);
    return Object.fromEntries(headers.entries());
  }

  private async readCatalog(token?: CancellationToken) {
    const first = await fetchJsonWithRetryMetadata<ModelsResponse>(this.endpoint('models'), {
      headers: this.headers(),
    }, this.options.requestTimeoutMs, token);
    validateModelCatalog(first.value);
    let page = first.value;
    const data = [...(page.data ?? [])];
    let bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
    const cursors = new Set<string>();
    let pages = 1;
    while (page.has_more === true) {
      if (token?.isCancellationRequested) {
        const error = new Error('Model discovery cancelled.'); error.name = 'AbortError'; throw error;
      }
      const cursor = page.last_id;
      if (typeof cursor !== 'string' || !cursor || cursor.length > 512 || cursors.has(cursor) || !page.data?.length || ++pages > 100) {
        throw new Error('Relay model pagination contains an invalid or repeated cursor.');
      }
      cursors.add(cursor);
      // Build a cursor on this same endpoint; never follow an upstream-provided URL with credentials.
      const url = new URL(this.endpoint('models'));
      url.searchParams.set('after_id', cursor);
      url.searchParams.set('limit', '1000');
      const response = await fetchJsonWithRetryMetadata<ModelsResponse>(url.toString(), {
        headers: this.headers(),
      }, this.options.requestTimeoutMs, token);
      validateModelCatalog(response.value);
      page = response.value;
      bytes += Buffer.byteLength(JSON.stringify(page.data), 'utf8');
      if (data.length + (page.data?.length ?? 0) > 10_000 || bytes > 10 * 1024 * 1024) {
        throw new Error('Relay model pagination exceeds the aggregate directory limit.');
      }
      data.push(...(page.data ?? []));
    }
    return { ...first, value: { data } as ModelsResponse };
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
