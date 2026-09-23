-- Группы (потоки/курсы). Изначально будет одна, но структура готова к множеству.
CREATE TABLE IF NOT EXISTS groups (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,        -- например: "ИС-21", "Экономика-1к"
  created_by  BIGINT,                      -- telegram_id создателя группы
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Расписание уроков по дням недели для группы.
-- weekday: 1=понедельник ... 7=воскресенье (ISO-8601)
CREATE TABLE IF NOT EXISTS lessons (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  position    SMALLINT NOT NULL,           -- порядок урока в дне (1,2,3...)
  time_start  TEXT NOT NULL,               -- "08:30"
  time_end    TEXT,                        -- "10:00" (необязательно)
  subject     TEXT NOT NULL,
  room        TEXT,
  teacher     TEXT,
  UNIQUE (group_id, weekday, position)
);

-- Пользователи бота.
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  telegram_id    BIGINT NOT NULL UNIQUE,
  username       TEXT,
  group_id       INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  morning_time   TEXT,                     -- "07:30" или NULL = выключено
  evening_time   TEXT,                     -- "20:00" или NULL = выключено
  timezone       TEXT NOT NULL DEFAULT 'Europe/Moscow',
  state          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- состояние диалога-визарда
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Журнал отправленных рассылок, чтобы не слать дважды в один день.
CREATE TABLE IF NOT EXISTS sent_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  send_date  DATE NOT NULL,               -- локальная дата пользователя
  kind       TEXT NOT NULL CHECK (kind IN ('morning', 'evening')),
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, send_date, kind)
);

CREATE INDEX IF NOT EXISTS idx_lessons_group_weekday ON lessons(group_id, weekday);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
