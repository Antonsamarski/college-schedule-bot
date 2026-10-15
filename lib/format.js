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
  'лекция': '📖 Лекция',
  'лпз': '✏️ Практика',
  'практика': '✏️ Практика',
  'лабораторная': '🔬 Лабораторная',
  'зачет': '📋 Зачёт',
  'зачёт': '📋 Зачёт',
  'экзамен': '🎓 Экзамен',
  'консультация': '💡 Консультация',
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

export const DIVIDER = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈';

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
const subgroupLabel = (n) => `${NUM_EMOJI[n] || n} подгр.`;

/** Строки-«ветки» под предметом: ├ … └ … */
function tree(items) {
  const list = items.filter(Boolean);
  return list.map((x, i) => `${i === list.length - 1 ? '└' : '├'} ${x}`);
}

/** Подробный блок одной пары группы. */
function groupSlotBlock(slot, { showSubgroups }) {
  const first = slot.items[0];
  const num = NUM_EMOJI[slot.number] || `${slot.number}.`;
  const lines = [`${num} <b>${timeRange(first)}</b>`];
  const sameSubject = slot.items.length > 1 &&
    slot.items.every((l) => l.subject === first.subject && (l.lesson_type || '') === (first.lesson_type || ''));

  if (sameSubject) {
    // Один предмет у обеих подгрупп — пишем один раз, ниже кабинеты и преподаватели.
    lines.push(`${emojiFor(first.subject)} <b>${escapeHtml(first.subject)}</b>${first.lesson_type ? ` · ${typeLabel(first.lesson_type)}` : ''}`);
    lines.push(...tree(slot.items.map((l) => [
      l.subgroup ? subgroupLabel(l.subgroup) : 'вся группа',
      l.room && `🚪 ${escapeHtml(l.room)}`,
      l.teacher && escapeHtml(splitShort(l.teacher)),
    ].filter(Boolean).join(' · '))));
    return lines.join('\n');
  }

  slot.items.forEach((l, i) => {
    if (i > 0) lines.push('');
    const sg = showSubgroups && l.subgroup ? `${subgroupLabel(l.subgroup)} · ` : '';
    lines.push(`${sg}${emojiFor(l.subject)} <b>${escapeHtml(l.subject)}</b>`);
    lines.push(...tree([
      [typeLabel(l.lesson_type), l.room && `🚪 ${escapeHtml(l.room)}`].filter(Boolean).join(' · '),
      l.teacher && `👤 ${escapeHtml(l.teacher)}`,
    ]));
  });
  return lines.join('\n');
}

/** Подробный блок пары преподавателя: где и у кого. */
function teacherSlotBlock(slot, current) {
  const first = slot.items[0];
  const isNow = current && slot.items.some((l) => l.id === current.id);
  const num = NUM_EMOJI[slot.number] || `${slot.number}.`;
  const lines = [`${num} <b>${timeRange(first)}</b>${isNow ? '  🟢 <b>идёт сейчас</b>' : ''}`];
  slot.items.forEach((l, i) => {
    if (i > 0) lines.push('');
    lines.push(`${emojiFor(l.subject)} <b>${escapeHtml(l.subject)}</b>`);
    lines.push(...tree([
      `👥 ${escapeHtml(l.group_name)}${l.subgroup ? `, ${l.subgroup} подгр.` : ''}`,
      [l.room && `🚪 ${escapeHtml(l.room)}`, typeLabel(l.lesson_type)].filter(Boolean).join(' · '),
    ]));
  });
  return lines.join('\n');
}

/** Пары дня с пометками окон и итоговой строкой. */
function dayBody(lessons, renderSlot) {
  const { standard, slots } = slotsOf(lessons);
  const lines = [];
  let gaps = 0;
  slots.forEach((slot, i) => {
    if (i > 0) {
      const gap = gapBetween(slots[i - 1], slot, standard);
      if (gap) {
        gaps += gap.pairs;
        lines.push(`☕ <i>Окно · ${gap.label}</i>`);
        lines.push('');
      }
    }
    lines.push(renderSlot(slot));
    lines.push('');
  });
  const first = slots[0].items[0];
  const last = slots[slots.length - 1].items[0];
  const summary = [
    `⏱ ${slots.length} ${plural(slots.length, 'пара', 'пары', 'пар')}`,
    `${first.time_start} – ${last.time_end || last.time_start}`,
    gaps ? `☕ ${gaps} ${plural(gaps, 'окно', 'окна', 'окон')}` : null,
  ].filter(Boolean).join(' · ');
  lines.push(DIVIDER, summary);
  return lines.join('\n');
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Расписание группы на день.
 * dateLabel — "пятница, 16 октября"; relLabel — "сегодня"/"завтра"/null;
 * greeting — первая строка для рассылок ("☀️ Доброе утро!").
 */
export function formatDaySchedule({ kind, dateLabel, relLabel = null, lessons, weekParity, subgroup = null, greeting }) {
  const hello = greeting ?? (kind === 'morning' ? '☀️ <b>Доброе утро!</b>' : kind === 'evening' ? '🌙 <b>Расписание на завтра</b>' : null);
  const rel = relLabel ?? (kind === 'morning' ? 'сегодня' : kind === 'evening' ? 'завтра' : null);
  const badges = [rel, weekParity && `${weekParity}-я неделя`, subgroup && `${subgroup}-я подгруппа`].filter(Boolean).join(' · ');

  const lines = [];
  if (hello) lines.push(hello);
  lines.push(`📅 <b>${escapeHtml(capitalize(dateLabel))}</b>`);
  if (badges) lines.push(`<i>${badges}</i>`);
  lines.push(DIVIDER, '');

  if (!lessons || lessons.length === 0) {
    lines.push('🎉 <b>Пар нет</b> — свободный день!');
    return lines.join('\n');
  }
  lines.push(dayBody(lessons, (slot) => groupSlotBlock(slot, { showSubgroups: !subgroup })));
  return lines.join('\n');
}

/** Пары преподавателя на день (по всем группам). current — пара, идущая сейчас. */
export function formatTeacherDay(name, lessons, { dateLabel, relLabel = null, current = null } = {}) {
  const lines = [`👤 <b>${escapeHtml(name)}</b>`, `📅 ${escapeHtml(capitalize(dateLabel))}${relLabel ? ` · <i>${relLabel}</i>` : ''}`, DIVIDER, ''];
  if (!lessons.length) {
    lines.push('🎉 В этот день пар нет.');
    return lines.join('\n');
  }
  if (relLabel === 'сегодня') {
    lines.push(current
      ? `🟢 <b>Сейчас на паре:</b> 🚪 ${escapeHtml(current.room || '—')} · ${escapeHtml(current.group_name)}`
      : '⚪ Сейчас пары не идёт');
    lines.push('');
  }
  lines.push(dayBody(lessons, (slot) => teacherSlotBlock(slot, current)));
  return lines.join('\n');
}

/** Компактная строка пары (неделя): номер, время, предмет, кабинет, преподаватель. */
function compactSlot(slot, { showSubgroups }) {
  const num = NUM_EMOJI[slot.number] || `${slot.number}.`;
  return slot.items.map((l, i) => {
    const sg = showSubgroups && l.subgroup ? ` <i>(${l.subgroup} подгр.)</i>` : '';
    const type = l.lesson_type && l.lesson_type.toLowerCase() === 'лекция' ? ' · <i>лекция</i>' : '';
    const head = i === 0 ? `${num} <code>${l.time_start}</code>` : '      ';
    const extras = [l.room && `🚪 ${escapeHtml(l.room)}`, l.teacher && escapeHtml(splitShort(l.teacher))].filter(Boolean).join(' · ');
    return `${head} ${emojiFor(l.subject)} ${escapeHtml(l.subject)}${sg}${type}${extras ? `\n        └ ${extras}` : ''}`;
  }).join('\n');
}

function weekDayBlock(title, lessons, opts) {
  const lines = [title];
  const { standard, slots } = slotsOf(lessons);
  slots.forEach((slot, i) => {
    if (i > 0) {
      const gap = gapBetween(slots[i - 1], slot, standard);
      if (gap) lines.push(`☕ <i>окно · ${gap.label}</i>`);
    }
    lines.push(compactSlot(slot, opts));
  });
  return lines.join('\n');
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
  const range = mondayKey ? ` · ${ddmm(mondayKey)} – ${ddmm(addDaysKey(mondayKey, 6))}` : '';
  const lines = [`🗓 <b>Неделя${range}</b>`];
  const badges = [weekParity && `${weekParity}-я неделя`, subgroup && `${subgroup}-я подгруппа`, term && escapeHtml(term.name)]
    .filter(Boolean).join(' · ');
  if (badges) lines.push(`<i>${badges}</i>`);
  lines.push(DIVIDER);
  const opts = { showSubgroups: !subgroup };

  let hasAnything = false;
  for (let wd = 1; wd <= 7; wd++) {
    const lessons = byDay[wd];
    const dateKey = mondayKey ? addDaysKey(mondayKey, wd - 1) : null;
    const isToday = dateKey && dateKey === todayKey;
    const title = `${isToday ? '🔶' : '▫️'} <b>${WEEKDAY_NAMES[wd]}</b>${dateKey ? ` · ${ddmm(dateKey)}` : ''}${isToday ? ' · <i>сегодня</i>' : ''}`;
    if (!lessons || lessons.length === 0) {
      if (wd <= 6 && mondayKey) lines.push('', `${title}\n      <i>пар нет</i>`);
      continue;
    }
    hasAnything = true;
    lines.push('', weekDayBlock(title, lessons, opts));
  }

  if (!hasAnything) lines.push('', '🎉 На этой неделе пар нет.');
  return lines.join('\n');
}

/** Расписание семестра (для совместимости — бот показывает недели). */
export function formatFullSchedule(byDay, term, subgroup = null) {
  const lines = ['📖 <b>Расписание семестра</b>'];
  if (term) lines.push(`<i>${escapeHtml(term.name)} (${formatDateShort(term.date_start)}–${formatDateShort(term.date_end)})</i>`);
  lines.push(DIVIDER);
  const opts = { showSubgroups: !subgroup };
  for (let wd = 1; wd <= 7; wd++) {
    const day = byDay[wd];
    if (!day) continue;
    for (const [label, list] of [['', day.both], [' · 1-я неделя', day.week1], [' · 2-я неделя', day.week2]]) {
      if (list.length) lines.push('', weekDayBlock(`▫️ <b>${WEEKDAY_NAMES[wd]}</b>${label}`, list, opts));
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
