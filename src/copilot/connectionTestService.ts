import * as vscode from 'vscode';
import type { AuthManager } from '../auth/auth';
import { getConfig, getProfileConfiguration } from '../config/config';
import type { ApiType, ConnectionProfile } from '../config/config';
import { RelayClient } from '../relay/client';
import type { RelayEndpointTestResult } from '../relay/client';
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
  diagnosticsOptions,
  fingerprintConnection,
} from './connectionDiagnosticsStore';
import type { ConnectionRuntime } from './connectionRuntimeManager';
import { catalogRevision } from './catalogIdentity';
import { assembleModelCatalog } from './modelRegistry';
import { toRoutedModel } from '../relay/models';
import type { RoutedModel } from '../relay/types';
import { t } from '../l10n';

export type ConnectionTestResult = ConnectionDiagnosticsSnapshot;

interface ConnectionTestTask {
  readonly profileId: string;
  readonly revision: string;
  readonly fingerprint: string;
  readonly cancellation: vscode.CancellationTokenSource;
  readonly promise: Promise<ConnectionTestResult>;
}

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
 * Runs one test per unchanged connection, cancels invalidated work, and persists
 * diagnostics only while the tested settings and credentials remain current.
 */
export class ConnectionTestService {
  private readonly connectionTestTasks = new Map<string, ConnectionTestTask>();

  constructor(private readonly options: ConnectionTestServiceOptions) {}

  test(profile: ConnectionProfile): Promise<ConnectionTestResult> {
    if (!normalizeRelayBaseUrl(profile.baseUrl)) {
      return Promise.reject(new ConnectionTestError({ category: 'url', message: 'The Relay Base URL must use HTTPS, or HTTP on a loopback host.' }));
    }
    const fingerprint = fingerprintConnection(profile, diagnosticsOptions());
    const revision = catalogRevision(profile);
    if (!this.matchesCurrentProfile(profile.id, revision, fingerprint)) {
      return Promise.reject(connectionTestCancelled());
    }
    const existing = this.connectionTestTasks.get(profile.id);
    if (existing && existing.revision === revision && existing.fingerprint === fingerprint
      && !existing.cancellation.token.isCancellationRequested) return existing.promise;
    existing?.cancellation.cancel();
    const cancellation = new vscode.CancellationTokenSource();
    const task: ConnectionTestTask = {
      profileId: profile.id, revision, fingerprint, cancellation,
      promise: Promise.resolve().then(() => this.runConnectionTest(profile, task)).finally(() => {
        if (this.connectionTestTasks.get(profile.id) === task) this.connectionTestTasks.delete(profile.id);
        cancellation.dispose();
      }),
    };
    this.connectionTestTasks.set(profile.id, task);
    return task.promise;
  }

  invalidate(profileId?: string): void {
    for (const task of this.connectionTestTasks.values()) {
      if (profileId === undefined || task.profileId === profileId) task.cancellation.cancel();
    }
  }

  async clearDiagnostics(profile: ConnectionProfile): Promise<void> {
    this.invalidate(profile.id);
    await this.options.diagnosticsStore.delete(profile, diagnosticsOptions());
  }

  async clearAllDiagnostics(): Promise<void> {
    this.invalidate();
    await this.options.diagnosticsStore.clear();
  }

  private async runConnectionTest(profile: ConnectionProfile, task: ConnectionTestTask): Promise<ConnectionTestResult> {
    const { fingerprint, cancellation: { token } } = task;
    const normalizedBaseUrl = normalizeRelayBaseUrl(profile.baseUrl);
    const host = safeHost(normalizedBaseUrl ?? profile.baseUrl) ?? 'unknown host';
    this.assertCurrent(task);
    const apiKey = await this.options.auth.getApiKey(profile);
    this.assertCurrent(task);
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
        authScheme: config.apiType === 'messages' ? 'x-api-key' : 'bearer',
        requestHeaders: profile.requestHeaders ?? {},
        anthropicVersion: config.anthropicVersion,
        requestTimeoutMs: config.requestTimeoutMs,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      });
      const modelsStartedAt = Date.now();
      const { models, diagnostic } = await client.testModels(token);
      this.assertCurrent(task);
      const catalog = assembleModelCatalog(config, (models.data ?? []).map(model => toRoutedModel(model, config.apiType)));
      const modelCount = models.data?.length ?? 0;
      const probes: ConnectionProbeResult[] = [successfulProbe('models', modelsStartedAt, diagnostic)];
      const candidates = new Map<ApiType, RoutedModel>();
      for (const model of catalog) {
        const existing = candidates.get(model.apiType);
        if (!existing || (model.apiType === 'chat-completions'
          && existing.openai?.tokenLimitField === 'omit' && model.openai?.tokenLimitField !== 'omit')) {
          candidates.set(model.apiType, model);
        }
      }
      for (const [apiType, model] of candidates) {
        const modelId = model.upstreamId;
        const prefix = apiType === 'messages' ? 'claude' : apiType === 'responses' ? 'responses' : 'openai';
        const endpoint = apiType === 'messages' ? '/messages' : apiType === 'responses' ? '/responses' : '/chat/completions';
        const tokenLimitField = model.openai?.tokenLimitField ?? 'max_tokens';
        const operation = (stream: boolean) => {
          if (apiType === 'messages') return client.testClaudeMessages(modelId, stream, token);
          if (apiType === 'responses') return client.testOpenAIResponses(modelId, stream, token);
          if (tokenLimitField === 'omit') return Promise.reject(new ConnectionTestError({ category: 'protocol',
            message: 'This model disables output limits; bounded generation tests are unavailable.' }));
          return client.testOpenAIChatCompletion(modelId, stream, token, tokenLimitField);
        };
        this.assertCurrent(task);
        probes.push(await runProtocolProbe(`${prefix}.nonStreaming`, endpoint, modelId, () => operation(false)));
        this.assertCurrent(task);
        probes.push(await runProtocolProbe(`${prefix}.streaming`, endpoint, modelId, () => operation(true)));
        this.assertCurrent(task);
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
      await this.options.diagnosticsStore.update(result, () => this.isCurrent(task));
      this.assertCurrent(task);
      this.options.onTestStatus(profile.id, fingerprint, {
        phase: result.overall === 'success' ? 'ready' : 'degraded',
        lastDiagnostics: result,
        message: result.overall === 'degraded' ? 'Connection capabilities are partially available or unknown.' : undefined,
      });
      return result;
    } catch (error) {
      this.assertCurrent(task);
      const failure = describeConnectionTestError(error);
      this.options.onTestStatus(profile.id, fingerprint, { phase: 'error', message: failure.message });
      throw new ConnectionTestError(failure);
    }
  }

  private isCurrent(task: ConnectionTestTask): boolean {
    if (task.cancellation.token.isCancellationRequested || this.connectionTestTasks.get(task.profileId) !== task) return false;
    return this.matchesCurrentProfile(task.profileId, task.revision, task.fingerprint);
  }

  private matchesCurrentProfile(profileId: string, revision: string, fingerprint: string): boolean {
    const profile = getProfileConfiguration().profiles.find(profile => profile.id === profileId);
    return !!profile && catalogRevision(profile) === revision && fingerprintConnection(profile, diagnosticsOptions()) === fingerprint;
  }

  private assertCurrent(task: ConnectionTestTask): void {
    if (!this.isCurrent(task)) throw connectionTestCancelled();
  }
}

function connectionTestCancelled(): ConnectionTestError {
  return new ConnectionTestError({ category: 'cancelled',
    message: t('The connection changed during testing. Run the connection test again.') });
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
