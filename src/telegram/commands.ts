/**
 * Telegram Bot command implementations.
 * Each command is a function that returns a Telegram sendMessage payload.
 */

import { Env } from '../index';
import * as providerService from '../services/provider';
import * as configGen from '../services/config-gen';
import * as healthCheck from '../services/health-check';
import * as statsService from '../services/stats';
import * as settingsDb from '../db/queries';
import { generateApiToken } from '../utils/auth';
import {
  providerListKeyboard,
  switchConfirmKeyboard,
  deleteConfirmKeyboard,
  configAppKeyboard,
  statsPeriodKeyboard,
  appTypeKeyboard,
} from './keyboard';

interface TgReply {
  text: string;
  parse_mode?: string;
  reply_markup?: unknown;
}

function md(text: string): TgReply {
  return { text, parse_mode: 'Markdown' };
}

function mdWithKeyboard(text: string, keyboard: unknown): TgReply {
  return { text, parse_mode: 'Markdown', reply_markup: keyboard };
}

// ============================================================
// /start - Register user + generate API token
// ============================================================

export async function cmdStart(env: Env, userId: string): Promise<TgReply> {
  let settings = await settingsDb.getSettings(env.DB, userId);
  let tokenMsg: string;

  if (settings) {
    tokenMsg = `Your API Token (already registered):\n\`${settings.api_token}\``;
  } else {
    const token = generateApiToken();
    await settingsDb.upsertSettings(env.DB, userId, token);
    tokenMsg = `Your API Token (save it!):\n\`${token}\``;
  }

  return md(
    `🤖 *CC-Switch Bot*\n\n` +
    `Manage Claude Code / Codex / Gemini providers remotely.\n\n` +
    `${tokenMsg}\n\n` +
    `*Commands:*\n` +
    `/add — Add a provider\n` +
    `/list — List providers\n` +
    `/switch — Switch provider\n` +
    `/current — Current provider\n` +
    `/test — Test connectivity\n` +
    `/config — View/download config\n` +
    `/stats — Usage statistics\n` +
    `/token — Show/reset API token\n` +
    `/help — Help`
  );
}

// ============================================================
// /help
// ============================================================

export async function cmdHelp(): Promise<TgReply> {
  return md(
    `📖 *CC-Switch Bot Help*\n\n` +
    `*Provider Management:*\n` +
    `/add — Add provider (interactive)\n` +
    `/list — List all providers\n` +
    `/switch — Switch current provider\n` +
    `/current — Show current provider\n` +
    `/delete — Delete a provider\n\n` +
    `*Diagnostics:*\n` +
    `/test — Test provider connectivity\n` +
    `/stats — Usage statistics\n\n` +
    `*Config:*\n` +
    `/config — View generated config\n` +
    `/token — Show/reset API token\n\n` +
    `*Add Provider Format:*\n` +
    `\`/add <name> <base_url> <api_key> [model] [app_type]\`\n` +
    `app\\_type: claude (default), codex, gemini\n\n` +
    `*REST API (for local agent):*\n` +
    `\`GET /api/config?app=claude\`\n` +
    `Header: \`Authorization: Bearer <your_token>\``
  );
}

// ============================================================
// /add - Add a provider
// ============================================================

export async function cmdAdd(env: Env, userId: string, args: string): Promise<TgReply> {
  // Parse: /add <name> <base_url> <api_key> [model] [app_type]
  const parts = args.trim().split(/\s+/);

  if (parts.length < 3 || !parts[0]) {
    return md(
      `📝 *Add Provider*\n\n` +
      `Format:\n` +
      `\`/add <name> <base_url> <api_key> [model] [app_type]\`\n\n` +
      `*Examples:*\n` +
      `\`/add official https://api.anthropic.com sk-ant-xxx\`\n` +
      `\`/add packy https://api.packy.com sk-xxx claude-sonnet-4-20250514\`\n` +
      `\`/add codex-relay https://api.openai.com/v1 sk-xxx gpt-4.1 codex\`\n\n` +
      `app\\_type: \`claude\` (default), \`codex\`, \`gemini\``
    );
  }

  const [name, baseUrl, apiKey, model, appType] = parts;
  const validAppTypes = ['claude', 'codex', 'gemini'];
  const resolvedAppType = validAppTypes.includes(appType || '') ? appType! : 'claude';

  // Determine api_format based on app_type
  let apiFormat = 'anthropic';
  if (resolvedAppType === 'codex') apiFormat = 'openai_responses';
  else if (resolvedAppType === 'gemini') apiFormat = 'gemini_native';

  try {
    const provider = await providerService.addProvider(env, userId, {
      name,
      appType: resolvedAppType,
      baseUrl,
      apiKey,
      model: model || undefined,
      apiFormat,
    });

    const currentMark = provider.isCurrent ? ' (auto-set as current ✅)' : '';
    return md(
      `✅ *Provider Added*${currentMark}\n\n` +
      `*ID:* \`${provider.id}\`\n` +
      `*Name:* ${provider.name}\n` +
      `*App:* ${provider.appType}\n` +
      `*URL:* \`${provider.baseUrl}\`\n` +
      `*Model:* ${provider.model || 'default'}`
    );
  } catch (e: unknown) {
    return md(`❌ Failed to add provider: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ============================================================
// /list - List all providers
// ============================================================

export async function cmdList(env: Env, userId: string): Promise<TgReply> {
  const providers = await providerService.listProviders(env, userId);

  if (providers.length === 0) {
    return md('📋 No providers configured.\n\nUse /add to add one.');
  }

  let text = '📋 *Your Providers:*\n\n';
  for (const p of providers) {
    const mark = p.isCurrent ? '✅ ' : '⬜ ';
    text += `${mark}*${p.name}* \`[${p.appType}]\`\n`;
    text += `   ID: \`${p.id}\`\n`;
    text += `   URL: \`${p.baseUrl}\`\n`;
    text += `   Model: ${p.model || 'default'}\n\n`;
  }

  return mdWithKeyboard(text, providerListKeyboard(providers));
}

// ============================================================
// /switch - Switch current provider
// ============================================================

export async function cmdSwitch(env: Env, userId: string, args: string): Promise<TgReply> {
  const providerId = args.trim();

  if (!providerId) {
    // Show selection keyboard
    const providers = await providerService.listProviders(env, userId);
    if (providers.length === 0) {
      return md('No providers. Use /add first.');
    }
    return mdWithKeyboard(
      '🔄 *Switch Provider*\nSelect which provider to activate:',
      switchConfirmKeyboard(providers)
    );
  }

  const result = await providerService.switchProvider(env, userId, providerId);
  if (!result) {
    return md(`❌ Provider \`${providerId}\` not found.`);
  }

  return md(
    `✅ *Switched to:* ${result.name}\n` +
    `*App:* ${result.appType}\n` +
    `*URL:* \`${result.baseUrl}\`\n\n` +
    `Local agent will pick up the change on next sync.`
  );
}

// ============================================================
// /current - Show current provider
// ============================================================

export async function cmdCurrent(env: Env, userId: string, args: string): Promise<TgReply> {
  const appType = args.trim() || 'claude';
  const validApps = ['claude', 'codex', 'gemini'];

  if (!validApps.includes(appType)) {
    return mdWithKeyboard('Select app type:', appTypeKeyboard('current'));
  }

  const provider = await providerService.getCurrentProvider(env, userId, appType);
  if (!provider) {
    return md(`No active provider for *${appType}*.\n\nUse /add to add one.`);
  }

  return md(
    `✅ *Current ${appType} Provider:*\n\n` +
    `*Name:* ${provider.name}\n` +
    `*ID:* \`${provider.id}\`\n` +
    `*URL:* \`${provider.baseUrl}\`\n` +
    `*Model:* ${provider.model || 'default'}`
  );
}

// ============================================================
// /test - Test provider connectivity
// ============================================================

export async function cmdTest(env: Env, userId: string, args: string): Promise<TgReply> {
  const providerId = args.trim();

  if (!providerId) {
    const providers = await providerService.listProviders(env, userId);
    if (providers.length === 0) return md('No providers. Use /add first.');

    // Test current providers for all app types
    let text = '🔍 *Testing current providers...*\n\n';
    const appTypes = ['claude', 'codex', 'gemini'];
    let tested = false;

    for (const appType of appTypes) {
      const current = await providerService.getCurrentProvider(env, userId, appType);
      if (current) {
        tested = true;
        // Find the provider row to get provider_id
        const providers = await providerService.listProviders(env, userId, appType);
        const currentProvider = providers.find(p => p.isCurrent);
        if (currentProvider) {
          const result = await healthCheck.checkProvider(env, userId, currentProvider.id);
          const icon = result.status === 'operational' ? '🟢' : result.status === 'degraded' ? '🟡' : '🔴';
          text += `${icon} *${result.providerName}* [${appType}]\n`;
          if (result.latencyMs !== null) {
            text += `   Latency: ${result.latencyMs}ms\n`;
          }
          if (result.error) {
            text += `   Error: ${result.error.slice(0, 100)}\n`;
          }
          text += '\n';
        }
      }
    }

    if (!tested) return md('No active providers to test.');
    return md(text);
  }

  // Test specific provider
  const result = await healthCheck.checkProvider(env, userId, providerId);
  const icon = result.status === 'operational' ? '🟢' : result.status === 'degraded' ? '🟡' : '🔴';

  let text = `${icon} *${result.providerName}* [${result.appType}]\n`;
  text += `Status: *${result.status}*\n`;
  if (result.latencyMs !== null) {
    text += `Latency: *${result.latencyMs}ms*\n`;
  }
  if (result.error) {
    text += `Error: \`${result.error.slice(0, 200)}\`\n`;
  }

  return md(text);
}

// ============================================================
// /config - View/download config
// ============================================================

export async function cmdConfig(env: Env, userId: string, args: string): Promise<TgReply> {
  const appType = args.trim() || '';

  if (!appType || !['claude', 'codex', 'gemini'].includes(appType)) {
    return mdWithKeyboard('📄 *Select app type to view config:*', configAppKeyboard());
  }

  const config = await configGen.generateConfig(env, userId, appType);
  if (!config) {
    return md(`No active provider for *${appType}*. Use /add first.`);
  }

  let text = `📄 *${appType} Config* (\`${config.filename}\`):\n\n`;
  text += '```\n' + config.content + '```\n';

  if (config.extraFile) {
    text += `\n📄 \`${config.extraFile.filename}\`:\n`;
    text += '```\n' + config.extraFile.content + '```\n';
  }

  return md(text);
}

// ============================================================
// /stats - Usage statistics
// ============================================================

export async function cmdStats(env: Env, userId: string, args: string): Promise<TgReply> {
  const days = parseInt(args.trim()) || 0;

  if (!days) {
    return mdWithKeyboard('📊 *Usage Statistics*\nSelect time period:', statsPeriodKeyboard());
  }

  const stats = await statsService.getStats(env, userId, days);

  let text = `📊 *Usage (last ${days} days)*\n\n`;
  text += `*Total:*\n`;
  text += `  Input tokens: ${formatTokens(stats.totalInputTokens)}\n`;
  text += `  Output tokens: ${formatTokens(stats.totalOutputTokens)}\n`;
  text += `  Requests: ${stats.requestCount}\n\n`;

  if (stats.byProvider.length > 0) {
    text += `*By Provider:*\n`;
    for (const p of stats.byProvider) {
      text += `  📌 *${p.providerName}*\n`;
      text += `    In: ${formatTokens(p.inputTokens)} / Out: ${formatTokens(p.outputTokens)} / ${p.requestCount} req\n`;
    }
  } else {
    text += `_No usage data recorded yet._\n`;
    text += `_Run \`sync.sh\` with usage reporting to start collecting data._`;
  }

  return md(text);
}

// ============================================================
// /token - Show/reset API token
// ============================================================

export async function cmdToken(env: Env, userId: string, args: string): Promise<TgReply> {
  const action = args.trim().toLowerCase();

  if (action === 'reset') {
    const newToken = generateApiToken();
    await settingsDb.upsertSettings(env.DB, userId, newToken);
    return md(`🔑 *Token Reset*\n\nNew API Token:\n\`${newToken}\`\n\n⚠️ Update your local sync.sh!`);
  }

  const settings = await settingsDb.getSettings(env.DB, userId);
  if (!settings) {
    return md('Not registered. Use /start first.');
  }

  return md(
    `🔑 *Your API Token:*\n\`${settings.api_token}\`\n\n` +
    `Use in local agent sync script:\n` +
    '```\nAuthorization: Bearer ' + settings.api_token + '\n```\n\n' +
    `To reset: \`/token reset\``
  );
}

// ============================================================
// /delete - Delete a provider
// ============================================================

export async function cmdDelete(env: Env, userId: string, args: string): Promise<TgReply> {
  const providerId = args.trim();

  if (!providerId) {
    const providers = await providerService.listProviders(env, userId);
    if (providers.length === 0) return md('No providers to delete.');

    let text = '🗑 *Delete Provider*\nSelect provider:\n\n';
    for (const p of providers) {
      text += `\`/delete ${p.id}\` — ${p.name} [${p.appType}]\n`;
    }
    return md(text);
  }

  const provider = await providerService.getProvider(env, userId, providerId);
  if (!provider) {
    return md(`❌ Provider \`${providerId}\` not found.`);
  }

  return mdWithKeyboard(
    `⚠️ Delete *${provider.name}* [${provider.appType}]?\n\nThis cannot be undone.`,
    deleteConfirmKeyboard(providerId)
  );
}

// ============================================================
// Callback query handlers (inline keyboard)
// ============================================================

export async function handleCallback(env: Env, userId: string, data: string): Promise<TgReply> {
  const [action, param] = data.split(':', 2);

  switch (action) {
    case 'switch': {
      const result = await providerService.switchProvider(env, userId, param);
      if (!result) return md(`❌ Provider not found.`);
      return md(`✅ Switched to *${result.name}* [${result.appType}]`);
    }

    case 'test': {
      const result = await healthCheck.checkProvider(env, userId, param);
      const icon = result.status === 'operational' ? '🟢' : result.status === 'degraded' ? '🟡' : '🔴';
      let text = `${icon} *${result.providerName}*: ${result.status}`;
      if (result.latencyMs !== null) text += ` (${result.latencyMs}ms)`;
      if (result.error) text += `\nError: \`${result.error.slice(0, 100)}\``;
      return md(text);
    }

    case 'del_confirm': {
      const provider = await providerService.getProvider(env, userId, param);
      if (!provider) return md('Provider not found.');
      return mdWithKeyboard(
        `⚠️ Delete *${provider.name}*?`,
        deleteConfirmKeyboard(param)
      );
    }

    case 'del_exec': {
      const ok = await providerService.deleteProvider(env, userId, param);
      return md(ok ? '✅ Provider deleted.' : '❌ Failed to delete.');
    }

    case 'del_cancel':
      return md('Cancelled.');

    case 'config':
      return cmdConfig(env, userId, param);

    case 'current':
      return cmdCurrent(env, userId, param);

    case 'stats': {
      const days = parseInt(param) || 30;
      return cmdStats(env, userId, String(days));
    }

    case 'noop':
      return md('💡 Use the buttons below to manage this provider.');

    default:
      return md('Unknown action.');
  }
}

// ============================================================
// Helpers
// ============================================================

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
