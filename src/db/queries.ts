/**
 * D1 database query helpers for providers, settings, and usage.
 */

import { Env } from '../index';

// ----- Types -----

export interface ProviderRow {
  id: string;
  user_id: string;
  name: string;
  app_type: string;
  base_url: string;
  api_key_encrypted: string;
  model: string | null;
  api_format: string;
  is_current: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface SettingsRow {
  user_id: string;
  api_token: string;
  allowed: number;
  created_at: number;
}

export interface UsageLogRow {
  id: number;
  user_id: string;
  provider_id: string | null;
  provider_name: string | null;
  input_tokens: number;
  output_tokens: number;
  recorded_at: number;
}

// ----- Settings -----

export async function getSettings(db: D1Database, userId: string): Promise<SettingsRow | null> {
  return db.prepare('SELECT * FROM settings WHERE user_id = ?')
    .bind(userId).first<SettingsRow>();
}

export async function upsertSettings(db: D1Database, userId: string, apiToken: string): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO settings (user_id, api_token, allowed, created_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET api_token = excluded.api_token`
  ).bind(userId, apiToken, now).run();
}

// ----- Providers -----

export async function listProviders(db: D1Database, userId: string, appType?: string): Promise<ProviderRow[]> {
  if (appType) {
    const result = await db.prepare(
      'SELECT * FROM providers WHERE user_id = ? AND app_type = ? ORDER BY created_at ASC'
    ).bind(userId, appType).all<ProviderRow>();
    return result.results;
  }
  const result = await db.prepare(
    'SELECT * FROM providers WHERE user_id = ? ORDER BY app_type, created_at ASC'
  ).bind(userId).all<ProviderRow>();
  return result.results;
}

export async function getProvider(db: D1Database, userId: string, providerId: string): Promise<ProviderRow | null> {
  return db.prepare(
    'SELECT * FROM providers WHERE id = ? AND user_id = ?'
  ).bind(providerId, userId).first<ProviderRow>();
}

export async function getCurrentProvider(db: D1Database, userId: string, appType: string): Promise<ProviderRow | null> {
  return db.prepare(
    'SELECT * FROM providers WHERE user_id = ? AND app_type = ? AND is_current = 1 LIMIT 1'
  ).bind(userId, appType).first<ProviderRow>();
}

export async function insertProvider(db: D1Database, provider: Omit<ProviderRow, 'created_at' | 'updated_at'>): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO providers (id, user_id, name, app_type, base_url, api_key_encrypted, model, api_format, is_current, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    provider.id, provider.user_id, provider.name, provider.app_type,
    provider.base_url, provider.api_key_encrypted, provider.model,
    provider.api_format, provider.is_current, provider.notes, now, now
  ).run();
}

export async function deleteProvider(db: D1Database, userId: string, providerId: string): Promise<boolean> {
  const result = await db.prepare(
    'DELETE FROM providers WHERE id = ? AND user_id = ?'
  ).bind(providerId, userId).run();
  return result.meta.changes > 0;
}

export async function switchProvider(db: D1Database, userId: string, providerId: string): Promise<ProviderRow | null> {
  // Get the target provider first
  const target = await getProvider(db, userId, providerId);
  if (!target) return null;

  // Unset current for this app_type, then set the target
  await db.batch([
    db.prepare(
      'UPDATE providers SET is_current = 0, updated_at = ? WHERE user_id = ? AND app_type = ?'
    ).bind(Date.now(), userId, target.app_type),
    db.prepare(
      'UPDATE providers SET is_current = 1, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(Date.now(), providerId, userId),
  ]);

  return { ...target, is_current: 1, updated_at: Date.now() };
}

export async function updateProvider(
  db: D1Database, userId: string, providerId: string,
  updates: Partial<Pick<ProviderRow, 'name' | 'base_url' | 'api_key_encrypted' | 'model' | 'api_format' | 'notes'>>
): Promise<boolean> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      setClauses.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (setClauses.length === 0) return false;

  setClauses.push('updated_at = ?');
  values.push(Date.now());
  values.push(providerId, userId);

  const result = await db.prepare(
    `UPDATE providers SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...values).run();
  return result.meta.changes > 0;
}

// ----- Usage -----

export async function insertUsageLog(
  db: D1Database, userId: string, providerId: string | null,
  providerName: string | null, inputTokens: number, outputTokens: number
): Promise<void> {
  await db.prepare(
    `INSERT INTO usage_logs (user_id, provider_id, provider_name, input_tokens, output_tokens, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(userId, providerId, providerName, inputTokens, outputTokens, Date.now()).run();
}

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  request_count: number;
}

export async function getUsageSummary(
  db: D1Database, userId: string, sinceDays: number = 30
): Promise<UsageSummary> {
  const since = Date.now() - sinceDays * 86400000;
  const row = await db.prepare(
    `SELECT
       COALESCE(SUM(input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(output_tokens), 0) as total_output_tokens,
       COUNT(*) as request_count
     FROM usage_logs WHERE user_id = ? AND recorded_at >= ?`
  ).bind(userId, since).first<UsageSummary>();
  return row || { total_input_tokens: 0, total_output_tokens: 0, request_count: 0 };
}

export interface ProviderUsageSummary {
  provider_name: string;
  total_input_tokens: number;
  total_output_tokens: number;
  request_count: number;
}

export async function getUsageByProvider(
  db: D1Database, userId: string, sinceDays: number = 30
): Promise<ProviderUsageSummary[]> {
  const since = Date.now() - sinceDays * 86400000;
  const result = await db.prepare(
    `SELECT
       COALESCE(provider_name, 'unknown') as provider_name,
       COALESCE(SUM(input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(output_tokens), 0) as total_output_tokens,
       COUNT(*) as request_count
     FROM usage_logs WHERE user_id = ? AND recorded_at >= ?
     GROUP BY provider_name ORDER BY total_input_tokens DESC`
  ).bind(userId, since).all<ProviderUsageSummary>();
  return result.results;
}
