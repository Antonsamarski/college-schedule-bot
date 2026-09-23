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
    '(ПН1 = только на 1-й неделе, ПН2 = только на 2-й, ПН без цифры = каждую неделю)',
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
    'преподавателя нет — оставь только "ЧЧ:ММ-ЧЧ:ММ Название | Аудитория").',
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
      time_start: timeStart,
      time_end: timeEnd || null,
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

/** Пары на конкретный день недели для конкретной недели (1 или 2): свои + общие ("каждую неделю"). */
export async function getLessonsForDay(termId, weekday, weekParity) {
  const { rows } = await query(
    `SELECT * FROM lessons
     WHERE term_id = $1 AND weekday = $2 AND (week_parity IS NULL OR week_parity = $3)
     ORDER BY time_start ASC`,
    [termId, weekday, weekParity]
  );
  return rows;
}

/** Всё расписание семестра, сгруппированное по дню, внутри дня — по неделям. */
export async function getFullScheduleForTerm(termId) {
  const { rows } = await query(
    'SELECT * FROM lessons WHERE term_id = $1 ORDER BY weekday ASC, time_start ASC',
    [termId]
  );
  const byDay = {};
  for (const row of rows) {
    if (!byDay[row.weekday]) byDay[row.weekday] = { both: [], week1: [], week2: [] };
    if (row.week_parity === 1) byDay[row.weekday].week1.push(row);
    else if (row.week_parity === 2) byDay[row.weekday].week2.push(row);
    else byDay[row.weekday].both.push(row);
  }
  return byDay;
}
