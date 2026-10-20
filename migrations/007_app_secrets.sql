-- Ключи, которые нужны и базе, и коду бота. Сейчас здесь один ключ —
-- tick_secret: с ним планировщик pg_cron в Supabase вызывает /api/tick.
-- Значение генерируется внутри базы и наружу не выдаётся (RLS + REVOKE).
CREATE TABLE IF NOT EXISTS app_secrets (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE EXTENSION IF NOT EXISTS pgcrypto;
INSERT INTO app_secrets (key, value)
VALUES ('tick_secret', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

ALTER TABLE app_secrets ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON app_secrets FROM anon, authenticated;
  END IF;
END $$;
