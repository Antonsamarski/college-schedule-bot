import { query, getPool } from './db.js';

export const WEEKDAY_NAMES = {
  1: 'Понедельник',
  2: 'Вторник',
  3: 'Среда',
  4: 'Четверг',
  5: 'Пятница',
  6: 'Суббота',
  7: 'Воскресенье',
};

// Позволяет понимать разные написания дня недели в тексте пользователя,
// в т.ч. с пометкой недели: "пн1", "пн 2", "понедельник1" и т.д.
const WEEKDAY_ALIASES = {
  'пн': 1, 'понедельник': 1,
  'вт': 2, 'вторник': 2,
  'ср': 3, 'среда': 3,
  'чт': 4, 'четверг': 4,
  'пт': 5, 'пятница': 5,
  'сб': 6, 'суббота': 6,
  'вс': 7, 'воскресенье': 7,
};

const DAY_HEADER_RE = /^(пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)\s*([12])?$/;

/**
 * Шаблон для ручного заполнения расписания (без нейросети).
 * Дни без цифры — "каждую неделю". С цифрой 1 или 2 — только та неделя
 * (как обычно подписывают "числитель"/"знаменатель").
 */
export function scheduleTemplate() {
  return [
    'ПН',
    '08:30-10:00 Математика | 2 корпус, ауд. 305 | Иванова А.И.',
    '',
    'ПН1',
    '10:10-11:40 Физика | ауд. 210',
    '',
    'ПН2',
    '10:10-11:40 Химия | ауд. 118',
    '',
    'ВТ',
    '08:30-10:00 История',
    '',
    '(ПН1 = только на 1-й неделе, ПН2 = только на 2-й, ПН без цифры = каждую неделю)',
    '(в аудитории можно сразу указать корпус — это пригодится для поиска преподавателя: "🔎 Найти преподавателя" покажет именно то, что тут написано)',
  ].join('\n');
}

/**
 * Готовый промпт, который студент копирует и отправляет вместе со
 * скриншотом расписания в любую нейросеть (Claude, ChatGPT и т.д.) —
 * а её ответ уже вставляет боту. Так не нужно вручную перепечатывать пары.
 */
export function aiPromptTemplate() {
  return [
    'Передо мной скриншот расписания занятий в колледже. Преобразуй его в текст',
    'строго по формату ниже — без каких-либо пояснений до или после, только сам текст.',
    '',
    'ФОРМАТ:',
    'Каждый день недели пишется отдельной строкой-заголовком: ПН, ВТ, СР, ЧТ, ПТ, СБ или ВС.',
    'Если на скриншоте видно, что расписание чередуется по неделям (обычно это',
    'подписано как "числитель/знаменатель", "1-я/2-я неделя", "верхняя/нижняя строка"',
    'в ячейке дня, или пары просто продублированы с пометкой недели рядом с датами),',
    'то вместо "ПН" пиши "ПН1" для пар первой недели и "ПН2" для пар второй недели —',
    'аналогично для остальных дней. Если чередования нет — просто "ПН" без цифры.',
    '',
    'После заголовка дня — по одной строке на каждую пару в формате:',
    'ЧЧ:ММ-ЧЧ:ММ Название предмета | Аудитория | Преподаватель',
    '(аудиторию и преподавателя пиши, только если они видны на скриншоте; если',
    'преподавателя нет — оставь только "ЧЧ:ММ-ЧЧ:ММ Название | Аудитория". Если на',
    'скриншоте видно название корпуса или здания — укажи его прямо в поле',
    'аудитории вместе с номером кабинета, например "2 корпус, ауд. 305".)',
    '',
    'Пример нужного результата:',
    'ПН',
    '08:30-10:00 Математика | ауд. 305 | Иванова А.И.',
    '',
    'ПН1',
    '10:10-11:40 Физика | ауд. 210',
    '',
    'ПН2',
    '10:10-11:40 Химия | ауд. 118',
    '',
    'ВТ',
    '08:30-10:00 История',
    '',
    'Дни без пар на скриншоте просто не указывай. Ответь только текстом в этом',
    'формате, готовым к копированию.',
  ].join('\n');
}

/**
 * Разбирает текст расписания (шаблон или ответ нейросети) в структуру:
 * { 1: [{position, time_start, time_end, subject, room, teacher, week_parity}], 2: [...], ... }
 * week_parity: null (каждую неделю), 1 или 2.
 * Бросает Error с понятным текстом, если что-то не распознано.
 */
/** "8:30" -> "08:30": иначе строковая сортировка ставит 8:30 после 10:10. */
export function padTime(t) {
  return /^\d:\d{2}$/.test(t) ? `0${t}` : t;
}

export function parseScheduleText(rawText) {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const result = {};
  const positionCounters = {}; // ключ "weekday_parity" -> счётчик позиции
  let currentWeekday = null;
  let currentParity = null;

  const timeLineRe = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})?\s+(.+)$/;

  for (const line of lines) {
    const lowerNoPunct = line.toLowerCase().replace(/[.,:]+$/, '');
    const headerMatch = lowerNoPunct.match(DAY_HEADER_RE);

    if (headerMatch) {
      const [, alias, parityDigit] = headerMatch;
      currentWeekday = WEEKDAY_ALIASES[alias];
      currentParity = parityDigit ? Number(parityDigit) : null;
      if (!result[currentWeekday]) result[currentWeekday] = [];
      continue;
    }

    if (line.startsWith('(')) continue; // строки-подсказки игнорируем

    if (currentWeekday === null) {
      throw new Error(
        `Не понял, к какому дню относится строка: "${line}". Сначала укажи день (ПН, ВТ, ...), потом пары.`
      );
    }

    const match = line.match(timeLineRe);
    if (!match) {
      throw new Error(
        `Не смог разобрать строку: "${line}". Формат: "08:30-10:00 Предмет | Аудитория | Преподаватель"`
      );
    }

    const [, timeStart, timeEnd, rest] = match;
    const parts = rest.split('|').map((p) => p.trim());
    const [subject, room, teacher] = parts;

    if (!subject) {
      throw new Error(`Не указан предмет в строке: "${line}"`);
    }

    const counterKey = `${currentWeekday}_${currentParity ?? 'both'}`;
    positionCounters[counterKey] = (positionCounters[counterKey] || 0) + 1;

    result[currentWeekday].push({
      position: positionCounters[counterKey],
      week_parity: currentParity,
      time_start: padTime(timeStart),
      time_end: timeEnd ? padTime(timeEnd) : null,
      subject,
      room: room || null,
      teacher: teacher || null,
    });
  }

  if (Object.keys(result).length === 0) {
    throw new Error('Не нашёл ни одного дня с парами. Проверь формат и попробуй снова.');
  }

  return result;
}

// ---------- Группы ----------

export async function findGroupByName(name) {
  const { rows } = await query('SELECT * FROM groups WHERE name = $1', [name]);
  return rows[0] || null;
}

export async function createGroup(name, createdBy) {
  const { rows } = await query(
    'INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING *',
    [name, createdBy]
  );
  return rows[0];
}

export async function renameGroup(groupId, newName) {
  const { rows } = await query('UPDATE groups SET name = $1 WHERE id = $2 RETURNING *', [newName, groupId]);
  return rows[0] || null;
}

export async function getGroup(groupId) {
  const { rows } = await query('SELECT * FROM groups WHERE id = $1', [groupId]);
  return rows[0] || null;
}

export async function deleteGroup(groupId) {
  await query('DELETE FROM groups WHERE id = $1', [groupId]);
}

export async function listGroups() {
  const { rows } = await query('SELECT * FROM groups ORDER BY name ASC LIMIT 50');
  return rows;
}

// ---------- Семестры ----------

export async function createTerm(groupId, name, dateStart, dateEnd) {
  const { rows } = await query(
    'INSERT INTO terms (group_id, name, date_start, date_end) VALUES ($1, $2, $3, $4) RETURNING *',
    [groupId, name, dateStart, dateEnd]
  );
  return rows[0];
}

export async function listTerms(groupId) {
  const { rows } = await query(
    'SELECT * FROM terms WHERE group_id = $1 ORDER BY date_start ASC',
    [groupId]
  );
  return rows;
}

export async function getTerm(termId) {
  const { rows } = await query('SELECT * FROM terms WHERE id = $1', [termId]);
  return rows[0] || null;
}

export async function deleteTerm(termId) {
  await query('DELETE FROM terms WHERE id = $1', [termId]);
}

/** Семестр, в даты которого попадает dateKey — тот, что сейчас актуален. */
export async function getActiveTerm(groupId, dateKey) {
  const { rows } = await query(
    'SELECT * FROM terms WHERE group_id = $1 AND date_start <= $2 AND date_end >= $2 ORDER BY date_start LIMIT 1',
    [groupId, dateKey]
  );
  return rows[0] || null;
}

/**
 * Для показа расписания, когда сейчас "между семестрами": актуальный, если
 * есть, иначе ближайший будущий, иначе последний прошедший.
 */
export async function getRelevantTermForViewing(groupId, dateKey) {
  const active = await getActiveTerm(groupId, dateKey);
  if (active) return { term: active, status: 'active' };

  const upcoming = await query(
    'SELECT * FROM terms WHERE group_id = $1 AND date_start > $2 ORDER BY date_start ASC LIMIT 1',
    [groupId, dateKey]
  );
  if (upcoming.rows[0]) return { term: upcoming.rows[0], status: 'upcoming' };

  const past = await query(
    'SELECT * FROM terms WHERE group_id = $1 AND date_end < $2 ORDER BY date_end DESC LIMIT 1',
    [groupId, dateKey]
  );
  if (past.rows[0]) return { term: past.rows[0], status: 'past' };

  return null;
}

// ---------- Расписание внутри семестра ----------

/** Полностью заменяет расписание семестра на новое (в транзакции). */
export async function replaceScheduleForTerm(termId, parsed) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM lessons WHERE term_id = $1', [termId]);
    for (const [weekday, lessons] of Object.entries(parsed)) {
      for (const lesson of lessons) {
        await client.query(
          `INSERT INTO lessons (term_id, weekday, week_parity, position, time_start, time_end, subject, room, teacher)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            termId,
            Number(weekday),
            lesson.week_parity,
            lesson.position,
            lesson.time_start,
            lesson.time_end,
            lesson.subject,
            lesson.room,
            lesson.teacher,
          ]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Условие "пара стоит на эту дату". У пар, загруженных с сайта, есть точный
// список дат (dates) — он главнее чередования недель: учитывает праздники,
// практику и сдвиги. У пар, введённых вручную, dates нет — работает 1-я/2-я неделя.
const ON_DATE_SQL = (dateExpr, parityParam) =>
  `(CASE WHEN l.dates IS NOT NULL THEN ${dateExpr} = ANY(l.dates)
         ELSE (l.week_parity IS NULL OR l.week_parity = ${parityParam}) END)`;

// Подгруппа подписчика: NULL — показываем пары обеих подгрупп.
const SUBGROUP_SQL = (param) => `(${param}::smallint IS NULL OR l.subgroup IS NULL OR l.subgroup = ${param}::smallint)`;

/**
 * Пары на конкретную дату: dateKey "YYYY-MM-DD", weekday 1..7, weekParity 1|2.
 * subgroup: 1 | 2 | null.
 */
export async function getLessonsForDay(termId, weekday, weekParity, dateKey, subgroup = null) {
  const { rows } = await query(
    `SELECT l.* FROM lessons l
     WHERE l.term_id = $1 AND l.weekday = $2
       AND ${ON_DATE_SQL('$4::date', '$3')}
       AND ${SUBGROUP_SQL('$5')}
     ORDER BY l.time_start ASC, l.subgroup ASC NULLS FIRST`,
    [termId, weekday, weekParity, dateKey, subgroup]
  );
  return rows;
}

/** Все пары недели, которая начинается с понедельника mondayKey, по дням. */
export async function getWeekScheduleForTerm(termId, weekParity, mondayKey, subgroup = null) {
  const { rows } = await query(
    `SELECT l.* FROM lessons l
     WHERE l.term_id = $1
       AND ${ON_DATE_SQL('($3::date + (l.weekday - 1))', '$2')}
       AND ${SUBGROUP_SQL('$4')}
     ORDER BY l.weekday ASC, l.time_start ASC, l.subgroup ASC NULLS FIRST`,
    [termId, weekParity, mondayKey, subgroup]
  );
  const byDay = {};
  for (const row of rows) {
    if (!byDay[row.weekday]) byDay[row.weekday] = [];
    byDay[row.weekday].push(row);
  }
  return byDay;
}

const sameLesson = (a, b) =>
  a.time_start === b.time_start && a.subject === b.subject && (a.room || '') === (b.room || '') &&
  (a.teacher || '') === (b.teacher || '') && (a.subgroup ?? 0) === (b.subgroup ?? 0) &&
  (a.lesson_type || '') === (b.lesson_type || '');

/**
 * Всё расписание семестра по дням, внутри дня — по неделям.
 * Пары, одинаковые на 1-й и 2-й неделе, показываются один раз в "both" —
 * иначе у групп с сайта каждая пара дублировалась бы дважды.
 */
export async function getFullScheduleForTerm(termId, subgroup = null) {
  const { rows } = await query(
    `SELECT l.* FROM lessons l WHERE l.term_id = $1 AND ${SUBGROUP_SQL('$2')}
     ORDER BY l.weekday ASC, l.time_start ASC, l.subgroup ASC NULLS FIRST`,
    [termId, subgroup]
  );
  const byDay = {};
  for (const row of rows) {
    if (!byDay[row.weekday]) byDay[row.weekday] = { both: [], week1: [], week2: [] };
    const day = byDay[row.weekday];
    if (row.week_parity === 1) day.week1.push(row);
    else if (row.week_parity === 2) day.week2.push(row);
    else day.both.push(row);
  }
  for (const day of Object.values(byDay)) {
    const rest2 = [...day.week2];
    day.week1 = day.week1.filter((l1) => {
      const i = rest2.findIndex((l2) => sameLesson(l1, l2));
      if (i === -1) return true;
      day.both.push(l1);
      rest2.splice(i, 1);
      return false;
    });
    day.week2 = rest2;
    day.both.sort((a, b) => a.time_start.localeCompare(b.time_start) || (a.subgroup ?? 0) - (b.subgroup ?? 0));
  }
  return byDay;
}

/** Есть ли у группы деление на подгруппы (хотя бы одна пара с подгруппой). */
export async function groupHasSubgroups(groupId) {
  if (!groupId) return false;
  const { rows } = await query(
    `SELECT EXISTS (
       SELECT 1 FROM lessons l JOIN terms t ON t.id = l.term_id
       WHERE t.group_id = $1 AND l.subgroup IS NOT NULL
     ) AS has`,
    [groupId]
  );
  return rows[0].has;
}
