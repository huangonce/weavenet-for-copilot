import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import type { ConnectionProfile } from '../config/config';
import { normalizeRelayBaseUrl } from '../relay/url';
import {
  CONNECTION_DIAGNOSTICS_KEY_PREFIX,
  CONNECTION_DIAGNOSTICS_SCHEMA_VERSION,
} from '../constants';
import type {
  ConnectionDiagnosticsSnapshot,
  ConnectionProbeId,
  ConnectionProbeResult,
  ConnectionProbeSkipReason,
  ConnectionProbeVerdict,
  ConnectionProtocolCapabilities,
} from './connectionDiagnostics';

const MAX_PERSISTED_STRING_LENGTH = 500;
const MAX_PROBES = 5;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const PROBE_IDS: readonly ConnectionProbeId[] = [
  'models',
  'openai.nonStreaming',
  'openai.streaming',
  'claude.nonStreaming',
  'claude.streaming',
];
const VERDICTS: readonly ConnectionProbeVerdict[] = ['supported', 'unsupported', 'indeterminate', 'skipped'];
const SKIP_REASONS: readonly ConnectionProbeSkipReason[] = ['modelsUnavailable', 'noOpenAIModel', 'noClaudeModel'];

export interface ConnectionFingerprintOptions {
  readonly anthropicVersion?: string;
}

export function fingerprintConnection(
  profile: ConnectionProfile,
  options: ConnectionFingerprintOptions = {},
): string {
  const headers = Object.entries(profile.requestHeaders ?? {})
    .map(([name, value]) => [name.trim().toLowerCase(), value] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
  const identity = {
    profileId: profile.id,
    name: profile.name.trim(),
    baseUrl: normalizeRelayBaseUrl(profile.baseUrl) ?? profile.baseUrl.trim(),
    requestHeaders: headers,
    includeModels: profile.includeModels ?? [],
    excludeModels: profile.excludeModels ?? [],
    models: profile.models ?? [],
    anthropicVersion: options.anthropicVersion?.trim() || '2023-06-01',
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export class ConnectionDiagnosticsStore {
  constructor(private readonly state: vscode.Memento) {}

  get(profile: ConnectionProfile, options: ConnectionFingerprintOptions = {}): ConnectionDiagnosticsSnapshot | undefined {
    return this.getByFingerprint(fingerprintConnection(profile, options));
  }

  getByFingerprint(fingerprint: string): ConnectionDiagnosticsSnapshot | undefined {
    return parseConnectionDiagnosticsSnapshot(this.state.get<unknown>(diagnosticsKey(fingerprint)), fingerprint);
  }

  async update(snapshot: ConnectionDiagnosticsSnapshot): Promise<void> {
    const parsed = parseConnectionDiagnosticsSnapshot(snapshot, snapshot.fingerprint);
    if (!parsed) throw new Error('Refusing to persist invalid connection diagnostics.');
    await this.state.update(diagnosticsKey(snapshot.fingerprint), parsed);
  }

  async delete(profile: ConnectionProfile, options: ConnectionFingerprintOptions = {}): Promise<void> {
    await this.deleteFingerprint(fingerprintConnection(profile, options));
  }

  async deleteFingerprint(fingerprint: string): Promise<void> {
    await this.state.update(diagnosticsKey(fingerprint), undefined);
  }

  async deleteProfile(profileId: string): Promise<void> {
    const updates: Thenable<void>[] = [];
    for (const key of this.state.keys()) {
      if (!key.startsWith(CONNECTION_DIAGNOSTICS_KEY_PREFIX)) continue;
      const fingerprint = key.slice(CONNECTION_DIAGNOSTICS_KEY_PREFIX.length);
      const snapshot = this.getByFingerprint(fingerprint);
      if (snapshot?.profileId === profileId) updates.push(this.state.update(key, undefined));
    }
    await Promise.all(updates);
  }

  async clear(): Promise<void> {
    await Promise.all(this.state.keys()
      .filter((key) => key.startsWith(CONNECTION_DIAGNOSTICS_KEY_PREFIX))
      .map((key) => this.state.update(key, undefined)));
  }
}

function diagnosticsKey(fingerprint: string): string {
  return `${CONNECTION_DIAGNOSTICS_KEY_PREFIX}${fingerprint}`;
}

export function parseConnectionDiagnosticsSnapshot(
  value: unknown,
  expectedFingerprint?: string,
  now = Date.now(),
): ConnectionDiagnosticsSnapshot | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== CONNECTION_DIAGNOSTICS_SCHEMA_VERSION
    || !isProfileId(value.profileId)
    || !isFingerprint(value.fingerprint)
    || (expectedFingerprint !== undefined && value.fingerprint !== expectedFingerprint)
    || !isSafeString(value.connectionName)
    || !isSafeString(value.host)
    || !isTimestamp(value.testedAt, now)
    || !isTimestamp(value.completedAt, now)
    || value.completedAt < value.testedAt
    || !isNonNegativeNumber(value.elapsedMs)
    || !isNonNegativeInteger(value.modelCount)
    || (value.overall !== 'success' && value.overall !== 'degraded' && value.overall !== 'failed')
    || !Array.isArray(value.probes)
    || value.probes.length > MAX_PROBES
  ) return undefined;
  const probes = value.probes.map((probe) => parseProbe(probe, now));
  if (probes.some((probe) => probe === undefined)) return undefined;
  const capabilities = parseCapabilities(value.capabilities);
  if (!capabilities) return undefined;
  return {
    schemaVersion: 2,
    profileId: value.profileId,
    fingerprint: value.fingerprint,
    connectionName: value.connectionName,
    host: value.host,
    testedAt: value.testedAt,
    completedAt: value.completedAt,
    elapsedMs: value.elapsedMs,
    overall: value.overall,
    modelCount: value.modelCount,
    capabilities,
    probes: probes as ConnectionProbeResult[],
  };
}

function parseProbe(value: unknown, now: number): ConnectionProbeResult | undefined {
  if (!isRecord(value)
    || !PROBE_IDS.includes(value.probe as ConnectionProbeId)
    || !VERDICTS.includes(value.verdict as ConnectionProbeVerdict)
    || (value.endpointPath !== '/models' && value.endpointPath !== '/chat/completions' && value.endpointPath !== '/messages')
    || !isTimestamp(value.startedAt, now)
    || !isNonNegativeNumber(value.elapsedMs)
    || !isOptionalInteger(value.status)
    || !isOptionalSafeString(value.responseType)
    || !isOptionalSafeString(value.requestId)
    || !isOptionalSafeString(value.evidenceModelId)
    || (value.termination !== undefined && value.termination !== '[DONE]' && value.termination !== 'finish_reason' && value.termination !== 'message_stop')
    || (value.skippedReason !== undefined && !SKIP_REASONS.includes(value.skippedReason as ConnectionProbeSkipReason))
  ) return undefined;
  const failure = value.failure === undefined ? undefined : parseFailure(value.failure);
  if (value.failure !== undefined && !failure) return undefined;
  return {
    probe: value.probe as ConnectionProbeId,
    verdict: value.verdict as ConnectionProbeVerdict,
    endpointPath: value.endpointPath,
    startedAt: value.startedAt,
    elapsedMs: value.elapsedMs,
    status: value.status as number | undefined,
    responseType: value.responseType as string | undefined,
    requestId: value.requestId as string | undefined,
    evidenceModelId: value.evidenceModelId as string | undefined,
    termination: value.termination as ConnectionProbeResult['termination'],
    failure,
    skippedReason: value.skippedReason as ConnectionProbeSkipReason | undefined,
  };
}

function parseCapabilities(value: unknown): ConnectionDiagnosticsSnapshot['capabilities'] | undefined {
  if (!isRecord(value)) return undefined;
  const openai = parseProtocolCapabilities(value.openai);
  const claude = parseProtocolCapabilities(value.claude);
  return openai && claude ? { openai, claude } : undefined;
}

function parseProtocolCapabilities(value: unknown): ConnectionProtocolCapabilities | undefined {
  if (!isRecord(value)
    || !VERDICTS.includes(value.nonStreaming as ConnectionProbeVerdict)
    || !VERDICTS.includes(value.streaming as ConnectionProbeVerdict)
    || (value.mode !== 'streaming' && value.mode !== 'nonStreamingOnly' && value.mode !== 'unavailable' && value.mode !== 'unknown')
    || !isOptionalSafeString(value.evidenceModelId)
  ) return undefined;
  return {
    nonStreaming: value.nonStreaming as ConnectionProbeVerdict,
    streaming: value.streaming as ConnectionProbeVerdict,
    mode: value.mode,
    evidenceModelId: value.evidenceModelId as string | undefined,
  };
}

function parseFailure(value: unknown): ConnectionProbeResult['failure'] | undefined {
  const categories = ['url', 'network', 'timeout', 'authentication', 'notFound', 'rateLimited', 'server', 'http', 'invalidResponse', 'protocol', 'cancelled', 'unknown'];
  if (!isRecord(value)
    || !categories.includes(value.category as string)
    || !isSafeString(value.message)
    || !isOptionalInteger(value.status)
    || !isOptionalSafeString(value.responseType)
    || !isOptionalSafeString(value.requestId)
  ) return undefined;
  return value as unknown as ConnectionProbeResult['failure'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isSafeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PERSISTED_STRING_LENGTH && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isOptionalSafeString(value: unknown): boolean {
  return value === undefined || isSafeString(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isTimestamp(value: unknown, now: number): value is number {
  return isNonNegativeInteger(value) && value <= now + MAX_FUTURE_SKEW_MS;
}