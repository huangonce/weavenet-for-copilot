import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestDumpStore } from '../../src/copilot/requestDumpStore';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weavenet-dumps-'));
  roots.push(root);
  const onError = vi.fn();
  return { root, onError, store: new RequestDumpStore(root, onError) };
}

describe('RequestDumpStore', () => {
  it('writes only verbose captures and keeps credentials outside its interface', async () => {
    const { root, store, onError } = await fixture();
    await store.capture('metadata', 'openai-chat', 'model', { prompt: 'not written' });
    expect(await readdir(root)).toEqual([]);

    await store.capture('verbose', 'openai-chat', 'model/a', { prompt: 'sensitive text' });

    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/openai-chat-model-a\.json$/u);
    const value = JSON.parse(await readFile(join(root, files[0]), 'utf8')) as Record<string, unknown>;
    expect(value).toMatchObject({ protocol: 'openai-chat', model: 'model/a', request: { prompt: 'sensitive text' } });
    expect(onError).not.toHaveBeenCalled();
  });

  it('bounds file count and truncates oversized request dumps', async () => {
    const { root, store } = await fixture();
    for (let index = 0; index < 25; index++) {
      await store.capture('verbose', 'claude', `model-${index}`, {
        prompt: index === 24 ? '\\"😀'.repeat(400_000) : 'x',
      });
    }

    const files = await readdir(root);
    expect(files.length).toBeLessThanOrEqual(20);
    const newest = files.find((file) => file.includes('model-24'));
    expect(newest).toBeDefined();
    expect((await stat(join(root, newest!))).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(await readFile(join(root, newest!), 'utf8')).toContain('truncated');
  });
});
