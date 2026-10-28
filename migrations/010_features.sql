-- Новые функции: бета-режим, приглашения-ссылки, старосты, правки пар.

-- Переключатели функций: off (выключена), beta (видят владелец и тестеры),
-- all (видят все). Меняются через /admin, без передеплоя.
CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT PRIMARY KEY,
  state       TEXT NOT NULL DEFAULT 'off' CHECK (state IN ('off', 'beta', 'all')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Бета-тестеры: кто видит функции в состоянии beta (кроме владельца — он всегда).
CREATE TABLE IF NOT EXISTS beta_testers (
  id          SERIAL PRIMARY KEY,
  platform    TEXT NOT NULL,
  user_id     BIGINT NOT NULL,          -- telegram_id / user_id в MAX
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, user_id)
);

-- Старосты: кто может настраивать и вести объявления для своей группы.
CREATE TABLE IF NOT EXISTS staff (
  id          SERIAL PRIMARY KEY,
  platform    TEXT NOT NULL,
  user_id     BIGINT NOT NULL,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'starosta' CHECK (role IN ('starosta')),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, user_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_user ON staff(platform, user_id);

-- Приглашения-ссылки. token попадает в deep-link (/start <token> в Telegram,
-- ?startapp=<token> в MAX). kind: group — подключить сразу к группе,
-- beta — выдать роль тестера, staff — выдать роль старосты группы.
CREATE TABLE IF NOT EXISTS invites (
  token       TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('group', 'beta', 'staff')),
  group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  created_by  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,              -- NULL = бессрочно
  max_uses    INTEGER,                  -- NULL = без ограничения
  uses        INTEGER NOT NULL DEFAULT 0
);

-- Откуда пришёл пользователь (по какому приглашению) — для статистики, без имён.
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by TEXT;
ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS invited_by TEXT;

-- Правки расписания на конкретный день от старосты: отмена или перенос пары.
-- Накладываются поверх расписания с сайта для указанной даты.
CREATE TABLE IF NOT EXISTS lesson_overrides (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  on_date     DATE NOT NULL,
  position    SMALLINT,                 -- номер пары по сетке звонков (NULL = по времени)
  time_start  TEXT,                     -- "08:00" — на случай нестандартной сетки
  action      TEXT NOT NULL CHECK (action IN ('cancel', 'move')),
  new_room    TEXT,
  new_time    TEXT,
  note        TEXT,
  created_by  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_overrides_group_date ON lesson_overrides(group_id, on_date);

-- Кого бот заблокировал (вышел из чата / удалил): таким не шлём рассылку.
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;

-- Слепок расписания для поиска изменений (функция «тихие уведомления владельцу»).
-- Храним хэш расписания дня, чтобы замечать, что на сайте что-то поменялось.
CREATE TABLE IF NOT EXISTS schedule_snapshots (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  on_date     DATE NOT NULL,
  digest      TEXT NOT NULL,            -- хэш содержимого дня
  summary     TEXT,                     -- человекочитаемое описание дня
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, on_date)
);

-- Закрытие таблиц от публичного API Supabase (как в миграции 009).
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
