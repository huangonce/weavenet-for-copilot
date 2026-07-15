import type { CancellationToken } from 'vscode';
import type {
  ChatRequest,
  ClaudeRequest,
  ClaudeUsage,
  ModelsResponse,
  OpenAIUsage,
  ToolCall,
} from './types';
import { streamClaudeMessages } from './claude';
import { fetchJsonWithRetry } from './http';
import { streamOpenAIChatCompletion } from './openai';

export interface RelayClientOptions {
  baseUrl: string;
  apiKey: string;
  requestHeaders: Record<string, string>;
  authScheme?: 'bearer' | 'x-api-key';
  anthropicVersion?: string;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

export interface StreamCallbacks {
  onContent(text: string): void;
  onReasoning(text: string): void;
  onToolCall(toolCall: ToolCall): void;
  onOpenAIUsage?(usage: OpenAIUsage): void;
  onClaudeUsage?(usage: ClaudeUsage, responseId?: string): void;
  /** HTTP response metadata only; authentication headers and bodies are never exposed. */
  onResponse?(protocol: 'OpenAI' | 'Claude', status: number, contentType: string): void;
  onProcessingStarted?(protocol: 'OpenAI' | 'Claude'): void;
  /** Called only when the protocol's normal terminal event is received. */
  onStreamEnd?(protocol: 'OpenAI' | 'Claude', terminalEvent: '[DONE]' | 'finish_reason' | 'message_stop'): void;
}

export class RelayClient {
  constructor(private readonly options: RelayClientOptions) {}

  async listModels(token?: CancellationToken): Promise<ModelsResponse> {
    const response = await fetchJsonWithRetry<ModelsResponse>(`${this.options.baseUrl}/models`, {
      headers: this.headers(),
    }, this.options.requestTimeoutMs, token);
    if (response.data !== undefined && (!Array.isArray(response.data) || response.data.length > 10_000)) {
      throw new Error('Relay model catalog has an invalid or excessive data array.');
    }
    return response;
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
    if (this.options.authScheme === 'x-api-key') {
      return {
        ...this.options.requestHeaders,
        'x-api-key': this.options.apiKey,
      };
    }

    return {
      ...this.options.requestHeaders,
      Authorization: `Bearer ${this.options.apiKey}`,
    };
  }
}
