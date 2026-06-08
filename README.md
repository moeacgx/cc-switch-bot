# CC-Switch Bot

Telegram Bot + Cloudflare Worker 精简版，用于远程管理 Claude Code / Codex / Gemini 供应商配置。

基于 [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) 的核心功能精简重写。

## 架构

```
Telegram App  ←→  CF Worker (Bot + REST API)  ←→  CF D1 (SQLite)
                         ↑
                  本地 sync.sh (定时拉取配置)
```

## 快速开始

### 1. 准备

- 一个 Cloudflare 账号
- 从 [@BotFather](https://t.me/BotFather) 创建一个 Telegram Bot，获取 `BOT_TOKEN`
- 安装 [wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### 2. 部署

```bash
# 安装依赖
npm install

# 创建 D1 数据库
wrangler d1 create cc-switch-bot-db
# 将返回的 database_id 填入 wrangler.toml

# 初始化数据库表
wrangler d1 execute cc-switch-bot-db --remote --file=schema.sql

# 设置 secrets
wrangler secret put BOT_TOKEN          # 粘贴你的 Telegram Bot Token
wrangler secret put ENCRYPTION_KEY     # 随机 32 位字符串，用于加密 API Key
# (可选) 限制只允许你的 Telegram ID 使用
wrangler secret put ADMIN_USER_ID      # 你的 Telegram user ID

# 部署
wrangler deploy

# 注册 Telegram Webhook（两种方式任选）
# 方式1: 浏览器访问 https://your-worker.workers.dev/setup
# 方式2: 命令行
BOT_TOKEN=xxx WORKER_URL=https://your-worker.workers.dev node scripts/set-webhook.mjs
```

### 3. 使用 Bot

在 Telegram 中打开你的 Bot，发送 `/start` 注册并获取 API Token。

**核心命令：**

| 命令 | 说明 |
|------|------|
| `/start` | 注册 + 获取 API Token |
| `/add <name> <url> <key> [model] [app]` | 添加供应商 |
| `/list` | 查看所有供应商 (可点击切换/测试/删除) |
| `/switch [id]` | 切换当前供应商 |
| `/current [app]` | 查看当前供应商 |
| `/test [id]` | 测试连通性 |
| `/config [app]` | 查看生成的配置 |
| `/stats` | 用量统计 |
| `/token` | 查看/重置 API Token |

**添加供应商示例：**
```
/add official https://api.anthropic.com sk-ant-xxx123
/add packy https://api.packy.com sk-xxx claude-sonnet-4-20250514
/add codex-relay https://api.openai.com/v1 sk-xxx gpt-4.1 codex
/add gemini-pro https://generativelanguage.googleapis.com AIzaSyXXX gemini-2.0-flash gemini
```

### 4. 配置本地同步

将 `agent/sync.sh` 复制到你运行 Claude Code 的机器上：

```bash
# 编辑配置
export CC_SWITCH_BOT_API="https://your-worker.workers.dev"
export CC_SWITCH_BOT_TOKEN="your_api_token_from_/start"
export CC_SWITCH_BOT_APPS="claude"  # 空格分隔: claude codex gemini

# 手动测试
bash sync.sh

# 添加到 crontab (每分钟同步)
crontab -e
# 添加:
# * * * * * CC_SWITCH_BOT_API=https://xxx.workers.dev CC_SWITCH_BOT_TOKEN=xxx CC_SWITCH_BOT_APPS=claude /path/to/sync.sh >> /tmp/cc-switch-sync.log 2>&1
```

## REST API

供本地 Agent 或自定义集成使用，所有请求需要 `Authorization: Bearer <token>` 头。

```
GET  /api/config?app=claude&format=raw  → 直接返回 settings.json 内容
GET  /api/config?app=codex              → 返回 JSON 包含 config.toml + auth.json
GET  /api/config?app=gemini&format=raw  → 直接返回 .env 内容
GET  /api/providers?app=claude          → 供应商列表
GET  /api/current?app=claude            → 当前供应商
POST /api/stats                         → 上报用量 { input_tokens, output_tokens }
GET  /api/stats?days=30                 → 用量统计
```

## 配置文件格式

Bot 生成的配置文件与 cc-switch-cli 完全兼容：

- **Claude**: `~/.claude/settings.json` (含 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`)
- **Codex**: `~/.codex/config.toml` + `~/.codex/auth.json`
- **Gemini**: `~/.gemini/.env`

## 安全

- API Key 使用 AES-GCM 加密存储在 D1 中
- 所有 REST API 需要 Bearer Token 认证
- 可选: `ADMIN_USER_ID` 限制只允许指定 Telegram 用户
- Cloudflare Worker 默认 HTTPS

## License

MIT
