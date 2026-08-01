#!/usr/bin/env node
/**
 * Standalone probe: reports which models on a WeaveNet relay support the
 * OpenAI Responses API (/responses).
 *
 * Usage (secrets stay in your shell, never passed through the assistant):
 *   WEAVENET_BASE_URL=https://relay.example.test/v1 \
 *   WEAVENET_API_KEY=sk-... \
 *   node scripts/probe-responses.mjs
 *
 * Optional: WEAVENET_MODELS="gpt-5,o3" to probe only listed model ids.
 */
const BASE_URL = process.env.WEAVENET_BASE_URL;
const API_KEY = process.env.WEAVENET_API_KEY;
const ONLY = (process.env.WEAVENET_MODELS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!BASE_URL || !API_KEY) {
  console.error('Missing WEAVENET_BASE_URL or WEAVENET_API_KEY environment variables.');
  process.exit(2);
}

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const url = (endpoint) => `${BASE_URL.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;

async function request(endpoint, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url(endpoint), {
      ...init,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: controller.signal,
      redirect: 'error',
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  // 1. Free GET /responses availability check.
  // 200/405 -> supported (405 means the route exists but only accepts POST);
  // 404 -> unsupported; anything else (401/426/...) -> unknown.
  let endpointAvailability;
  try {
    const response = await request('responses', { method: 'GET' });
    endpointAvailability = response.ok || response.status === 405
      ? 'supported'
      : response.status === 404
        ? 'unsupported'
        : `unknown(${response.status})`;
  } catch {
    endpointAvailability = 'unknown';
  }
  console.log(`GET /responses  => ${endpointAvailability}`);

  // 2. List models.
  let models;
  const catalogResponse = await request('models', { method: 'GET' });
  if (!catalogResponse.ok) {
    console.error(`GET /models failed: ${catalogResponse.status}`);
    process.exit(1);
  }
  models = (await catalogResponse.json()).data ?? [];
  console.log(`GET /models    => ${models.length} models`);

  const candidates = models.filter((model) => !String(model.id).toLowerCase().startsWith('claude-'));
  if (ONLY.length) {
    candidates.filter((model) => ONLY.includes(model.id));
  }
  console.log(`Probing ${candidates.length} OpenAI-compatible model(s) via minimal POST /responses...\n`);

  if (endpointAvailability === 'unsupported') {
    console.log('Endpoint unsupported: every model falls back to Chat Completions. Skipping per-model probes.');
    return;
  }

  // 3. Minimal POST /responses per model, bounded concurrency.
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
    while (next < candidates.length) {
      const model = candidates[next++];
      const startedAt = Date.now();
      try {
        const response = await request('responses', {
          method: 'POST',
          body: JSON.stringify({
            model: model.id,
            input: [{ role: 'user', content: 'OK' }],
            max_output_tokens: 1,
            stream: false,
            store: false,
          }),
        });
        const elapsed = Date.now() - startedAt;
        if (response.ok) {
          results.push({ id: model.id, verdict: 'responses', detail: `${response.status} in ${elapsed}ms` });
        } else {
          const body = await response.text().catch(() => '');
          results.push({ id: model.id, verdict: 'chat', detail: `${response.status} ${body.slice(0, 120)}` });
        }
      } catch (error) {
        results.push({ id: model.id, verdict: 'chat', detail: `error: ${String(error).slice(0, 120)}` });
      }
    }
  });
  await Promise.all(workers);

  results.sort((a, b) => a.id.localeCompare(b.id));
  const supported = results.filter((entry) => entry.verdict === 'responses').length;
  for (const entry of results) {
    console.log(`  ${entry.verdict === 'responses' ? '✅' : '❌'} ${entry.id.padEnd(48)} ${entry.detail}`);
  }
  console.log(`\nSummary: ${supported}/${results.length} model(s) support the Responses API.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
