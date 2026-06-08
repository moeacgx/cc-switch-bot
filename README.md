<div align="center">

# 🤖 CC-Switch Bot

**Telegram Bot 远程管理 Claude Code / Codex / Gemini 供应商配置**

一个 Cloudflare Worker 单文件部署的 Telegram Bot，在手机上一键切换 API 供应商，所有服务器自动同步。

基于 [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) 核心功能精简重写。

</div>

---

## 它能做什么

```
你的手机 Telegram          CF Worker (后端)           你的服务器们
      │                        │                     ┌──── 服务器A
      │  点 🔄 切换供应商       │                     │
      │ ─────────────────────> │  写入 D1 数据库      ├──── 服务器B
      │                        │                     │
      │                        │  ← 每分钟 cron 拉取  ├──── 服务器C
      │                        │     sync.sh          │
      │                        │ ──────────────────> 自动覆盖 settings.json
      │                        │
      │                 Claude Code 下次启动就用新供应商
```

**在手机上切换，所有服务器 1 分钟内自动生效。**

---

## 功能预览

### 📱 常驻底部键盘

发送 `/start` 后，输入框下方会出现 8 个常驻按钮，所有操作点点点完成：

```
╔═══════════════╦═══════════════╗
║ ➕ 添加供应商  ║ 📋 供应商列表  ║
╠═══════════════╬═══════════════╣
║ 🔄 切换供应商  ║ ✅ 当前状态   ║
╠═══════════════╬═══════════════╣
║ 🔍 连通性测试  ║ 📄 查看配置   ║
╠═══════════════╬═══════════════╣
║ 📊 用量统计   ║ 🔑 API Token  ║
╚═══════════════╩═══════════════╝
```

### ➕ 添加供应商（分步引导）

全程交互式，不用记任何命令格式：

```
点 ➕ 添加供应商
  ↓
🔸 第 1/4 步：选应用类型
  [🟣 Claude] [🟢 Codex] [🔵 Gemini]
  ↓
🔸 第 2/4 步：输入名称  → 你打字，例: "猫佬API"
  ↓
🔸 第 3/4 步：输入 URL   → https://maolaoapi.com/
  ↓
🔸 第 4/4 步：输入 Key   → sk-xxx (加密存储)
  ↓
🔄 自动拉取模型列表...
  ↓
🔸 发现 15 个模型，多选要添加的：
  [⬜ claude-sonnet-4]     [⬜ claude-opus-4]
  [⬜ claude-haiku-4]      [⬜ claude-3.5-sonnet]
  [🔘 全选]  [✅ 确认选择 (3)]
  [⏭ 跳过 (使用默认模型)]
  ↓
✅ 已添加 3 个供应商！
```

### 📥 获取模型列表（已有供应商）

在供应商详情页点 **📥 获取模型**，随时从 API 拉取可用模型并批量添加：

```
🟣 猫佬API

✅ 当前使用中
📱 应用: claude
🌐 地址: https://maolaoapi.com/
🤖 模型: 默认
🆔 ID: api-25064c

[🔄 切换到此] [🔍 测试连通]
[📥 获取模型] [🗑 删除]
```

点 📥 获取模型 →

```
📥 猫佬API 模型列表

发现 15 个模型
选择要批量添加为独立供应商的模型

[⬜ claude-sonnet-4]     [⬜ claude-opus-4]
[⬜ claude-haiku-4]      [⬜ claude-3.5-sonnet]
[⬜ gpt-4.1]             [⬜ gpt-4o]
...
[🔘 全选]  [✅ 批量添加 (0)]
```

### 🔍 连通性测试

自动测试所有活跃供应商的流式 API 响应延迟：

```
🔍 连通性测试

🟢 猫佬API [claude]  326ms
🟢 Codex官方 [codex]  891ms
🟡 Gemini中转 [gemini]  7200ms (降级)
```

判定标准：🟢 ≤6s 正常 / 🟡 >6s 降级 / 🔴 超时或失败

### 📄 查看配置

生成与 cc-switch-cli 完全兼容的配置文件预览：

```
📄 claude (settings.json)

{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
    "ANTHROPIC_BASE_URL": "https://maolaoapi.com/"
  }
}
```

---

## 部署

### 方式一：单文件粘贴（推荐）

**零命令行，全在浏览器完成：**

1. 复制 [`worker.js`](worker.js) 全部内容
2. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers → 创建 Worker → 粘贴代码
3. **Settings → Variables** 添加：

   | 变量名 | 值 | 说明 |
   |--------|-----|------|
   | `BOT_TOKEN` | `123456:ABC...` | 从 [@BotFather](https://t.me/BotFather) 获取 |
   | `ENCRYPTION_KEY` | 任意 32 位字符串 | 用于加密 API Key |
   | `ADMIN_USER_ID` | 你的 Telegram 数字 ID | (可选) 限制只有你能用 |

4. **Settings → D1 Database Bindings** → 变量名填 `DB` → 选择你创建的 D1 数据库
5. 浏览器访问 `https://你的worker.workers.dev/init-db` → 自动建表
6. 浏览器访问 `https://你的worker.workers.dev/setup` → 注册 Webhook

> **D1 建库：** Workers & Pages → D1 → Create database → 取个名就行

### 方式二：Wrangler CLI

```bash
git clone https://github.com/moeacgx/cc-switch-bot.git
cd cc-switch-bot
npm install

# 创建 D1
wrangler d1 create cc-switch-bot-db
# 把返回的 database_id 填入 wrangler.toml

# 建表
wrangler d1 execute cc-switch-bot-db --remote --file=schema.sql

# 设置 secrets
wrangler secret put BOT_TOKEN
wrangler secret put ENCRYPTION_KEY
wrangler secret put ADMIN_USER_ID  # 可选

# 部署
wrangler deploy

# 注册 Webhook
# 浏览器访问 https://你的worker.workers.dev/setup
```

---

## 服务器同步

### 一键安装

在任意 Linux 服务器上运行：

```bash
curl -fsSL https://你的worker.workers.dev/install.sh | bash
```

脚本会交互式询问 API Token（在 Bot 中发 `/start` 获取），然后自动：

- 安装 sync 脚本到 `~/.cc-switch-bot/`
- 配置 cron 每分钟自动同步
- 创建 `~/.claude/` 等应用目录

也支持静默安装：

```bash
CC_SWITCH_BOT_TOKEN=xxx CC_SWITCH_BOT_APPS="claude codex" \
  curl -fsSL https://你的worker.workers.dev/install.sh | bash
```

### 同步原理

```
cron 每分钟 → sync.sh → GET /api/config?app=claude&format=raw
                       → 对比内容是否变化
                       → 变化时原子写入 ~/.claude/settings.json
```

不需要 root，所有文件在用户 home 目录下。

### 卸载

```bash
crontab -l | grep -v cc-switch-bot-sync | crontab -; rm -rf ~/.cc-switch-bot
```

---

## REST API

供本地 Agent 或自定义集成使用，所有请求需 `Authorization: Bearer <token>` 头。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config?app=claude&format=raw` | 返回 settings.json 原文 |
| GET | `/api/config?app=codex` | 返回 JSON 含 config.toml + auth.json |
| GET | `/api/config?app=gemini&format=raw` | 返回 .env 原文 |
| GET | `/api/providers?app=claude` | 供应商列表 |
| GET | `/api/current?app=claude` | 当前活跃供应商 |
| POST | `/api/stats` | 上报用量 `{ input_tokens, output_tokens }` |
| GET | `/api/stats?days=30` | 用量统计 |
| GET | `/health` | 健康检查 |
| GET | `/install.sh` | 一键安装脚本 |
| GET | `/init-db` | 初始化数据库表 |
| GET | `/setup` | 注册 Telegram Webhook |

---

## 配置文件格式

生成的配置与 [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) 完全兼容：

| 应用 | 文件 | 格式 |
|------|------|------|
| Claude | `~/.claude/settings.json` | `{ env: { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL } }` |
| Codex | `~/.codex/config.toml` + `auth.json` | TOML + JSON |
| Gemini | `~/.gemini/.env` | `KEY=VALUE` |

---

## 安全

- **API Key 加密存储**：AES-GCM 加密后存入 D1，密钥为你设置的 `ENCRYPTION_KEY`
- **Bearer Token 认证**：REST API 全部需要 Token，在 Bot 中 `/start` 自动生成
- **用户白名单**：设置 `ADMIN_USER_ID` 后只有你的 Telegram 账号能操作
- **HTTPS**：Cloudflare Worker 默认全链路 HTTPS
- **权限 600**：本地 `.env` 文件只有文件所有者可读

## License

MIT
