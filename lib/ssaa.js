/**
 * Загрузка расписания с сайта Самарского ГАУ (ssaa.ru) — без ручного ввода.
 *
 * Как устроен сайт (проверено на живых данных, осень 2026):
 *  - Страница https://ssaa.ru/raspisanie-ochnoe содержит JS-массивы
 *    a_form / a_fak / a_kur / a_gr / a_per / a_pern — по элементу на каждую
 *    пару "группа + период". Из них берём список всех групп, поэтому новые
 *    группы и семестры появляются в боте сами, код трогать не нужно.
 *  - Расписание группы отдаёт POST /01/shedule.php с полями
 *    forma_f, fakultet_f, kurs_f, grupp_f, teil_f. Ответ — HTML-таблица:
 *    блоки «1 неделя» / «2 неделя», в ячейке дня перечислены ВСЕ даты,
 *    на которые этот день приходится в семестре.
 *  - Подгруппы пишутся через «/»: «Предмет/-» — пара только у 1-й
 *    подгруппы, «-/Предмет» — только у 2-й, «А1/А2» в аудитории — у каждой
 *    подгруппы свой кабинет. Преподаватели подгрупп идут через запятую.
 *    Здесь такие строки раскладываются по подгруппам — отсюда и не будет
 *    "склеенных" преподавателей в списке.
 */

export const SSAA_BASE = 'https://ssaa.ru';
export const SSAA_GROUPS_URL = `${SSAA_BASE}/raspisanie-ochnoe`;
export const SSAA_SCHEDULE_URL = `${SSAA_BASE}/01/shedule.php`;

/** Формы обучения — коды как на сайте. Порядок = порядок кнопок в боте. */
export const SSAA_FORMS = [
  { code: '11', label: 'Колледж (очная)', short: 'колледж' },
  { code: '13', label: 'Колледж (заочная)', short: 'колледж, заочн.' },
  { code: '1', label: 'Очная (бакалавр, специалист)', short: 'очн.' },
  { code: '2', label: 'Очная (магистр)', short: 'магистр., очн.' },
  { code: '9', label: 'Очно-заочная', short: 'очно-заочн.' },
  { code: '3', label: 'Заочная (бакалавр, специалист)', short: 'заочн.' },
  { code: '4', label: 'Заочная (магистр)', short: 'магистр., заочн.' },
  { code: '5', label: 'Аспирантура', short: 'аспирантура' },
];

const FETCH_TIMEOUT_MS = 8000;
const HEADERS = { 'User-Agent': 'college-schedule-bot (+https://github.com/Antonsamarski/college-schedule-bot)' };

// ---------------------------------------------------------------- утилиты

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', ndash: '–', mdash: '—' };

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Текст ячейки: теги убраны, <br> → разделитель, пробелы схлопнуты. */
function cellText(html, brAs = ' ') {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, brAs).replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function ddmmyyToIso(s) {
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${year}-${m[2]}-${m[1]}`;
}

const num = (s) => (String(s).match(/\d+/) || [String(s).trim()])[0];

async function fetchText(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) }, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`ssaa.ru ответил ${resp.status}`);
    return await resp.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('ssaa.ru не ответил вовремя');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- список групп

/**
 * Разбирает страницу raspisanie-ochnoe в список групп:
 * [{ key, form, faculty, course, group, period, periodName, dateStart, dateEnd, title }]
 * key — стабильный идентификатор группы (без периода), period — код семестра.
 */
export function parseGroupsPage(page) {
  const arrays = {};
  for (const [, name, body] of page.matchAll(/var\s+(a_\w+)\s*=\s*new Array\(([\s\S]*?)\);/g)) {
    arrays[name] = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => decodeEntities(m[1]));
  }
  const need = ['a_form', 'a_fak', 'a_kur', 'a_gr', 'a_per', 'a_pern'];
  if (!need.every((n) => Array.isArray(arrays[n]))) {
    throw new Error('На странице ssaa.ru не нашёл список групп — возможно, сайт изменился');
  }

  const seen = new Set();
  const out = [];
  for (let i = 0; i < arrays.a_form.length; i++) {
    const row = {
      form: arrays.a_form[i],
      faculty: arrays.a_fak[i],
      course: arrays.a_kur[i], // "2 курс"
      group: arrays.a_gr[i], // " 3 группа" — пробел в начале нужен сайту, не трогаем
      period: arrays.a_per[i],
      periodName: arrays.a_pern[i],
    };
    if (!row.form || !row.faculty || !row.course || !row.group || !row.period) continue;
    const [d1, d2] = (row.periodName.match(/\d{2}\.\d{2}\.\d{4}/g) || []).map(ddmmyyToIso);
    row.dateStart = d1 || null;
    row.dateEnd = d2 || d1 || null;
    row.key = groupKey(row);
    row.title = groupTitle(row);
    const dedupe = `${row.key}#${row.period}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(row);
  }
  return out;
}

export function groupKey(g) {
  return `ssaa:${g.form}:${g.faculty}:${num(g.course)}:${num(g.group)}`;
}

/** Человеческое название: "Колледж · 2 курс · 3 группа" (+ форма, если не колледж-очная). */
export function groupTitle(g) {
  const base = `${g.faculty} · ${num(g.course)} курс · ${num(g.group)} группа`;
  if (g.form === '11') return base;
  const form = SSAA_FORMS.find((f) => f.code === g.form);
  return form ? `${base} (${form.short})` : base;
}

let groupsCache = null;
let groupsCacheAt = 0;
const GROUPS_TTL_MS = 30 * 60_000;

export async function fetchSsaaGroups({ force = false } = {}) {
  if (!force && groupsCache && Date.now() - groupsCacheAt < GROUPS_TTL_MS) return groupsCache;
  const page = await fetchText(SSAA_GROUPS_URL);
  groupsCache = parseGroupsPage(page);
  groupsCacheAt = Date.now();
  return groupsCache;
}

/** Актуальный период группы на дату: идущий сейчас, иначе ближайший будущий, иначе последний. */
export function pickPeriod(periods, dateKey) {
  const sorted = [...periods].sort((a, b) => String(a.dateStart).localeCompare(String(b.dateStart)));
  return (
    sorted.find((p) => p.dateStart <= dateKey && dateKey <= p.dateEnd) ||
    sorted.find((p) => p.dateStart > dateKey) ||
    sorted[sorted.length - 1] ||
    null
  );
}

// ---------------------------------------------------------------- расписание группы

const WEEKDAY_ABBR = { 'Пн': 1, 'Вт': 2, 'Ср': 3, 'Чт': 4, 'Пт': 5, 'Сб': 6, 'Вс': 7 };

export async function fetchSsaaScheduleHtml(g) {
  const body = new URLSearchParams({
    forma_f: g.form,
    fakultet_f: g.faculty,
    kurs_f: g.course,
    grupp_f: g.group,
    teil_f: g.period,
    Next: 'Далее',
  });
  return fetchText(SSAA_SCHEDULE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

/** "Иванова А. А., Петров Б. Б." → ["Иванова А. А.", "Петров Б. Б."] (без повторов). */
export function splitTeachers(s) {
  if (!s) return [];
  const parts = s.split(/,\s*(?=[А-ЯЁA-Z])/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(parts)];
}

/**
 * Раскладывает строку с подгруппами на отдельные записи.
 * Без "/" — одна запись на всю группу (subgroup = null).
 */
export function expandSubgroups({ subject, room, teachers }) {
  if (!subject.includes('/') && !room.includes('/')) {
    return [{ subject, room, teachers, subgroup: null }];
  }
  const two = (s) => {
    const parts = s.includes('/') ? s.split('/').map((x) => x.trim()) : [s, s];
    while (parts.length < 2) parts.push('');
    return parts.slice(0, 2);
  };
  const subj = two(subject);
  const rooms = two(room);
  const active = [0, 1].filter((i) => subj[i] && subj[i] !== '-');

  return active.map((i, n) => {
    let t = teachers;
    if (teachers.length === active.length && active.length > 1) t = [teachers[n]];
    else if (teachers.length === 2 && active.length === 1) t = [teachers[i]];
    return {
      subject: subj[i],
      room: rooms[i] === '-' ? '' : rooms[i],
      teachers: t,
      subgroup: i + 1,
    };
  });
}

function pushLesson(lessons, [time, subject, room, kind, teacher], { week, weekday, dates }) {
  if (!subject) return;
  const tm = time.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})?/);
  if (!tm) return;
  const pad = (t) => (t && t.length === 4 ? `0${t}` : t || null);
  for (const part of expandSubgroups({ subject, room, teachers: splitTeachers(teacher) })) {
    lessons.push({
      week,
      weekday,
      dates: [...dates],
      time_start: pad(tm[1]),
      time_end: pad(tm[2]),
      subject: part.subject,
      room: part.room || null,
      lesson_type: kind || null,
      teacher: part.teachers.join(', ') || null,
      subgroup: part.subgroup,
    });
  }
}

/**
 * HTML ответа shedule.php → массив пар:
 * { week, weekday (1..7), dates: ['YYYY-MM-DD'], time_start, time_end,
 *   subject, room, lesson_type, teacher, subgroup }
 */
export function parseScheduleHtml(html) {
  const lessons = [];
  let week = 1;
  let weekday = null;
  let dates = [];
  let buf = [];

  // Идём по ячейкам подряд, а не по строкам <tr>: в настоящем ответе сайта
  // у большинства строк нет открывающего <tr>, классы записаны в одинарных
  // кавычках, а таблица не закрывается. Браузер это молча исправляет, а
  // разбор "по строкам" на сыром HTML находил 0 пар.
  for (const [, attrs, inner] of html.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
    const cls = (attrs.match(/class\s*=\s*(["']?)([^"'\s>]+)\1/i) || [])[2] || '';

    if (cls === 'shedstrm' || cls === 'shedstrb') {
      buf.push(inner);
      if (buf.length < 5) continue;
      const cells = buf.map((c) => cellText(c));
      buf = [];
      if (weekday !== null) pushLesson(lessons, cells, { week, weekday, dates });
      continue;
    }

    buf = []; // любая другая ячейка — граница строки
    if (cls === 'shed_w') {
      week = Number(num(cellText(inner))) || week;
    } else if (cls === 'shedstrd') {
      const raw = cellText(inner, ';');
      const wd = raw.match(/(Пн|Вт|Ср|Чт|Пт|Сб|Вс)/);
      weekday = wd ? WEEKDAY_ABBR[wd[1]] : null;
      dates = [...raw.matchAll(/\d{2}\.\d{2}\.\d{2,4}/g)].map((m) => ddmmyyToIso(m[0])).filter(Boolean);
    }
  }
  return lessons;
}

export async function fetchSsaaLessons(g) {
  const html = await fetchSsaaScheduleHtml(g);
  const lessons = parseScheduleHtml(html);
  const rows = (html.match(/shedstrb/g) || []).length;
  if (lessons.length === 0 && rows > 0) {
    throw new Error(`на странице ${rows} пар, но разобрать не удалось — сайт мог изменить вёрстку`);
  }
  if (lessons.length === 0 && !/shed_w|shedstr/.test(html)) {
    // Заочникам и сессиям расписание вывешивают незадолго до начала: пока его нет,
    // сайт отдаёт обычную страницу с формой выбора группы. Это не ошибка — пар ещё нет.
    const published = /grupp_f|forma_f/.test(html);
    const todayIso = new Date().toISOString().slice(0, 10);
    const notOver = g.dateEnd && g.dateEnd >= todayIso; // период идёт или впереди, а пар ещё нет
    if (!published && !notOver) {
      throw new Error('ssaa.ru вернул страницу без расписания — возможно, сайт изменился');
    }
  }
  return lessons;
}
