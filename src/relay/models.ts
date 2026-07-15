import * as vscode from 'vscode';
import type { ConfiguredModel, ExtensionConfig } from '../config/config';
import { enrichModelsWithOpenRouter } from '../metadata/openrouterFallback';
import type { ModelMetadataSources, ModelProtocol, ReasoningEffort, RelayModel, RoutedModel } from './types';

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
): PickerModelInformation {
  const owner = model.owned_by ? `owned by ${model.owned_by}` : 'from your relay';
  const protocolLabel = model.protocol === 'claude' ? 'Claude native' : 'OpenAI compatible';
  return {
    id: model.pickerId || model.id,
    name: `${config.modelNamePrefix} ${model.name || model.upstreamId}`,
    family: model.protocol === 'claude' ? 'claude' : 'weavenet',
    version: model.upstreamId,
    detail: hasApiKey ? `${protocolLabel}, ${owner}${model.referencePricing ? ', public reference pricing' : ''}` : 'API key required',
    tooltip: hasApiKey ? buildTooltip(model, protocolLabel) : 'Run a WeaveNet key command first.',
    maxInputTokens: Math.min(model.maxInputTokens ?? config.maxInputTokens, config.maxInputTokens),
    maxOutputTokens: model.maxOutputTokens ?? config.maxOutputTokens,
    isBYOK: true,
    isUserSelectable: true,
    statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
    capabilities: {
      toolCalling: supportsToolCallingForModel(model, config),
      imageInput: supportsImageInputForRoutedModel(model, config),
    },
    ...toModelCostInfo(model),
    ...toConfigurationSchema(model),
  };
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function toConfigurationSchema(model: RoutedModel): { configurationSchema?: object } {
  const properties: Record<string, object> = {};
  if (model.thinking) {
    properties.reasoningEffort = {
      type: 'string',
      title: '思考工作量',
      enum: REASONING_EFFORTS,
      enumItemLabels: ['Low', 'Medium', 'High', 'Extra High', 'Max'],
      enumDescriptions: [
        'Faster responses with less reasoning',
        'Balanced reasoning and speed',
        'Greater reasoning depth but slower',
        'Extra reasoning depth for complex tasks',
        'Maximum reasoning budget',
      ],
      default: 'high',
      group: 'navigation',
    };
  }
  if (model.contextWindows?.length) {
    properties.contextWindow = {
      type: 'string',
      title: '上下文大小',
      enum: ['default', ...model.contextWindows.map(String)],
      enumItemLabels: ['Default', ...model.contextWindows.map(formatContextWindow)],
      enumDescriptions: ['Use the provider default context budget', ...model.contextWindows.map((value) => `${formatContextWindow(value)} context budget`)],
      default: model.contextWindows.at(-1)?.toString() ?? 'default',
      group: 'navigation',
    };
  }
  return Object.keys(properties).length > 0 ? { configurationSchema: { properties } } : {};
}

function formatContextWindow(value: number): string {
  return value >= 1_000_000 ? `${value / 1_000_000}M` : `${Math.round(value / 1000)}K`;
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
        contextMax: model.maxInputTokens,
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
  return supportsImageInputForModel(model.id, config) || model.imageInput === true;
}

export function supportsToolCallingForModel(model: RoutedModel, config: ExtensionConfig): boolean {
  return config.supportsToolCalling && model.toolCalling === true;
}

export function enrichModelsWithMetadata(models: RoutedModel[]): RoutedModel[] {
  return enrichModelsWithOpenRouter(models);
}

export function toRoutedModel(
  model: RelayModel,
  protocol: ModelProtocol,
  route: RoutedModel['route'] = protocol === 'claude' ? 'claude' : 'openai',
): RoutedModel {
  const record = model as unknown as Record<string, unknown>;
  const capabilities = objectFrom(model.capabilities);
  const maxInputTokens = numberFrom(model.context_length, model.context_window, record.max_input_tokens);
  const maxOutputTokens = numberFrom(model.max_completion_tokens, model.max_output_tokens, record.max_tokens);
  const imageInput = booleanFrom(
    capabilities.vision,
    capabilities.image_input,
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
  const thinking = booleanFrom(capabilities.reasoning, capabilities.thinking, record.reasoning);
  const metadataSources: ModelMetadataSources = {
    maxInputTokens: maxInputTokens === undefined ? undefined : 'api',
    maxOutputTokens: maxOutputTokens === undefined ? undefined : 'api',
    imageInput: imageInput === undefined ? undefined : 'api',
    toolCalling: toolCalling === undefined ? undefined : 'api',
    thinking: thinking === undefined ? undefined : 'api',
  };

  return {
    ...model,
    pickerId: model.id,
    upstreamId: model.id,
    protocol,
    route,
    maxInputTokens,
    maxOutputTokens,
    imageInput,
    toolCalling,
    thinking,
    metadataSources,
  };
}

export function fromConfiguredModel(model: ConfiguredModel): RoutedModel {
  const protocol: ModelProtocol = model.route === 'claude' ? 'claude' : 'openai';
  return {
    id: model.id,
    pickerId: model.id,
    upstreamId: model.id,
    name: model.name,
    protocol,
    route: model.route,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    toolCalling: model.toolCalling,
    imageInput: model.imageInput,
    thinking: model.thinking,
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
      ? `${model.upstreamId}::${model.route}`
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
  protocol?: ModelProtocol,
): RoutedModel[] {
  return models
    .filter((model) => model.id)
    .filter((model) => !protocol || model.protocol === protocol)
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
    if (typeof value === 'number' && Number.isFinite(value)) {
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
