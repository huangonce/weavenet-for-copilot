import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { getConfig } from '../../src/config/config';
import type { ExtensionConfig } from '../../src/config/config';
import { catalogArtifactRevision, hashCatalogIdentity } from '../../src/copilot/catalogIdentity';

const ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: () => undefined } as never);
});
afterEach(() => vi.restoreAllMocks());

function configuration(): ExtensionConfig {
  return {
    ...getConfig({ id: ID, name: 'Work', baseUrl: 'https://relay.example.test/v1/', apiType: 'responses' }),
    modelMetadataEnabled: false,
    includeModels: [/^b/, /^a/, /^b/],
    excludeModels: [/^z/],
    requestHeaders: { 'X-Z': ' last ', 'X-A': 'first' },
    models: [{ id: 'shared', openai: { strictTools: true, sampling: undefined } }, { id: 'shared', imageInput: false }],
  };
}

describe('catalog identity compatibility', () => {
  it('preserves the serialized identity used by existing catalog snapshots', () => {
    // Literal wire identity from before the shared JSON helper; do not derive it
    // through the implementation under test or silently re-key saved snapshots.
    const serialized = '{"apiType":"responses","baseUrl":"https://relay.example.test/v1","excludeModels":["^z"],"includeModels":["^a","^b"],"modelMetadataEnabled":false,"models":[{"id":"shared","openai":{"strictTools":true}},{"id":"shared","imageInput":false}],"profileId":"11111111-1111-4111-8111-111111111111","requestHeaders":[["x-a","first"],["x-z","last"]]}';
    const config = configuration();
    expect(hashCatalogIdentity(config)).toBe(createHash('sha256').update(serialized).digest('hex'));
    const persisted = catalogArtifactRevision(config, 'key', 'pepper');
    expect(persisted).toBe(createHmac('sha256', 'pepper').update('credential\0key\0catalog\0').update(serialized).digest('hex'));
    expect(catalogArtifactRevision(config, 'other-key', 'pepper')).not.toBe(persisted);
  });

  it('ignores object-key order and absent fields while retaining model declaration order', () => {
    const config = configuration();
    const revision = hashCatalogIdentity(config);
    expect(hashCatalogIdentity({ ...config, models: [
      { openai: { strictTools: true }, id: 'shared' }, { imageInput: false, id: 'shared' },
    ] })).toBe(revision);
    expect(hashCatalogIdentity({ ...config, models: [...config.models].reverse() })).not.toBe(revision);
  });
});
