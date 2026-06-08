/**
 * API Token authentication for local Agent REST API calls.
 */

import { Env } from '../index';

export interface AuthResult {
  ok: boolean;
  userId?: string;
  error?: string;
}

/**
 * Validate Bearer token from Authorization header against D1 settings table.
 */
export async function validateApiToken(request: Request, env: Env): Promise<AuthResult> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, error: 'Missing or invalid Authorization header' };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { ok: false, error: 'Empty token' };
  }

  const row = await env.DB.prepare(
    'SELECT user_id, allowed FROM settings WHERE api_token = ?'
  ).bind(token).first<{ user_id: string; allowed: number }>();

  if (!row) {
    return { ok: false, error: 'Invalid token' };
  }

  if (!row.allowed) {
    return { ok: false, error: 'Account disabled' };
  }

  return { ok: true, userId: row.user_id };
}

/**
 * Generate a random API token (32 hex chars).
 */
export function generateApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
