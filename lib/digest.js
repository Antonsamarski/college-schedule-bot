import { getActiveTerm, getLessonsForDay, getWeekScheduleForTerm, groupHasSubgroups } from './schedule.js';
import { formatDaySchedule, formatWeekSchedule } from './format.js';
import { ensureGroupFresh } from './ssaaSync.js';
import {
  nowInTimezone,
  nextWeekdayIso,
  tomorrowDateKey,
  formatHumanDate,
  weekParityForDate,
  mondayKeyOf,
  isoWeekday,
  relativeDayLabel,
} from './time.js';
import { query } from './db.js';

const NO_ACTIVE_TERM_TODAY = '<b>Каникулы</b>\nНа сегодня в расписании нет семестра.';
const NO_ACTIVE_TERM_TOMORROW = '<b>Каникулы</b>\nНа завтра в расписании нет семестра.';

/** Выбранная подгруппа, но только если у группы вообще есть подгруппы. */
async function effectiveSubgroup(sub) {
  if (!sub.subgroup) return null;
  return (await groupHasSubgroups(sub.group_id)) ? sub.subgroup : null;
}

/**
 * Подписчик — строка users или group_chats: { group_id, timezone, subgroup }.
 * Перед построением расписания группа с сайта при необходимости обновляется.
 */
async function buildDayDigest(sub, kind) {
  await ensureGroupFresh(sub.group_id);
  const subgroup = await effectiveSubgroup(sub);
  const now = nowInTimezone(sub.timezone);
  const dateKey = kind === 'evening' ? tomorrowDateKey(now.dateKey) : now.dateKey;
  const weekdayIso = kind === 'evening' ? nextWeekdayIso(now.weekdayIso) : now.weekdayIso;

  const term = await getActiveTerm(sub.group_id, dateKey);
  if (!term) return kind === 'evening' ? NO_ACTIVE_TERM_TOMORROW : NO_ACTIVE_TERM_TODAY;

  const weekParity = weekParityForDate(dateKey, term.date_start);
  const lessons = await getLessonsForDay(term.id, weekdayIso, weekParity, dateKey, subgroup);
  const dateLabel = formatHumanDate(dateKey, weekdayIso);
  return formatDaySchedule({ kind, dateLabel, lessons, weekParity, subgroup: subgroup });
}

/** Готовый HTML-текст с расписанием на сегодня. */
export async function buildTodayDigest(sub) {
  return buildDayDigest(sub, 'morning');
}

/** Готовый HTML-текст с расписанием на завтра. */
export async function buildTomorrowDigest(sub) {
  return buildDayDigest(sub, 'evening');
}

/** Расписание на текущую неделю (по точным датам, если они есть). */
export async function buildWeekDigest(sub) {
  await ensureGroupFresh(sub.group_id);
  const subgroup = await effectiveSubgroup(sub);
  const { dateKey } = nowInTimezone(sub.timezone);
  const term = await getActiveTerm(sub.group_id, dateKey);
  if (!term) return NO_ACTIVE_TERM_TODAY;

  const weekParity = weekParityForDate(dateKey, term.date_start);
  const byDay = await getWeekScheduleForTerm(term.id, weekParity, mondayKeyOf(dateKey), subgroup);
  return formatWeekSchedule(byDay, term, weekParity, subgroup);
}

/**
 * Пары группы на любую дату (для экранов бота с листанием и календарём).
 * Возвращает HTML-текст.
 */
export async function buildDateView(sub, dateKey) {
  await ensureGroupFresh(sub.group_id);
  const subgroup = await effectiveSubgroup(sub);
  const today = nowInTimezone(sub.timezone).dateKey;
  const weekday = isoWeekday(dateKey);
  const dateLabel = formatHumanDate(dateKey, weekday);
  const relLabel = relativeDayLabel(dateKey, today);
  const term = await getActiveTerm(sub.group_id, dateKey);
  if (!term) {
    return formatDaySchedule({ kind: 'date', dateLabel, relLabel, lessons: [], weekParity: null, subgroup: subgroup })
      .replace('<b>Пар нет</b>\nСвободный день', '<b>Каникулы</b>\nНа эту дату в расписании нет семестра');
  }
  const weekParity = weekParityForDate(dateKey, term.date_start);
  const lessons = await getLessonsForDay(term.id, weekday, weekParity, dateKey, subgroup);
  const nowHHMM = dateKey === today ? nowInTimezone(sub.timezone).hhmm : null;
  return formatDaySchedule({ kind: 'date', dateLabel, relLabel, lessons, weekParity, subgroup: subgroup, nowHHMM });
}

/** Пары группы на неделю, начинающуюся с mondayKey. */
export async function buildWeekView(sub, mondayKey) {
  await ensureGroupFresh(sub.group_id);
  const subgroup = await effectiveSubgroup(sub);
  const today = nowInTimezone(sub.timezone).dateKey;
  // Семестр ищем по любому дню недели (неделя может начаться до семестра).
  let term = null;
  for (let i = 0; i < 7 && !term; i++) {
    const d = new Date(Date.parse(mondayKey) + i * 86_400_000).toISOString().slice(0, 10);
    term = await getActiveTerm(sub.group_id, d);
  }
  if (!term) return formatWeekSchedule({}, null, null, subgroup, { mondayKey, todayKey: today });
  const weekParity = weekParityForDate(mondayKey, term.date_start);
  const byDay = await getWeekScheduleForTerm(term.id, weekParity, mondayKey, subgroup);
  return formatWeekSchedule(byDay, term, weekParity, subgroup, { mondayKey, todayKey: today });
}

/**
 * Даты в [from, to], на которые у группы есть пары — для точек в календаре.
 * Для расписаний с сайта даты точные; для введённых вручную считаем по дням недели.
 */
export async function groupLessonDates(sub, from, to) {
  const { rows } = await query(
    `SELECT DISTINCT d::text AS d FROM (
       SELECT unnest(l.dates) AS d FROM lessons l JOIN terms t ON t.id = l.term_id
       WHERE t.group_id = $1 AND l.dates IS NOT NULL
         AND ($4::smallint IS NULL OR l.subgroup IS NULL OR l.subgroup = $4::smallint)
       UNION ALL
       SELECT g::date FROM terms t
       JOIN generate_series(GREATEST(t.date_start, $2::date), LEAST(t.date_end, $3::date), interval '1 day') g ON true
       WHERE t.group_id = $1 AND EXISTS (
         SELECT 1 FROM lessons l WHERE l.term_id = t.id AND l.dates IS NULL
           AND l.weekday = EXTRACT(ISODOW FROM g)::int
           AND (l.week_parity IS NULL OR l.week_parity =
                CASE WHEN ((g::date - date_trunc('week', t.date_start)::date) / 7) % 2 = 0 THEN 1 ELSE 2 END))
     ) x WHERE d BETWEEN $2::date AND $3::date`,
    [sub.group_id, from, to, sub.subgroup ?? null]
  );
  return new Set(rows.map((r) => r.d));
}
