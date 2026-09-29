import { query } from './db.js';
import { nowInTimezone, weekParityForDate, tomorrowDateKey, nextWeekdayIso } from './time.js';

async function findTeacherLessonsForDate(teacherQuery, dateKey, weekdayIso) {
  const { rows } = await query(
    `SELECT l.id, l.time_start, l.time_end, l.subject, l.room, l.teacher, l.week_parity,
            t.date_start AS term_date_start, g.name AS group_name
     FROM lessons l
     JOIN terms t ON l.term_id = t.id
     JOIN groups g ON t.group_id = g.id
     WHERE t.date_start <= $1 AND t.date_end >= $1
       AND l.weekday = $2
       AND l.teacher ILIKE $3
     ORDER BY l.time_start ASC`,
    [dateKey, weekdayIso, `%${teacherQuery}%`]
  );

  // У каждой группы свой семестр (своя дата начала) — а значит и своё
  // чередование недель 1/2, поэтому фильтруем по неделе уже в JS, отдельно
  // для каждой строки, а не одним общим параметром в SQL.
  return rows.filter((row) => {
    if (row.week_parity === null) return true;
    const parity = weekParityForDate(dateKey, row.term_date_start);
    return row.week_parity === parity;
  });
}

/**
 * Ищет пары преподавателя (по подстроке ФИО, без учёта регистра) на сегодня,
 * сразу по ВСЕМ учебным группам, у которых прямо сейчас идёт семестр — не
 * только по той группе, что настроена в этом чате. Так студент любой
 * группы может узнать, где сейчас конкретный преподаватель.
 *
 * timezone — чей "сегодня"/"сейчас" считать (часовой пояс спрашивающего).
 */
export async function findTeacherLessonsToday(teacherQuery, timezone) {
  const { weekdayIso, dateKey, hhmm } = nowInTimezone(timezone);
  const todayLessons = await findTeacherLessonsForDate(teacherQuery, dateKey, weekdayIso);

  const current = todayLessons.find((row) => {
    if (!row.time_end) return false;
    return hhmm >= row.time_start && hhmm < row.time_end;
  }) || null;

  return { todayLessons, current };
}

/** То же самое, но на завтра (без понятия "текущая пара" — она ещё не наступила). */
export async function findTeacherLessonsTomorrow(teacherQuery, timezone) {
  const { dateKey, weekdayIso } = nowInTimezone(timezone);
  const targetDateKey = tomorrowDateKey(dateKey);
  const targetWeekday = nextWeekdayIso(weekdayIso);
  const lessons = await findTeacherLessonsForDate(teacherQuery, targetDateKey, targetWeekday);
  return { lessons };
}

/** Список всех преподавателей, у которых вообще есть хоть одна пара в
 * расписании (по всем группам), отсортированный по алфавиту — для того,
 * чтобы предлагать их кнопками, а не заставлять печатать фамилию вручную. */
export async function listDistinctTeachers() {
  const { rows } = await query(
    `SELECT DISTINCT teacher FROM lessons WHERE teacher IS NOT NULL AND teacher <> '' ORDER BY teacher ASC`
  );
  return rows.map((r) => r.teacher);
}
