export interface RelayModel {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  name?: string;
  context_length?: number;
  context_window?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  capabilities?: Record<string, unknown>;
}

/** Wire protocol：上游请求使用的协议族。 */
export type ModelProtocol = 'openai' | 'claude';

/** 目录来源：模型来自 Relay 自动发现（`discovery`）还是用户固定配置（`configured`）。 */
export type CatalogSource = 'discovery' | 'configured';

/**
 * 目录分组 key：去重与快照按此维度隔离（同一 `upstreamId` 可在不同 route 共存）。
 * `chatgpt` 是历史遗留值，语义等价 `openai`。
 */
export type RouteKey = 'openai' | 'chatgpt' | 'claude';

/** OpenAI 协议族内部 API variant（仅当 `protocol === 'openai'` 时生效；`undefined` 等价 `'chat'`）。 */
export type OpenAIApiVariant = 'chat' | 'responses';

export interface RoutedModel extends RelayModel {
  /** Unique id exposed to VS Code. */
  pickerId: string;
  /** Model id sent unchanged to the relay. */
  upstreamId: string;
  /** Wire protocol：决定请求构造（Claude Messages / OpenAI 兼容）。 */
  protocol: ModelProtocol;
  /** 目录分组 key：去重与快照分组的维度，与 wire protocol 无关。 */
  route: RouteKey;
  /** 目录来源：discovery（Relay 自动发现）或 configured（用户固定配置）。 */
  catalogSource: CatalogSource;
  /** Probing result: Responses API support for OpenAI-compatible models. `undefined` means Chat Completions. */
  openaiApi?: OpenAIApiVariant;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
  thinking?: boolean;
  contextWindows?: number[];
  /** Explicit OpenAI request-field support. Unknown capabilities stay omitted. */
  openai?: OpenAIRequestCapabilities;
  /** Public catalog reference pricing. It is never used for relay billing. */
  referencePricing?: ReferencePricing;
  metadataSources?: ModelMetadataSources;
}

export interface ModelMetadataSources {
  maxInputTokens?: ModelMetadataSource;
  maxOutputTokens?: ModelMetadataSource;
  toolCalling?: ModelMetadataSource;
  imageInput?: ModelMetadataSource;
  thinking?: ModelMetadataSource;
  contextWindows?: ModelMetadataSource;
  referencePricing?: ModelMetadataSource;
}

export interface ReferencePricing {
  readonly currencyCode: 'USD';
  readonly inputPer1M?: number;
  readonly outputPer1M?: number;
  readonly cacheHitPer1M?: number;
  readonly cacheCreationPer1M?: number;
}

export type ModelMetadataSource =
  | 'api'
  | 'openrouter';

export interface ModelsResponse {
  data?: RelayModel[];
}

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: {
        url: string;
        detail?: 'auto';
        media_type?: string;
      };
    };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: true;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'required';
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  context_window?: number;
  reasoning_effort?: ReasoningEffort;
  thinking?: { type: 'enabled' | 'disabled' };
  prompt_cache_key?: string;
  store?: false;
  parallel_tool_calls?: boolean;
  stream_options?: {
    include_usage: true;
  };
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OpenAIRequestCapabilities {
  /** Provider-specific Chat Completions request semantics. */
  dialect?: 'deepseek';
  /** Defaults to max_tokens for compatibility when sendMaxTokens is enabled. */
  tokenLimitField?: 'max_tokens' | 'max_completion_tokens' | 'omit';
  /** Relay-private request extension, never inferred from public context limits. */
  contextWindow?: boolean;
  promptCacheKey?: boolean;
  store?: boolean;
  strictTools?: boolean;
  parallelToolCalls?: boolean;
  /** DeepSeek-style thinking relays reject tool-call history unless `reasoning.content` is replayed, even without the `id` the spec expects. */
  replayReasoningContent?: boolean;
  /** Codex-style models degrade when replayed assistant messages drop their `phase`. */
  assistantPhase?: boolean;
  /**
   * Requests `include: ["reasoning.encrypted_content"]` and replays the returned reasoning items
   * verbatim (real `id` + encrypted payload) on later turns. Stateless: `store` stays disabled and
   * `previous_response_id` is never sent. Requires an endpoint that accepts the `include` field.
   */
  encryptedReasoning?: boolean;
  /**
   * Sends `reasoning.summary: "auto"` on the Responses API so the model streams a readable
   * summary of its thinking. Defaults to on for Responses requests; set `false` when the
   * endpoint rejects the field or the account has no summary access.
   */
  reasoningSummary?: boolean;
  developerRole?: boolean;
  clientRequestId?: boolean;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
}

export interface StreamChunk {
  usage?: OpenAIUsage;
  error?: {
    type?: string;
    code?: string;
    message?: string;
    request_id?: string;
  };
  choices?: Array<{
    delta?: {
      content?: string | null;
      refusal?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

export interface OpenAIFullResponse extends StreamChunk {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }> | null;
      refusal?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string | null;
  }>;
}

// OpenAI Responses API protocol types. Kept separate from Chat Completions so
// that request construction, SSE event parsing, and usage mapping stay
// independent per protocol.

export type ResponsesInputItem =
  | {
      role: 'user' | 'assistant';
      content: string | ResponsesInputContentPart[];
      phase?: 'commentary' | 'final_answer';
    }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | {
      type: 'reasoning';
      /** The id of the response that produced this item; required for a spec-compliant replay. */
      id?: string;
      content?: { type: 'reasoning_text'; text: string }[];
      summary: { type: 'summary_text'; text: string }[];
      /** Opaque server-encrypted reasoning, replayed verbatim so stateless requests keep real reasoning. */
      encrypted_content?: string;
    };

export type ResponsesInputContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' };

export interface ResponsesToolDefinition {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: true;
}

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  stream: boolean;
  tools?: ResponsesToolDefinition[];
  tool_choice?: 'auto' | 'required' | 'none';
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning?: { effort?: ReasoningEffort; summary?: 'auto' | 'disabled' };
  store?: false;
  parallel_tool_calls?: boolean;
  /** Cache-affinity routing hint; same semantics as the Chat Completions field. */
  prompt_cache_key?: string;
  /** Extra fields to include on output items, e.g. `["reasoning.encrypted_content"]`. */
  include?: string[];
  text?: { format?: { type: 'text' } };
  truncation?: 'auto';
}

export interface ResponsesUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
}

export interface ResponsesMessageOutputContentPart {
  type: 'output_text' | 'refusal';
  text?: string;
  refusal?: string;
}

export interface ResponsesOutputItemMessage {
  id?: string;
  type: 'message';
  role?: 'assistant';
  status?: string;
  content?: ResponsesMessageOutputContentPart[];
}

export interface ResponsesOutputItemFunctionCall {
  id?: string;
  type: 'function_call';
  call_id?: string;
  name: string;
  arguments: string;
  status?: string;
}

export interface ResponsesOutputItemReasoning {
  id?: string;
  type: 'reasoning';
  summary?: Array<{ type: 'summary_text'; text: string }>;
  content?: Array<{ type: 'reasoning_text'; text: string }>;
  /** Server-side encrypted reasoning content; opaque to the client, only returned when `include: ["reasoning.encrypted_content"]` is set. */
  encrypted_content?: string;
}

export type ResponsesOutputItem =
  | ResponsesOutputItemMessage
  | ResponsesOutputItemFunctionCall
  | ResponsesOutputItemReasoning;

export interface ResponsesFullResponse {
  id?: string;
  object?: string;
  status?: 'completed' | 'failed' | 'in_progress' | 'incomplete' | 'cancelled';
  error?: { code?: string; message?: string; param?: string; type?: string };
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
}

export interface ResponsesStreamEvent {
  type?: string;
  event_id?: string;
  response_id?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  /** Text delta for output_text/refusal/reasoning events. */
  delta?: string;
  /** Complete arguments for function_call_arguments.done events. */
  arguments?: string;
  item?: ResponsesOutputItem;
  response?: {
    id?: string;
    status?: ResponsesFullResponse['status'];
    error?: ResponsesFullResponse['error'];
    usage?: ResponsesUsage;
  };
  error?: { code?: string; message?: string; param?: string; type?: string };
  usage?: ResponsesUsage;
}

export interface ClaudeContentBlockText {
  type: 'text';
  text: string;
  cache_control?: ClaudeCacheControl;
}

export interface ClaudeContentBlockImage {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  cache_control?: ClaudeCacheControl;
}

export interface ClaudeContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  cache_control?: ClaudeCacheControl;
}

export interface ClaudeContentBlockToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  cache_control?: ClaudeCacheControl;
}

export type ClaudeContentBlock =
  | ClaudeContentBlockText
  | ClaudeContentBlockImage
  | ClaudeContentBlockToolUse
  | ClaudeContentBlockToolResult;

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

export interface ClaudeToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  cache_control?: ClaudeCacheControl;
}

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  messages: ClaudeMessage[];
  system?: string | ClaudeContentBlockText[];
  stream: boolean;
  tools?: ClaudeToolDefinition[];
  tool_choice?: { type: 'auto' | 'any' };
  temperature?: number;
  top_p?: number;
  thinking?: ClaudeThinking;
}

export interface ClaudeCacheControl {
  type: 'ephemeral';
  ttl?: '1h';
}

export interface ClaudeThinking {
  type: 'enabled';
  budget_tokens: number;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClaudeStreamEvent {
  type?: string;
  error?: {
    type?: string;
    code?: string;
    message?: string;
    request_id?: string;
  };
  message?: {
    id?: string;
    usage?: ClaudeUsage;
  };
  usage?: ClaudeUsage;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  index?: number;
  content?: Array<{
    type?: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
}

/** Protocol family used in diagnostics and error attribution. */
export type RelayProtocol = 'OpenAI' | 'Responses' | 'Claude';

export interface StreamCallbacks {
  onContent(text: string): void;
  onReasoning(text: string): void;
  onToolCall(toolCall: ToolCall): void;
  /** Full reasoning output item captured from the stream (id, summary, encrypted_content). */
  onResponsesReasoningItem?(item: ResponsesOutputItemReasoning): void;
  /** Request metadata only; request bodies, URLs, and headers are never exposed. */
  onRequest?(protocol: RelayProtocol, metadata: RequestDiagnosticsMetadata): void;
  /** Transport state captured when fetch returns or rejects. */
  onRequestSettled?(protocol: RelayProtocol, metadata: RequestTransportDiagnosticsMetadata): void;
  onRefusal?(text: string): void;
  onOpenAIFinishReason?(reason: string): void;
  onOpenAIUsage?(usage: OpenAIUsage): void;
  onClaudeUsage?(usage: ClaudeUsage, responseId?: string): void;
  /** HTTP response metadata only; authentication headers and bodies are never exposed. */
  onResponse?(protocol: RelayProtocol, status: number, contentType: string, metadata?: ResponseDiagnosticsMetadata): void;
  onProcessingStarted?(protocol: RelayProtocol): void;
  /** Called only when the protocol's normal terminal event is received. */
  onStreamEnd?(protocol: RelayProtocol, terminalEvent: '[DONE]' | 'finish_reason' | 'message_stop' | 'completed' | 'incomplete'): void;
}

export interface RequestDiagnosticsMetadata {
  readonly clientRequestId: string;
  readonly bodyBytes: number;
  readonly clientRequestIdSent: boolean;
  readonly attempt: number;
  readonly stream: boolean;
}

export interface RequestTransportDiagnosticsMetadata {
  readonly clientRequestId: string;
  readonly responseReceived: boolean;
  readonly signalAborted: boolean;
  readonly abortSource: 'none' | 'vscode' | 'timeout';
  readonly tokenCancellationRequested: boolean;
}

export interface ResponseDiagnosticsMetadata {
  readonly requestId?: string;
  readonly clientRequestId?: string;
  readonly processingMs?: number;
  readonly rateLimitLimitRequests?: string;
  readonly rateLimitRemainingRequests?: string;
  readonly rateLimitResetRequests?: string;
  readonly rateLimitLimitTokens?: string;
  readonly rateLimitRemainingTokens?: string;
  readonly rateLimitResetTokens?: string;
  readonly retryAfter?: string;
}
