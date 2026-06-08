/**
 * CC-Switch Bot - Cloudflare Worker Entry Point
 *
 * Routes:
 *   POST /webhook           → Telegram Bot webhook
 *   GET  /api/config        → Config file for local agent
 *   GET  /api/providers     → Provider list
 *   GET  /api/current       → Current provider
 *   POST /api/stats         → Usage reporting
 *   GET  /api/stats         → Usage statistics
 *   GET  /health            → Health check
 *   GET  /install.sh        → One-click install script
 */

import { handleUpdate } from './telegram/handler';
import { handleApiRequest } from './api/routes';
import { INSTALL_SCRIPT } from './install-script';

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  ENCRYPTION_KEY: string;
  ADMIN_USER_ID?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Health check ---
    if (path === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'cc-switch-bot' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- Telegram Webhook ---
    if (path === '/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        await handleUpdate(update as any, env);
        return new Response('ok');
      } catch (e) {
        console.error('Webhook error:', e);
        return new Response('error', { status: 500 });
      }
    }

    // --- REST API (for local agent) ---
    if (path.startsWith('/api/')) {
      // CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          },
        });
      }

      return handleApiRequest(request, env, path);
    }

    // --- One-click install script ---
    if (path === '/install.sh' && request.method === 'GET') {
      return new Response(INSTALL_SCRIPT.replace(/\{\{API_BASE\}\}/g, url.origin), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // --- Setup helper: set webhook URL ---
    if (path === '/setup' && request.method === 'GET') {
      const webhookUrl = `${url.origin}/webhook`;
      const resp = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
      );
      const result = await resp.json();
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- 404 ---
    return new Response('Not Found', { status: 404 });
  },
};
