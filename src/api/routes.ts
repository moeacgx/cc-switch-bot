/**
 * REST API routes for local Agent config sync and usage reporting.
 * All endpoints require Bearer token authentication.
 */

import { Env } from '../index';
import { validateApiToken } from '../utils/auth';
import * as configGen from '../services/config-gen';
import * as providerService from '../services/provider';
import * as statsService from '../services/stats';

/**
 * Route an API request to the appropriate handler.
 */
export async function handleApiRequest(request: Request, env: Env, path: string): Promise<Response> {
  // Authenticate
  const auth = await validateApiToken(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, 401);
  }
  const userId = auth.userId!;

  // Route
  const url = new URL(request.url);

  if (path === '/api/config' && request.method === 'GET') {
    return handleGetConfig(env, userId, url);
  }

  if (path === '/api/providers' && request.method === 'GET') {
    return handleListProviders(env, userId, url);
  }

  if (path === '/api/current' && request.method === 'GET') {
    return handleGetCurrent(env, userId, url);
  }

  if (path === '/api/stats' && request.method === 'POST') {
    return handleReportUsage(request, env, userId);
  }

  if (path === '/api/stats' && request.method === 'GET') {
    return handleGetStats(env, userId, url);
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

// ============================================================
// GET /api/config?app=claude|codex|gemini
// Returns raw config content for the specified app type.
// ============================================================

async function handleGetConfig(env: Env, userId: string, url: URL): Promise<Response> {
  const appType = url.searchParams.get('app') || 'claude';
  const format = url.searchParams.get('format'); // optional: 'raw' for raw text

  const config = await configGen.generateConfig(env, userId, appType);
  if (!config) {
    return jsonResponse({ error: `No active provider for ${appType}` }, 404);
  }

  // Return raw content (for direct file write) or structured JSON
  if (format === 'raw') {
    const contentType = config.format === 'json' ? 'application/json'
      : config.format === 'toml' ? 'application/toml'
      : 'text/plain';
    return new Response(config.content, {
      headers: { 'Content-Type': contentType },
    });
  }

  return jsonResponse({
    appType: config.appType,
    filename: config.filename,
    content: config.content,
    extraFile: config.extraFile || null,
  });
}

// ============================================================
// GET /api/providers?app=claude
// List all providers for the user.
// ============================================================

async function handleListProviders(env: Env, userId: string, url: URL): Promise<Response> {
  const appType = url.searchParams.get('app') || undefined;
  const providers = await providerService.listProviders(env, userId, appType);
  return jsonResponse({ providers });
}

// ============================================================
// GET /api/current?app=claude
// Get current active provider for the app type.
// ============================================================

async function handleGetCurrent(env: Env, userId: string, url: URL): Promise<Response> {
  const appType = url.searchParams.get('app') || 'claude';
  const provider = await providerService.getCurrentProvider(env, userId, appType);

  if (!provider) {
    return jsonResponse({ error: `No active provider for ${appType}` }, 404);
  }

  return jsonResponse({ provider });
}

// ============================================================
// POST /api/stats
// Report usage data from local agent.
// Body: { provider_id?, provider_name?, input_tokens, output_tokens }
// ============================================================

async function handleReportUsage(request: Request, env: Env, userId: string): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;
    const inputTokens = typeof body.input_tokens === 'number' ? body.input_tokens : 0;
    const outputTokens = typeof body.output_tokens === 'number' ? body.output_tokens : 0;
    const providerId = typeof body.provider_id === 'string' ? body.provider_id : null;
    const providerName = typeof body.provider_name === 'string' ? body.provider_name : null;

    await statsService.recordUsage(env, userId, providerId, providerName, inputTokens, outputTokens);
    return jsonResponse({ ok: true });
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }
}

// ============================================================
// GET /api/stats?days=30
// Get usage statistics.
// ============================================================

async function handleGetStats(env: Env, userId: string, url: URL): Promise<Response> {
  const days = parseInt(url.searchParams.get('days') || '30') || 30;
  const stats = await statsService.getStats(env, userId, days);
  return jsonResponse(stats);
}

// ============================================================
// Helpers
// ============================================================

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
