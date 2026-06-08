#!/usr/bin/env bash
# ============================================================
# CC-Switch Bot - Local Agent Sync Script
#
# This script pulls the latest provider config from the CF Worker
# and writes it to the appropriate local config files.
#
# Usage:
#   1. Edit the variables below with your Worker URL and API token
#   2. chmod +x sync.sh
#   3. Add to crontab: */1 * * * * /path/to/sync.sh
#      (runs every 1 minute)
# ============================================================

set -euo pipefail

# ===== Configuration =====
API_BASE="${CC_SWITCH_BOT_API:-https://cc-switch-bot.YOUR_SUBDOMAIN.workers.dev}"
API_TOKEN="${CC_SWITCH_BOT_TOKEN:-your_api_token_here}"

# Which apps to sync (space-separated: claude codex gemini)
SYNC_APPS="${CC_SWITCH_BOT_APPS:-claude}"

# ===== Auth Header =====
AUTH_HEADER="Authorization: Bearer ${API_TOKEN}"

# ===== Sync Functions =====

sync_claude() {
  local config_dir="${HOME}/.claude"
  local config_file="${config_dir}/settings.json"

  # Skip if Claude hasn't been initialized
  if [ ! -d "$config_dir" ]; then
    echo "[SKIP] ~/.claude does not exist (Claude Code not initialized)"
    return 0
  fi

  local new_config
  new_config=$(curl -sf -H "$AUTH_HEADER" "${API_BASE}/api/config?app=claude&format=raw" 2>/dev/null) || {
    echo "[WARN] Failed to fetch Claude config (no current provider?)"
    return 0
  }

  # Only write if content is valid JSON and different from current
  if echo "$new_config" | python3 -m json.tool >/dev/null 2>&1; then
    if [ -f "$config_file" ]; then
      local current
      current=$(cat "$config_file" 2>/dev/null || echo "")
      if [ "$new_config" = "$current" ]; then
        return 0  # No change
      fi
    fi
    # Atomic write: write to temp then rename
    local tmp
    tmp=$(mktemp "${config_file}.XXXXXX")
    echo "$new_config" > "$tmp"
    mv -f "$tmp" "$config_file"
    echo "[OK] Claude config updated: ${config_file}"
  else
    echo "[WARN] Invalid Claude config received, skipping"
  fi
}

sync_codex() {
  local config_dir="${CODEX_HOME:-${HOME}/.codex}"
  local config_file="${config_dir}/config.toml"
  local auth_file="${config_dir}/auth.json"

  if [ ! -d "$config_dir" ]; then
    echo "[SKIP] ~/.codex does not exist (Codex not initialized)"
    return 0
  fi

  local response
  response=$(curl -sf -H "$AUTH_HEADER" "${API_BASE}/api/config?app=codex" 2>/dev/null) || {
    echo "[WARN] Failed to fetch Codex config"
    return 0
  }

  # Extract fields from JSON response
  local toml_content auth_content
  toml_content=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['content'])" 2>/dev/null) || return 0
  auth_content=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); e=d.get('extraFile'); print(e['content'] if e else '')" 2>/dev/null) || return 0

  if [ -n "$toml_content" ]; then
    local tmp
    tmp=$(mktemp "${config_file}.XXXXXX")
    echo "$toml_content" > "$tmp"
    mv -f "$tmp" "$config_file"
    echo "[OK] Codex config.toml updated"
  fi

  if [ -n "$auth_content" ]; then
    local tmp
    tmp=$(mktemp "${auth_file}.XXXXXX")
    echo "$auth_content" > "$tmp"
    mv -f "$tmp" "$auth_file"
    echo "[OK] Codex auth.json updated"
  fi
}

sync_gemini() {
  local config_dir="${HOME}/.gemini"
  local env_file="${config_dir}/.env"

  if [ ! -d "$config_dir" ]; then
    echo "[SKIP] ~/.gemini does not exist (Gemini not initialized)"
    return 0
  fi

  local new_env
  new_env=$(curl -sf -H "$AUTH_HEADER" "${API_BASE}/api/config?app=gemini&format=raw" 2>/dev/null) || {
    echo "[WARN] Failed to fetch Gemini config"
    return 0
  }

  if [ -n "$new_env" ]; then
    local tmp
    tmp=$(mktemp "${env_file}.XXXXXX")
    echo "$new_env" > "$tmp"
    mv -f "$tmp" "$env_file"
    echo "[OK] Gemini .env updated"
  fi
}

# ===== Main =====

for app in $SYNC_APPS; do
  case "$app" in
    claude) sync_claude ;;
    codex)  sync_codex  ;;
    gemini) sync_gemini ;;
    *)      echo "[WARN] Unknown app: $app" ;;
  esac
done
