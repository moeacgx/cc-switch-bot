/**
 * Provider health check / connectivity test.
 * Replicates cc-switch's stream check logic using CF Worker fetch().
 *
 * Tests: send a minimal streaming request, measure time to first SSE chunk.
 *   - Operational: latency <= 6000ms
 *   - Degraded:    latency >  6000ms
 *   - Failed:      any error or timeout
 */

import { Env } from '../index';
import { decrypt } from '../utils/crypto';
import * as db from '../db/queries';

export type HealthStatus = 'operational' | 'degraded' | 'failed';

export interface HealthCheckResult {
  status: HealthStatus;
  latencyMs: number | null;
  error?: string;
  providerName: string;
  appType: string;
}

const TIMEOUT_MS = 15000;
const DEGRADED_THRESHOLD_MS = 6000;
const TEST_PROMPT = 'Hi';

/**
 * Run a health check against the given provider.
 */
export async function checkProvider(env: Env, userId: string, providerId: string): Promise<HealthCheckResult> {
  const provider = await db.getProvider(env.DB, userId, providerId);
  if (!provider) {
    return { status: 'failed', latencyMs: null, error: 'Provider not found', providerName: 'unknown', appType: 'unknown' };
  }

  const apiKey = await decrypt(provider.api_key_encrypted, env.ENCRYPTION_KEY);
  const base: HealthCheckResult = { status: 'failed', latencyMs: null, providerName: provider.name, appType: provider.app_type };

  try {
    let result: { latencyMs: number };

    switch (provider.app_type) {
      case 'claude':
        result = await checkClaude(provider.base_url, apiKey, provider.model, provider.api_format);
        break;
      case 'codex':
        result = await checkCodex(provider.base_url, apiKey, provider.model);
        break;
      case 'gemini':
        result = await checkGemini(provider.base_url, apiKey, provider.model);
        break;
      default:
        return { ...base, error: `Unsupported app type: ${provider.app_type}` };
    }

    const status: HealthStatus = result.latencyMs <= DEGRADED_THRESHOLD_MS ? 'operational' : 'degraded';
    return { ...base, status, latencyMs: result.latencyMs };

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, error: msg };
  }
}

// ----- Claude (Anthropic API) -----

async function checkClaude(baseUrl: string, apiKey: string, model?: string | null, apiFormat?: string | null): Promise<{ latencyMs: number }> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  // Set auth headers based on format
  if (apiFormat === 'openai_chat' || apiFormat === 'openai_responses') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    // Anthropic native
    if (apiKey.startsWith('sk-ant-')) {
      headers['x-api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey;
    }
  }

  const body = JSON.stringify({
    model: model || 'claude-sonnet-4-20250514',
    max_tokens: 1,
    stream: true,
    messages: [{ role: 'user', content: TEST_PROMPT }],
  });

  return measureStreamLatency(url, { method: 'POST', headers, body });
}

// ----- Codex (OpenAI Responses API) -----

async function checkCodex(baseUrl: string, apiKey: string, model?: string | null): Promise<{ latencyMs: number }> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/responses`;

  const body = JSON.stringify({
    model: model || 'gpt-4.1',
    stream: true,
    input: [{ role: 'user', content: TEST_PROMPT }],
  });

  return measureStreamLatency(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream',
    },
    body,
  });
}

// ----- Gemini -----

async function checkGemini(baseUrl: string, apiKey: string, model?: string | null): Promise<{ latencyMs: number }> {
  const m = model || 'gemini-2.0-flash';
  const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${m}:streamGenerateContent?alt=sse`;

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
  });

  return measureStreamLatency(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body,
  });
}

// ----- Stream latency measurement -----

async function measureStreamLatency(url: string, init: RequestInit): Promise<{ latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const start = performance.now();

  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    // Read first chunk to confirm streaming works
    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body');

    const { done } = await reader.read();
    const latencyMs = Math.round(performance.now() - start);

    // Cancel the rest — we only care about first chunk
    reader.cancel().catch(() => {});

    if (done) throw new Error('Empty stream response');

    return { latencyMs };
  } finally {
    clearTimeout(timer);
  }
}
