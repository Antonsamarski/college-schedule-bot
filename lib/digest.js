import { getActiveTerm, getLessonsForDay, getWeekScheduleForTerm } from './schedule.js';
import { formatDaySchedule, formatWeekSchedule } from './format.js';
import { ensureGroupFresh } from './ssaaSync.js';
import {
  nowInTimezone,
  nextWeekdayIso,
  tomorrowDateKey,
  formatHumanDate,
  weekParityForDate,
  mondayKeyOf,
} from './time.js';

const NO_ACTIVE_TERM_TODAY =
  'Сейчас нет активного семестра на эту дату (возможно, каникулы). Проверь «📆 Семестры» в меню расписания.';
const NO_ACTIVE_TERM_TOMORROW =
  'На завтра нет активного семестра (возможно, каникулы). Проверь «📆 Семестры» в меню расписания.';

/**
 * Подписчик — строка users или group_chats: { group_id, timezone, subgroup }.
 * Перед построением расписания группа с сайта при необходимости обновляется.
 */
async function buildDayDigest(sub, kind) {
  await ensureGroupFresh(sub.group_id);
  const now = nowInTimezone(sub.timezone);
  const dateKey = kind === 'evening' ? tomorrowDateKey(now.dateKey) : now.dateKey;
  const weekdayIso = kind === 'evening' ? nextWeekdayIso(now.weekdayIso) : now.weekdayIso;

  const term = await getActiveTerm(sub.group_id, dateKey);
  if (!term) return kind === 'evening' ? NO_ACTIVE_TERM_TOMORROW : NO_ACTIVE_TERM_TODAY;

  const weekParity = weekParityForDate(dateKey, term.date_start);
  const lessons = await getLessonsForDay(term.id, weekdayIso, weekParity, dateKey, sub.subgroup ?? null);
  const dateLabel = formatHumanDate(dateKey, weekdayIso);
  return formatDaySchedule({ kind, dateLabel, lessons, weekParity, subgroup: sub.subgroup ?? null });
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
  const { dateKey } = nowInTimezone(sub.timezone);
  const term = await getActiveTerm(sub.group_id, dateKey);
  if (!term) return NO_ACTIVE_TERM_TODAY;

  const weekParity = weekParityForDate(dateKey, term.date_start);
  const byDay = await getWeekScheduleForTerm(term.id, weekParity, mondayKeyOf(dateKey), sub.subgroup ?? null);
  return formatWeekSchedule(byDay, term, weekParity, sub.subgroup ?? null);
}
