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
  return l.time_end ? `${l.time_start}–${l.time_end}` : l.time_start;
}

/** Группирует пары одного дня по времени начала, проставляя номер пары. */
function slotsOf(lessons) {
  const map = new Map();
  for (const l of lessons) {
    if (!map.has(l.time_start)) map.set(l.time_start, []);
    map.get(l.time_start).push(l);
  }
  const slots = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  const allStandard = slots.every(([t]) => PAIR_BY_START[t]);
  return slots.map(([t, items], i) => ({ number: allStandard ? PAIR_BY_START[t] : i + 1, items }));
}

/** "Иванова Анна Ивановна" → "Иванова А. И." */
export function shortName(full) {
  const p = full.trim().split(/\s+/);
  if (p.length === 3 && p.every((x) => /^[А-ЯЁ][а-яё-]+$/.test(x))) return `${p[0]} ${p[1][0]}. ${p[2][0]}.`;
  return full;
}

const subgroupLabel = (n) => `${NUM_EMOJI[n] || n} подгр.`;

/**
 * Подробный блок одной пары (для расписания на день).
 * Если в одно время у подгрупп один и тот же предмет — пишем его один раз,
 * а ниже по строке на каждую подгруппу: кабинет и преподаватель.
 */
function slotBlock(slot, { showSubgroups }) {
  const first = slot.items[0];
  const num = NUM_EMOJI[slot.number] || `${slot.number}.`;
  const lines = [`${num} <b>${timeRange(first)}</b>`];

  const sameSubject = slot.items.every((l) => l.subject === first.subject && (l.lesson_type || '') === (first.lesson_type || ''));

  if (slot.items.length === 1 || !sameSubject) {
    for (const l of slot.items) {
      const prefix = showSubgroups && l.subgroup ? `${subgroupLabel(l.subgroup)} · ` : '';
      lines.push(`${prefix}${emojiFor(l.subject)} <b>${escapeHtml(l.subject)}</b>`);
      const meta = [typeLabel(l.lesson_type), l.room && `🚪 ${escapeHtml(l.room)}`].filter(Boolean);
      if (meta.length) lines.push(meta.join(' · '));
      if (l.teacher) lines.push(`👤 ${escapeHtml(l.teacher)}`);
    }
    return lines.join('\n');
  }

  // Один предмет у обеих подгрупп, но разные кабинеты/преподаватели.
  lines.push(`${emojiFor(first.subject)} <b>${escapeHtml(first.subject)}</b>`);
  if (first.lesson_type) lines.push(typeLabel(first.lesson_type));
  for (const l of slot.items) {
    const parts = [
      l.subgroup ? subgroupLabel(l.subgroup) : 'вся группа',
      l.room && `🚪 ${escapeHtml(l.room)}`,
      l.teacher && `👤 ${escapeHtml(l.teacher)}`,
    ].filter(Boolean);
    lines.push(`   ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

/** Компактная строка пары (для недели и семестра): время, предмет, кабинет, преподаватель. */
function compactLine(l, { showSubgroups }) {
  const sg = showSubgroups && l.subgroup ? ` <i>(${l.subgroup} подгр.)</i>` : '';
  const type = l.lesson_type && l.lesson_type.toLowerCase() === 'лекция' ? ' · лекц.' : '';
  let line = `<code>${l.time_start}</code> ${emojiFor(l.subject)} ${escapeHtml(l.subject)}${sg}${type}`;
  const extras = [l.room && `🚪 ${escapeHtml(l.room)}`, l.teacher && `👤 ${escapeHtml(splitShort(l.teacher))}`].filter(Boolean);
  if (extras.length) line += `\n        ${extras.join('  ')}`;
  return line;
}

const splitShort = (teacher) => teacher.split(/,\s*/).map(shortName).join(', ');

/**
 * kind: 'evening' | 'morning' — влияет на заголовок.
 * dateLabel: например "вторник, 23 сентября"
 * weekParity: 1 | 2 | null; subgroup: 1 | 2 | null — выбранная подгруппа.
 */
export function formatDaySchedule({ kind, dateLabel, lessons, weekParity, subgroup = null }) {
  const header = kind === 'evening'
    ? '🌙 <b>Расписание на завтра</b>'
    : '☀️ <b>Расписание на сегодня</b>';

  const badges = [escapeHtml(dateLabel), weekParity && `${weekParity}-я неделя`, subgroup && `${subgroup}-я подгруппа`]
    .filter(Boolean)
    .join(' · ');
  const lines = [header, `<i>${badges}</i>`, ''];

  if (!lessons || lessons.length === 0) {
    lines.push('🎉 Пар нет — можно выспаться и заняться своими делами!');
    return lines.join('\n');
  }

  const slots = slotsOf(lessons);
  const blocks = slots.map((slot) => slotBlock(slot, { showSubgroups: !subgroup }));
  lines.push(blocks.join('\n\n'));
  lines.push('');
  const first = slots[0].items[0];
  const last = slots[slots.length - 1].items[0];
  lines.push(`⏱ ${slots.length} ${plural(slots.length, 'пара', 'пары', 'пар')} · с ${first.time_start} до ${last.time_end || last.time_start}`);
  return lines.join('\n');
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/**
 * byDay: { [weekday]: { both, week1, week2 } } — из getFullScheduleForTerm().
 * term: { name, date_start, date_end } — для заголовка.
 */
export function formatFullSchedule(byDay, term, subgroup = null) {
  const lines = ['📅 <b>Расписание семестра</b>'];
  if (term) {
    lines.push(`<i>${escapeHtml(term.name)} (${formatDateShort(term.date_start)}–${formatDateShort(term.date_end)})${subgroup ? ` · ${subgroup}-я подгруппа` : ''}</i>`);
  }
  lines.push('');
  const opts = { showSubgroups: !subgroup };

  let hasAnything = false;
  for (let wd = 1; wd <= 7; wd++) {
    const day = byDay[wd];
    if (!day || (day.both.length === 0 && day.week1.length === 0 && day.week2.length === 0)) continue;
    hasAnything = true;

    lines.push(`📌 <b>${WEEKDAY_NAMES[wd]}</b>`);
    for (const l of day.both) lines.push(compactLine(l, opts));
    if (day.week1.length > 0) {
      lines.push('  <u>только 1-я неделя:</u>');
      for (const l of day.week1) lines.push(compactLine(l, opts));
    }
    if (day.week2.length > 0) {
      lines.push('  <u>только 2-я неделя:</u>');
      for (const l of day.week2) lines.push(compactLine(l, opts));
    }
    lines.push('');
  }

  if (!hasAnything) lines.push('Расписание ещё не заполнено.');
  return lines.join('\n');
}

/** byDay: { [weekday]: [lessons] } — пары конкретной недели. */
export function formatWeekSchedule(byDay, term, weekParity, subgroup = null) {
  const lines = ['🗓 <b>Расписание на эту неделю</b>'];
  const badges = [term && escapeHtml(term.name), weekParity && `${weekParity}-я неделя`, subgroup && `${subgroup}-я подгруппа`]
    .filter(Boolean)
    .join(' · ');
  if (badges) lines.push(`<i>${badges}</i>`);
  lines.push('');
  const opts = { showSubgroups: !subgroup };

  let hasAnything = false;
  for (let wd = 1; wd <= 7; wd++) {
    const lessons = byDay[wd];
    if (!lessons || lessons.length === 0) continue;
    hasAnything = true;
    lines.push(`📌 <b>${WEEKDAY_NAMES[wd]}</b>`);
    for (const l of lessons) lines.push(compactLine(l, opts));
    lines.push('');
  }

  if (!hasAnything) lines.push('На этой неделе пар нет.');
  return lines.join('\n');
}

/**
 * lessons: строки из findTeacherLessonsToday/Tomorrow, отсортированные по времени.
 * options.dayLabel: 'сегодня' | 'завтра'; options.current — пара, идущая сейчас.
 */
export function formatTeacherSchedule(teacherQuery, lessons, options = {}) {
  const { dayLabel = 'сегодня', current = null } = options;
  const lines = [`👤 <b>${escapeHtml(teacherQuery)}</b>`, ''];

  if (lessons.length === 0) {
    lines.push(`На ${dayLabel} пар не найдено — либо преподаватель не ведёт, либо проверь написание фамилии.`);
    return lines.join('\n');
  }

  const where = (l) => {
    const sg = l.subgroup ? `, ${l.subgroup} подгр.` : '';
    return `👥 ${escapeHtml(l.group_name)}${sg}`;
  };

  if (dayLabel === 'сегодня') {
    if (current) {
      lines.push('🟢 <b>Сейчас ведёт пару</b>');
      lines.push(`${emojiFor(current.subject)} ${escapeHtml(current.subject)}`);
      lines.push([current.room && `🚪 ${escapeHtml(current.room)}`, where(current)].filter(Boolean).join(' · '));
    } else {
      lines.push('⚪ Сейчас пары не идёт.');
    }
    lines.push('');
  }

  lines.push(`<b>Все пары на ${dayLabel}:</b>`);
  for (const l of lessons) {
    const isNow = current && l.id === current.id;
    lines.push(`${isNow ? '🟢' : '▫️'} <code>${timeRange(l)}</code> ${emojiFor(l.subject)} ${escapeHtml(l.subject)}`);
    lines.push(`      ${[l.room && `🚪 ${escapeHtml(l.room)}`, where(l)].filter(Boolean).join(' · ')}`);
  }
  return lines.join('\n');
}

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
