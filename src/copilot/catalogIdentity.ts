import { createHash, createHmac } from 'node:crypto';
import { getConfig } from '../config/config';
import type { ConnectionProfile, ExtensionConfig } from '../config/config';
import { canonicalRelayHeaders } from '../relay/headers';
import { normalizeRelayBaseUrl } from '../relay/url';

/**
 * Process-local equality token for catalog-affecting connection settings.
 * Bindings may retain it, but persisted artifacts must use the peppered
 * credential-bound identity below so low-entropy header values cannot be
 * guessed offline.
 */
export function catalogRevision(profile: ConnectionProfile): string {
  return hashCatalogIdentity(getConfig(profile));
}

/**
 * Credential-bound catalog identity used for persisted snapshots and probe
 * verdicts. An installation-local SecretStorage pepper keys the HMAC, so the
 * persisted digest exposes neither the API key nor an offline verifier for a
 * weak key.
 */
export function catalogArtifactRevision(
  config: ExtensionConfig,
  apiKey: string,
  pepper: string,
): string {
  return createHmac('sha256', pepper)
    .update('credential\0')
    .update(apiKey)
    .update('\0catalog\0')
    .update(canonicalCatalogIdentity(config))
    .digest('hex');
}

export function hashCatalogIdentity(config: ExtensionConfig): string {
  return createHash('sha256')
    .update(canonicalCatalogIdentity(config))
    .digest('hex');
}

function canonicalCatalogIdentity(config: ExtensionConfig): string {
  return JSON.stringify(stableValue({
    profileId: config.profileId,
    baseUrl: normalizeRelayBaseUrl(config.baseUrl) ?? config.baseUrl.trim(),
    openaiApiStrategy: config.openaiApiStrategy,
    requestHeaders: canonicalRelayHeaders(config.requestHeaders),
    includeModels: normalizedPatterns(config.includeModels),
    excludeModels: normalizedPatterns(config.excludeModels),
    // Declaration order is significant: later duplicate model declarations
    // participate in deterministic merge/veto behavior.
    models: config.models,
  }));
}

function normalizedPatterns(patterns: readonly RegExp[]): string[] {
  return [...new Set(patterns.map((pattern) => pattern.source))].sort();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}
