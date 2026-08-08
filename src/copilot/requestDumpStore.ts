import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { DebugMode } from '../config/config';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * Serializes sensitive verbose diagnostics behind one bounded filesystem seam.
 * Callers provide request objects only—credentials and headers never enter the
 * interface—and writes are pruned by count and total bytes.
 */
export class RequestDumpStore {
  private queue: Promise<void> = Promise.resolve();
  private counter = 0;

  constructor(
    private readonly root: string,
    private readonly onError: (message: string) => void,
  ) {}

  capture(
    mode: DebugMode,
    protocol: 'openai-chat' | 'openai-responses' | 'claude',
    model: string,
    request: unknown,
  ): Promise<void> {
    if (mode !== 'verbose') return Promise.resolve();
    const write = async (): Promise<void> => {
      await fs.mkdir(this.root, { recursive: true });
      const serialized = boundedDumpJson({
        warning: 'Sensitive diagnostic: may contain prompts, tool schemas, file content, and image descriptions.',
        capturedAt: new Date().toISOString(),
        protocol,
        model,
        request,
      });
      const filename = `${Date.now()}-${++this.counter}-${protocol}-${safeFilename(model)}.json`;
      await fs.writeFile(join(this.root, filename), serialized, { encoding: 'utf8', mode: 0o600 });
      await this.prune();
    };
    const result = this.queue.then(write, write);
    this.queue = result.catch((error) => {
      this.onError(`Request dump failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return result;
  }

  async open(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(this.root));
  }

  private async prune(): Promise<void> {
    const names = (await fs.readdir(this.root)).filter((name) => name.endsWith('.json'));
    const files = await Promise.all(names.map(async (name) => {
      const path = join(this.root, name);
      const stat = await fs.stat(path);
      return { path, size: stat.size, modified: stat.mtimeMs };
    }));
    files.sort((left, right) => right.modified - left.modified || right.path.localeCompare(left.path));
    let total = 0;
    for (const [index, file] of files.entries()) {
      total += file.size;
      if (index >= MAX_FILES || total > MAX_TOTAL_BYTES) await fs.unlink(file.path);
    }
  }
}

function boundedDumpJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_FILE_BYTES) return serialized;
  const originalBytes = Buffer.byteLength(serialized, 'utf8');
  let prefixCharacters = Math.min(serialized.length, Math.floor(MAX_FILE_BYTES / 2));
  while (prefixCharacters > 0) {
    const result = JSON.stringify({
      warning: 'Sensitive diagnostic was truncated to the per-file limit.',
      originalBytes,
      prefix: serialized.slice(0, prefixCharacters),
    }, null, 2);
    const overflow = Buffer.byteLength(result, 'utf8') - MAX_FILE_BYTES;
    if (overflow <= 0) return result;
    prefixCharacters -= Math.max(1, Math.ceil(overflow / 2));
  }
  return JSON.stringify({
    warning: 'Sensitive diagnostic exceeded the per-file limit and could not include a prefix.',
    originalBytes,
  }, null, 2);
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 80) || 'model';
}
