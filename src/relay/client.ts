import type { CancellationToken } from 'vscode';
import type {
  ChatRequest,
  ClaudeRequest,
  ModelsResponse,
  StreamCallbacks,
} from './types';
import { streamClaudeMessages } from './claude';
import { isReservedRelayHeader } from '../config/config';
import { fetchJsonWithRetry, fetchJsonWithRetryMetadata, fetchWithResponseTimeout, readResponseText, throwIfNotOk } from './http';
import { streamOpenAIChatCompletion } from './openai';
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
  readonly endpoint: '/models' | '/messages';
  readonly status: number;
  readonly responseType: string;
  readonly requestId?: string;
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

  async testClaudeMessages(model: string, token?: CancellationToken): Promise<RelayEndpointTestResult> {
    const response = await fetchWithResponseTimeout(this.endpoint('messages'), {
      method: 'POST',
      headers: {
        ...this.headersFor('x-api-key'),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-version': this.options.anthropicVersion ?? '2023-06-01',
      },
      // This intentional minimal, non-streaming request verifies the endpoint.
      // It may consume a minimal amount of provider quota.
      body: JSON.stringify({ model, max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'Reply OK.' }] }),
    }, this.options.requestTimeoutMs, token);
    const diagnostic = {
      endpoint: '/messages' as const,
      status: response.status,
      responseType: response.headers.get('content-type') ?? 'unknown',
      requestId: response.headers.get('x-request-id') ?? undefined,
    };
    await throwIfNotOk(response, this.options.streamIdleTimeoutMs, token);
    await readResponseText(response, this.options.streamIdleTimeoutMs, token);
    return diagnostic;
  }

  async streamChatCompletion(
    request: ChatRequest,
    callbacks: StreamCallbacks,
    token?: CancellationToken,
  ): Promise<void> {
    await streamOpenAIChatCompletion({
      baseUrl: this.options.baseUrl,
      headers: this.headers(),
      requestTimeoutMs: this.options.requestTimeoutMs,
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
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
