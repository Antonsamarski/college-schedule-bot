-- Семестры (периоды обучения) группы: например "Осень 2026" (сентябрь-декабрь)
-- и "Весна 2027" (январь-июнь) — у каждого своё расписание.
CREATE TABLE IF NOT EXISTS terms (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  date_start  DATE NOT NULL,
  date_end    DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (date_end >= date_start)
);

CREATE INDEX IF NOT EXISTS idx_terms_group_dates ON terms(group_id, date_start, date_end);

-- Пары теперь привязаны к семестру, а не напрямую к группе, и могут быть
-- помечены неделей (1, 2, или NULL = каждую неделю — "числитель/знаменатель").
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS term_id INTEGER REFERENCES terms(id) ON DELETE CASCADE;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS week_parity SMALLINT CHECK (week_parity IN (1, 2) OR week_parity IS NULL);

-- Старое поле group_id и ограничение на нём больше не обязательны для новых
-- записей (расписание теперь привязывается к term_id).
ALTER TABLE lessons ALTER COLUMN group_id DROP NOT NULL;
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS lessons_group_id_weekday_position_key;

CREATE INDEX IF NOT EXISTS idx_lessons_term_weekday ON lessons(term_id, weekday);
