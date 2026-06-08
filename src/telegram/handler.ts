/**
 * Telegram Webhook handler.
 * Receives updates from Telegram, routes to command handlers, sends replies.
 */

import { Env } from '../index';
import * as commands from './commands';

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TgMessage {
  message_id: number;
  from?: { id: number; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
}

interface TgCallbackQuery {
  id: string;
  from: { id: number };
  message?: { chat: { id: number }; message_id: number };
  data?: string;
}

/**
 * Process a Telegram webhook update.
 */
export async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  if (update.message?.text) {
    await handleMessage(update.message, env);
  }
}

async function handleMessage(message: TgMessage, env: Env): Promise<void> {
  const chatId = message.chat.id;
  const userId = String(message.from?.id || chatId);
  const text = message.text || '';

  // Check admin restriction if configured
  if (env.ADMIN_USER_ID && env.ADMIN_USER_ID !== userId) {
    await sendMessage(env, chatId, { text: '⛔ Unauthorized. This bot is private.' });
    return;
  }

  // Parse command and arguments
  const match = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)?$/);
  if (!match) return;

  const [, cmd, args = ''] = match;
  let reply;

  try {
    switch (cmd) {
      case 'start':
        reply = await commands.cmdStart(env, userId);
        break;
      case 'help':
        reply = await commands.cmdHelp();
        break;
      case 'add':
        reply = await commands.cmdAdd(env, userId, args);
        break;
      case 'list':
        reply = await commands.cmdList(env, userId);
        break;
      case 'switch':
        reply = await commands.cmdSwitch(env, userId, args);
        break;
      case 'current':
        reply = await commands.cmdCurrent(env, userId, args);
        break;
      case 'test':
        reply = await commands.cmdTest(env, userId, args);
        break;
      case 'config':
        reply = await commands.cmdConfig(env, userId, args);
        break;
      case 'stats':
        reply = await commands.cmdStats(env, userId, args);
        break;
      case 'token':
        reply = await commands.cmdToken(env, userId, args);
        break;
      case 'delete':
        reply = await commands.cmdDelete(env, userId, args);
        break;
      default:
        reply = { text: `Unknown command: /${cmd}\n\nUse /help for available commands.` };
    }
  } catch (e) {
    console.error('Command error:', e);
    reply = { text: `❌ Error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (reply) {
    await sendMessage(env, chatId, reply);
  }
}

async function handleCallbackQuery(query: TgCallbackQuery, env: Env): Promise<void> {
  const userId = String(query.from.id);
  const chatId = query.message?.chat.id;
  const data = query.data || '';

  if (!chatId) return;

  // Check admin restriction
  if (env.ADMIN_USER_ID && env.ADMIN_USER_ID !== userId) {
    await answerCallbackQuery(env, query.id, 'Unauthorized');
    return;
  }

  try {
    const reply = await commands.handleCallback(env, userId, data);

    // Edit the original message with the response
    await editMessage(env, chatId, query.message!.message_id, reply);
    await answerCallbackQuery(env, query.id);
  } catch (e) {
    console.error('Callback error:', e);
    await answerCallbackQuery(env, query.id, 'Error processing request');
  }
}

// ============================================================
// Telegram API helpers
// ============================================================

async function sendMessage(env: Env, chatId: number, payload: { text: string; parse_mode?: string; reply_markup?: unknown }): Promise<void> {
  await telegramApi(env, 'sendMessage', { chat_id: chatId, ...payload } as Record<string, unknown>);
}

async function editMessage(env: Env, chatId: number, messageId: number, payload: { text: string; parse_mode?: string; reply_markup?: unknown }): Promise<void> {
  await telegramApi(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    ...payload,
  } as Record<string, unknown>);
}

async function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  await telegramApi(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}

async function telegramApi(env: Env, method: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Telegram API error (${method}):`, text);
  }

  return resp.json();
}
