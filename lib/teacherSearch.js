import { query } from './db.js';
import { nowInTimezone, weekParityForDate, tomorrowDateKey, nextWeekdayIso } from './time.js';

/**
 * Разбивает поле "преподаватель" на отдельных людей: у пар подгрупп там
 * бывает "Иванова А. А., Петров Б. Б." — раньше это считалось одним
 * "преподавателем" и в списке появлялись склейки и дубли.
 */
export function splitTeacherField(s) {
  if (!s) return [];
  return s
    .split(/[,;]\s*(?=[А-ЯЁA-Z])/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p && p !== '-');
}

/**
 * Ключ для сравнения людей: "фамилия + инициалы" без регистра и ё.
 * "Иванова Анна Ивановна", "Иванова А.И." и "иванова  а. и." → "иванова аи".
 */
export function teacherKey(name) {
  const tokens = name.replace(/\./g, '. ').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const surname = tokens[0].replace(/\.$/, '');
  const initials = tokens.slice(1, 3).map((t) => t[0]).join('');
  return `${surname} ${initials}`.toLowerCase().replace(/ё/g, 'е').trim();
}

/** Из всех написаний одного человека выбираем самое полное. */
export function dedupeTeachers(fields) {
  const best = new Map();
  for (const field of fields) {
    for (const name of splitTeacherField(field)) {
      const key = teacherKey(name);
      if (!key) continue;
      const prev = best.get(key);
      if (!prev || name.length > prev.length) best.set(key, name);
    }
  }
  return [...best.values()].sort((a, b) => a.localeCompare(b, 'ru'));
}

function rowMatches(row, teacherQuery, exact) {
  const people = splitTeacherField(row.teacher);
  if (exact) {
    const want = teacherKey(teacherQuery);
    return people.some((p) => teacherKey(p) === want);
  }
  const q = teacherQuery.toLowerCase().replace(/ё/g, 'е');
  return people.some((p) => p.toLowerCase().replace(/ё/g, 'е').includes(q));
}

async function findTeacherLessonsForDate(teacherQuery, dateKey, weekdayIso, exact) {
  // В SQL ищем грубо по фамилии, точное совпадение — уже в JS.
  const surname = teacherQuery.trim().split(/\s+/)[0].replace(/\.$/, '');
  const { rows } = await query(
    `SELECT l.id, l.time_start, l.time_end, l.subject, l.room, l.teacher, l.week_parity,
            l.subgroup, l.lesson_type, l.dates,
            t.date_start AS term_date_start, g.name AS group_name
     FROM lessons l
     JOIN terms t ON l.term_id = t.id
     JOIN groups g ON t.group_id = g.id
     WHERE t.date_start <= $1 AND t.date_end >= $1
       AND l.weekday = $2
       AND l.teacher ILIKE $3
       AND (l.dates IS NULL OR $1::date = ANY(l.dates))
     ORDER BY l.time_start ASC, g.name ASC`,
    [dateKey, weekdayIso, `%${surname}%`]
  );

  // У каждой группы свой семестр (своя дата начала) — а значит и своё
  // чередование недель 1/2, поэтому фильтруем по неделе отдельно для каждой
  // строки. Для пар с точными датами (с сайта) неделя уже учтена в SQL.
  return rows.filter((row) => {
    if (!rowMatches(row, teacherQuery, exact)) return false;
    if (row.dates || row.week_parity === null) return true;
    return row.week_parity === weekParityForDate(dateKey, row.term_date_start);
  });
}

/**
 * Пары преподавателя на сегодня по ВСЕМ группам, у которых сейчас идёт
 * семестр. exact = true — выбран из списка (сравниваем по фамилии и
 * инициалам), false — введён текстом (поиск по подстроке).
 */
export async function findTeacherLessonsToday(teacherQuery, timezone, exact = false) {
  const { weekdayIso, dateKey, hhmm } = nowInTimezone(timezone);
  const todayLessons = await findTeacherLessonsForDate(teacherQuery, dateKey, weekdayIso, exact);

  const current = todayLessons.find((row) => row.time_end && hhmm >= row.time_start && hhmm < row.time_end) || null;
  return { todayLessons, current };
}

/** То же самое, но на завтра (без "текущей пары"). */
export async function findTeacherLessonsTomorrow(teacherQuery, timezone, exact = false) {
  const { dateKey, weekdayIso } = nowInTimezone(timezone);
  const lessons = await findTeacherLessonsForDate(
    teacherQuery, tomorrowDateKey(dateKey), nextWeekdayIso(weekdayIso), exact
  );
  return { lessons };
}

/** Все преподаватели по всем группам — без повторов и склеек, по алфавиту. */
export async function listDistinctTeachers() {
  const { rows } = await query(
    `SELECT DISTINCT teacher FROM lessons WHERE teacher IS NOT NULL AND teacher <> ''`
  );
  return dedupeTeachers(rows.map((r) => r.teacher));
}
