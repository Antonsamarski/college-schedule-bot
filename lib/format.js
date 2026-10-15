import { WEEKDAY_NAMES } from './schedule.js';
import { formatDateShort } from './time.js';

const SUBJECT_EMOJI_FALLBACK = '📘';

// Эмодзи по ключевым словам предметов — чтобы пару было видно с первого взгляда.
const EMOJI_MAP = [
  [/матем|алгебр|геометр/i, '📐'],
  [/физик/i, '🧲'],
  [/физическ|физкульт|спорт/i, '🏀'],
  [/информат|программир|компьютер/i, '💻'],
  [/истори/i, '🏛'],
  [/язык/i, '🗣'],
  [/хими/i, '🧪'],
  [/правов|юрид/i, '⚖️'],
  [/биолог|анатом|физиолог|ветерин|зоотех|животн/i, '🧬'],
  [/литератур|русск/i, '📖'],
  [/экономик|бухгалтер|финанс/i, '💰'],
  [/эколог|природ|почв|растени|агро/i, '🌿'],
  [/психолог|философ|обществ/i, '🧠'],
  [/безопасн|защит|обж/i, '🛡'],
  [/трактор|автомоб|машин|двигател|мдк|технич|механ/i, '🚜'],
  [/графи|черчен/i, '📏'],
  [/электр/i, '⚡'],
  [/куратор|разговор/i, '💬'],
  [/самостоят/i, '📝'],
  [/рисован|дизайн|искусств/i, '🎨'],
  [/музык/i, '🎵'],
];

export function emojiFor(subject) {
  for (const [re, emoji] of EMOJI_MAP) {
    if (re.test(subject)) return emoji;
  }
  return SUBJECT_EMOJI_FALLBACK;
}

export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Стандартная сетка звонков ssaa.ru — по ней определяется номер пары.
const PAIR_BY_START = { '08:00': 1, '09:45': 2, '11:30': 3, '14:00': 4, '15:45': 5, '17:30': 6, '19:15': 7 };
const NUM_EMOJI = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

const TYPE_LABELS = {
  'лекция': 'Лекция',
  'лпз': 'Практика',
  'практика': 'Практика',
  'лабораторная': 'Лабораторная',
  'зачет': 'Зачёт',
  'зачёт': 'Зачёт',
  'экзамен': 'Экзамен',
  'консультация': 'Консультация',
};

function typeLabel(t) {
  if (!t) return '';
  return TYPE_LABELS[t.toLowerCase()] || escapeHtml(t[0].toUpperCase() + t.slice(1));
}

function timeRange(l) {
  return l.time_end ? `${l.time_start} – ${l.time_end}` : l.time_start;
}

// Время пар по сетке звонков ssaa.ru — чтобы подписать окно ("3 пара · 11:30 – 13:00").
const PAIR_TIMES = {
  1: ['08:00', '09:30'], 2: ['09:45', '11:15'], 3: ['11:30', '13:00'], 4: ['14:00', '15:30'],
  5: ['15:45', '17:15'], 6: ['17:30', '19:00'], 7: ['19:15', '20:45'],
};

const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

// Тонкий разделитель — для экранов меню (в расписании структуру дают карточки).
export const DIVIDER = '—————————————';

/** Группирует пары одного дня по времени начала, проставляя номер пары. */
function slotsOf(lessons) {
  const map = new Map();
  for (const l of lessons) {
    if (!map.has(l.time_start)) map.set(l.time_start, []);
    map.get(l.time_start).push(l);
  }
  const slots = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  const standard = slots.every(([t]) => PAIR_BY_START[t]);
  return {
    standard,
    slots: slots.map(([t, items], i) => ({ number: standard ? PAIR_BY_START[t] : i + 1, start: t, items })),
  };
}

/**
 * Окно между двумя соседними парами или null.
 * По сетке звонков: пропущен номер пары. Для своего расписания (не с сайта):
 * перерыв больше часа с четвертью (обычный обед — час, это не окно).
 */
export function gapBetween(prev, next, standard) {
  if (standard) {
    if (next.number - prev.number <= 1) return null;
    const from = prev.number + 1;
    const to = next.number - 1;
    const pairs = from === to ? `${from} пара` : `${from}–${to} пары`;
    return { pairs: to - from + 1, label: `${pairs} · ${PAIR_TIMES[from][0]} – ${PAIR_TIMES[to][1]}` };
  }
  const end = prev.items[0].time_end;
  if (!end) return null;
  const minutes = toMin(next.start) - toMin(end);
  if (minutes < 75) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return { pairs: 1, label: `${end} – ${next.start} · ${h ? `${h} ч` : ''}${h && m ? ' ' : ''}${m ? `${m} мин` : ''}` };
}

/** "Иванова Анна Ивановна" → "Иванова А. И." */
export function shortName(full) {
  const p = full.trim().split(/\s+/);
  if (p.length === 3 && p.every((x) => /^[А-ЯЁ][а-яё-]+$/.test(x))) return `${p[0]} ${p[1][0]}. ${p[2][0]}.`;
  return full;
}

const splitShort = (teacher) => teacher.split(/,\s*/).map(shortName).join(', ');
const room = (r) => (r ? (/^\d|^[А-ЯA-Z]\d|^к\d/i.test(r) ? `ауд. ${escapeHtml(r)}` : escapeHtml(r)) : '');
const join = (...parts) => parts.filter(Boolean).join('  ·  ');

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Идёт ли пара прямо сейчас (nowHHMM — "10:05" или null). */
const isNow = (l, nowHHMM) => Boolean(nowHHMM && l.time_end && nowHHMM >= l.time_start && nowHHMM < l.time_end);

/** Строка над карточкой: «2 пара · 09:45 – 11:15». */
function slotTitle(slot, nowHHMM) {
  const now = slot.items.some((l) => isNow(l, nowHHMM)) ? '   <b>● идёт сейчас</b>' : '';
  return `<b>${slot.number} пара</b>   ${timeRange(slot.items[0])}${now}`;
}

/**
 * Карточка пары группы (цитата Telegram): предмет, вид и аудитория,
 * преподаватель. Подгруппы с одним предметом — одной карточкой.
 */
function groupSlotCard(slot, { showSubgroups }) {
  const first = slot.items[0];
  const sameSubject = slot.items.length > 1 &&
    slot.items.every((l) => l.subject === first.subject && (l.lesson_type || '') === (first.lesson_type || ''));

  if (sameSubject) {
    const lines = [`<b>${escapeHtml(first.subject)}</b>`];
    if (first.lesson_type) lines.push(typeLabel(first.lesson_type));
    for (const l of slot.items) {
      const who = l.subgroup ? `${l.subgroup} подгруппа` : 'Вся группа';
      lines.push(`<b>${who}</b> — ${join(room(l.room), l.teacher && escapeHtml(l.teacher))}`);
    }
    return `<blockquote>${lines.join('\n')}</blockquote>`;
  }

  return slot.items.map((l) => {
    const lines = [`<b>${escapeHtml(l.subject)}</b>`];
    if (showSubgroups && l.subgroup) lines.push(`<i>только ${l.subgroup} подгруппа</i>`);
    const meta = join(typeLabel(l.lesson_type), room(l.room));
    if (meta) lines.push(meta);
    if (l.teacher) lines.push(`Преподаватель: ${escapeHtml(l.teacher)}`);
    return `<blockquote>${lines.join('\n')}</blockquote>`;
  }).join('\n');
}

/** Карточка пары преподавателя: предмет, группа, аудитория. */
function teacherSlotCard(slot) {
  return slot.items.map((l) => {
    const lines = [
      `<b>${escapeHtml(l.subject)}</b>`,
      `Группа: ${escapeHtml(l.group_name)}${l.subgroup ? `, ${l.subgroup} подгруппа` : ''}`,
    ];
    const meta = join(typeLabel(l.lesson_type), room(l.room));
    if (meta) lines.push(meta);
    return `<blockquote>${lines.join('\n')}</blockquote>`;
  }).join('\n');
}

/** Все пары дня: заголовок пары, карточка, окна между ними, итог внизу. */
function dayBody(lessons, card, nowHHMM) {
  const { standard, slots } = slotsOf(lessons);
  const blocks = [];
  let gaps = 0;
  slots.forEach((slot, i) => {
    if (i > 0) {
      const gap = gapBetween(slots[i - 1], slot, standard);
      if (gap) {
        gaps += gap.pairs;
        blocks.push(`<i>Окно — ${gap.label}</i>`);
      }
    }
    blocks.push(`${slotTitle(slot, nowHHMM)}\n${card(slot)}`);
  });
  const first = slots[0].items[0];
  const last = slots[slots.length - 1].items[0];
  const summary = [
    `${slots.length} ${plural(slots.length, 'пара', 'пары', 'пар')}`,
    `с ${first.time_start} до ${last.time_end || last.time_start}`,
    gaps ? `${gaps} ${plural(gaps, 'окно', 'окна', 'окон')}` : null,
  ].filter(Boolean).join('  ·  ');
  return `${blocks.join('\n\n')}\n\n<i>Итого: ${summary}</i>`;
}

/**
 * Расписание группы на день.
 * dateLabel — "пятница, 16 октября"; relLabel — "сегодня"/"завтра"/null;
 * nowHHMM — текущее время, если это сегодняшний день (метка «идёт сейчас»).
 */
export function formatDaySchedule({ kind, dateLabel, relLabel = null, lessons, weekParity, subgroup = null, greeting, nowHHMM = null }) {
  const hello = greeting ?? (kind === 'morning' ? 'Доброе утро! Расписание на сегодня' : kind === 'evening' ? 'Расписание на завтра' : null);
  const rel = relLabel ?? (kind === 'morning' ? 'сегодня' : kind === 'evening' ? 'завтра' : null);
  const badges = [rel && capitalize(rel), weekParity && `${weekParity}-я неделя`, subgroup && `${subgroup}-я подгруппа`].filter(Boolean).join('  ·  ');

  const lines = [];
  if (hello) lines.push(`<i>${hello}</i>`, '');
  lines.push(`<b>${escapeHtml(capitalize(dateLabel))}</b>`);
  if (badges) lines.push(badges);
  lines.push('');

  if (!lessons || lessons.length === 0) {
    lines.push('<blockquote><b>Пар нет</b>\nСвободный день</blockquote>');
    return lines.join('\n');
  }
  lines.push(dayBody(lessons, (slot) => groupSlotCard(slot, { showSubgroups: !subgroup }), nowHHMM));
  return lines.join('\n');
}

/** Пары преподавателя на день (по всем группам). current — пара, идущая сейчас. */
export function formatTeacherDay(name, lessons, { dateLabel, relLabel = null, current = null, nowHHMM = null } = {}) {
  const lines = [
    `<b>${escapeHtml(name)}</b>`,
    `${escapeHtml(capitalize(dateLabel))}${relLabel ? `  ·  ${capitalize(relLabel)}` : ''}`,
    '',
  ];
  if (!lessons.length) {
    lines.push('<blockquote><b>Пар нет</b>\nВ этот день занятий не найдено</blockquote>');
    return lines.join('\n');
  }
  if (relLabel === 'сегодня') {
    lines.push(current
      ? `<b>Сейчас на паре:</b> ${room(current.room) || '—'}, ${escapeHtml(current.group_name)}`
      : '<i>Сейчас пары не идёт</i>');
    lines.push('');
  }
  const now = nowHHMM || (current ? current.time_start : null);
  lines.push(dayBody(lessons, teacherSlotCard, now));
  return lines.join('\n');
}

/** Строки одного дня для недели: «1  08:00  Предмет» и под ним аудитория и преподаватель. */
function weekDayLines(lessons, { showSubgroups }) {
  const { standard, slots } = slotsOf(lessons);
  const out = [];
  slots.forEach((slot, i) => {
    if (i > 0) {
      const gap = gapBetween(slots[i - 1], slot, standard);
      if (gap) out.push(`<i>окно — ${gap.label}</i>`);
    }
    slot.items.forEach((l, j) => {
      const sg = showSubgroups && l.subgroup ? `, ${l.subgroup} подгр.` : '';
      const type = l.lesson_type && l.lesson_type.toLowerCase() === 'лекция' ? ' (лекция)' : '';
      const head = j === 0 ? `<b>${slot.number}</b>  ${l.time_start}` : '         ';
      out.push(`${head}   <b>${escapeHtml(l.subject)}</b>${type}`);
      const meta = join(room(l.room), l.teacher && escapeHtml(splitShort(l.teacher))) + sg;
      if (meta) out.push(`          <i>${meta}</i>`);
    });
  });
  return out.join('\n');
}

const DAY_SHORT = { 1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 7: 'Вс' };

function ddmm(dateKey) {
  const [, m, d] = dateKey.split('-');
  return `${d}.${m}`;
}

function addDaysKey(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/**
 * byDay: { [weekday]: [lessons] } — пары конкретной недели.
 * mondayKey / todayKey — чтобы подписать даты и выделить сегодняшний день.
 */
export function formatWeekSchedule(byDay, term, weekParity, subgroup = null, { mondayKey = null, todayKey = null } = {}) {
  const range = mondayKey ? `  ${ddmm(mondayKey)} – ${ddmm(addDaysKey(mondayKey, 6))}` : '';
  const lines = [`<b>Неделя</b>${range}`];
  const badges = [weekParity && `${weekParity}-я неделя`, subgroup && `${subgroup}-я подгруппа`, term && escapeHtml(term.name)]
    .filter(Boolean).join('  ·  ');
  if (badges) lines.push(badges);
  const opts = { showSubgroups: !subgroup };

  let hasAnything = false;
  for (let wd = 1; wd <= 7; wd++) {
    const lessons = byDay[wd];
    const dateKey = mondayKey ? addDaysKey(mondayKey, wd - 1) : null;
    const isToday = dateKey && dateKey === todayKey;
    const title = `<b>${WEEKDAY_NAMES[wd]}</b>${dateKey ? `, ${ddmm(dateKey)}` : ''}${isToday ? '   <b>● сегодня</b>' : ''}`;
    if (!lessons || lessons.length === 0) {
      if (wd <= 6 && mondayKey) lines.push('', title, '<blockquote><i>пар нет</i></blockquote>');
      continue;
    }
    hasAnything = true;
    lines.push('', title, `<blockquote>${weekDayLines(lessons, opts)}</blockquote>`);
  }

  if (!hasAnything) lines.push('', '<blockquote><b>На этой неделе пар нет</b></blockquote>');
  return lines.join('\n');
}

/** Расписание семестра (для совместимости — бот показывает недели). */
export function formatFullSchedule(byDay, term, subgroup = null) {
  const lines = ['<b>Расписание семестра</b>'];
  if (term) lines.push(`${escapeHtml(term.name)} (${formatDateShort(term.date_start)}–${formatDateShort(term.date_end)})`);
  const opts = { showSubgroups: !subgroup };
  for (let wd = 1; wd <= 7; wd++) {
    const day = byDay[wd];
    if (!day) continue;
    for (const [label, list] of [['', day.both], [' · 1-я неделя', day.week1], [' · 2-я неделя', day.week2]]) {
      if (list.length) lines.push('', `<b>${WEEKDAY_NAMES[wd]}</b>${label}`, `<blockquote>${weekDayLines(list, opts)}</blockquote>`);
    }
  }
  return lines.join('\n');
}

export { DAY_SHORT, ddmm };

/**
 * Делит длинный текст на части до limit символов по пустым строкам —
 * у Telegram лимит 4096 символов на сообщение.
 */
export function splitMessage(text, limit = 3900) {
  if (text.length <= limit) return [text];
  const parts = [];
  let current = '';
  for (const block of text.split('\n\n')) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (block.length <= limit) {
      current = block;
    } else {
      // Блок сам по себе длиннее лимита — режем по строкам.
      current = '';
      for (const line of block.split('\n')) {
        const c2 = current ? `${current}\n${line}` : line;
        if (c2.length > limit && current) {
          parts.push(current);
          current = line;
        } else {
          current = c2;
        }
      }
    }
  }
  if (current) parts.push(current);
  return parts;
}
