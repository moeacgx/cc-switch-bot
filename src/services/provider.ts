/**
 * Provider management service.
 * Handles CRUD + switching logic, delegates encryption to crypto util.
 */

import { Env } from '../index';
import { encrypt, decrypt } from '../utils/crypto';
import * as db from '../db/queries';

export interface ProviderInput {
  name: string;
  appType: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
  apiFormat?: string;
  notes?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  appType: string;
  baseUrl: string;
  model: string | null;
  apiFormat: string;
  isCurrent: boolean;
  notes: string | null;
  createdAt: number;
}

function generateProviderId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suffix = crypto.getRandomValues(new Uint8Array(3));
  const hex = Array.from(suffix).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${slug}-${hex}`;
}

function rowToInfo(row: db.ProviderRow): ProviderInfo {
  return {
    id: row.id,
    name: row.name,
    appType: row.app_type,
    baseUrl: row.base_url,
    model: row.model,
    apiFormat: row.api_format,
    isCurrent: row.is_current === 1,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function addProvider(env: Env, userId: string, input: ProviderInput): Promise<ProviderInfo> {
  const id = generateProviderId(input.name);
  const encrypted = await encrypt(input.apiKey, env.ENCRYPTION_KEY);

  const row: Omit<db.ProviderRow, 'created_at' | 'updated_at'> = {
    id,
    user_id: userId,
    name: input.name,
    app_type: input.appType || 'claude',
    base_url: input.baseUrl,
    api_key_encrypted: encrypted,
    model: input.model || null,
    api_format: input.apiFormat || 'anthropic',
    is_current: 0,
    notes: input.notes || null,
  };

  await db.insertProvider(env.DB, row);

  // If this is the first provider for this app_type, auto-set as current
  const allProviders = await db.listProviders(env.DB, userId, input.appType);
  if (allProviders.length === 1) {
    await db.switchProvider(env.DB, userId, id);
    return { ...rowToInfo({ ...row, created_at: Date.now(), updated_at: Date.now() }), isCurrent: true };
  }

  return rowToInfo({ ...row, created_at: Date.now(), updated_at: Date.now() });
}

export async function listProviders(env: Env, userId: string, appType?: string): Promise<ProviderInfo[]> {
  const rows = await db.listProviders(env.DB, userId, appType);
  return rows.map(rowToInfo);
}

export async function getProvider(env: Env, userId: string, providerId: string): Promise<ProviderInfo | null> {
  const row = await db.getProvider(env.DB, userId, providerId);
  return row ? rowToInfo(row) : null;
}

export async function getProviderApiKey(env: Env, userId: string, providerId: string): Promise<string | null> {
  const row = await db.getProvider(env.DB, userId, providerId);
  if (!row) return null;
  return decrypt(row.api_key_encrypted, env.ENCRYPTION_KEY);
}

export async function getCurrentProvider(env: Env, userId: string, appType: string): Promise<ProviderInfo | null> {
  const row = await db.getCurrentProvider(env.DB, userId, appType);
  return row ? rowToInfo(row) : null;
}

export async function switchProvider(env: Env, userId: string, providerId: string): Promise<ProviderInfo | null> {
  const row = await db.switchProvider(env.DB, userId, providerId);
  return row ? rowToInfo(row) : null;
}

export async function deleteProvider(env: Env, userId: string, providerId: string): Promise<boolean> {
  return db.deleteProvider(env.DB, userId, providerId);
}

/**
 * Get the decrypted API key for a provider row.
 */
export async function decryptProviderKey(env: Env, row: db.ProviderRow): Promise<string> {
  return decrypt(row.api_key_encrypted, env.ENCRYPTION_KEY);
}
