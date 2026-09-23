-- Telegram-групповые чаты, в которые добавлен бот и настроена рассылка
-- расписания на весь чат (в отличие от users — там на личку каждому).
CREATE TABLE IF NOT EXISTS group_chats (
  id                 SERIAL PRIMARY KEY,
  chat_id            BIGINT NOT NULL UNIQUE,   -- Telegram chat_id (отрицательный для групп)
  title              TEXT,                      -- название чата в Telegram (для удобства)
  group_id           INTEGER REFERENCES groups(id) ON DELETE SET NULL, -- привязанная учебная группа
  morning_time       TEXT,
  evening_time       TEXT,
  morning_time_last  TEXT,
  evening_time_last  TEXT,
  timezone           TEXT NOT NULL DEFAULT 'Europe/Moscow',
  state              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_chats_chat_id ON group_chats(chat_id);

-- Журнал отправленных рассылок для групповых чатов (аналог sent_log для users).
CREATE TABLE IF NOT EXISTS group_chat_sent_log (
  id             SERIAL PRIMARY KEY,
  group_chat_id  INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
  send_date      DATE NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('morning', 'evening')),
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_chat_id, send_date, kind)
);
