-- Редактируемые тексты бота (главное меню, помощь и т.д.), которые можно
-- менять через админ-панель, не трогая код.
CREATE TABLE IF NOT EXISTS bot_texts (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
