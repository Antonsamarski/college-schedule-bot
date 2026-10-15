/**
 * Возвращает { hhmm: "07:30", weekdayIso: 1..7, dateKey: "2026-09-23" }
 * для текущего момента в указанном IANA-часовом поясе.
 */
export function nowInTimezone(timezone) {
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    // hourCycle h23, а не hour12:false — иначе в полночь Node отдаёт "24:05"
    // вместо "00:05", и рассылка на 00:xx не срабатывает никогда.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(now);

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

  return {
    hhmm: `${map.hour}:${map.minute}`,
    weekdayIso: weekdayMap[map.weekday],
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

/** Проверяет формат "HH:MM" (24 часа). */
export function isValidTime(str) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(str.trim());
}

export function nextWeekdayIso(weekdayIso) {
  return weekdayIso === 7 ? 1 : weekdayIso + 1;
}

const RU_WEEKDAY_LONG = {
  1: 'понедельник', 2: 'вторник', 3: 'среда', 4: 'четверг',
  5: 'пятница', 6: 'суббота', 7: 'воскресенье',
};

const RU_MONTH = {
  1: 'января', 2: 'февраля', 3: 'марта', 4: 'апреля', 5: 'мая', 6: 'июня',
  7: 'июля', 8: 'августа', 9: 'сентября', 10: 'октября', 11: 'ноября', 12: 'декабря',
};

/** dateKey "YYYY-MM-DD" + weekdayIso -> "вторник, 23 сентября" (для нужного дня, не обязательно сегодняшнего) */
export function formatHumanDate(dateKey, weekdayIso) {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${RU_WEEKDAY_LONG[weekdayIso]}, ${Number(d)} ${RU_MONTH[m]}`;
}

/** Дата "завтра" по календарю, для вечерней рассылки (просто +1 день с учётом месяца/года). */
export function tomorrowDateKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function dateKeyToUTC(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Понедельник той недели, в которую попадает dateKey (как Date в UTC). */
function mondayOfWeek(dateKey) {
  const dt = dateKeyToUTC(dateKey);
  const isoDow = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay(); // 1=Пн..7=Вс
  dt.setUTCDate(dt.getUTCDate() - (isoDow - 1));
  return dt;
}

/** Понедельник недели, в которую попадает dateKey, строкой "YYYY-MM-DD". */
export function mondayKeyOf(dateKey) {
  return mondayOfWeek(dateKey).toISOString().slice(0, 10);
}

/** dateKey + n дней -> "YYYY-MM-DD". */
export function addDays(dateKey, n) {
  const dt = dateKeyToUTC(dateKey);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** "HH:MM" + минуты -> минуты от полуночи (для сравнения окон рассылки). */
export function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Считает, какая сейчас неделя (1 или 2) для dateKey, если неделя 1
 * начинается с недели, куда попадает termStartDateKey (начало семестра).
 * Как в обычном расписании "числитель/знаменатель": первая неделя семестра
 * всегда неделя 1, дальше чередуется.
 */
export function weekParityForDate(dateKey, termStartDateKey) {
  const targetMonday = mondayOfWeek(dateKey);
  const anchorMonday = mondayOfWeek(termStartDateKey);
  const diffDays = Math.round((targetMonday - anchorMonday) / 86_400_000);
  const weeksSince = Math.floor(diffDays / 7);
  const evenWeeksSince = ((weeksSince % 2) + 2) % 2; // на случай отрицательного diffDays
  return evenWeeksSince === 0 ? 1 : 2;
}

/** dateKey входит в диапазон [dateStart, dateEnd] (обе границы включительно, формат YYYY-MM-DD). */
export function isDateInRange(dateKey, dateStart, dateEnd) {
  return dateKey >= dateStart && dateKey <= dateEnd;
}

/** "2026-09-01" -> "01.09.2026" (для показа пользователю). */
export function formatDateShort(dateKey) {
  const [y, m, d] = dateKey.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * Разбирает дату, введённую пользователем, в форматах "01.09.2026" или
 * "2026-09-01". Возвращает "YYYY-MM-DD" или null, если не распознано
 * (в т.ч. если дата не существует, например 31.02).
 */
export function parseDateInput(str) {
  const s = str.trim();

  let y, m, d;
  const dotMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

  if (dotMatch) {
    [, d, m, y] = dotMatch;
  } else if (isoMatch) {
    [, y, m, d] = isoMatch;
  } else {
    return null;
  }

  y = Number(y);
  m = Number(m);
  d = Number(d);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null; // например 31 февраля — JS "перетёк" бы в март
  }

  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** День недели даты: 1 = понедельник … 7 = воскресенье. */
export function isoWeekday(dateKey) {
  const d = dateKeyToUTC(dateKey).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Разница в днях между датами (b - a). */
export function daysBetween(a, b) {
  return Math.round((dateKeyToUTC(b) - dateKeyToUTC(a)) / 86_400_000);
}

/** "сегодня" / "завтра" / "вчера" / "послезавтра" или null. */
export function relativeDayLabel(dateKey, todayKey) {
  return { 0: 'сегодня', 1: 'завтра', '-1': 'вчера', 2: 'послезавтра' }[daysBetween(todayKey, dateKey)] ?? null;
}

/**
 * Дата, введённая пользователем коротко: "20.10", "20.10.26", "20.10.2026",
 * "2026-10-20". Без года — ближайшая такая дата не раньше чем 2 месяца назад.
 */
export function parseUserDate(str, todayKey) {
  const s = str.trim().replace(/[/,\-\s]+/g, '.').replace(/\.$/, '');
  const full = parseDateInput(str) || parseDateInput(s.replace(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/, '$1.$2.20$3'));
  if (full) return full;
  const m = s.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!m) return null;
  const year = Number(todayKey.slice(0, 4));
  for (const y of [year, year + 1, year - 1]) {
    const k = parseDateInput(`${m[1]}.${m[2]}.${y}`);
    if (k && daysBetween(todayKey, k) >= -60 && daysBetween(todayKey, k) <= 305) return k;
  }
  return parseDateInput(`${m[1]}.${m[2]}.${year}`);
}
