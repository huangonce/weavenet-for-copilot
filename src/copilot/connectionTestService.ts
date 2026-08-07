import type { AuthManager } from '../auth/auth';
import { getConfig } from '../config/config';
import type { ConfiguredModel, ConnectionProfile } from '../config/config';
import { RelayClient } from '../relay/client';
import type { RelayEndpointTestResult } from '../relay/client';
import { isClaudeModelId } from '../relay/models';
import type { ModelsResponse } from '../relay/types';
import { normalizeRelayBaseUrl } from '../relay/url';
import { ConnectionTestError, describeConnectionTestError, safeHost } from './connection';
import type { ConnectionTestFailure } from './connection';
import { deriveConnectionCapabilities, deriveDiagnosticsOverall } from './connectionDiagnostics';
import type {
  ConnectionDiagnosticsSnapshot,
  ConnectionProbeId,
  ConnectionProbeResult,
  ConnectionProbeVerdict,
} from './connectionDiagnostics';
import type {
  ConnectionDiagnosticsStore} from './connectionDiagnosticsStore';
import {
  currentProfileFingerprint,
  diagnosticsOptions,
  fingerprintConnection,
} from './connectionDiagnosticsStore';
import type { ConnectionRuntime } from './connectionRuntimeManager';

export type ConnectionTestResult = ConnectionDiagnosticsSnapshot;

export interface ConnectionTestServiceOptions {
  readonly auth: AuthManager;
  readonly diagnosticsStore: ConnectionDiagnosticsStore;
  /** Writes the outcome back into the owning connection runtime. */
  readonly onTestStatus: (
    profileId: string,
    fingerprint: string,
    status: Pick<ConnectionRuntime, 'phase' | 'message' | 'lastDiagnostics'>,
  ) => void;
}

/**
 * Runs the endpoint-level connection test (models + per-protocol probes) with
 * per-fingerprint deduplication, and persists the resulting diagnostics.
 */
export class ConnectionTestService {
  private readonly connectionTestTasks = new Map<string, Promise<ConnectionTestResult>>();

  constructor(private readonly options: ConnectionTestServiceOptions) {}

  test(profile: ConnectionProfile): Promise<ConnectionTestResult> {
    const fingerprint = fingerprintConnection(profile, diagnosticsOptions());
    const existing = this.connectionTestTasks.get(fingerprint);
    if (existing) return existing;
    const task = this.runConnectionTest(profile, fingerprint).finally(() => {
      if (this.connectionTestTasks.get(fingerprint) === task) this.connectionTestTasks.delete(fingerprint);
    });
    this.connectionTestTasks.set(fingerprint, task);
    return task;
  }

  async clearDiagnostics(profile: ConnectionProfile): Promise<void> {
    await this.options.diagnosticsStore.delete(profile, diagnosticsOptions());
  }

  async clearAllDiagnostics(): Promise<void> {
    await this.options.diagnosticsStore.clear();
  }

  private async runConnectionTest(profile: ConnectionProfile, fingerprint: string): Promise<ConnectionTestResult> {
    const normalizedBaseUrl = normalizeRelayBaseUrl(profile.baseUrl);
    const host = safeHost(normalizedBaseUrl ?? profile.baseUrl) ?? 'unknown host';
    if (!normalizedBaseUrl) {
      throw new ConnectionTestError({ category: 'url', message: 'The Relay Base URL must use HTTPS, or HTTP on a loopback host.' });
    }
    const apiKey = await this.options.auth.getApiKey(profile);
    if (!apiKey) {
      this.options.onTestStatus(profile.id, fingerprint, { phase: 'keyMissing', message: 'API key is required.' });
      throw new ConnectionTestError({ category: 'authentication', message: 'API key is required for this connection.' });
    }
    const testedAt = Date.now();
    try {
      const config = getConfig(profile);
      const client = new RelayClient({
        baseUrl: profile.baseUrl,
        apiKey,
        requestHeaders: profile.requestHeaders ?? {},
        anthropicVersion: config.anthropicVersion,
        requestTimeoutMs: config.requestTimeoutMs,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      });
      const modelsStartedAt = Date.now();
      const { models, diagnostic } = await client.testModels();
      const modelCount = Array.isArray(models.data) ? models.data.length : 0;
      const probes: ConnectionProbeResult[] = [successfulProbe('models', modelsStartedAt, diagnostic)];
      const candidates = selectProbeCandidates(profile.models ?? [], models);
      if (candidates.openai) {
        const model = candidates.openai;
        probes.push(await runProtocolProbe('openai.nonStreaming', '/chat/completions', model, () => client.testOpenAIChatCompletion(model, false)));
        probes.push(await runProtocolProbe('openai.streaming', '/chat/completions', model, () => client.testOpenAIChatCompletion(model, true)));
        // A free GET reports whether the relay exposes /responses at all. It is
        // informational only and never downgrades overall health on its own.
        probes.push(await runOpenAIResponsesProbe(client));
      } else {
        probes.push(skippedProbe('openai.nonStreaming', '/chat/completions', 'noOpenAIModel'));
        probes.push(skippedProbe('openai.streaming', '/chat/completions', 'noOpenAIModel'));
        probes.push(skippedProbe('openai.responses', '/responses', 'noOpenAIModel'));
      }
      if (candidates.claude) {
        const model = candidates.claude;
        probes.push(await runProtocolProbe('claude.nonStreaming', '/messages', model, () => client.testClaudeMessages(model, false)));
        probes.push(await runProtocolProbe('claude.streaming', '/messages', model, () => client.testClaudeMessages(model, true)));
      } else {
        probes.push(skippedProbe('claude.nonStreaming', '/messages', 'noClaudeModel'));
        probes.push(skippedProbe('claude.streaming', '/messages', 'noClaudeModel'));
      }
      const completedAt = Date.now();
      const result: ConnectionDiagnosticsSnapshot = {
        schemaVersion: 2,
        profileId: profile.id,
        fingerprint,
        connectionName: profile.name,
        host,
        testedAt,
        completedAt,
        elapsedMs: completedAt - testedAt,
        overall: deriveDiagnosticsOverall(probes),
        modelCount,
        capabilities: deriveConnectionCapabilities(probes),
        probes,
      };
      if (currentProfileFingerprint(profile.id) === fingerprint) {
        await this.options.diagnosticsStore.update(result);
        this.options.onTestStatus(profile.id, fingerprint, {
          phase: result.overall === 'success' ? 'ready' : 'degraded',
          lastDiagnostics: result,
          message: result.overall === 'degraded' ? 'Connection capabilities are partially available or unknown.' : undefined,
        });
      }
      return result;
    } catch (error) {
      const failure = describeConnectionTestError(error);
      this.options.onTestStatus(profile.id, fingerprint, { phase: 'error', message: failure.message });
      throw new ConnectionTestError(failure);
    }
  }
}

function selectProbeCandidates(
  configured: readonly ConfiguredModel[],
  models: ModelsResponse,
): { openai?: string; claude?: string } {
  const explicitOpenAI = configured.find((model) => model.route === 'openai' || model.route === 'chatgpt')?.id;
  const explicitClaude = configured.find((model) => model.route === 'claude')?.id;
  const catalog = models.data ?? [];
  const claude = explicitClaude ?? catalog.find((model) => isClaudeModelId(model.id))?.id;
  const openai = explicitOpenAI ?? catalog.find((model) => model.id !== claude && !isClaudeModelId(model.id))?.id;
  return { openai, claude };
}

function successfulProbe(
  probe: ConnectionProbeId,
  startedAt: number,
  diagnostic: RelayEndpointTestResult,
  evidenceModelId?: string,
): ConnectionProbeResult {
  return {
    probe,
    verdict: 'supported',
    endpointPath: diagnostic.endpoint,
    startedAt,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    status: diagnostic.status,
    responseType: diagnostic.responseType,
    requestId: diagnostic.requestId,
    evidenceModelId,
    termination: diagnostic.termination,
  };
}

async function runProtocolProbe(
  probe: ConnectionProbeId,
  endpointPath: RelayEndpointTestResult['endpoint'],
  evidenceModelId: string,
  operation: () => Promise<RelayEndpointTestResult>,
): Promise<ConnectionProbeResult> {
  const startedAt = Date.now();
  try {
    return successfulProbe(probe, startedAt, await operation(), evidenceModelId);
  } catch (error) {
    const failure = describeConnectionTestError(error);
    return {
      probe,
      verdict: probeVerdictForFailure(failure),
      endpointPath,
      startedAt,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      status: failure.status,
      responseType: failure.responseType,
      requestId: failure.requestId,
      evidenceModelId,
      failure,
    };
  }
}

function probeVerdictForFailure(failure: ConnectionTestFailure): ConnectionProbeVerdict {
  return failure.category === 'notFound' ? 'unsupported' : 'indeterminate';
}

async function runOpenAIResponsesProbe(client: RelayClient): Promise<ConnectionProbeResult> {
  const startedAt = Date.now();
  try {
    // probeResponsesEndpoint is a free GET and never throws; it maps network
    // failures to 'unknown', which we surface as 'indeterminate'.
    const availability = await client.probeResponsesEndpoint();
    return {
      probe: 'openai.responses',
      verdict: availability === 'supported' ? 'supported' : availability === 'unsupported' ? 'unsupported' : 'indeterminate',
      endpointPath: '/responses',
      startedAt,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (error) {
    const failure = describeConnectionTestError(error);
    return {
      probe: 'openai.responses',
      verdict: 'indeterminate',
      endpointPath: '/responses',
      startedAt,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      status: failure.status,
      responseType: failure.responseType,
      requestId: failure.requestId,
      failure,
    };
  }
}

function skippedProbe(
  probe: ConnectionProbeId,
  endpointPath: '/chat/completions' | '/responses' | '/messages',
  skippedReason: 'noOpenAIModel' | 'noClaudeModel',
): ConnectionProbeResult {
  return { probe, verdict: 'skipped', endpointPath, startedAt: Date.now(), elapsedMs: 0, skippedReason };
}
