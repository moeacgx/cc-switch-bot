-- CC-Switch Bot D1 Database Schema

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  app_type TEXT NOT NULL DEFAULT 'claude',
  base_url TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  model TEXT,
  api_format TEXT NOT NULL DEFAULT 'anthropic',
  is_current INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_providers_user ON providers(user_id);
CREATE INDEX IF NOT EXISTS idx_providers_current ON providers(user_id, app_type, is_current);

CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  provider_id TEXT,
  provider_name TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id, recorded_at);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY,
  api_token TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
