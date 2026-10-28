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


const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
function longDate(dateKey) {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}

/**
 * Пояснение, когда пар нет не просто так: занятия ещё не начались, расписание
 * на сайте не опубликовано (бывает у заочников) или ближайшее занятие позже.
 * Возвращает HTML-строки или null, если сказать нечего.
 * dayEmpty — пустой ли именно этот день (тогда можно подсказать ближайшую дату).
 */
export async function upcomingNote(groupId, dateKey, term, { dayEmpty = true } = {}) {
  if (!term) {
    const { rows: [next] } = await query(
      `SELECT t.id, t.date_start::text AS start,
              EXISTS (SELECT 1 FROM lessons l WHERE l.term_id = t.id) AS has_lessons
       FROM terms t WHERE t.group_id = $1 AND t.date_start > $2::date ORDER BY t.date_start LIMIT 1`, [groupId, dateKey]);
    if (!next) return null;
    return [`⏳ <b>Занятия начнутся ${longDate(next.start)}</b>`,
      next.has_lessons ? null : '<i>Расписание на сайте пока не опубликовано — подтяну его сам, как только появится.</i>']
      .filter(Boolean).join('\n');
  }
  const { rows: [c] } = await query('SELECT count(*)::int n FROM lessons WHERE term_id = $1', [term.id]);
  if (!c.n) {
    const { rows: [t] } = await query('SELECT date_start::text s, date_end::text e FROM terms WHERE id = $1', [term.id]);
    return `⏳ <b>Расписание на сайте пока не опубликовано</b>\nПериод: ${longDate(t.s)} – ${longDate(t.e)}. Подтяну его сам, как только появится.`;
  }
  if (!dayEmpty) return null;
  const { rows: [nx] } = await query(
    `SELECT min(d)::text AS d FROM (SELECT unnest(l.dates) AS d FROM lessons l WHERE l.term_id IN (SELECT id FROM terms WHERE group_id = $1)) x
     WHERE d > $2::date`, [groupId, dateKey]);
  return nx?.d ? `📅 <b>Ближайшее занятие: ${longDate(nx.d)}</b>` : null;
}

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
  if (!term) {
    return (await upcomingNote(sub.group_id, dateKey, null)) || (kind === 'evening' ? NO_ACTIVE_TERM_TOMORROW : NO_ACTIVE_TERM_TODAY);
  }

  const weekParity = weekParityForDate(dateKey, term.date_start);
  const lessons = await getLessonsForDay(term.id, weekdayIso, weekParity, dateKey, subgroup);
  const dateLabel = formatHumanDate(dateKey, weekdayIso);
  const text = formatDaySchedule({ kind, dateLabel, lessons, weekParity, subgroup: subgroup });
  return lessons.length ? text : appendNote(text, await upcomingNote(sub.group_id, dateKey, term));
}

const appendNote = (text, note) => (note ? `${text}\n\n${note}` : text);

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
  if (!term) return (await upcomingNote(sub.group_id, dateKey, null)) || NO_ACTIVE_TERM_TODAY;

  const weekParity = weekParityForDate(dateKey, term.date_start);
  const byDay = await getWeekScheduleForTerm(term.id, weekParity, mondayKeyOf(dateKey), subgroup);
  const text = formatWeekSchedule(byDay, term, weekParity, subgroup);
  return Object.keys(byDay).length ? text : appendNote(text, await upcomingNote(sub.group_id, dateKey, term));
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
    const note = await upcomingNote(sub.group_id, dateKey, null);
    return formatDaySchedule({ kind: 'date', dateLabel, relLabel, lessons: [], weekParity: null, subgroup: subgroup })
      .replace('<b>ПАР НЕТ</b>\nСвободный день', note || '<b>Каникулы</b>\nНа эту дату в расписании нет семестра');
  }
  const weekParity = weekParityForDate(dateKey, term.date_start);
  const lessons = await getLessonsForDay(term.id, weekday, weekParity, dateKey, subgroup);
  const nowHHMM = dateKey === today ? nowInTimezone(sub.timezone).hhmm : null;
  const text = formatDaySchedule({ kind: 'date', dateLabel, relLabel, lessons, weekParity, subgroup: subgroup, nowHHMM });
  return lessons.length ? text : appendNote(text, await upcomingNote(sub.group_id, dateKey, term));
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
  if (!term) {
    return appendNote(formatWeekSchedule({}, null, null, subgroup, { mondayKey, todayKey: today }),
      await upcomingNote(sub.group_id, mondayKey, null));
  }
  const weekParity = weekParityForDate(mondayKey, term.date_start);
  const byDay = await getWeekScheduleForTerm(term.id, weekParity, mondayKey, subgroup);
  const text = formatWeekSchedule(byDay, term, weekParity, subgroup, { mondayKey, todayKey: today });
  return Object.keys(byDay).length ? text : appendNote(text, await upcomingNote(sub.group_id, mondayKey, term));
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
