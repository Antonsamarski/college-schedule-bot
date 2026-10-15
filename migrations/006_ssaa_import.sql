-- Автоматическая загрузка расписания с сайта ssaa.ru + подгруппы.
-- Все команды идемпотентны: scripts/migrate.js прогоняет все файлы каждый раз.

-- Группа, привязанная к сайту: ключ вида "ssaa:11:Колледж:2:3" и параметры
-- для запроса к shedule.php. Для групп, заполненных вручную, — NULL.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS source_params JSONB;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS sync_error TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS sync_attempted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_source_key ON groups(source_key) WHERE source_key IS NOT NULL;

-- Семестр, загруженный с сайта, помечается кодом периода (teil_f).
ALTER TABLE terms ADD COLUMN IF NOT EXISTS source_period TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_terms_source_period ON terms(group_id, source_period) WHERE source_period IS NOT NULL;

-- Пары: подгруппа (NULL = вся группа), вид занятия (лекция/ЛПЗ/...) и
-- точные даты, на которые пара стоит на сайте. Если dates заполнено — оно
-- главнее чередования недель (учитывает праздники и сдвиги).
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS subgroup SMALLINT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS lesson_type TEXT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS dates DATE[];
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS lessons_subgroup_check;
ALTER TABLE lessons ADD CONSTRAINT lessons_subgroup_check CHECK (subgroup IN (1, 2) OR subgroup IS NULL);

-- Какая подгруппа у подписчика (NULL = показывать пары обеих подгрупп).
ALTER TABLE users ADD COLUMN IF NOT EXISTS subgroup SMALLINT;
ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS subgroup SMALLINT;

-- Исправление: раньше время можно было ввести как "8:30" — тогда строковая
-- сортировка ставила его после "10:10", а поиск "кто ведёт сейчас" не
-- срабатывал. Приводим всё к виду "08:30".
UPDATE lessons SET time_start = '0' || time_start WHERE time_start ~ '^[0-9]:[0-9]{2}$';
UPDATE lessons SET time_end = '0' || time_end WHERE time_end ~ '^[0-9]:[0-9]{2}$';
