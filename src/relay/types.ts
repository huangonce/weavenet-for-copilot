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

export type ModelProtocol = 'openai' | 'claude';

export interface RoutedModel extends RelayModel {
  /** Unique id exposed to VS Code. */
  pickerId: string;
  /** Model id sent unchanged to the relay. */
  upstreamId: string;
  protocol: ModelProtocol;
  route: 'openai' | 'chatgpt' | 'claude';
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
  thinking?: boolean;
  contextWindows?: number[];
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
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
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
  temperature?: number;
  top_p?: number;
  context_window?: number;
  reasoning_effort?: ReasoningEffort;
  prompt_cache_key?: string;
  stream_options?: {
    include_usage: true;
  };
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
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
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string | null;
  }>;
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
