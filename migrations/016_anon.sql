-- Анонимки: личный код-ссылка, сообщения, блокировки получателем, баны владельца.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anon_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_anon_code_idx ON users (anon_code) WHERE anon_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS anon_messages (
  id           BIGSERIAL PRIMARY KEY,
  from_user    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reply_to     BIGINT,
  body         TEXT NOT NULL,
  window_until TIMESTAMPTZ,
  delivered    BOOLEAN NOT NULL DEFAULT false,
  suppressed   BOOLEAN NOT NULL DEFAULT false,
  reported     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS anon_messages_from_idx ON anon_messages (from_user, created_at);
CREATE INDEX IF NOT EXISTS anon_messages_to_idx ON anon_messages (to_user);

CREATE TABLE IF NOT EXISTS anon_blocks (
  blocker INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker, blocked)
);

CREATE TABLE IF NOT EXISTS anon_bans (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  banned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE anon_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE anon_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE anon_bans ENABLE ROW LEVEL SECURITY;
