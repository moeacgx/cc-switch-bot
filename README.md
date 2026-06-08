<div align="center">

# 🤖 CC-Switch Bot

**Telegram Bot 远程管理 Claude Code / Codex / Gemini / OpenClaw / Hermes 供应商配置**

一个 Cloudflare Worker 单文件部署的 Telegram Bot，在手机上管理 API 供应商、切换模型、同步配置到所有服务器，支持自动降级。

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
      │
      │  供应商挂了？            │
      │                        │  sync.sh → POST /api/failover-check
      │                        │  → 健康检查当前供应商
      │                        │  → 失败 → 按优先级切换到下一个
      │  ⚠️ 自动降级通知  <──── │
```

**在手机上切换，所有服务器 1 分钟内自动生效。供应商挂了自动降级，Telegram 实时通知。**

---

## 功能总览

| 功能 | 说明 |
|------|------|
| 📱 **常驻底部键盘** | 9 个按钮，所有操作点点点 |
| ➕ **添加供应商** | 4 步引导，自动拉取模型列表 |
| 🔄 **切换供应商** | 一键切换，1 分钟内同步全部服务器 |
| ⚙️ **模型映射** | Claude 三槽 (Sonnet/Haiku/Opus) 独立映射 |
| 🔀 **切换模型** | Codex/Gemini/OpenClaw/Hermes 单模型切换 |
| 📥 **获取模型列表** | 从 API 拉取可用模型，Claude 自动映射三槽 |
| 🛡️ **自动降级** | 多供应商优先级排序，当前挂了自动切到下一个 |
| 🔍 **连通性测试** | 流式 API 延迟检测，⏱ 毫秒级 |
| 📄 **配置管理** | 查看/下载/上传配置，支持自定义覆盖 |
| 🧩 **Skills 管理** | 添加/启用/禁用，按应用同步到服务器 |
| 📊 **用量统计** | 按天/按供应商统计 token 消耗 |
| 🔑 **API Token** | 本地 Agent 认证，一键重置 |

### 支持的应用

| 应用 | 图标 | 配置文件 | 模型方式 |
|------|------|---------|---------|
| Claude Code | 🟣 | `~/.claude/settings.json` | 三槽映射 (Sonnet/Haiku/Opus) |
| Codex | 🟢 | `~/.codex/config.toml` + `auth.json` | 单模型 |
| Gemini | 🔵 | `~/.gemini/.env` | 单模型 |
| OpenClaw | 🟠 | `~/.openclaw/openclaw.json` | 单模型 |
| Hermes | 🟤 | `~/.hermes/config.yaml` | 单模型 |

---

## 功能预览

### 📱 常驻底部键盘

发送 `/start` 后，输入框下方出现常驻按钮：

```
╔═══════════════╦═══════════════╗
║ ➕ 添加供应商  ║ 📋 供应商列表  ║
╠═══════════════╬═══════════════╣
║ 🔄 切换供应商  ║ ✅ 当前状态   ║
╠═══════════════╬═══════════════╣
║ 🔍 连通性测试  ║ 📄 查看配置   ║
╠═══════════════╬═══════════════╣
║ 🧩 Skills管理  ║ 📊 用量统计   ║
╠═══════════════╩═══════════════╣
║         🔑 API Token          ║
╚═══════════════════════════════╝
```

### ➕ 添加供应商

4 步交互引导，输入 Key 后自动拉取模型列表：

```
🔸 第 1/4 步：选应用类型
  [🟣 Claude] [🟢 Codex] [🔵 Gemini]
  [🟠 OpenClaw] [🟤 Hermes]
  ↓
🔸 第 2/4 步：输入名称 → "MyProvider"
  ↓
🔸 第 3/4 步：输入 URL → https://api.example.com
  ↓
🔸 第 4/4 步：输入 Key → sk-xxx (加密存储)
  ↓
📦 已发现 6 个可用模型 (添加后可管理)
  [✅ 确认添加] [❌ 取消]
```

### ⚙️ Claude 模型映射

Claude 使用三个模型槽位，获取模型后自动按关键词映射，也可手动调整：

```
📥 获取模型 →

已自动映射：
🤖 Sonnet → claude-sonnet-4-6
🤖 Haiku  → claude-haiku-4-5
🤖 Opus   → claude-opus-4-8

⚙️ 模型映射 → 点击任一槽位 → 从列表选择
```

生成的 `settings.json`：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
    "ANTHROPIC_BASE_URL": "https://api.example.com",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8"
  }
}
```

### 🛡️ 自动降级

同一应用多个供应商按优先级排序，当前挂了自动切换：

```
📋 供应商列表

  [1] 🟣 主力API ✅         ← 当前，优先级 1
  [2] 🟣 备用API            ← 优先级 2
  [3] 🟣 应急API            ← 优先级 3

供应商详情页：
  [🔄 切换到此] [🔍 测试连通]
  [📥 获取模型] [⚙️ 模型映射]
  [⬆️ 上移] [⬇️ 下移]          ← 调整优先级
  [🗑 删除]
```

当 sync agent 检测到当前供应商不可用时：

```
⚠️ 自动降级

🟣 claude
❌ 主力API 不可用
✅ 已切换到 备用API (326ms)
```

如果所有供应商都挂了：`🔴 claude 所有供应商均不可用！`

### 📄 配置管理

查看、下载文件、上传自定义配置：

```
📄 claude (settings.json) 🔄 自动生成

{...配置预览...}

[📥 下载文件] [📤 上传替换]
```

- **📥 下载**：Bot 发送配置文件附件
- **📤 上传**：发送文件或文本替换配置（优先级高于自动生成）
- **🗑 清除自定义**：恢复为自动生成模式

### 🧩 Skills 管理

添加 Skill，按应用独立启用/禁用，自动同步到服务器：

```
🧩 Skills 管理

  [🟣🟠 code-review]       ← 启用了 Claude + OpenClaw
  [🟣 auto-test]            ← 只启用了 Claude
  [⬜ my-prompt]            ← 未启用
  [➕ 添加 Skill]

点击 Skill → 开关启用状态：
  [✅ 🟣 claude]
  [⬜ 🟢 codex]
  [✅ 🟠 openclaw]
  [⬜ 🟤 hermes]
  [📄 查看内容] [🗑 删除]
```

同步目录：
- Claude → `~/.claude/commands/`
- Codex → `~/.codex/commands/`
- OpenClaw → `~/.openclaw/commands/`
- Hermes → `~/.hermes/skills/`

### 🔍 连通性测试

测试所有活跃供应商的流式 API 延迟：

```
🟢 MyProvider [claude]  326ms
🟢 CodexAPI [codex]  891ms
🟡 GeminiRelay [gemini]  7200ms (降级)
🔴 HermesAPI [hermes]  超时
```

判定：🟢 ≤6s 正常 / 🟡 >6s 降级 / 🔴 超时或错误

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

# 创建 wrangler.toml (参考 worker.js 头部注释)

# 创建 D1
wrangler d1 create cc-switch-bot-db

# 设置 secrets
wrangler secret put BOT_TOKEN
wrangler secret put ENCRYPTION_KEY

# 部署
wrangler deploy

# 浏览器访问 /init-db 和 /setup
```

---

## 服务器同步

### 一键安装

在任意 Linux 服务器上运行：

```bash
curl -fsSL https://你的worker.workers.dev/install.sh | bash
```

交互式询问 API Token（Bot 中发 `/start` 获取），然后自动：

- 安装 sync 脚本到 `~/.cc-switch-bot/`
- 配置 cron 每分钟自动同步
- 创建应用目录

支持静默安装：

```bash
CC_SWITCH_BOT_TOKEN=xxx CC_SWITCH_BOT_APPS="claude codex openclaw hermes" \
  curl -fsSL https://你的worker.workers.dev/install.sh | bash
```

### 同步流程

```
cron 每分钟 → sync.sh
  ↓
POST /api/failover-check        ← 健康检查 + 自动降级
  ↓
GET /api/config?app=claude      ← 拉取配置
  → 原子写入 ~/.claude/settings.json
  ↓
GET /api/skills?app=claude      ← 拉取 Skills
  → 写入 ~/.claude/commands/*.md
```

不需要 root，所有文件在用户 home 目录下。

### 卸载

```bash
crontab -l | grep -v cc-switch-bot-sync | crontab -; rm -rf ~/.cc-switch-bot
```

---

## REST API

所有请求需 `Authorization: Bearer <token>` 头。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config?app=claude&format=raw` | 配置文件原文 (支持 override) |
| GET | `/api/config?app=codex` | JSON 含 config.toml + auth.json |
| GET | `/api/providers?app=claude` | 供应商列表 (按优先级排序) |
| GET | `/api/current?app=claude` | 当前活跃供应商 |
| POST | `/api/failover-check` | 健康检查 + 自动降级 |
| GET | `/api/skills?app=claude` | 获取已启用的 Skills |
| POST | `/api/stats` | 上报用量 |
| GET | `/api/stats?days=30` | 用量统计 |

公开端点（无需认证）：

| 路径 | 说明 |
|------|------|
| `/health` | 健康检查 |
| `/install.sh` | 一键安装脚本 |
| `/init-db` | 初始化数据库表 |
| `/setup` | 注册 Telegram Webhook + Bot Commands |

---

## 安全

- **API Key 加密存储**：AES-GCM 加密后存入 D1，密钥为你设置的 `ENCRYPTION_KEY`
- **Bearer Token 认证**：REST API 全部需要 Token，`/start` 自动生成
- **用户白名单**：`ADMIN_USER_ID` 限制只有你的 Telegram 账号能操作
- **HTTPS**：Cloudflare Worker 默认全链路 HTTPS
- **权限 600**：本地 `.env` 文件只有所有者可读
- **自定义配置隔离**：上传的配置按用户+应用存储，互不干扰

## License

MIT
