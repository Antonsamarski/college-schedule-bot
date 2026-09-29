import { getActiveTerm, getLessonsForDay, getWeekScheduleForTerm } from './schedule.js';
import { formatDaySchedule, formatWeekSchedule } from './format.js';
import {
  nowInTimezone,
  nextWeekdayIso,
  tomorrowDateKey,
  formatHumanDate,
  weekParityForDate,
} from './time.js';

const NO_ACTIVE_TERM_TODAY =
  'Сейчас нет активного семестра на эту дату (возможно, каникулы). Проверь «📆 Семестры» в меню расписания.';
const NO_ACTIVE_TERM_TOMORROW =
  'На завтра нет активного семестра (возможно, каникулы). Проверь «📆 Семестры» в меню расписания.';

/** Готовый HTML-текст с расписанием на сегодня для группы, с учётом часового пояса. */
export async function buildTodayDigest(groupId, timezone) {
  const { weekdayIso, dateKey } = nowInTimezone(timezone);
  const term = await getActiveTerm(groupId, dateKey);
  if (!term) return NO_ACTIVE_TERM_TODAY;

  const weekParity = weekParityForDate(dateKey, term.date_start);
  const lessons = await getLessonsForDay(term.id, weekdayIso, weekParity);
  const dateLabel = formatHumanDate(dateKey, weekdayIso);
  return formatDaySchedule({ kind: 'morning', dateLabel, lessons, weekParity });
}

/** Готовый HTML-текст с расписанием на завтра для группы, с учётом часового пояса. */
export async function buildTomorrowDigest(groupId, timezone) {
  const { weekdayIso, dateKey } = nowInTimezone(timezone);
  const targetWeekday = nextWeekdayIso(weekdayIso);
  const targetDateKey = tomorrowDateKey(dateKey);
  const term = await getActiveTerm(groupId, targetDateKey);
  if (!term) return NO_ACTIVE_TERM_TOMORROW;

  const weekParity = weekParityForDate(targetDateKey, term.date_start);
  const lessons = await getLessonsForDay(term.id, targetWeekday, weekParity);
  const dateLabel = formatHumanDate(targetDateKey, targetWeekday);
  return formatDaySchedule({ kind: 'evening', dateLabel, lessons, weekParity });
}

/** Готовый HTML-текст с расписанием на ТЕКУЩУЮ неделю (все дни разом, с
 * учётом того, какая сейчас неделя — 1-я или 2-я). */
export async function buildWeekDigest(groupId, timezone) {
  const { dateKey } = nowInTimezone(timezone);
  const term = await getActiveTerm(groupId, dateKey);
  if (!term) return NO_ACTIVE_TERM_TODAY;

  const weekParity = weekParityForDate(dateKey, term.date_start);
  const byDay = await getWeekScheduleForTerm(term.id, weekParity);
  return formatWeekSchedule(byDay, term, weekParity);
}
