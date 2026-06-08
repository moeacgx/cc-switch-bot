/**
 * Set Telegram webhook URL for the bot.
 *
 * Usage:
 *   BOT_TOKEN=xxx WORKER_URL=https://cc-switch-bot.xxx.workers.dev node scripts/set-webhook.mjs
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const WORKER_URL = process.env.WORKER_URL;

if (!BOT_TOKEN || !WORKER_URL) {
  console.error('Usage: BOT_TOKEN=xxx WORKER_URL=https://your-worker.workers.dev node scripts/set-webhook.mjs');
  process.exit(1);
}

const webhookUrl = `${WORKER_URL}/webhook`;
const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;

fetch(apiUrl)
  .then(r => r.json())
  .then(result => {
    console.log('Set webhook result:', JSON.stringify(result, null, 2));
    if (result.ok) {
      console.log(`\n✅ Webhook set to: ${webhookUrl}`);
    } else {
      console.error('\n❌ Failed to set webhook');
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
