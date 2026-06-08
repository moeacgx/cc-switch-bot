// ===========================================================================
// CC-Switch Bot — Cloudflare Worker 单文件版 v2
//
// 全内联键盘交互，零命令行参数，所有操作点点点完成。
//
// 部署方式：
//   1. CF Dashboard → Workers → 创建 Worker → 粘贴此文件
//   2. Settings → Variables → 添加:
//      - BOT_TOKEN       (Telegram Bot Token)
//      - ENCRYPTION_KEY  (任意 32 位字符串)
//      - ADMIN_USER_ID   (可选，限制只有你能用)
//   3. Settings → D1 Database Bindings → 变量名: DB → 选择你创建的 D1
//   4. 访问 https://你的worker.workers.dev/init-db  初始化数据库
//   5. 访问 https://你的worker.workers.dev/setup 注册 Webhook
// ===========================================================================

// ========================== Crypto ==========================
const ALGO = 'AES-GCM', IV_BYTES = 12;
async function deriveKey(s) { return crypto.subtle.importKey('raw', new TextEncoder().encode(s.padEnd(32, '0').slice(0, 32)), { name: ALGO }, false, ['encrypt', 'decrypt']); }
async function encrypt(pt, s) { const k = await deriveKey(s), iv = crypto.getRandomValues(new Uint8Array(IV_BYTES)), ct = await crypto.subtle.encrypt({ name: ALGO, iv }, k, new TextEncoder().encode(pt)); const c = new Uint8Array(iv.length + ct.byteLength); c.set(iv); c.set(new Uint8Array(ct), iv.length); return btoa(String.fromCharCode(...c)); }
async function decrypt(enc, s) { const k = await deriveKey(s), c = Uint8Array.from(atob(enc), x => x.charCodeAt(0)); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: ALGO, iv: c.slice(0, IV_BYTES) }, k, c.slice(IV_BYTES))); }
function genToken() { return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join(''); }
function genId(name) { const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); return s + '-' + Array.from(crypto.getRandomValues(new Uint8Array(3))).map(b => b.toString(16).padStart(2, '0')).join(''); }

// ========================== DB Schema ==========================
const DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, app_type TEXT NOT NULL DEFAULT 'claude', base_url TEXT NOT NULL, api_key_encrypted TEXT NOT NULL, model TEXT, api_format TEXT NOT NULL DEFAULT 'anthropic', is_current INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_prov_user ON providers(user_id);
CREATE INDEX IF NOT EXISTS idx_prov_cur ON providers(user_id, app_type, is_current);
CREATE TABLE IF NOT EXISTS usage_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, provider_id TEXT, provider_name TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, recorded_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id, recorded_at);
CREATE TABLE IF NOT EXISTS settings (user_id TEXT PRIMARY KEY, api_token TEXT NOT NULL, allowed INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (user_id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);`;

// ========================== DB Helpers ==========================
const now = () => Date.now();
async function dbSettings(db, uid) { return db.prepare('SELECT * FROM settings WHERE user_id=?').bind(uid).first(); }
async function dbUpsertSettings(db, uid, tok) { await db.prepare('INSERT INTO settings(user_id,api_token,allowed,created_at) VALUES(?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET api_token=excluded.api_token').bind(uid, tok, now()).run(); }
async function dbProviders(db, uid, app) { const q = app ? db.prepare('SELECT * FROM providers WHERE user_id=? AND app_type=? ORDER BY created_at').bind(uid, app) : db.prepare('SELECT * FROM providers WHERE user_id=? ORDER BY app_type,created_at').bind(uid); return (await q.all()).results; }
async function dbProvider(db, uid, id) { return db.prepare('SELECT * FROM providers WHERE id=? AND user_id=?').bind(id, uid).first(); }
async function dbCurrent(db, uid, app) { return db.prepare('SELECT * FROM providers WHERE user_id=? AND app_type=? AND is_current=1 LIMIT 1').bind(uid, app).first(); }
async function dbInsertProv(db, p) { const n = now(); await db.prepare('INSERT INTO providers(id,user_id,name,app_type,base_url,api_key_encrypted,model,api_format,is_current,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(p.id,p.user_id,p.name,p.app_type,p.base_url,p.api_key_encrypted,p.model,p.api_format,p.is_current,p.notes,n,n).run(); }
async function dbDeleteProv(db, uid, id) { return (await db.prepare('DELETE FROM providers WHERE id=? AND user_id=?').bind(id, uid).run()).meta.changes > 0; }
async function dbSwitch(db, uid, id) { const t = await dbProvider(db, uid, id); if (!t) return null; const n = now(); await db.batch([db.prepare('UPDATE providers SET is_current=0,updated_at=? WHERE user_id=? AND app_type=?').bind(n,uid,t.app_type), db.prepare('UPDATE providers SET is_current=1,updated_at=? WHERE id=? AND user_id=?').bind(n,id,uid)]); return { ...t, is_current: 1 }; }
async function dbUsageSummary(db, uid, days) { return db.prepare('SELECT COALESCE(SUM(input_tokens),0) as ti,COALESCE(SUM(output_tokens),0) as to2,COUNT(*) as cnt FROM usage_logs WHERE user_id=? AND recorded_at>=?').bind(uid, now()-days*864e5).first(); }
async function dbUsageByProv(db, uid, days) { return (await db.prepare('SELECT COALESCE(provider_name,"unknown") as name,COALESCE(SUM(input_tokens),0) as ti,COALESCE(SUM(output_tokens),0) as to2,COUNT(*) as cnt FROM usage_logs WHERE user_id=? AND recorded_at>=? GROUP BY provider_name ORDER BY ti DESC').bind(uid, now()-days*864e5).all()).results; }
async function dbInsertUsage(db, uid, pId, pName, iT, oT) { await db.prepare('INSERT INTO usage_logs(user_id,provider_id,provider_name,input_tokens,output_tokens,recorded_at) VALUES(?,?,?,?,?,?)').bind(uid,pId,pName,iT,oT,now()).run(); }

// -- Conversation state --
async function getConvo(db, uid) { const r = await db.prepare('SELECT state,data FROM conversations WHERE user_id=?').bind(uid).first(); return r ? { state: r.state, data: JSON.parse(r.data) } : null; }
async function setConvo(db, uid, state, data) { await db.prepare('INSERT INTO conversations(user_id,state,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at=excluded.updated_at').bind(uid, state, JSON.stringify(data), now()).run(); }
async function clearConvo(db, uid) { await db.prepare('DELETE FROM conversations WHERE user_id=?').bind(uid).run(); }

// ========================== Config Gen ==========================
function genClaudeConfig(url, key, model, fmt) { const e = {}; if (fmt==='openai_chat'||fmt==='openai_responses') { e.OPENAI_API_KEY=key;e.OPENAI_BASE_URL=url; } else if (fmt==='gemini_native') { e.GOOGLE_API_KEY=key;e.GEMINI_BASE_URL=url; } else { e[key.startsWith('sk-ant-')?'ANTHROPIC_API_KEY':'ANTHROPIC_AUTH_TOKEN']=key;e.ANTHROPIC_BASE_URL=url; } if (model&&(!fmt||fmt==='anthropic')) e.ANTHROPIC_DEFAULT_SONNET_MODEL=model; return JSON.stringify({env:e},null,2); }
function genCodexConfig(url, key, model, name) { const s=(name||'custom').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')||'custom'; let t=`model_provider = "${s}"\n`; if(model) t+=`model = "${model}"\n`; t+=`\n[model_providers.${s}]\nbase_url = "${url}"\n`; return { toml: t, auth: JSON.stringify({OPENAI_API_KEY:key},null,2) }; }
function genGeminiEnv(url, key, model) { const l=[`GEMINI_API_KEY=${key}`]; if(url)l.push(`GEMINI_BASE_URL=${url}`); if(model)l.push(`GEMINI_MODEL=${model}`); return l.sort().join('\n')+'\n'; }
async function genConfig(db, ek, uid, app) { const p=await dbCurrent(db,uid,app); if(!p)return null; const k=await decrypt(p.api_key_encrypted,ek); switch(app){ case'claude':return{fmt:'json',fn:'settings.json',content:genClaudeConfig(p.base_url,k,p.model,p.api_format),extra:null}; case'codex':{const c=genCodexConfig(p.base_url,k,p.model,p.name);return{fmt:'toml',fn:'config.toml',content:c.toml,extra:{fn:'auth.json',content:c.auth}};} case'gemini':return{fmt:'env',fn:'.env',content:genGeminiEnv(p.base_url,k,p.model),extra:null}; default:return null; } }

// ========================== Health Check ==========================
async function checkProv(db, ek, uid, pid) {
  const p = await dbProvider(db, uid, pid); if (!p) return { status:'failed', ms:null, err:'Not found', name:'?', app:'?' };
  const k = await decrypt(p.api_key_encrypted, ek);
  try { const { ms } = await streamTest(p.app_type, p.base_url, k, p.model, p.api_format); return { name:p.name, app:p.app_type, status:ms<=6000?'operational':'degraded', ms }; }
  catch(e) { return { name:p.name, app:p.app_type, status:'failed', ms:null, err:e.message?.slice(0,200) }; }
}
async function streamTest(app, base, key, model, fmt) {
  const b = base.replace(/\/$/,''); let url, headers, body;
  if (app==='claude') { url=b+'/v1/messages'; headers={'Content-Type':'application/json','anthropic-version':'2023-06-01'}; if(key.startsWith('sk-ant-'))headers['x-api-key']=key; else{headers['Authorization']='Bearer '+key;headers['x-api-key']=key;} body=JSON.stringify({model:model||'claude-sonnet-4-20250514',max_tokens:1,stream:true,messages:[{role:'user',content:'Hi'}]}); }
  else if (app==='codex') { url=b+'/v1/responses'; headers={'Content-Type':'application/json','Authorization':'Bearer '+key,'Accept':'text/event-stream'}; body=JSON.stringify({model:model||'gpt-4.1',stream:true,input:[{role:'user',content:'Hi'}]}); }
  else { const m=model||'gemini-2.0-flash'; url=b+`/v1beta/models/${m}:streamGenerateContent?alt=sse`; headers={'Content-Type':'application/json','x-goog-api-key':key}; body=JSON.stringify({contents:[{role:'user',parts:[{text:'Hi'}]}]}); }
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),15000); const start=performance.now();
  try { const r=await fetch(url,{method:'POST',headers,body,signal:ctrl.signal}); if(!r.ok){const t=await r.text().catch(()=>'');throw new Error(`HTTP ${r.status}: ${t.slice(0,200)}`);} const rd=r.body?.getReader(); if(!rd)throw new Error('No body'); const{done}=await rd.read(); const ms=Math.round(performance.now()-start); rd.cancel().catch(()=>{}); if(done)throw new Error('Empty'); return{ms}; } finally{clearTimeout(timer);}
}

// ========================== Telegram Helpers ==========================
async function tgApi(tok, method, body) { await fetch(`https://api.telegram.org/bot${tok}/${method}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }); }
async function tgSend(tok, cid, p) { await tgApi(tok, 'sendMessage', { chat_id:cid, ...p }); }
async function tgEdit(tok, cid, mid, p) { await tgApi(tok, 'editMessageText', { chat_id:cid, message_id:mid, ...p }); }
async function tgAnswer(tok, cbid, text) { await tgApi(tok, 'answerCallbackQuery', { callback_query_id:cbid, text }); }
function md(t, kb) { const r = { text: t, parse_mode: 'Markdown' }; if (kb) r.reply_markup = kb; return r; }
function kb(rows) { return { inline_keyboard: rows }; }
function btn(t, d) { return { text: t, callback_data: d }; }
function fmtTok(n) { return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n); }
function maskKey(k) { if (!k || k.length < 8) return '***'; return k.slice(0, 4) + '...' + k.slice(-4); }

// ========================== UI: Keyboards ==========================

// Reply Keyboard — 常驻在输入框下方
function replyKb() {
  return {
    keyboard: [
      ['➕ 添加供应商', '📋 供应商列表'],
      ['🔄 切换供应商', '✅ 当前状态'],
      ['🔍 连通性测试', '📄 查看配置'],
      ['📊 用量统计',  '🔑 API Token'],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// Map reply keyboard text → action
const REPLY_KB_MAP = {
  '➕ 添加供应商': 'add',
  '📋 供应商列表': 'list',
  '🔄 切换供应商': 'switch',
  '✅ 当前状态':   'current',
  '🔍 连通性测试': 'test',
  '📄 查看配置':   'config',
  '📊 用量统计':   'stats',
  '🔑 API Token': 'token',
};

function appTypeKb(action) {
  return kb([
    [btn('🟣 Claude', `${action}:claude`), btn('🟢 Codex', `${action}:codex`), btn('🔵 Gemini', `${action}:gemini`)],
    [btn('🏠 返回主菜单', 'menu:home')],
  ]);
}

function providerListKb(ps) {
  const rows = [];
  for (const p of ps) {
    const icon = p.app_type === 'claude' ? '🟣' : p.app_type === 'codex' ? '🟢' : '🔵';
    const cur = p.is_current ? ' ✅' : '';
    rows.push([btn(`${icon} ${p.name}${cur}`, `pinfo:${p.id}`)]);
  }
  rows.push([btn('➕ 添加供应商', 'menu:add'), btn('🏠 主菜单', 'menu:home')]);
  return kb(rows);
}

function providerActionKb(id) {
  return kb([
    [btn('🔄 切换到此', `switch:${id}`), btn('🔍 测试连通', `test:${id}`)],
    [btn('🗑 删除', `delc:${id}`), btn('◀️ 返回列表', 'menu:list')],
  ]);
}

function confirmDeleteKb(id) {
  return kb([[btn('✅ 确认删除', `dele:${id}`), btn('❌ 取消', 'menu:list')]]);
}

function skipKb(action) {
  return kb([[btn('⏭ 跳过 (使用默认)', action)]]);
}

function cancelKb() {
  return kb([[btn('❌ 取消', 'cancel')]]);
}

// ========================== Main Menu ==========================

function mainMenuMsg(name) {
  return {
    text: `🤖 *CC-Switch Bot*\n\n` +
      `欢迎${name ? ', *' + name + '*' : ''}！\n\n` +
      `在 Telegram 里管理你所有服务器的\nClaude / Codex / Gemini 供应商配置。\n\n` +
      `👇 用下方键盘操作：`,
    parse_mode: 'Markdown',
    reply_markup: replyKb(),
  };
}

// ========================== Conversation Flow: Add Provider ==========================
// States: add_app → add_name → add_url → add_key → add_model → add_confirm

async function startAddFlow(env, uid) {
  await setConvo(env.DB, uid, 'add_app', {});
  return md('➕ *添加供应商*\n\n🔸 第 1/5 步：选择应用类型', appTypeKb('addapp'));
}

async function handleAddCallback(env, uid, action, param) {
  const convo = await getConvo(env.DB, uid);

  if (action === 'addapp') {
    await setConvo(env.DB, uid, 'add_name', { app: param, fmt: param === 'codex' ? 'openai_responses' : param === 'gemini' ? 'gemini_native' : 'anthropic' });
    const icon = param === 'claude' ? '🟣' : param === 'codex' ? '🟢' : '🔵';
    return md(`➕ *添加供应商*\n\n${icon} 已选择 *${param}*\n\n🔸 第 2/5 步：输入供应商名称\n\n_例如: official, packy, relay_`, cancelKb());
  }

  if (action === 'addskip_model') {
    const d = convo?.data || {};
    d.model = null;
    return await confirmAdd(env, uid, d);
  }

  return null;
}

async function handleAddText(env, uid, text) {
  const convo = await getConvo(env.DB, uid);
  if (!convo) return null;

  const d = convo.data;

  switch (convo.state) {
    case 'add_name': {
      d.name = text.trim();
      if (!d.name) return md('❌ 名称不能为空，请重新输入：', cancelKb());
      await setConvo(env.DB, uid, 'add_url', d);
      return md(`➕ *添加供应商*\n\n📛 名称: *${d.name}*\n\n🔸 第 3/5 步：输入 API 地址 (Base URL)\n\n_例如: https://api.anthropic.com_`, cancelKb());
    }
    case 'add_url': {
      d.url = text.trim();
      if (!d.url.startsWith('http')) return md('❌ URL 必须以 http 开头，请重新输入：', cancelKb());
      await setConvo(env.DB, uid, 'add_key', d);
      return md(`➕ *添加供应商*\n\n📛 ${d.name}\n🌐 \`${d.url}\`\n\n🔸 第 4/5 步：输入 API Key\n\n🔒 _密钥会加密存储_`, cancelKb());
    }
    case 'add_key': {
      d.key = text.trim();
      if (!d.key || d.key.length < 5) return md('❌ API Key 太短，请重新输入：', cancelKb());
      await setConvo(env.DB, uid, 'add_model', d);
      return md(`➕ *添加供应商*\n\n📛 ${d.name}\n🌐 \`${d.url}\`\n🔑 \`${maskKey(d.key)}\`\n\n🔸 第 5/5 步：输入模型名称\n\n_直接输入模型名，或点跳过使用默认_`, skipKb('addskip_model'));
    }
    case 'add_model': {
      d.model = text.trim() || null;
      return await confirmAdd(env, uid, d);
    }
  }
  return null;
}

async function confirmAdd(env, uid, d) {
  await setConvo(env.DB, uid, 'add_confirm', d);
  const icon = d.app === 'claude' ? '🟣' : d.app === 'codex' ? '🟢' : '🔵';
  return md(
    `➕ *确认添加供应商*\n\n` +
    `${icon} 应用: *${d.app}*\n` +
    `📛 名称: *${d.name}*\n` +
    `🌐 地址: \`${d.url}\`\n` +
    `🔑 密钥: \`${maskKey(d.key)}\`\n` +
    `🤖 模型: ${d.model || '_默认_'}\n`,
    kb([[btn('✅ 确认添加', 'addconfirm'), btn('❌ 取消', 'cancel')]])
  );
}

async function executeAdd(env, uid) {
  const convo = await getConvo(env.DB, uid);
  if (!convo || convo.state !== 'add_confirm') return md('❌ 操作已过期');
  const d = convo.data;
  await clearConvo(env.DB, uid);

  const id = genId(d.name);
  const enc = await encrypt(d.key, env.ENCRYPTION_KEY);
  await dbInsertProv(env.DB, { id, user_id: uid, name: d.name, app_type: d.app, base_url: d.url, api_key_encrypted: enc, model: d.model || null, api_format: d.fmt, is_current: 0, notes: null });

  const all = await dbProviders(env.DB, uid, d.app);
  let auto = '';
  if (all.length === 1) { await dbSwitch(env.DB, uid, id); auto = '\n\n_（首个供应商，已自动设为当前 ✅）_'; }

  const icon = d.app === 'claude' ? '🟣' : d.app === 'codex' ? '🟢' : '🔵';
  return md(
    `✅ *供应商已添加！*${auto}\n\n` +
    `${icon} *${d.name}*\n` +
    `ID: \`${id}\`\n` +
    `地址: \`${d.url}\`\n` +
    `模型: ${d.model || '默认'}`,
    kb([[btn('📋 查看列表', 'menu:list'), btn('🏠 主菜单', 'menu:home')]])
  );
}

// ========================== Commands (all via callback) ==========================

async function showList(env, uid) {
  const ps = await dbProviders(env.DB, uid);
  if (!ps.length) return md('📋 *供应商列表*\n\n_还没有供应商，点下方添加一个吧！_', kb([[btn('➕ 添加供应商', 'menu:add'), btn('🏠 主菜单', 'menu:home')]]));
  let t = '📋 *供应商列表*\n\n_点击供应商查看详情和操作_\n';
  return md(t, providerListKb(ps));
}

async function showProviderInfo(env, uid, id) {
  const p = await dbProvider(env.DB, uid, id);
  if (!p) return md('❌ 供应商不存在');
  const icon = p.app_type === 'claude' ? '🟣' : p.app_type === 'codex' ? '🟢' : '🔵';
  const cur = p.is_current ? '✅ *当前使用中*\n' : '';
  return md(
    `${icon} *${p.name}*\n\n` +
    `${cur}` +
    `📱 应用: ${p.app_type}\n` +
    `🌐 地址: \`${p.base_url}\`\n` +
    `🤖 模型: ${p.model || '默认'}\n` +
    `🆔 ID: \`${p.id}\``,
    providerActionKb(id)
  );
}

async function showSwitch(env, uid) {
  const ps = await dbProviders(env.DB, uid);
  if (!ps.length) return md('🔄 *切换供应商*\n\n_还没有供应商_', kb([[btn('➕ 添加', 'menu:add'), btn('🏠 主菜单', 'menu:home')]]));
  const rows = [];
  for (const p of ps) {
    const icon = p.app_type === 'claude' ? '🟣' : p.app_type === 'codex' ? '🟢' : '🔵';
    const cur = p.is_current ? ' ✅' : '';
    rows.push([btn(`${icon} ${p.name}${cur}`, `switch:${p.id}`)]);
  }
  rows.push([btn('🏠 主菜单', 'menu:home')]);
  return md('🔄 *切换供应商*\n\n选择要启用的供应商：', kb(rows));
}

async function doSwitch(env, uid, id) {
  const r = await dbSwitch(env.DB, uid, id);
  if (!r) return md('❌ 未找到');
  const icon = r.app_type === 'claude' ? '🟣' : r.app_type === 'codex' ? '🟢' : '🔵';
  return md(`✅ *已切换！*\n\n${icon} *${r.name}* [${r.app_type}]\n\n_所有同步 Agent 将在 1 分钟内自动更新_`, kb([[btn('📋 列表', 'menu:list'), btn('🏠 主菜单', 'menu:home')]]));
}

async function showCurrent(env, uid) {
  let t = '✅ *当前活跃供应商*\n\n';
  let found = false;
  for (const app of ['claude', 'codex', 'gemini']) {
    const p = await dbCurrent(env.DB, uid, app);
    if (p) {
      found = true;
      const icon = app === 'claude' ? '🟣' : app === 'codex' ? '🟢' : '🔵';
      t += `${icon} *${app}*: ${p.name}\n   \`${p.base_url}\`\n   模型: ${p.model || '默认'}\n\n`;
    }
  }
  if (!found) t += '_暂无活跃供应商_';
  return md(t, kb([[btn('🔄 切换', 'menu:switch'), btn('🏠 主菜单', 'menu:home')]]));
}

async function showTest(env, uid, specificId) {
  if (specificId) {
    const r = await checkProv(env.DB, env.ENCRYPTION_KEY, uid, specificId);
    const icon = r.status === 'operational' ? '🟢' : r.status === 'degraded' ? '🟡' : '🔴';
    let t = `🔍 *连通性测试*\n\n${icon} *${r.name}* [${r.app}]\n状态: *${r.status}*\n`;
    if (r.ms != null) t += `延迟: *${r.ms}ms*\n`;
    if (r.err) t += `错误: \`${r.err}\`\n`;
    return md(t, kb([[btn('📋 列表', 'menu:list'), btn('🏠 主菜单', 'menu:home')]]));
  }
  // Test all current providers
  let t = '🔍 *连通性测试*\n\n'; let tested = false;
  for (const app of ['claude', 'codex', 'gemini']) {
    const cur = await dbCurrent(env.DB, uid, app);
    if (cur) {
      tested = true;
      const r = await checkProv(env.DB, env.ENCRYPTION_KEY, uid, cur.id);
      const icon = r.status === 'operational' ? '🟢' : r.status === 'degraded' ? '🟡' : '🔴';
      t += `${icon} *${r.name}* [${app}]${r.ms != null ? '  '+r.ms+'ms' : ''}${r.err ? '\n   '+r.err.slice(0,80) : ''}\n`;
    }
  }
  if (!tested) t += '_无活跃供应商_';
  return md(t, kb([[btn('🏠 主菜单', 'menu:home')]]));
}

async function showConfig(env, uid, app) {
  if (!app) return md('📄 *查看配置*\n\n选择应用类型：', appTypeKb('cfg'));
  const c = await genConfig(env.DB, env.ENCRYPTION_KEY, uid, app);
  if (!c) return md(`📄 *${app}* 暂无活跃供应商`, kb([[btn('🏠 主菜单', 'menu:home')]]));
  let t = `📄 *${app}* (\`${c.fn}\`)\n\`\`\`\n${c.content}\`\`\``;
  if (c.extra) t += `\n\`${c.extra.fn}\`:\n\`\`\`\n${c.extra.content}\`\`\``;
  return md(t, kb([[btn('🏠 主菜单', 'menu:home')]]));
}

async function showStats(env, uid, days) {
  if (!days) return md('📊 *用量统计*\n\n选择时间范围：', kb([[btn('7️⃣ 7天', 'stats:7'), btn('📅 30天', 'stats:30'), btn('📆 90天', 'stats:90')], [btn('🏠 主菜单', 'menu:home')]]));
  const s = await dbUsageSummary(env.DB, uid, days);
  const bp = await dbUsageByProv(env.DB, uid, days);
  let t = `📊 *最近 ${days} 天用量*\n\n📥 输入: *${fmtTok(s.ti)}* tokens\n📤 输出: *${fmtTok(s.to2)}* tokens\n🔢 请求: *${s.cnt}* 次\n`;
  if (bp.length) { t += '\n*按供应商:*\n'; for (const p of bp) t += `  📌 *${p.name}*\n     ${fmtTok(p.ti)} / ${fmtTok(p.to2)} / ${p.cnt}次\n`; }
  else t += '\n_暂无数据，运行 sync agent 后开始统计_';
  return md(t, kb([[btn('🏠 主菜单', 'menu:home')]]));
}

async function showToken(env, uid) {
  const s = await dbSettings(env.DB, uid);
  if (!s) return md('未注册，发 /start');
  return md(
    `🔑 *API Token*\n\n` +
    `\`${s.api_token}\`\n\n` +
    `本地 Agent 用此 Token 认证。\n` +
    `一键安装:\n\`curl -fsSL <Worker地址>/install.sh | bash\``,
    kb([[btn('🔄 重置 Token', 'token_reset')], [btn('🏠 主菜单', 'menu:home')]])
  );
}

async function resetToken(env, uid) {
  const t = genToken(); await dbUpsertSettings(env.DB, uid, t);
  return md(`🔑 *Token 已重置！*\n\n新 Token:\n\`${t}\`\n\n⚠️ _记得更新所有服务器的 sync agent_`, kb([[btn('🏠 主菜单', 'menu:home')]]));
}

// ========================== Callback Router ==========================

async function handleCallback(env, uid, data) {
  const [action, param] = data.split(':', 2);

  // Cancel any ongoing conversation
  if (action === 'cancel') { await clearConvo(env.DB, uid); return mainMenuMsg(); }

  // Main menu
  if (action === 'menu') {
    await clearConvo(env.DB, uid); // Clear any ongoing flow
    switch (param) {
      case 'home': return mainMenuMsg();
      case 'add': return await startAddFlow(env, uid);
      case 'list': return await showList(env, uid);
      case 'switch': return await showSwitch(env, uid);
      case 'current': return await showCurrent(env, uid);
      case 'test': return await showTest(env, uid, null);
      case 'config': return await showConfig(env, uid, null);
      case 'stats': return await showStats(env, uid, null);
      case 'token': return await showToken(env, uid);
    }
  }

  // Add flow callbacks
  if (action === 'addapp' || action === 'addskip_model') return await handleAddCallback(env, uid, action, param);
  if (action === 'addconfirm') return await executeAdd(env, uid);

  // Provider info
  if (action === 'pinfo') return await showProviderInfo(env, uid, param);

  // Switch
  if (action === 'switch') return await doSwitch(env, uid, param);

  // Test specific
  if (action === 'test') return await showTest(env, uid, param);

  // Delete
  if (action === 'delc') { const p = await dbProvider(env.DB, uid, param); return p ? md(`⚠️ *确认删除？*\n\n🗑 ${p.name} [${p.app_type}]\n\n_此操作不可恢复_`, confirmDeleteKb(param)) : md('未找到'); }
  if (action === 'dele') { await dbDeleteProv(env.DB, uid, param); return md('✅ *已删除*', kb([[btn('📋 列表', 'menu:list'), btn('🏠 主菜单', 'menu:home')]])); }

  // Config with app type
  if (action === 'cfg') return await showConfig(env, uid, param);

  // Stats with days
  if (action === 'stats') return await showStats(env, uid, parseInt(param));

  // Token reset
  if (action === 'token_reset') return await resetToken(env, uid);

  return md('❓ 未知操作', kb([[btn('🏠 主菜单', 'menu:home')]]));
}

// ========================== Message Handler ==========================

async function handleMessage(env, uid, text, firstName) {
  // 1. Check ongoing conversation flow (add provider steps)
  const convo = await getConvo(env.DB, uid);
  if (convo && convo.state.startsWith('add_')) {
    // If user taps a bottom keyboard button mid-flow, cancel the flow
    if (REPLY_KB_MAP[text]) {
      await clearConvo(env.DB, uid);
      // Fall through to handle the button
    } else {
      const result = await handleAddText(env, uid, text);
      if (result) return result;
    }
  }

  // 2. Reply Keyboard buttons (bottom persistent keyboard)
  const menuAction = REPLY_KB_MAP[text];
  if (menuAction) {
    // Ensure registered
    if (!(await dbSettings(env.DB, uid))) { const t = genToken(); await dbUpsertSettings(env.DB, uid, t); }
    switch (menuAction) {
      case 'add':     return await startAddFlow(env, uid);
      case 'list':    return await showList(env, uid);
      case 'switch':  return await showSwitch(env, uid);
      case 'current': return await showCurrent(env, uid);
      case 'test':    return await showTest(env, uid, null);
      case 'config':  return await showConfig(env, uid, null);
      case 'stats':   return await showStats(env, uid, null);
      case 'token':   return await showToken(env, uid);
    }
  }

  // 3. Slash commands
  if (text === '/start' || text === '/menu') {
    await clearConvo(env.DB, uid);
    if (!(await dbSettings(env.DB, uid))) { const t = genToken(); await dbUpsertSettings(env.DB, uid, t); }
    return mainMenuMsg(firstName);
  }
  if (text === '/help') return {
    text: `📖 *帮助*\n\n用输入框下方的键盘操作即可！\n\n*一键安装同步 Agent:*\n\`curl -fsSL <Worker地址>/install.sh | bash\``,
    parse_mode: 'Markdown',
    reply_markup: replyKb(),
  };

  // 4. Fallback
  return {
    text: '👇 用下方键盘操作，或发 /start 重新打开',
    reply_markup: replyKb(),
  };
}

// ========================== REST API ==========================

async function handleApi(req, env, path) {
  const ah = req.headers.get('Authorization');
  if (!ah?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
  const row = await env.DB.prepare('SELECT user_id,allowed FROM settings WHERE api_token=?').bind(ah.slice(7).trim()).first();
  if (!row || !row.allowed) return json({ error: 'Invalid token' }, 401);
  const uid = row.user_id, url = new URL(req.url);

  if (path === '/api/config') {
    const app = url.searchParams.get('app') || 'claude';
    const c = await genConfig(env.DB, env.ENCRYPTION_KEY, uid, app);
    if (!c) return json({ error: `No provider for ${app}` }, 404);
    if (url.searchParams.get('format') === 'raw') return new Response(c.content, { headers: { 'Content-Type': c.fmt === 'json' ? 'application/json' : 'text/plain' } });
    return json({ appType: app, filename: c.fn, content: c.content, extraFile: c.extra ? { filename: c.extra.fn, content: c.extra.content } : null });
  }
  if (path === '/api/providers') return json({ providers: await dbProviders(env.DB, uid, url.searchParams.get('app') || undefined) });
  if (path === '/api/current') { const p = await dbCurrent(env.DB, uid, url.searchParams.get('app') || 'claude'); return p ? json({ provider: p }) : json({ error: 'No active provider' }, 404); }
  if (path === '/api/stats' && req.method === 'POST') { try { const b = await req.json(); await dbInsertUsage(env.DB, uid, b.provider_id||null, b.provider_name||null, b.input_tokens||0, b.output_tokens||0); return json({ ok: true }); } catch { return json({ error: 'Bad body' }, 400); } }
  if (path === '/api/stats') { const d = parseInt(url.searchParams.get('days')||'30')||30, s = await dbUsageSummary(env.DB, uid, d); return json({ totalInput: s.ti, totalOutput: s.to2, requests: s.cnt }); }
  return json({ error: 'Not found' }, 404);
}
function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }); }

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
if [ -z "\${CC_SWITCH_BOT_TOKEN:-}" ]; then echo -e "\${BOLD}请输入 API Token\${NC} (Bot 中发 /start 获取)"; read -rp "Token: " CC_SWITCH_BOT_TOKEN < /dev/tty; echo ""; fi
[ -z "\$CC_SWITCH_BOT_TOKEN" ] && { err "Token 为空"; exit 1; }
info "验证 Token..."; curl -sf -H "Authorization: Bearer \${CC_SWITCH_BOT_TOKEN}" "\${API_BASE}/api/providers" >/dev/null || { err "验证失败"; exit 1; }; ok "验证通过"
if [ -z "\${CC_SWITCH_BOT_APPS:-}" ]; then echo "同步哪些应用? (空格分隔, 默认 claude)"; echo "  可选: claude codex gemini"; read -rp "[claude]: " CC_SWITCH_BOT_APPS < /dev/tty; CC_SWITCH_BOT_APPS="\${CC_SWITCH_BOT_APPS:-claude}"; fi
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
bash "\$SYNC_SCRIPT" 2>&1 || warn "首次同步无数据 (先在 Bot 中添加供应商)"
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

    if (path === '/health') return json({ ok: true });
    if (path === '/install.sh') return new Response(getInstallScript(url.origin), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (path === '/init-db') { try { for (const s of DB_SCHEMA.split(';').map(x=>x.trim()).filter(Boolean)) await env.DB.prepare(s+';').run(); return json({ ok:true, msg:'Tables created' }); } catch(e) { return json({ ok:false, error:e.message },500); } }
    if (path === '/setup') {
      const tg = (m, b) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${m}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b) });
      const [whRes, cmdRes] = await Promise.all([
        tg('setWebhook', { url: url.origin + '/webhook' }),
        tg('setMyCommands', { commands: [
          { command: 'start', description: '🏠 打开主菜单' },
          { command: 'help', description: '📖 帮助' },
        ]}),
      ]);
      const whResult = await whRes.json();
      return new Response(JSON.stringify({ webhook: whResult, commands: 'set' }, null, 2), { headers:{'Content-Type':'application/json'} });
    }

    if (path === '/webhook' && request.method === 'POST') {
      try {
        const u = await request.json();
        if (u.callback_query) {
          const uid = String(u.callback_query.from.id), cid = u.callback_query.message?.chat?.id;
          if (!cid) return new Response('ok');
          if (env.ADMIN_USER_ID && env.ADMIN_USER_ID !== uid) { await tgAnswer(env.BOT_TOKEN, u.callback_query.id, '⛔ 无权限'); return new Response('ok'); }
          const reply = await handleCallback(env, uid, u.callback_query.data || '');
          await tgEdit(env.BOT_TOKEN, cid, u.callback_query.message.message_id, reply);
          await tgAnswer(env.BOT_TOKEN, u.callback_query.id);
        } else if (u.message?.text) {
          const cid = u.message.chat.id, uid = String(u.message.from?.id || cid);
          if (env.ADMIN_USER_ID && env.ADMIN_USER_ID !== uid) { await tgSend(env.BOT_TOKEN, cid, { text: '⛔ 无权限' }); return new Response('ok'); }
          const reply = await handleMessage(env, uid, u.message.text, u.message.from?.first_name);
          if (reply) await tgSend(env.BOT_TOKEN, cid, reply);
        }
        return new Response('ok');
      } catch(e) { console.error('Webhook:', e); return new Response('error', { status: 500 }); }
    }

    if (path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Headers':'Authorization,Content-Type' } });
      return handleApi(request, env, path);
    }

    return new Response('CC-Switch Bot | /install.sh | /health', { status: 404 });
  }
};
