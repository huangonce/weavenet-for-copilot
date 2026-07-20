import { describe, expect, it } from 'vitest';
import type { ConnectionProfile } from '../../src/config/config';
import {
  deriveConnectionCapabilities,
  deriveDiagnosticsOverall,
} from '../../src/copilot/connectionDiagnostics';
import type {
  ConnectionDiagnosticsSnapshot,
  ConnectionProbeResult,
} from '../../src/copilot/connectionDiagnostics';
import {
  ConnectionDiagnosticsStore,
  fingerprintConnection,
  parseConnectionDiagnosticsSnapshot,
} from '../../src/copilot/connectionDiagnosticsStore';
import { InMemoryMemento } from '../support/memento';

const profile: ConnectionProfile = {
  name: 'Work',
  baseUrl: 'https://relay.example.test/v1/',
  requestHeaders: { 'X-Tenant': 'team-a', 'X-Region': 'west' },
  includeModels: ['gpt', 'claude'],
  models: [{ id: 'gpt-test', route: 'openai' }],
};

function probe(overrides: Partial<ConnectionProbeResult>): ConnectionProbeResult {
  return {
    probe: 'models',
    verdict: 'supported',
    endpointPath: '/models',
    startedAt: 1_000,
    elapsedMs: 5,
    ...overrides,
  };
}

function snapshot(fingerprint = fingerprintConnection(profile)): ConnectionDiagnosticsSnapshot {
  const probes = [
    probe({}),
    probe({ probe: 'openai.nonStreaming', endpointPath: '/chat/completions', evidenceModelId: 'gpt-test' }),
    probe({ probe: 'openai.streaming', endpointPath: '/chat/completions', evidenceModelId: 'gpt-test', termination: '[DONE]' }),
    probe({ probe: 'claude.nonStreaming', endpointPath: '/messages', verdict: 'skipped', skippedReason: 'noClaudeModel' }),
    probe({ probe: 'claude.streaming', endpointPath: '/messages', verdict: 'skipped', skippedReason: 'noClaudeModel' }),
  ] as const;
  return {
    schemaVersion: 1,
    fingerprint,
    connectionName: 'Work',
    host: 'relay.example.test',
    testedAt: 1_000,
    completedAt: 1_025,
    elapsedMs: 25,
    overall: deriveDiagnosticsOverall(probes),
    modelCount: 1,
    capabilities: deriveConnectionCapabilities(probes),
    probes,
  };
}

describe('connection diagnostics', () => {
  it('derives conservative protocol capabilities and overall health', () => {
    const probes = [
      probe({}),
      probe({ probe: 'openai.nonStreaming', endpointPath: '/chat/completions' }),
      probe({ probe: 'openai.streaming', endpointPath: '/chat/completions', verdict: 'unsupported' }),
    ];
    expect(deriveConnectionCapabilities(probes).openai).toMatchObject({
      nonStreaming: 'supported', streaming: 'unsupported', mode: 'nonStreamingOnly',
    });
    expect(deriveDiagnosticsOverall(probes)).toBe('degraded');
    expect(deriveDiagnosticsOverall([probe({ verdict: 'indeterminate' })])).toBe('failed');
  });

  it('creates stable isolated fingerprints without exposing configuration values', () => {
    const fingerprint = fingerprintConnection(profile, { anthropicVersion: '2023-06-01' });
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprint).not.toContain('team-a');
    expect(fingerprintConnection({
      ...profile,
      baseUrl: 'https://relay.example.test/v1',
      requestHeaders: { 'x-region': 'west', 'x-tenant': 'team-a' },
    })).toBe(fingerprint);
    expect(fingerprintConnection({ ...profile, name: 'Personal' })).not.toBe(fingerprint);
    expect(fingerprintConnection({ ...profile, requestHeaders: { 'X-Tenant': 'team-b' } })).not.toBe(fingerprint);
  });

  it('persists by fingerprint and restores from a shared global state', async () => {
    const values = new Map<string, unknown>();
    const first = new ConnectionDiagnosticsStore(new InMemoryMemento(values) as never);
    await first.update(snapshot());
    const restored = new ConnectionDiagnosticsStore(new InMemoryMemento(values) as never);
    expect(restored.get(profile)).toEqual(snapshot());
    expect(JSON.stringify([...values.entries()])).not.toContain('team-a');
  });

  it('deletes one profile or all diagnostics without affecting unrelated global state', async () => {
    const state = new InMemoryMemento();
    const store = new ConnectionDiagnosticsStore(state as never);
    await store.update(snapshot());
    await state.update('unrelated', true);
    await store.deleteProfile('Work');
    expect(store.get(profile)).toBeUndefined();
    await store.update(snapshot());
    await store.clear();
    expect(state.get('unrelated')).toBe(true);
  });

  it('ignores damaged, mismatched, unsafe, and future-schema values', () => {
    const valid = snapshot();
    expect(parseConnectionDiagnosticsSnapshot(valid, valid.fingerprint, 2_000)).toEqual(valid);
    expect(parseConnectionDiagnosticsSnapshot({ ...valid, schemaVersion: 2 }, valid.fingerprint, 2_000)).toBeUndefined();
    expect(parseConnectionDiagnosticsSnapshot({ ...valid, fingerprint: 'a'.repeat(64) }, valid.fingerprint, 2_000)).toBeUndefined();
    expect(parseConnectionDiagnosticsSnapshot({ ...valid, host: 'relay\nsecret' }, valid.fingerprint, 2_000)).toBeUndefined();
    expect(parseConnectionDiagnosticsSnapshot({ ...valid, testedAt: 100_000_000 }, valid.fingerprint, 2_000)).toBeUndefined();
  });
});