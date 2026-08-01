import type { ConnectionTestFailure } from './connection';

export type ConnectionProbeId =
  | 'models'
  | 'openai.nonStreaming'
  | 'openai.streaming'
  | 'openai.responses'
  | 'claude.nonStreaming'
  | 'claude.streaming';

export type ConnectionProbeVerdict = 'supported' | 'unsupported' | 'indeterminate' | 'skipped';

export type ConnectionProbeSkipReason =
  | 'modelsUnavailable'
  | 'noOpenAIModel'
  | 'noClaudeModel';

export interface ConnectionProbeResult {
  readonly probe: ConnectionProbeId;
  readonly verdict: ConnectionProbeVerdict;
  readonly endpointPath: '/models' | '/chat/completions' | '/responses' | '/messages';
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly status?: number;
  readonly responseType?: string;
  readonly requestId?: string;
  readonly evidenceModelId?: string;
  readonly termination?: '[DONE]' | 'finish_reason' | 'message_stop' | 'completed' | 'incomplete';
  readonly failure?: ConnectionTestFailure;
  readonly skippedReason?: ConnectionProbeSkipReason;
}

export type ConnectionProtocolMode = 'streaming' | 'nonStreamingOnly' | 'unavailable' | 'unknown';

export interface ConnectionProtocolCapabilities {
  readonly nonStreaming: ConnectionProbeVerdict;
  readonly streaming: ConnectionProbeVerdict;
  readonly mode: ConnectionProtocolMode;
  readonly evidenceModelId?: string;
}

export interface ConnectionCapabilities {
  readonly openai: ConnectionProtocolCapabilities;
  readonly claude: ConnectionProtocolCapabilities;
}

export interface ConnectionDiagnosticsSnapshot {
  readonly schemaVersion: 2;
  readonly profileId: string;
  readonly fingerprint: string;
  readonly connectionName: string;
  readonly host: string;
  readonly testedAt: number;
  readonly completedAt: number;
  readonly elapsedMs: number;
  readonly overall: 'success' | 'degraded' | 'failed';
  readonly modelCount: number;
  readonly capabilities: ConnectionCapabilities;
  readonly probes: readonly ConnectionProbeResult[];
}

export function deriveProtocolCapabilities(
  nonStreaming: ConnectionProbeResult | undefined,
  streaming: ConnectionProbeResult | undefined,
): ConnectionProtocolCapabilities {
  const nonStreamingVerdict = nonStreaming?.verdict ?? 'skipped';
  const streamingVerdict = streaming?.verdict ?? 'skipped';
  let mode: ConnectionProtocolMode = 'unknown';
  if (streamingVerdict === 'supported') mode = 'streaming';
  else if (nonStreamingVerdict === 'supported' && streamingVerdict === 'unsupported') mode = 'nonStreamingOnly';
  else if (nonStreamingVerdict === 'unsupported' && streamingVerdict === 'unsupported') mode = 'unavailable';
  return {
    nonStreaming: nonStreamingVerdict,
    streaming: streamingVerdict,
    mode,
    evidenceModelId: nonStreaming?.evidenceModelId ?? streaming?.evidenceModelId,
  };
}

export function deriveConnectionCapabilities(probes: readonly ConnectionProbeResult[]): ConnectionCapabilities {
  const find = (probe: ConnectionProbeId) => probes.find((entry) => entry.probe === probe);
  return {
    openai: deriveProtocolCapabilities(find('openai.nonStreaming'), find('openai.streaming')),
    claude: deriveProtocolCapabilities(find('claude.nonStreaming'), find('claude.streaming')),
  };
}

export function deriveDiagnosticsOverall(probes: readonly ConnectionProbeResult[]): ConnectionDiagnosticsSnapshot['overall'] {
  const models = probes.find((probe) => probe.probe === 'models');
  if (!models || models.verdict !== 'supported') return 'failed';
  // A single-model relay intentionally skips the other protocol; skipped probes
  // are not failures. The /responses availability probe is informational: it is
  // free (GET), so it must not downgrade overall health.
  const executed = probes.filter((probe) =>
    probe.probe !== 'models'
    && probe.probe !== 'openai.responses'
    && probe.verdict !== 'skipped');
  return executed.length > 0 && executed.every((probe) => probe.verdict === 'supported')
    ? 'success'
    : 'degraded';
}