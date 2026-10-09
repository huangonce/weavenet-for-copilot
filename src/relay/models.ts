import type * as vscode from 'vscode';
import { normalizeClaudeRequestCapabilities } from '../config/config';
import type { ApiType, ConfiguredModel, ExtensionConfig } from '../config/config';
import { normalizeOpenAIRequestCapabilities } from './openaiCapabilities';
import type {
  ClaudeEffort,
  ModelMetadataSources,
  ReasoningEffort,
  RelayModel,
  RoutedModel,
} from './types';

export type PickerModelInformation = vscode.LanguageModelChatInformation & {
  readonly isBYOK: true;
  readonly isUserSelectable: boolean;
  readonly statusIcon?: vscode.ThemeIcon;
  readonly inputCost?: number;
  readonly outputCost?: number;
  readonly cacheCost?: number;
  readonly cacheWriteCost?: number;
  readonly pricing?: {
    readonly multiplier: number;
    readonly tokenPrices: {
      readonly inputPrice?: number;
      readonly outputPrice?: number;
      readonly cachePrice?: number;
      readonly cacheWritePrice?: number;
      readonly contextMax?: number;
    };
  };
  readonly priceCategory?: 'low' | 'medium' | 'high' | 'very_high';
  readonly configurationSchema?: object;
};

export function toChatInformation(
  model: RoutedModel,
  config: ExtensionConfig,
  hasApiKey: boolean,
  source?: { readonly name: string; readonly host?: string },
): PickerModelInformation {
  const protocolLabel = model.apiType === 'messages' ? 'Claude native' : 'OpenAI compatible';
  const budget = modelTokenBudget(model, config);
  return {
    id: model.pickerId || model.id,
    name: `${config.modelNamePrefix} ${model.name || model.upstreamId}`,
    family: model.apiType === 'messages' ? 'claude' : 'weavenet',
    version: model.upstreamId,
    detail: hasApiKey ? detailFor(model, source) : 'API key required',
    tooltip: hasApiKey ? buildTooltip(model, protocolLabel) : 'Run a WeaveNet key command first.',
    ...budget,
    isBYOK: true,
    isUserSelectable: true,
    capabilities: {
      toolCalling: supportsToolCallingForModel(model, config),
      imageInput: supportsImageInputForRoutedModel(model, config) || supportsVisionProxy(config),
    },
    ...toModelCostInfo(model),
    ...toConfigurationSchema(model),
  };
}

/** Never advertise input + output above a documented shared context window. */
export function modelTokenBudget(model: RoutedModel, config: ExtensionConfig): { maxInputTokens: number; maxOutputTokens: number } {
  const positive = (value: number | undefined, fallback: number) => Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
  // Old OpenRouter-enriched snapshots stored the total window as maxInputTokens.
  const legacyWindow = model.metadataSources?.maxInputTokens === 'openrouter' ? model.maxInputTokens : undefined;
  const total = positive(model.contextWindow ?? model.context_length ?? model.context_window ?? legacyWindow, Infinity);
  if (total < 2) throw new Error('The model context window must allow at least one input and one output token.');
  const defaultOutput = positive(config.maxOutputTokens, 16_384);
  const maxOutputTokens = Math.min(positive(model.maxOutputTokens, defaultOutput), total - 1);
  const maxInputTokens = Math.min(positive(model.maxInputTokens, positive(config.maxInputTokens, 128_000)),
    positive(config.maxInputTokens, 128_000), total - maxOutputTokens);
  return { maxInputTokens, maxOutputTokens };
}

const LEGACY_REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function toConfigurationSchema(model: RoutedModel): { configurationSchema?: object } {
  const properties: Record<string, object> = {};
  if (model.thinking) {
    const efforts = model.apiType === 'messages' && model.claude?.thinkingMode === 'adaptive'
      ? model.claude.reasoningEfforts ?? ['low', 'medium', 'high', 'max']
      : model.apiType !== 'messages' && model.openai?.reasoningEfforts?.length
        ? model.openai.reasoningEfforts : LEGACY_REASONING_EFFORTS;
    properties.reasoningEffort = {
      type: 'string',
      title: '思考工作量',
      enum: efforts,
      enumItemLabels: efforts.map(reasoningEffortLabel),
      enumDescriptions: efforts.map(reasoningEffortDescription),
      default: (model.apiType === 'messages' ? model.claude?.defaultReasoningEffort : model.openai?.defaultReasoningEffort)
        ?? (efforts.includes('high') ? 'high' : efforts[0]),
      group: 'navigation',
    };
  }
  return Object.keys(properties).length > 0 ? { configurationSchema: { properties } } : {};
}

function reasoningEffortLabel(value: ReasoningEffort): string {
  return { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' }[value];
}

function reasoningEffortDescription(value: ReasoningEffort): string {
  return {
    none: 'Disable model reasoning when supported',
    minimal: 'Minimal reasoning for the lowest latency',
    low: 'Faster responses with less reasoning',
    medium: 'Balanced reasoning and speed',
    high: 'Greater reasoning depth but slower',
    xhigh: 'Extra reasoning depth for complex tasks',
    max: 'Maximum reasoning budget',
  }[value];
}

function detailFor(model: RoutedModel, source?: { readonly name: string; readonly host?: string }): string {
  const protocolLabel = model.apiType === 'messages' ? 'Claude native' : 'OpenAI compatible';
  const owner = model.owned_by ? `owned by ${model.owned_by}` : 'from your relay';
  const parts = [protocolLabel, owner];
  if (source) parts.push(`${source.name}${source.host ? ` (${source.host})` : ''}`);
  if (model.referencePricing) parts.push('public reference pricing');
  return parts.join(', ');
}

function buildTooltip(model: RoutedModel, protocolLabel: string): string {
  if (!model.referencePricing) return `${model.id} via ${protocolLabel}`;
  return `${model.id} via ${protocolLabel}\nPublic reference pricing from OpenRouter; your sub2api charge may differ.`;
}

function toModelCostInfo(model: RoutedModel): Pick<PickerModelInformation, 'inputCost' | 'outputCost' | 'cacheCost' | 'cacheWriteCost' | 'priceCategory' | 'pricing'> {
  const pricing = model.referencePricing;
  if (!pricing) return {};
  return {
    // VS Code expects numeric costs per million tokens. Strings such as "$5.00"
    // are accepted by the extension host but render as "Unknown" in the picker.
    inputCost: pricing.inputPer1M,
    outputCost: pricing.outputPer1M,
    cacheCost: pricing.cacheHitPer1M,
    cacheWriteCost: pricing.cacheCreationPer1M,
    pricing: {
      multiplier: 1,
      tokenPrices: {
        inputPrice: pricing.inputPer1M,
        outputPrice: pricing.outputPer1M,
        cachePrice: pricing.cacheHitPer1M,
        cacheWritePrice: pricing.cacheCreationPer1M,
        contextMax: model.contextWindow ?? model.maxInputTokens,
      },
    },
    priceCategory: priceCategory(pricing.outputPer1M),
  };
}

function priceCategory(value: number | undefined): 'low' | 'medium' | 'high' | 'very_high' | undefined {
  if (value === undefined) return undefined;
  if (value <= 2) return 'low';
  if (value <= 10) return 'medium';
  if (value <= 30) return 'high';
  return 'very_high';
}

export function supportsImageInputForModel(modelId: string, config: ExtensionConfig): boolean {
  if (config.disabledImageInputModels.some((regex) => regex.test(modelId))) return false;
  return config.imageInputModels.some((regex) => regex.test(modelId)) || config.supportsImageInput;
}

export function supportsImageInputForRoutedModel(model: RoutedModel, config: ExtensionConfig): boolean {
  if (config.disabledImageInputModels.some((regex) => regex.test(model.id))) return false;
  return model.imageInput ?? supportsImageInputForModel(model.id, config);
}

export function supportsVisionProxy(config: Pick<ExtensionConfig, 'visionProxyEnabled' | 'visionProxyModel'>): boolean {
  return config.visionProxyEnabled && /^[^/\s]+\/[^\s]+$/.test(config.visionProxyModel);
}

export function supportsToolCallingForModel(model: RoutedModel, config: ExtensionConfig): boolean {
  return config.supportsToolCalling && model.toolCalling === true;
}

export function toRoutedModel(
  model: RelayModel,
  apiType: ApiType,
): RoutedModel {
  const record = model as unknown as Record<string, unknown>;
  const capabilities = objectFrom(model.capabilities);
  const openai = normalizeOpenAIRequestCapabilities(
    capabilities.openai ?? record.openai ?? record.openai_request_capabilities,
  );
  const contextWindow = numberFrom(model.context_length, model.context_window, record.contextWindow);
  const maxInputTokens = numberFrom(record.max_input_tokens, record.maxInputTokens);
  const maxOutputTokens = numberFrom(model.max_completion_tokens, model.max_output_tokens, record.max_tokens);
  const imageInput = booleanFrom(
    capabilities.vision,
    typeof capabilities.image_input === 'object' ? objectFrom(capabilities.image_input).supported : capabilities.image_input,
    capabilities.imageInput,
    capabilities.multimodal,
    capabilities.multi_modal,
    record.vision,
    record.image_input,
  );
  const toolCalling = booleanFrom(
    capabilities.tool_calling,
    capabilities.tools,
    capabilities.function_calling,
    record.tool_calling,
  );
  const nativeThinking = objectFrom(capabilities.thinking);
  const manualThinking = nativeThinking.supported === false ? false : objectFrom(objectFrom(nativeThinking.types).enabled).supported;
  const adaptiveThinking = objectFrom(objectFrom(nativeThinking.types).adaptive).supported;
  const declaredClaude = normalizeClaudeRequestCapabilities(capabilities.claude ?? record.claude);
  const effortSupport = objectFrom(capabilities.effort);
  const nativeEfforts = (['low', 'medium', 'high', 'xhigh', 'max'] as ClaudeEffort[])
    .filter((level) => objectFrom(effortSupport[level]).supported === true);
  const inferredClaude = apiType === 'messages' && (adaptiveThinking === true || manualThinking === true)
    ? { sampling: manualThinking === true, forcedToolChoice: manualThinking === true, thinkingMode: adaptiveThinking === true ? 'adaptive' as const : 'manual' as const,
      reasoningEfforts: nativeEfforts.length ? nativeEfforts : undefined } : undefined;
  const claude = inferredClaude || declaredClaude ? { ...inferredClaude,
    ...Object.fromEntries(Object.entries(declaredClaude ?? {}).filter(([, value]) => value !== undefined)) } : undefined;
  const thinking = booleanFrom(apiType === 'messages' && adaptiveThinking === true ? true : undefined, apiType === 'messages' ? manualThinking : undefined,
    capabilities.reasoning, capabilities.thinking, apiType !== 'messages' ? nativeThinking.supported : undefined, record.reasoning);
  const metadataSources: ModelMetadataSources = {
    contextWindow: contextWindow === undefined ? undefined : 'api',
    maxInputTokens: maxInputTokens === undefined ? undefined : 'api',
    maxOutputTokens: maxOutputTokens === undefined ? undefined : 'api',
    imageInput: imageInput === undefined ? undefined : 'api',
    toolCalling: toolCalling === undefined ? undefined : 'api',
    thinking: thinking === undefined ? undefined : 'api',
  };

  return {
    id: model.id,
    object: model.object,
    owned_by: model.owned_by,
    created: model.created,
    display_name: model.display_name,
    max_input_tokens: model.max_input_tokens,
    max_tokens: model.max_tokens,
    context_length: model.context_length,
    context_window: model.context_window,
    max_completion_tokens: model.max_completion_tokens,
    max_output_tokens: model.max_output_tokens,
    capabilities: model.capabilities,
    name: model.name ?? (typeof record.display_name === 'string' ? record.display_name : undefined),
    pickerId: model.id,
    upstreamId: model.id,
    apiType,
    catalogSource: 'discovery',
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    imageInput,
    toolCalling,
    thinking,
    openai,
    claude,
    metadataSources,
  };
}

/** Fixed declarations inherit the connection API unless explicitly overridden. */
export function fromConfiguredModel(model: ConfiguredModel, defaultApiType: ApiType = 'chat-completions'): RoutedModel {
  const apiType = model.apiType ?? defaultApiType;
  return {
    id: model.id,
    pickerId: model.id,
    upstreamId: model.id,
    name: model.name,
    apiType,
    catalogSource: 'configured',
    contextWindow: model.contextWindow,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    toolCalling: model.toolCalling,
    imageInput: model.imageInput,
    thinking: model.thinking,
    openai: model.openai,
    claude: model.claude,
    metadataSources: {},
  };
}

/** Adds a protocol suffix only when two routes expose the same upstream id. */
export function assignUniquePickerIds(models: RoutedModel[]): RoutedModel[] {
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.upstreamId, (counts.get(model.upstreamId) ?? 0) + 1);
  const used = new Set<string>();
  return models.map((model) => {
    const base = (counts.get(model.upstreamId) ?? 0) > 1
      ? `${model.upstreamId}::${model.apiType}`
      : model.upstreamId;
    let pickerId = base;
    let suffix = 2;
    while (used.has(pickerId)) pickerId = `${base}::${suffix++}`;
    used.add(pickerId);
    return { ...model, pickerId };
  });
}

export function filterModels(
  models: RoutedModel[],
  config: ExtensionConfig,
  apiType?: ApiType,
): RoutedModel[] {
  return models
    .filter((model) => model.id)
    .filter((model) => !apiType || model.apiType === apiType)
    .filter((model) =>
      config.includeModels.length === 0 || config.includeModels.some((regex) => regex.test(model.id)),
    )
    .filter((model) => !config.excludeModels.some((regex) => regex.test(model.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function objectFrom(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function numberFrom(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function booleanFrom(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}
