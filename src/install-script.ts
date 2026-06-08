/**
 * Embedded install script served at GET /install.sh
 * The Worker replaces {{API_BASE}} with its own origin at serve time.
 */

export const INSTALL_SCRIPT = `#!/usr/bin/env bash
# ============================================================
# CC-Switch Bot - 一键安装脚本
#
# 在任意 Linux 服务器上运行即可完成：
#   1. 安装 sync agent（定时从 CF Worker 拉取供应商配置）
#   2. 自动创建 cron 定时任务
#   3. 确保 ~/.claude 等目录存在
#
# 用法：
#   curl -fsSL {{API_BASE}}/install.sh | bash
#   或：
#   CC_SWITCH_BOT_TOKEN=xxx bash install.sh
# ============================================================

set -euo pipefail

RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'
CYAN='\\033[0;36m'; BOLD='\\033[1m'; NC='\\033[0m'

info()  { echo -e "\${CYAN}[INFO]\${NC}  $*"; }
ok()    { echo -e "\${GREEN}[OK]\${NC}    $*"; }
warn()  { echo -e "\${YELLOW}[WARN]\${NC}  $*"; }
err()   { echo -e "\${RED}[ERROR]\${NC} $*"; }

API_BASE="{{API_BASE}}"
INSTALL_DIR="\${HOME}/.cc-switch-bot"
SYNC_SCRIPT="\${INSTALL_DIR}/sync.sh"
ENV_FILE="\${INSTALL_DIR}/.env"
LOG_FILE="\${INSTALL_DIR}/sync.log"

echo ""
echo -e "\${BOLD}╔══════════════════════════════════════════╗\${NC}"
echo -e "\${BOLD}║    CC-Switch Bot  —  一键安装 Agent      ║\${NC}"
echo -e "\${BOLD}║    远程管理 Claude/Codex/Gemini 供应商    ║\${NC}"
echo -e "\${BOLD}╚══════════════════════════════════════════╝\${NC}"
echo ""

# ---- 依赖检查 ----
info "检查系统依赖..."
missing=()
for cmd in curl crontab mktemp; do
  command -v "$cmd" &>/dev/null || missing+=("$cmd")
done
[ \${#missing[@]} -gt 0 ] && { err "缺少: \${missing[*]}. 请 apt install -y curl cron"; exit 1; }
ok "依赖检查通过"

# ---- 收集 Token ----
if [ -z "\${CC_SWITCH_BOT_TOKEN:-}" ]; then
  echo ""
  echo -e "\${BOLD}请输入你的 API Token\${NC} (Telegram Bot 中发 /start 获取)"
  read -rp "API Token: " CC_SWITCH_BOT_TOKEN
  echo ""
fi
[ -z "\$CC_SWITCH_BOT_TOKEN" ] && { err "Token 不能为空"; exit 1; }

info "验证 Token..."
curl -sf -H "Authorization: Bearer \${CC_SWITCH_BOT_TOKEN}" "\${API_BASE}/api/providers" >/dev/null 2>&1 || {
  err "Token 验证失败！请确认已在 Bot 中 /start 注册"; exit 1
}
ok "Token 验证通过"

# ---- 选择 App ----
if [ -z "\${CC_SWITCH_BOT_APPS:-}" ]; then
  echo ""
  echo -e "\${BOLD}同步哪些应用?\${NC} (空格分隔, 回车默认 claude)"
  echo "  可选: claude  codex  gemini"
  read -rp "同步应用 [claude]: " CC_SWITCH_BOT_APPS
  CC_SWITCH_BOT_APPS="\${CC_SWITCH_BOT_APPS:-claude}"
  echo ""
fi

# ---- 初始化目录 ----
info "初始化应用目录..."
for app in \$CC_SWITCH_BOT_APPS; do
  case "\$app" in
    claude) mkdir -p "\${HOME}/.claude"  && ok "~/.claude/ 就绪" ;;
    codex)  mkdir -p "\${CODEX_HOME:-\${HOME}/.codex}" && ok "~/.codex/ 就绪" ;;
    gemini) mkdir -p "\${HOME}/.gemini"  && ok "~/.gemini/ 就绪" ;;
  esac
done

# ---- 写 .env ----
mkdir -p "\$INSTALL_DIR"
cat > "\$ENV_FILE" <<ENVEOF
CC_SWITCH_BOT_API=\${API_BASE}
CC_SWITCH_BOT_TOKEN=\${CC_SWITCH_BOT_TOKEN}
CC_SWITCH_BOT_APPS=\${CC_SWITCH_BOT_APPS}
ENVEOF
chmod 600 "\$ENV_FILE"
ok ".env 已写入"

# ---- 写 sync.sh ----
cat > "\$SYNC_SCRIPT" <<'SYNCEOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "\${SCRIPT_DIR}/.env" ] && set -a && source "\${SCRIPT_DIR}/.env" && set +a
API_BASE="\${CC_SWITCH_BOT_API:-}"; API_TOKEN="\${CC_SWITCH_BOT_TOKEN:-}"
SYNC_APPS="\${CC_SWITCH_BOT_APPS:-claude}"
[ -z "$API_BASE" ] || [ -z "$API_TOKEN" ] && { echo "[ERROR] .env not configured"; exit 1; }
AUTH="Authorization: Bearer \${API_TOKEN}"; CHANGED=0

json_get() {
  local j="$1" f="$2"
  if command -v jq &>/dev/null; then echo "$j" | jq -r "$f" 2>/dev/null
  elif command -v python3 &>/dev/null; then echo "$j" | python3 -c "import sys,json;d=json.load(sys.stdin);exec('print(d'+f.replace('.','').replace('[',\"['\").replace(']',\"']\")+')' if True else None)" 2>/dev/null
  else return 1; fi
}

atomic_write() {
  local t="$1" c="$2"
  [ -f "$t" ] && { local cur; cur=$(cat "$t" 2>/dev/null||echo ""); [ "$c" = "$cur" ] && return 0; }
  local tmp; tmp=$(mktemp "\${t}.XXXXXX"); printf '%s' "$c" > "$tmp"; mv -f "$tmp" "$t"; CHANGED=1
}

sync_claude() {
  local d="\${HOME}/.claude" f="\${HOME}/.claude/settings.json"; [ ! -d "$d" ] && return 0
  local cfg; cfg=$(curl -sf -H "$AUTH" "\${API_BASE}/api/config?app=claude&format=raw") || return 0
  atomic_write "$f" "$cfg" && [ \$CHANGED -eq 1 ] && echo "[$(date +%H:%M:%S)] Claude settings.json updated"
}
sync_codex() {
  local d="\${CODEX_HOME:-\${HOME}/.codex}"; [ ! -d "$d" ] && return 0
  local r; r=$(curl -sf -H "$AUTH" "\${API_BASE}/api/config?app=codex") || return 0
  local t a; t=$(json_get "$r" ".content") || return 0; a=$(json_get "$r" ".extraFile.content") || a=""
  [ -n "$t" ] && atomic_write "\${d}/config.toml" "$t" && [ \$CHANGED -eq 1 ] && echo "[$(date +%H:%M:%S)] Codex config.toml updated"
  [ -n "$a" ] && atomic_write "\${d}/auth.json" "$a" && [ \$CHANGED -eq 1 ] && echo "[$(date +%H:%M:%S)] Codex auth.json updated"
}
sync_gemini() {
  local d="\${HOME}/.gemini" f="\${HOME}/.gemini/.env"; [ ! -d "$d" ] && return 0
  local cfg; cfg=$(curl -sf -H "$AUTH" "\${API_BASE}/api/config?app=gemini&format=raw") || return 0
  [ -n "$cfg" ] && atomic_write "$f" "$cfg" && [ \$CHANGED -eq 1 ] && echo "[$(date +%H:%M:%S)] Gemini .env updated"
}

for app in \$SYNC_APPS; do
  case "\$app" in claude) sync_claude;; codex) sync_codex;; gemini) sync_gemini;; esac
done
SYNCEOF
chmod +x "\$SYNC_SCRIPT"
ok "sync.sh 已安装"

# ---- 设置 cron ----
info "配置 cron..."
crontab -l 2>/dev/null | grep -v "cc-switch-bot-sync" > /tmp/cc-cron-tmp || true
echo "* * * * * \${SYNC_SCRIPT} >> \${LOG_FILE} 2>&1 # cc-switch-bot-sync" >> /tmp/cc-cron-tmp
crontab /tmp/cc-cron-tmp; rm -f /tmp/cc-cron-tmp
ok "Cron 已设置: 每分钟同步"

# ---- 首次同步 ----
info "首次同步..."
bash "\$SYNC_SCRIPT" 2>&1 || warn "首次同步未拉到配置 (可能还没在 Bot 添加供应商)"

echo ""
echo -e "\${GREEN}\${BOLD}══════════════════════════════════════════\${NC}"
echo -e "\${GREEN}\${BOLD}  ✅ 安装完成！\${NC}"
echo -e "\${GREEN}\${BOLD}══════════════════════════════════════════\${NC}"
echo ""
echo -e "  安装目录:  \${CYAN}\${INSTALL_DIR}/\${NC}"
echo -e "  同步脚本:  \${CYAN}\${SYNC_SCRIPT}\${NC}"
echo -e "  配置文件:  \${CYAN}\${ENV_FILE}\${NC}"
echo -e "  运行日志:  \${CYAN}\${LOG_FILE}\${NC}"
echo -e "  同步应用:  \${CYAN}\${CC_SWITCH_BOT_APPS}\${NC}"
echo ""
echo -e "  \${BOLD}常用操作:\${NC}"
echo -e "  手动同步:  \${YELLOW}bash \${SYNC_SCRIPT}\${NC}"
echo -e "  查看日志:  \${YELLOW}tail -f \${LOG_FILE}\${NC}"
echo -e "  修改配置:  \${YELLOW}nano \${ENV_FILE}\${NC}"
echo -e "  卸载:      \${YELLOW}crontab -l | grep -v cc-switch-bot-sync | crontab -; rm -rf \${INSTALL_DIR}\${NC}"
echo ""
`;
