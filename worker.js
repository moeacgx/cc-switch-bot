// ===========================================================================
// CC-Switch Bot — Cloudflare Worker 单文件版
//
// 部署方式：
//   1. CF Dashboard → Workers → 创建 Worker → 粘贴此文件
//   2. Settings → Variables → 添加:
//      - BOT_TOKEN       (Telegram Bot Token)
//      - ENCRYPTION_KEY  (任意 32 位字符串，用于加密 API Key)
//      - ADMIN_USER_ID   (可选，限制只有你能用)
//   3. Settings → D1 Database Bindings → 变量名: DB → 选择你创建的 D1
//   4. 访问 https://你的worker.workers.dev/setup 注册 Webhook
//   5. 访问 https://你的worker.workers.dev/init-db  初始化数据库表
//
// D1 建库：Workers & Pages → D1 → Create database → 取名随意
//
// Telegram Bot: @BotFather → /newbot → 拿到 Token
//
// 一键安装同步 Agent 到任意服务器:
//   curl -fsSL https://你的worker.workers.dev/install.sh | bash
// ===========================================================================

// ========================== Crypto ==========================

const ALGO = 'AES-GCM';
const IV_BYTES = 12;

async function deriveKey(secret) {
  const raw = new TextEncoder().encode(secret.padEnd(32, '0').slice(0, 32));
  return crypto.subtle.importKey('raw', raw, { name: ALGO }, false, ['encrypt', 'decrypt']);
}

async function encrypt(plaintext, secret) {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: ALGO, iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(encrypted, secret) {
  const key = await deriveKey(secret);
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ct);
  return new TextDecoder().decode(pt);
}

function generateToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ========================== DB ==========================

const DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
  app_type TEXT NOT NULL DEFAULT 'claude', base_url TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL, model TEXT, api_format TEXT NOT NULL DEFAULT 'anthropic',
  is_current INTEGER NOT NULL DEFAULT 0, notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prov_user ON providers(user_id);
CREATE INDEX IF NOT EXISTS idx_prov_cur ON providers(user_id, app_type, is_current);
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
  provider_id TEXT, provider_name TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id, recorded_at);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY, api_token TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);`;

async function dbGetSettings(db, userId) {
  return db.prepare('SELECT * FROM settings WHERE user_id = ?').bind(userId).first();
}
async function dbUpsertSettings(db, userId, token) {
  await db.prepare('INSERT INTO settings(user_id,api_token,allowed,created_at) VALUES(?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET api_token=excluded.api_token').bind(userId, token, Date.now()).run();
}
async function dbListProviders(db, userId, appType) {
  const q = appType
    ? db.prepare('SELECT * FROM providers WHERE user_id=? AND app_type=? ORDER BY created_at').bind(userId, appType)
    : db.prepare('SELECT * FROM providers WHERE user_id=? ORDER BY app_type,created_at').bind(userId);
  return (await q.all()).results;
}
async function dbGetProvider(db, userId, id) {
  return db.prepare('SELECT * FROM providers WHERE id=? AND user_id=?').bind(id, userId).first();
}
async function dbGetCurrent(db, userId, appType) {
  return db.prepare('SELECT * FROM providers WHERE user_id=? AND app_type=? AND is_current=1 LIMIT 1').bind(userId, appType).first();
}
async function dbInsertProvider(db, p) {
  const now = Date.now();
  await db.prepare('INSERT INTO providers(id,user_id,name,app_type,base_url,api_key_encrypted,model,api_format,is_current,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(p.id, p.user_id, p.name, p.app_type, p.base_url, p.api_key_encrypted, p.model, p.api_format, p.is_current, p.notes, now, now).run();
}
async function dbDeleteProvider(db, userId, id) {
  return (await db.prepare('DELETE FROM providers WHERE id=? AND user_id=?').bind(id, userId).run()).meta.changes > 0;
}
async function dbSwitchProvider(db, userId, id) {
  const target = await dbGetProvider(db, userId, id);
  if (!target) return null;
  const now = Date.now();
  await db.batch([
    db.prepare('UPDATE providers SET is_current=0,updated_at=? WHERE user_id=? AND app_type=?').bind(now, userId, target.app_type),
    db.prepare('UPDATE providers SET is_current=1,updated_at=? WHERE id=? AND user_id=?').bind(now, id, userId),
  ]);
  return { ...target, is_current: 1 };
}
async function dbInsertUsage(db, userId, pId, pName, inTok, outTok) {
  await db.prepare('INSERT INTO usage_logs(user_id,provider_id,provider_name,input_tokens,output_tokens,recorded_at) VALUES(?,?,?,?,?,?)').bind(userId, pId, pName, inTok, outTok, Date.now()).run();
}
async function dbGetUsageSummary(db, userId, days) {
  const since = Date.now() - days * 86400000;
  return db.prepare('SELECT COALESCE(SUM(input_tokens),0) as ti, COALESCE(SUM(output_tokens),0) as to2, COUNT(*) as cnt FROM usage_logs WHERE user_id=? AND recorded_at>=?').bind(userId, since).first();
}
async function dbGetUsageByProvider(db, userId, days) {
  const since = Date.now() - days * 86400000;
  return (await db.prepare('SELECT COALESCE(provider_name,"unknown") as name, COALESCE(SUM(input_tokens),0) as ti, COALESCE(SUM(output_tokens),0) as to2, COUNT(*) as cnt FROM usage_logs WHERE user_id=? AND recorded_at>=? GROUP BY provider_name ORDER BY ti DESC').bind(userId, since).all()).results;
}

// ========================== Config Gen ==========================

function genClaudeConfig(baseUrl, apiKey, model, apiFormat) {
  const env = {};
  if (apiFormat === 'openai_chat' || apiFormat === 'openai_responses') {
    env.OPENAI_API_KEY = apiKey; env.OPENAI_BASE_URL = baseUrl;
  } else if (apiFormat === 'gemini_native') {
    env.GOOGLE_API_KEY = apiKey; env.GEMINI_BASE_URL = baseUrl;
  } else {
    env[apiKey.startsWith('sk-ant-') ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = apiKey;
    env.ANTHROPIC_BASE_URL = baseUrl;
  }
  if (model && (!apiFormat || apiFormat === 'anthropic')) env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  return JSON.stringify({ env }, null, 2);
}

function genCodexConfig(baseUrl, apiKey, model, providerName) {
  const safe = (providerName || 'custom').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'custom';
  let toml = `model_provider = "${safe}"\n`;
  if (model) toml += `model = "${model}"\n`;
  toml += `\n[model_providers.${safe}]\nbase_url = "${baseUrl}"\n`;
  return { toml, authJson: JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2) };
}

function genGeminiEnv(baseUrl, apiKey, model) {
  const lines = [`GEMINI_API_KEY=${apiKey}`];
  if (baseUrl) lines.push(`GEMINI_BASE_URL=${baseUrl}`);
  if (model) lines.push(`GEMINI_MODEL=${model}`);
  return lines.sort().join('\n') + '\n';
}

async function generateConfig(db, encKey, userId, appType) {
  const p = await dbGetCurrent(db, userId, appType);
  if (!p) return null;
  const apiKey = await decrypt(p.api_key_encrypted, encKey);
  switch (appType) {
    case 'claude': return { format: 'json', filename: 'settings.json', content: genClaudeConfig(p.base_url, apiKey, p.model, p.api_format), extra: null };
    case 'codex': { const c = genCodexConfig(p.base_url, apiKey, p.model, p.name); return { format: 'toml', filename: 'config.toml', content: c.toml, extra: { filename: 'auth.json', content: c.authJson } }; }
    case 'gemini': return { format: 'env', filename: '.env', content: genGeminiEnv(p.base_url, apiKey, p.model), extra: null };
    default: return null;
  }
}

// ========================== Health Check ==========================

async function checkProvider(db, encKey, userId, providerId) {
  const p = await dbGetProvider(db, userId, providerId);
  if (!p) return { status: 'failed', latencyMs: null, error: 'Not found', name: 'unknown', app: 'unknown' };
  const apiKey = await decrypt(p.api_key_encrypted, encKey);
  const base = { name: p.name, app: p.app_type };
  try {
    const { latencyMs } = await measureStream(p.app_type, p.base_url, apiKey, p.model, p.api_format);
    return { ...base, status: latencyMs <= 6000 ? 'operational' : 'degraded', latencyMs };
  } catch (e) {
    return { ...base, status: 'failed', latencyMs: null, error: e.message?.slice(0, 200) };
  }
}

async function measureStream(appType, baseUrl, apiKey, model, apiFormat) {
  const base = baseUrl.replace(/\/$/, '');
  let url, headers, body;
  if (appType === 'claude') {
    url = `${base}/v1/messages`;
    headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (apiKey.startsWith('sk-ant-')) headers['x-api-key'] = apiKey;
    else { headers['Authorization'] = `Bearer ${apiKey}`; headers['x-api-key'] = apiKey; }
    body = JSON.stringify({ model: model || 'claude-sonnet-4-20250514', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'Hi' }] });
  } else if (appType === 'codex') {
    url = `${base}/v1/responses`;
    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Accept': 'text/event-stream' };
    body = JSON.stringify({ model: model || 'gpt-4.1', stream: true, input: [{ role: 'user', content: 'Hi' }] });
  } else {
    const m = model || 'gemini-2.0-flash';
    url = `${base}/v1beta/models/${m}:streamGenerateContent?alt=sse`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
    body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const start = performance.now();
  try {
    const resp = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`); }
    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No body');
    const { done } = await reader.read();
    const latencyMs = Math.round(performance.now() - start);
    reader.cancel().catch(() => {});
    if (done) throw new Error('Empty stream');
    return { latencyMs };
  } finally { clearTimeout(timer); }
}

// ========================== Telegram Helpers ==========================

async function tgApi(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) console.error(`TG ${method} error:`, await r.text());
}
async function tgSend(token, chatId, p) { await tgApi(token, 'sendMessage', { chat_id: chatId, ...p }); }
async function tgEdit(token, chatId, msgId, p) { await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, ...p }); }
async function tgAnswer(token, cbId, text) { await tgApi(token, 'answerCallbackQuery', { callback_query_id: cbId, text }); }

function md(text, kb) { const r = { text, parse_mode: 'Markdown' }; if (kb) r.reply_markup = kb; return r; }
function mkKb(rows) { return { inline_keyboard: rows }; }
function btn(text, data) { return { text, callback_data: data }; }
function fmtTok(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }

function providerListKb(providers) {
  const rows = [];
  for (const p of providers) {
    rows.push([btn(`${p.is_current ? '✅ ' : ''}${p.name} [${p.app_type}]`, `noop:${p.id}`)]);
    rows.push([btn('🔄 切换', `switch:${p.id}`), btn('🔍 测试', `test:${p.id}`), btn('🗑 删除', `delc:${p.id}`)]);
  }
  return mkKb(rows);
}

// ========================== Bot Commands ==========================

async function cmdStart(env, userId) {
  let s = await dbGetSettings(env.DB, userId);
  let msg;
  if (s) { msg = `已注册，你的 API Token:\n\`${s.api_token}\``; }
  else { const t = generateToken(); await dbUpsertSettings(env.DB, userId, t); msg = `注册成功！API Token:\n\`${t}\``; }
  return md(`🤖 *CC-Switch Bot*\n\n${msg}\n\n/add — 添加供应商\n/list — 供应商列表\n/switch — 切换\n/test — 测试连通性\n/config — 查看配置\n/stats — 用量统计\n/token — 查看/重置 Token\n/help — 帮助`);
}

async function cmdHelp() {
  return md(`📖 *CC-Switch Bot*\n\n*供应商:*\n/add \`<名称> <URL> <Key> [模型] [应用]\`\n/list — 列表 (可点按钮操作)\n/switch — 切换\n/current [claude|codex|gemini]\n/delete\n\n*诊断:*\n/test — 连通性测试\n/stats — 用量统计\n\n*配置:*\n/config [claude|codex|gemini]\n/token [reset]\n\n*一键安装同步 Agent:*\n\`curl -fsSL <Worker地址>/install.sh | bash\`\n\n应用类型: claude(默认) codex gemini`);
}

async function cmdAdd(env, userId, args) {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 3 || !parts[0]) return md(`📝 *添加供应商*\n\n\`/add <名称> <URL> <Key> [模型] [应用]\`\n\n例:\n\`/add official https://api.anthropic.com sk-ant-xxx\`\n\`/add relay https://api.openai.com/v1 sk-xxx gpt-4.1 codex\``);
  const [name, baseUrl, apiKey, model, appType] = parts;
  const app = ['claude', 'codex', 'gemini'].includes(appType || '') ? appType : 'claude';
  const fmt = app === 'codex' ? 'openai_responses' : app === 'gemini' ? 'gemini_native' : 'anthropic';
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Array.from(crypto.getRandomValues(new Uint8Array(3))).map(b => b.toString(16).padStart(2, '0')).join('');
  const enc = await encrypt(apiKey, env.ENCRYPTION_KEY);
  await dbInsertProvider(env.DB, { id, user_id: userId, name, app_type: app, base_url: baseUrl, api_key_encrypted: enc, model: model || null, api_format: fmt, is_current: 0, notes: null });
  const all = await dbListProviders(env.DB, userId, app);
  let auto = '';
  if (all.length === 1) { await dbSwitchProvider(env.DB, userId, id); auto = ' (已自动设为当前 ✅)'; }
  return md(`✅ *已添加*${auto}\n\nID: \`${id}\`\n名称: ${name}\n应用: ${app}\nURL: \`${baseUrl}\`\n模型: ${model || 'default'}`);
}

async function cmdList(env, userId) {
  const ps = await dbListProviders(env.DB, userId);
  if (!ps.length) return md('📋 暂无供应商，用 /add 添加');
  let t = '📋 *供应商列表:*\n\n';
  for (const p of ps) t += `${p.is_current ? '✅' : '⬜'} *${p.name}* \`[${p.app_type}]\`\n   ID: \`${p.id}\`\n   URL: \`${p.base_url}\`\n   模型: ${p.model || 'default'}\n\n`;
  return md(t, providerListKb(ps));
}

async function cmdSwitch(env, userId, args) {
  const id = args.trim();
  if (!id) {
    const ps = await dbListProviders(env.DB, userId);
    if (!ps.length) return md('无供应商');
    return md('🔄 *选择要切换的供应商:*', mkKb(ps.map(p => [btn(`${p.is_current ? '✅ ' : ''}${p.name} [${p.app_type}]`, `switch:${p.id}`)])));
  }
  const r = await dbSwitchProvider(env.DB, userId, id);
  if (!r) return md(`❌ 未找到 \`${id}\``);
  return md(`✅ 已切换到 *${r.name}* [${r.app_type}]\n\n本地 Agent 将在下次同步时生效`);
}

async function cmdCurrent(env, userId, args) {
  const app = ['claude', 'codex', 'gemini'].includes(args.trim()) ? args.trim() : 'claude';
  const p = await dbGetCurrent(env.DB, userId, app);
  if (!p) return md(`*${app}* 暂无活跃供应商`);
  return md(`✅ *当前 ${app} 供应商:*\n\n${p.name}\nID: \`${p.id}\`\nURL: \`${p.base_url}\`\n模型: ${p.model || 'default'}`);
}

async function cmdTest(env, userId, args) {
  const id = args.trim();
  if (!id) {
    let t = '🔍 *测试当前供应商...*\n\n'; let tested = false;
    for (const app of ['claude', 'codex', 'gemini']) {
      const cur = await dbGetCurrent(env.DB, userId, app);
      if (cur) {
        tested = true;
        const r = await checkProvider(env.DB, env.ENCRYPTION_KEY, userId, cur.id);
        const icon = r.status === 'operational' ? '🟢' : r.status === 'degraded' ? '🟡' : '🔴';
        t += `${icon} *${r.name}* [${app}]${r.latencyMs != null ? ' ' + r.latencyMs + 'ms' : ''}${r.error ? '\n   ' + r.error.slice(0, 100) : ''}\n`;
      }
    }
    return md(tested ? t : '无活跃供应商');
  }
  const r = await checkProvider(env.DB, env.ENCRYPTION_KEY, userId, id);
  const icon = r.status === 'operational' ? '🟢' : r.status === 'degraded' ? '🟡' : '🔴';
  return md(`${icon} *${r.name}*: ${r.status}${r.latencyMs != null ? ' (' + r.latencyMs + 'ms)' : ''}${r.error ? '\n\`' + r.error.slice(0, 200) + '\`' : ''}`);
}

async function cmdConfig(env, userId, args) {
  const app = ['claude', 'codex', 'gemini'].includes(args.trim()) ? args.trim() : '';
  if (!app) return md('📄 *选择应用:*', mkKb([[btn('Claude', 'config:claude'), btn('Codex', 'config:codex'), btn('Gemini', 'config:gemini')]]));
  const c = await generateConfig(env.DB, env.ENCRYPTION_KEY, userId, app);
  if (!c) return md(`*${app}* 无活跃供应商`);
  let t = `📄 *${app}* (\`${c.filename}\`):\n\`\`\`\n${c.content}\`\`\``;
  if (c.extra) t += `\n\`${c.extra.filename}\`:\n\`\`\`\n${c.extra.content}\`\`\``;
  return md(t);
}

async function cmdStats(env, userId, args) {
  const days = parseInt(args.trim()) || 0;
  if (!days) return md('📊 *用量统计:*', mkKb([[btn('7天', 'stats:7'), btn('30天', 'stats:30'), btn('90天', 'stats:90')]]));
  const s = await dbGetUsageSummary(env.DB, userId, days);
  const bp = await dbGetUsageByProvider(env.DB, userId, days);
  let t = `📊 *最近 ${days} 天*\n\n输入: ${fmtTok(s.ti)}\n输出: ${fmtTok(s.to2)}\n请求: ${s.cnt}\n`;
  if (bp.length) { t += '\n*按供应商:*\n'; for (const p of bp) t += `  📌 *${p.name}*: ${fmtTok(p.ti)}/${fmtTok(p.to2)} (${p.cnt}次)\n`; }
  return md(t);
}

async function cmdToken(env, userId, args) {
  if (args.trim() === 'reset') {
    const t = generateToken(); await dbUpsertSettings(env.DB, userId, t);
    return md(`🔑 *已重置*\n\n新 Token:\n\`${t}\`\n\n⚠️ 记得更新本地 Agent!`);
  }
  const s = await dbGetSettings(env.DB, userId);
  if (!s) return md('未注册，先 /start');
  return md(`🔑 *API Token:*\n\`${s.api_token}\`\n\n重置: \`/token reset\``);
}

async function cmdDelete(env, userId, args) {
  const id = args.trim();
  if (!id) {
    const ps = await dbListProviders(env.DB, userId);
    if (!ps.length) return md('无供应商');
    let t = '🗑 *删除供应商:*\n\n';
    for (const p of ps) t += `\`/delete ${p.id}\` — ${p.name} [${p.app_type}]\n`;
    return md(t);
  }
  const p = await dbGetProvider(env.DB, userId, id);
  if (!p) return md(`❌ 未找到 \`${id}\``);
  return md(`⚠️ 删除 *${p.name}* [${p.app_type}]?`, mkKb([[btn('✅ 确认删除', `dele:${id}`), btn('❌ 取消', 'delx')]]));
}

async function handleCallback(env, userId, data) {
  const [act, param] = data.split(':', 2);
  switch (act) {
    case 'switch': { const r = await dbSwitchProvider(env.DB, userId, param); return r ? md(`✅ 已切换到 *${r.name}*`) : md('❌ 未找到'); }
    case 'test': { const r = await checkProvider(env.DB, env.ENCRYPTION_KEY, userId, param); const i = r.status === 'operational' ? '🟢' : r.status === 'degraded' ? '🟡' : '🔴'; return md(`${i} *${r.name}*: ${r.status}${r.latencyMs != null ? ' ' + r.latencyMs + 'ms' : ''}${r.error ? '\n' + r.error.slice(0, 100) : ''}`); }
    case 'delc': { const p = await dbGetProvider(env.DB, userId, param); return p ? md(`⚠️ 删除 *${p.name}*?`, mkKb([[btn('✅ 确认', `dele:${param}`), btn('❌ 取消', 'delx')]])) : md('未找到'); }
    case 'dele': return md(await dbDeleteProvider(env.DB, userId, param) ? '✅ 已删除' : '❌ 失败');
    case 'delx': return md('已取消');
    case 'config': return await cmdConfig(env, userId, param);
    case 'stats': return await cmdStats(env, userId, param);
    case 'noop': return md('💡 用下方按钮操作');
    default: return md('未知操作');
  }
}

// ========================== REST API ==========================

async function handleApi(req, env, path) {
  const authH = req.headers.get('Authorization');
  if (!authH?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
  const tok = authH.slice(7).trim();
  const row = await env.DB.prepare('SELECT user_id,allowed FROM settings WHERE api_token=?').bind(tok).first();
  if (!row || !row.allowed) return json({ error: 'Invalid token' }, 401);
  const uid = row.user_id;
  const url = new URL(req.url);

  if (path === '/api/config' && req.method === 'GET') {
    const app = url.searchParams.get('app') || 'claude';
    const c = await generateConfig(env.DB, env.ENCRYPTION_KEY, uid, app);
    if (!c) return json({ error: `No provider for ${app}` }, 404);
    if (url.searchParams.get('format') === 'raw') return new Response(c.content, { headers: { 'Content-Type': c.format === 'json' ? 'application/json' : 'text/plain' } });
    return json({ appType: app, filename: c.filename, content: c.content, extraFile: c.extra });
  }
  if (path === '/api/providers' && req.method === 'GET') {
    return json({ providers: await dbListProviders(env.DB, uid, url.searchParams.get('app') || undefined) });
  }
  if (path === '/api/current' && req.method === 'GET') {
    const p = await dbGetCurrent(env.DB, uid, url.searchParams.get('app') || 'claude');
    return p ? json({ provider: p }) : json({ error: 'No active provider' }, 404);
  }
  if (path === '/api/stats' && req.method === 'POST') {
    try { const b = await req.json(); await dbInsertUsage(env.DB, uid, b.provider_id || null, b.provider_name || null, b.input_tokens || 0, b.output_tokens || 0); return json({ ok: true }); } catch { return json({ error: 'Bad request' }, 400); }
  }
  if (path === '/api/stats' && req.method === 'GET') {
    const days = parseInt(url.searchParams.get('days') || '30') || 30;
    const s = await dbGetUsageSummary(env.DB, uid, days);
    return json({ totalInputTokens: s.ti, totalOutputTokens: s.to2, requestCount: s.cnt });
  }
  return json({ error: 'Not found' }, 404);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

// ========================== Install Script ==========================

function getInstallScript(origin) {
  return `#!/usr/bin/env bash
set -euo pipefail
RED='\\033[0;31m';GREEN='\\033[0;32m';YELLOW='\\033[1;33m';CYAN='\\033[0;36m';BOLD='\\033[1m';NC='\\033[0m'
info(){ echo -e "\${CYAN}[INFO]\${NC} $*"; }; ok(){ echo -e "\${GREEN}[OK]\${NC} $*"; }; warn(){ echo -e "\${YELLOW}[WARN]\${NC} $*"; }; err(){ echo -e "\${RED}[ERROR]\${NC} $*"; }
API_BASE="${origin}"
INSTALL_DIR="\${HOME}/.cc-switch-bot"; SYNC_SCRIPT="\${INSTALL_DIR}/sync.sh"; ENV_FILE="\${INSTALL_DIR}/.env"; LOG_FILE="\${INSTALL_DIR}/sync.log"
echo ""; echo -e "\${BOLD}╔═══════════════════════════════════════════╗\${NC}"; echo -e "\${BOLD}║  CC-Switch Bot — 一键安装同步 Agent       ║\${NC}"; echo -e "\${BOLD}╚═══════════════════════════════════════════╝\${NC}"; echo ""
for cmd in curl crontab mktemp; do command -v "\$cmd" &>/dev/null || { err "缺少 \$cmd"; exit 1; }; done; ok "依赖检查通过"
if [ -z "\${CC_SWITCH_BOT_TOKEN:-}" ]; then echo -e "\${BOLD}请输入 API Token\${NC} (Bot 中发 /start 获取)"; read -rp "Token: " CC_SWITCH_BOT_TOKEN; echo ""; fi
[ -z "\$CC_SWITCH_BOT_TOKEN" ] && { err "Token 为空"; exit 1; }
info "验证 Token..."; curl -sf -H "Authorization: Bearer \${CC_SWITCH_BOT_TOKEN}" "\${API_BASE}/api/providers" >/dev/null || { err "验证失败"; exit 1; }; ok "验证通过"
if [ -z "\${CC_SWITCH_BOT_APPS:-}" ]; then echo "同步哪些应用? (空格分隔, 默认 claude)"; echo "  可选: claude codex gemini"; read -rp "[claude]: " CC_SWITCH_BOT_APPS; CC_SWITCH_BOT_APPS="\${CC_SWITCH_BOT_APPS:-claude}"; fi
for a in \$CC_SWITCH_BOT_APPS; do case "\$a" in claude) mkdir -p ~/.claude;; codex) mkdir -p "\${CODEX_HOME:-~/.codex}";; gemini) mkdir -p ~/.gemini;; esac; done
mkdir -p "\$INSTALL_DIR"
cat > "\$ENV_FILE" <<EOF
CC_SWITCH_BOT_API=\${API_BASE}
CC_SWITCH_BOT_TOKEN=\${CC_SWITCH_BOT_TOKEN}
CC_SWITCH_BOT_APPS=\${CC_SWITCH_BOT_APPS}
EOF
chmod 600 "\$ENV_FILE"; ok ".env 写入"
cat > "\$SYNC_SCRIPT" <<'SEOF'
#!/usr/bin/env bash
set -euo pipefail; D="\$(cd "\$(dirname "\$0")" && pwd)"; [ -f "\$D/.env" ] && set -a && . "\$D/.env" && set +a
[ -z "\${CC_SWITCH_BOT_API:-}" ] && exit 1; A="Authorization: Bearer \${CC_SWITCH_BOT_TOKEN}"
aw(){ local t="\$1" c="\$2"; [ -f "\$t" ] && [ "\$c" = "\$(cat "\$t" 2>/dev/null)" ] && return 0; local p; p=\$(mktemp "\${t}.XXXXXX"); printf '%s' "\$c">"\$p"; mv -f "\$p" "\$t"; echo "[\$(date +%H:%M:%S)] \$t updated"; }
for app in \${CC_SWITCH_BOT_APPS:-claude}; do case "\$app" in
claude) [ -d ~/.claude ] && { c=\$(curl -sf -H "\$A" "\${CC_SWITCH_BOT_API}/api/config?app=claude&format=raw") && aw ~/.claude/settings.json "\$c"; } || true;;
codex) d="\${CODEX_HOME:-~/.codex}"; [ -d "\$d" ] && { r=\$(curl -sf -H "\$A" "\${CC_SWITCH_BOT_API}/api/config?app=codex") && { t=\$(echo "\$r"|jq -r .content 2>/dev/null||python3 -c "import sys,json;print(json.load(sys.stdin)['content'])" 2>/dev/null) && aw "\$d/config.toml" "\$t"; a=\$(echo "\$r"|jq -r .extraFile.content 2>/dev/null||python3 -c "import sys,json;print(json.load(sys.stdin)['extraFile']['content'])" 2>/dev/null) && aw "\$d/auth.json" "\$a"; }; } || true;;
gemini) [ -d ~/.gemini ] && { c=\$(curl -sf -H "\$A" "\${CC_SWITCH_BOT_API}/api/config?app=gemini&format=raw") && aw ~/.gemini/.env "\$c"; } || true;;
esac; done
SEOF
chmod +x "\$SYNC_SCRIPT"; ok "sync.sh 安装完成"
crontab -l 2>/dev/null | grep -v cc-switch-bot-sync > /tmp/.cc-cron || true
echo "* * * * * \$SYNC_SCRIPT >> \$LOG_FILE 2>&1 # cc-switch-bot-sync" >> /tmp/.cc-cron
crontab /tmp/.cc-cron; rm -f /tmp/.cc-cron; ok "Cron 设置完成 (每分钟)"
bash "\$SYNC_SCRIPT" 2>&1 || warn "首次同步无数据 (先在 Bot 中 /add 供应商)"
echo ""; echo -e "\${GREEN}\${BOLD}  ✅ 安装完成!\${NC}"; echo ""
echo "  手动同步: bash \$SYNC_SCRIPT"; echo "  查看日志: tail -f \$LOG_FILE"; echo "  改配置:   nano \$ENV_FILE"
echo "  卸载:     crontab -l|grep -v cc-switch-bot-sync|crontab -;rm -rf \$INSTALL_DIR"; echo ""
`;
}

// ========================== Worker Entry ==========================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') return json({ ok: true, service: 'cc-switch-bot' });

    if (path === '/install.sh') return new Response(getInstallScript(url.origin), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

    if (path === '/init-db') {
      try {
        for (const stmt of DB_SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(stmt + ';').run();
        return json({ ok: true, message: 'Database tables created' });
      } catch (e) { return json({ ok: false, error: e.message }, 500); }
    }

    if (path === '/setup') {
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(url.origin + '/webhook')}`);
      return new Response(await r.text(), { headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        if (update.callback_query) {
          const uid = String(update.callback_query.from.id);
          const chatId = update.callback_query.message?.chat?.id;
          if (!chatId) return new Response('ok');
          if (env.ADMIN_USER_ID && env.ADMIN_USER_ID !== uid) { await tgAnswer(env.BOT_TOKEN, update.callback_query.id, '无权限'); return new Response('ok'); }
          const reply = await handleCallback(env, uid, update.callback_query.data || '');
          await tgEdit(env.BOT_TOKEN, chatId, update.callback_query.message.message_id, reply);
          await tgAnswer(env.BOT_TOKEN, update.callback_query.id);
          return new Response('ok');
        }
        if (update.message?.text) {
          const chatId = update.message.chat.id;
          const uid = String(update.message.from?.id || chatId);
          if (env.ADMIN_USER_ID && env.ADMIN_USER_ID !== uid) { await tgSend(env.BOT_TOKEN, chatId, { text: '⛔ 无权限' }); return new Response('ok'); }
          const m = update.message.text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)?$/);
          if (!m) return new Response('ok');
          const [, cmd, args = ''] = m;
          let reply;
          try {
            switch (cmd) {
              case 'start': reply = await cmdStart(env, uid); break;
              case 'help': reply = await cmdHelp(); break;
              case 'add': reply = await cmdAdd(env, uid, args); break;
              case 'list': reply = await cmdList(env, uid); break;
              case 'switch': reply = await cmdSwitch(env, uid, args); break;
              case 'current': reply = await cmdCurrent(env, uid, args); break;
              case 'test': reply = await cmdTest(env, uid, args); break;
              case 'config': reply = await cmdConfig(env, uid, args); break;
              case 'stats': reply = await cmdStats(env, uid, args); break;
              case 'token': reply = await cmdToken(env, uid, args); break;
              case 'delete': reply = await cmdDelete(env, uid, args); break;
              default: reply = { text: `未知命令 /${cmd}，试试 /help` };
            }
          } catch (e) { reply = { text: '❌ ' + (e.message || e) }; }
          if (reply) await tgSend(env.BOT_TOKEN, chatId, reply);
        }
        return new Response('ok');
      } catch (e) { console.error('Webhook:', e); return new Response('error', { status: 500 }); }
    }

    if (path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' } });
      return handleApi(request, env, path);
    }

    return new Response('CC-Switch Bot | /install.sh | /health', { status: 404 });
  }
};
