import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeConnectionProfiles } from '../src/config/config';
import type { ApiType } from '../src/relay/types';

/**
 * Manifest-level guardrails. These run without a host and catch drift between the
 * declared schema, the localized strings and the runtime validators.
 */

interface Manifest {
  engines: { vscode: string };
  l10n?: string;
  devDependencies: Record<string, string>;
  contributes: {
    configuration: {
      properties: Record<string, {
        items?: { properties?: Record<string, { enum?: readonly ApiType[] }> };
      }>;
    };
  };
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;
const english = JSON.parse(readFileSync('package.nls.json', 'utf8')) as Record<string, string>;
const chinese = JSON.parse(readFileSync('package.nls.zh-cn.json', 'utf8')) as Record<string, string>;
const runtimeBundle = JSON.parse(readFileSync('l10n/bundle.l10n.zh-cn.json', 'utf8')) as Record<string, string>;

function referencedKeys(): string[] {
  return [...readFileSync('package.json', 'utf8').matchAll(/%([^%]+)%/gu)].map((match) => match[1]);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Every `t('...')` source string in the extension code, mapped to its files. */
function localizedStrings(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles('src')) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/gu)) {
      const message = match[1].replace(/\\(['\\])/gu, '$1');
      found.set(message, [...(found.get(message) ?? []), file]);
    }
  }
  return found;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\d+)\}/gu)].map((match) => match[1]).sort();
}

describe('extension manifest', () => {
  it('keeps every localized string referenced, translated and free of stale keys', () => {
    const referenced = new Set(referencedKeys());
    const englishKeys = new Set(Object.keys(english));
    const chineseKeys = new Set(Object.keys(chinese));

    expect([...referenced].filter((key) => !englishKeys.has(key))).toEqual([]);
    expect([...referenced].filter((key) => !chineseKeys.has(key))).toEqual([]);
    expect([...englishKeys].filter((key) => !chineseKeys.has(key))).toEqual([]);
    expect([...chineseKeys].filter((key) => !englishKeys.has(key))).toEqual([]);
    expect([...englishKeys].filter((key) => !referenced.has(key))).toEqual([]);
    expect(Object.values(english).concat(Object.values(chinese)).filter((value) => !value.trim())).toEqual([]);
  });

  it('declares only API types the runtime accepts', () => {
    const declared = manifest.contributes.configuration.properties['weavenet-copilot.profiles']
      .items?.properties?.apiType?.enum;

    expect(new Set(declared)).toEqual(new Set<ApiType>(['chat-completions', 'responses', 'messages']));
    for (const apiType of declared ?? []) {
      // Every advertised value must survive configuration normalization.
      expect(normalizeConnectionProfiles([{
        id: '11111111-1111-4111-8111-111111111111', name: 'Relay', baseUrl: 'https://relay.example.test/v1', apiType,
      }])).toHaveLength(1);
    }
  });

  it('pins the API types to the declared minimum host', () => {
    const floor = manifest.engines.vscode.replace(/^[^\d]*/u, '');
    expect(manifest.devDependencies['@types/vscode']).toBe(floor);
  });
});

describe('runtime localization bundle', () => {
  const referenced = localizedStrings();

  it('declares the bundle folder and translates every referenced string', () => {
    expect(manifest.l10n).toBe('./l10n');
    expect([...referenced.keys()].filter((key) => !(key in runtimeBundle))).toEqual([]);
  });

  it('keeps no stale or empty translations', () => {
    expect(Object.keys(runtimeBundle).filter((key) => !referenced.has(key))).toEqual([]);
    expect(Object.values(runtimeBundle).filter((value) => !value.trim())).toEqual([]);
  });

  it('preserves every placeholder in the translation', () => {
    const mismatched = Object.entries(runtimeBundle)
      .filter(([key, value]) => JSON.stringify(placeholders(key)) !== JSON.stringify(placeholders(value)))
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  it('localizes rather than copying the English source', () => {
    // A value identical to its key means the string was never translated; the
    // technical `HTTP {0}` prefix is the single intentional exception.
    const untranslated = Object.entries(runtimeBundle).filter(([key, value]) => key === value).map(([key]) => key);
    expect(untranslated).toEqual(['HTTP {0}']);
  });
});
