#!/usr/bin/env bash
# ============================================================
# CC-Switch Bot - 一键安装脚本
#
# 在任意 Linux 服务器上运行即可完成：
#   1. 安装 sync agent（定时从 CF Worker 拉取供应商配置）
#   2. 自动创建 cron 定时任务
#   3. 确保 ~/.claude 等目录存在
#
# 用法：
#   curl -fsSL https://cc-switch-bot.muabl.workers.dev/install.sh | bash
#   或：
#   bash install.sh
#
# 交互式安装会询问 API Token；也可预设环境变量跳过交互：
#   CC_SWITCH_BOT_TOKEN=xxx CC_SWITCH_BOT_APPS="claude codex" bash install.sh
# ============================================================

set -euo pipefail

# ===== 颜色 =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ===== 配置 =====
API_BASE="https://cc-switch-bot.muabl.workers.dev"
INSTALL_DIR="${HOME}/.cc-switch-bot"
SYNC_SCRIPT="${INSTALL_DIR}/sync.sh"
ENV_FILE="${INSTALL_DIR}/.env"
LOG_FILE="${INSTALL_DIR}/sync.log"
CRON_INTERVAL="* * * * *"  # 每分钟

# ============================================================
# Banner
# ============================================================
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║    CC-Switch Bot  —  一键安装 Agent      ║${NC}"
echo -e "${BOLD}║    远程管理 Claude/Codex/Gemini 供应商    ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ============================================================
# Step 1: 检查依赖
# ============================================================
info "检查系统依赖..."

missing=()
for cmd in curl crontab mktemp; do
  if ! command -v "$cmd" &>/dev/null; then
    missing+=("$cmd")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  err "缺少依赖: ${missing[*]}"
  err "请先安装: apt install -y curl cron  (或 yum install -y curl cronie)"
  exit 1
fi

# JSON 解析: 优先 jq，回退 python3
JSON_PARSER=""
if command -v jq &>/dev/null; then
  JSON_PARSER="jq"
elif command -v python3 &>/dev/null; then
  JSON_PARSER="python3"
else
  warn "未找到 jq 或 python3，Codex 配置同步将不可用（Claude/Gemini 不受影响）"
  JSON_PARSER="none"
fi

ok "依赖检查通过 (JSON parser: ${JSON_PARSER})"

# ============================================================
# Step 2: 收集配置
# ============================================================

# API Token
if [ -z "${CC_SWITCH_BOT_TOKEN:-}" ]; then
  echo ""
  echo -e "${BOLD}请输入你的 API Token${NC}"
  echo -e "  (在 Telegram Bot 中发送 /start 获取)"
  echo ""
  read -rp "API Token: " CC_SWITCH_BOT_TOKEN
  echo ""
fi

if [ -z "$CC_SWITCH_BOT_TOKEN" ]; then
  err "API Token 不能为空"
  exit 1
fi

# 验证 Token
info "验证 Token..."
verify_resp=$(curl -sf -H "Authorization: Bearer ${CC_SWITCH_BOT_TOKEN}" "${API_BASE}/api/providers" 2>/dev/null) || {
  err "Token 验证失败！请确认你已在 Telegram Bot 中 /start 注册"
  exit 1
}
ok "Token 验证通过"

# 同步哪些 App
if [ -z "${CC_SWITCH_BOT_APPS:-}" ]; then
  echo ""
  echo -e "${BOLD}选择要同步的应用${NC} (空格分隔，回车默认 claude):"
  echo "  可选: claude  codex  gemini"
  echo ""
  read -rp "同步应用 [claude]: " CC_SWITCH_BOT_APPS
  CC_SWITCH_BOT_APPS="${CC_SWITCH_BOT_APPS:-claude}"
  echo ""
fi

# ============================================================
# Step 3: 确保应用目录存在
# ============================================================
info "初始化应用目录..."

for app in $CC_SWITCH_BOT_APPS; do
  case "$app" in
    claude)
      mkdir -p "${HOME}/.claude"
      ok "~/.claude/ 已就绪"
      ;;
    codex)
      mkdir -p "${CODEX_HOME:-${HOME}/.codex}"
      ok "~/.codex/ 已就绪"
      ;;
    gemini)
      mkdir -p "${HOME}/.gemini"
      ok "~/.gemini/ 已就绪"
      ;;
  esac
done

# ============================================================
# Step 4: 安装 sync 脚本
# ============================================================
info "安装到 ${INSTALL_DIR}/ ..."

mkdir -p "$INSTALL_DIR"

# 写 .env
cat > "$ENV_FILE" <<ENVEOF
# CC-Switch Bot Agent 配置
# 修改后会在下次 cron 执行时生效
CC_SWITCH_BOT_API=${API_BASE}
CC_SWITCH_BOT_TOKEN=${CC_SWITCH_BOT_TOKEN}
CC_SWITCH_BOT_APPS=${CC_SWITCH_BOT_APPS}
ENVEOF
chmod 600 "$ENV_FILE"
ok ".env 已写入 (权限 600)"

# 写 sync.sh
cat > "$SYNC_SCRIPT" <<'SYNCEOF'
#!/usr/bin/env bash
# CC-Switch Bot sync agent — 由一键安装脚本生成
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${SCRIPT_DIR}/.env" ] && set -a && source "${SCRIPT_DIR}/.env" && set +a

API_BASE="${CC_SWITCH_BOT_API:-}"
API_TOKEN="${CC_SWITCH_BOT_TOKEN:-}"
SYNC_APPS="${CC_SWITCH_BOT_APPS:-claude}"

if [ -z "$API_BASE" ] || [ -z "$API_TOKEN" ]; then
  echo "[ERROR] API_BASE or API_TOKEN not set. Check ${SCRIPT_DIR}/.env"
  exit 1
fi

AUTH="Authorization: Bearer ${API_TOKEN}"
CHANGED=0

# ---- JSON field extractor (jq or python3 fallback) ----
json_get() {
  local json="$1" field="$2"
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r "$field" 2>/dev/null
  elif command -v python3 &>/dev/null; then
    echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(eval('d'+\"$field\".replace('.','').replace('[',\"['\").replace(']',\"']\")))" 2>/dev/null
  else
    return 1
  fi
}

# ---- atomic write: only if content actually changed ----
atomic_write() {
  local target="$1" content="$2"
  if [ -f "$target" ]; then
    local current
    current=$(cat "$target" 2>/dev/null || echo "")
    [ "$content" = "$current" ] && return 0
  fi
  local tmp
  tmp=$(mktemp "${target}.XXXXXX")
  printf '%s' "$content" > "$tmp"
  mv -f "$tmp" "$target"
  CHANGED=1
  return 0
}

# ---- sync functions ----
sync_claude() {
  local dir="${HOME}/.claude" file="${HOME}/.claude/settings.json"
  [ ! -d "$dir" ] && return 0
  local cfg
  cfg=$(curl -sf -H "$AUTH" "${API_BASE}/api/config?app=claude&format=raw" 2>/dev/null) || return 0
  # quick JSON validity check
  echo "$cfg" | python3 -m json.tool &>/dev/null 2>&1 || \
  echo "$cfg" | jq . &>/dev/null 2>&1 || \
  { echo "[$(date +%H:%M:%S)] [WARN] Claude: invalid JSON, skip"; return 0; }
  atomic_write "$file" "$cfg" && [ $CHANGED -eq 1 ] && echo "[$(date +%H:%M:%S)] [OK] Claude settings.json updated"
}

sync_codex() {
  local dir="${CODEX_HOME:-${HOME}/.codex}"
  [ ! -d "$dir" ] && return 0
  local resp
  resp=$(curl -sf -H "$AUTH" "${API_BASE}/api/config?app=codex" 2>/dev/null) || return 0
  local toml auth_json
  toml=$(json_get "$resp" "['content']") || return 0
  auth_json=$(json_get "$resp" "['extraFile']['content']") || auth_json=""
  [ -n "$toml" ] && atomic_write "${dir}/config.toml" "$toml" && [ $CHANGED -eq 1 ] && echo "[$(date +%H:%M:%S)] [OK] Codex config.toml updated"
  [ -n "$auth_json" ] && atomic_write "${dir}/auth.json" "$auth_json" && [ $CHANGED -eq 1 ] && echo "[$(date +%H:%M:%S)] [OK] Codex auth.json updated"
}

sync_gemini() {
  local dir="${HOME}/.gemini" file="${HOME}/.gemini/.env"
  [ ! -d "$dir" ] && return 0
  local cfg
  cfg=$(curl -sf -H "$AUTH" "${API_BASE}/api/config?app=gemini&format=raw" 2>/dev/null) || return 0
  [ -n "$cfg" ] && atomic_write "$file" "$cfg" && [ $CHANGED -eq 1 ] && echo "[$(date +%H:%M:%S)] [OK] Gemini .env updated"
}

# ---- main ----
for app in $SYNC_APPS; do
  case "$app" in
    claude) sync_claude ;;
    codex)  sync_codex  ;;
    gemini) sync_gemini ;;
  esac
done
SYNCEOF

chmod +x "$SYNC_SCRIPT"
ok "sync.sh 已安装"

# ============================================================
# Step 5: 设置 cron
# ============================================================
info "配置 cron 定时任务..."

CRON_CMD="${SYNC_SCRIPT} >> ${LOG_FILE} 2>&1"
CRON_TAG="# cc-switch-bot-sync"

# 移除旧条目（如果有）
crontab -l 2>/dev/null | grep -v "cc-switch-bot-sync" > /tmp/cc-switch-cron-tmp || true
echo "${CRON_INTERVAL} ${CRON_CMD} ${CRON_TAG}" >> /tmp/cc-switch-cron-tmp
crontab /tmp/cc-switch-cron-tmp
rm -f /tmp/cc-switch-cron-tmp

ok "Cron 已设置: 每分钟同步"

# ============================================================
# Step 6: 首次同步
# ============================================================
info "执行首次同步..."
bash "$SYNC_SCRIPT" 2>&1 || warn "首次同步未拉到配置（可能还没在 Bot 中添加供应商）"

# ============================================================
# 完成
# ============================================================
echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✅ 安装完成！${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════${NC}"
echo ""
echo -e "  安装目录:  ${CYAN}${INSTALL_DIR}/${NC}"
echo -e "  同步脚本:  ${CYAN}${SYNC_SCRIPT}${NC}"
echo -e "  配置文件:  ${CYAN}${ENV_FILE}${NC}"
echo -e "  运行日志:  ${CYAN}${LOG_FILE}${NC}"
echo -e "  Cron 频率: ${CYAN}每分钟${NC}"
echo -e "  同步应用:  ${CYAN}${CC_SWITCH_BOT_APPS}${NC}"
echo ""
echo -e "  ${BOLD}常用操作:${NC}"
echo -e "  手动同步:  ${YELLOW}bash ${SYNC_SCRIPT}${NC}"
echo -e "  查看日志:  ${YELLOW}tail -f ${LOG_FILE}${NC}"
echo -e "  修改配置:  ${YELLOW}nano ${ENV_FILE}${NC}"
echo -e "  查看cron:  ${YELLOW}crontab -l | grep cc-switch${NC}"
echo -e "  卸载:      ${YELLOW}crontab -l | grep -v cc-switch-bot-sync | crontab -; rm -rf ${INSTALL_DIR}${NC}"
echo ""
