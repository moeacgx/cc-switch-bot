/**
 * Config file generation service.
 * Generates Claude settings.json, Codex config.toml + auth.json, Gemini .env
 * matching the exact formats that cc-switch-cli produces.
 */

import { Env } from '../index';
import { decrypt } from '../utils/crypto';
import * as db from '../db/queries';

// ----- Claude Code → settings.json -----

interface ClaudeConfig {
  env: Record<string, string>;
  [key: string]: unknown;
}

export function generateClaudeConfig(baseUrl: string, apiKey: string, model?: string | null, apiFormat?: string): ClaudeConfig {
  const envBlock: Record<string, string> = {};

  // Determine the API key field name based on format
  if (apiFormat === 'openai_chat' || apiFormat === 'openai_responses') {
    envBlock['OPENAI_API_KEY'] = apiKey;
    envBlock['OPENAI_BASE_URL'] = baseUrl;
  } else if (apiFormat === 'gemini_native') {
    envBlock['GOOGLE_API_KEY'] = apiKey;
    envBlock['GEMINI_BASE_URL'] = baseUrl;
  } else {
    // Default: anthropic format
    // Use ANTHROPIC_API_KEY for keys starting with sk-ant-, otherwise ANTHROPIC_AUTH_TOKEN
    if (apiKey.startsWith('sk-ant-')) {
      envBlock['ANTHROPIC_API_KEY'] = apiKey;
    } else {
      envBlock['ANTHROPIC_AUTH_TOKEN'] = apiKey;
    }
    envBlock['ANTHROPIC_BASE_URL'] = baseUrl;
  }

  // Model settings
  if (model) {
    if (apiFormat === 'anthropic' || !apiFormat) {
      envBlock['ANTHROPIC_DEFAULT_SONNET_MODEL'] = model;
    }
  }

  return { env: envBlock };
}

// ----- Codex → config.toml + auth.json -----

export interface CodexConfig {
  toml: string;
  authJson: string;
}

export function generateCodexConfig(baseUrl: string, apiKey: string, model?: string | null, providerName?: string): CodexConfig {
  const safeName = (providerName || 'custom')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'custom';

  const lines: string[] = [
    `model_provider = "${safeName}"`,
  ];

  if (model) {
    lines.push(`model = "${model}"`);
  }

  lines.push('');
  lines.push(`[model_providers.${safeName}]`);
  lines.push(`base_url = "${baseUrl}"`);

  const toml = lines.join('\n') + '\n';
  const authJson = JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2);

  return { toml, authJson };
}

// ----- Gemini → .env -----

export function generateGeminiEnv(baseUrl: string, apiKey: string, model?: string | null): string {
  const lines: string[] = [];
  lines.push(`GEMINI_API_KEY=${apiKey}`);

  if (baseUrl) {
    lines.push(`GEMINI_BASE_URL=${baseUrl}`);
  }

  if (model) {
    lines.push(`GEMINI_MODEL=${model}`);
  }

  // Sort for consistency (matching cc-switch behavior)
  lines.sort();
  return lines.join('\n') + '\n';
}

// ----- Unified config generation -----

export interface GeneratedConfig {
  appType: string;
  format: string; // 'json' | 'toml' | 'env'
  filename: string;
  content: string;
  // Codex has a second file
  extraFile?: { filename: string; content: string };
}

export async function generateConfig(env: Env, userId: string, appType: string): Promise<GeneratedConfig | null> {
  const provider = await db.getCurrentProvider(env.DB, userId, appType);
  if (!provider) return null;

  const apiKey = await decrypt(provider.api_key_encrypted, env.ENCRYPTION_KEY);

  switch (appType) {
    case 'claude': {
      const config = generateClaudeConfig(provider.base_url, apiKey, provider.model, provider.api_format);
      return {
        appType: 'claude',
        format: 'json',
        filename: 'settings.json',
        content: JSON.stringify(config, null, 2),
      };
    }

    case 'codex': {
      const config = generateCodexConfig(provider.base_url, apiKey, provider.model, provider.name);
      return {
        appType: 'codex',
        format: 'toml',
        filename: 'config.toml',
        content: config.toml,
        extraFile: {
          filename: 'auth.json',
          content: config.authJson,
        },
      };
    }

    case 'gemini': {
      const content = generateGeminiEnv(provider.base_url, apiKey, provider.model);
      return {
        appType: 'gemini',
        format: 'env',
        filename: '.env',
        content,
      };
    }

    default:
      return null;
  }
}
