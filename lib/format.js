import { WEEKDAY_NAMES } from './schedule.js';
import { formatDateShort } from './time.js';

const SUBJECT_EMOJI_FALLBACK = '📘';

// Немного эмодзи по ключевым словам предметов — просто для приятного вида.
const EMOJI_MAP = [
  [/матем|алгебр|геометр/i, '📐'],
  [/физик/i, '🧲'],
  [/информат|программир|it/i, '💻'],
  [/histor|истори/i, '🏛'],
  [/англ|немец|франц|язык/i, '🗣'],
  [/химия/i, '🧪'],
  [/биолог/i, '🧬'],
  [/физкульт|спорт/i, '🏀'],
  [/литератур|русск/i, '📖'],
  [/экономик|бухгалтер|финанс/i, '💰'],
  [/рисован|дизайн|искусств/i, '🎨'],
  [/музык/i, '🎵'],
];

function emojiFor(subject) {
  for (const [re, emoji] of EMOJI_MAP) {
    if (re.test(subject)) return emoji;
  }
  return SUBJECT_EMOJI_FALLBACK;
}

function escapeHtml(s) {
  if (!s) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lessonLine(lesson, idx) {
  const time = lesson.time_end
    ? `${lesson.time_start}–${lesson.time_end}`
    : lesson.time_start;
  const emoji = emojiFor(lesson.subject);
  let line = `${idx}. ${emoji} <b>${escapeHtml(lesson.subject)}</b>  <code>${time}</code>`;
  const extras = [];
  if (lesson.room) extras.push(`🚪 ${escapeHtml(lesson.room)}`);
  if (lesson.teacher) extras.push(`👤 ${escapeHtml(lesson.teacher)}`);
  if (extras.length) line += `\n    ${extras.join('   ')}`;
  return line;
}

/**
 * kind: 'evening' | 'morning' — влияет на заголовок.
 * dateLabel: например "вторник, 23 сентября"
 * weekParity: 1 | 2 | null — показываем бейджик недели, если известна.
 */
export function formatDaySchedule({ kind, dateLabel, lessons, weekParity }) {
  const header =
    kind === 'evening'
      ? `🌙 <b>Расписание на завтра</b>`
      : `☀️ <b>Доброе утро! Расписание на сегодня</b>`;

  const weekBadge = weekParity ? `  ·  ${weekParity}-я неделя` : '';
  const dayLine = `<i>${escapeHtml(dateLabel)}${weekBadge}</i>`;

  if (!lessons || lessons.length === 0) {
    return [
      header,
      dayLine,
      '',
      '🎉 Пар нет — можно выспаться и заняться своими делами!',
    ].join('\n');
  }

  const lines = [header, dayLine, ''];
  lessons.forEach((lesson, idx) => lines.push(lessonLine(lesson, idx + 1)));
  lines.push('');
  lines.push(`Хорошего дня! 💪`);

  return lines.join('\n');
}

/**
 * byDay: { [weekday]: { both: [...], week1: [...], week2: [...] } } — из getFullScheduleForTerm().
 * term: { name, date_start, date_end } — для заголовка.
 */
export function formatFullSchedule(byDay, term) {
  const lines = ['📅 <b>Расписание</b>'];
  if (term) {
    lines.push(`<i>${escapeHtml(term.name)} (${formatDateShort(term.date_start)}–${formatDateShort(term.date_end)})</i>`);
  }
  lines.push('');

  let hasAnything = false;

  for (let wd = 1; wd <= 7; wd++) {
    const day = byDay[wd];
    if (!day || (day.both.length === 0 && day.week1.length === 0 && day.week2.length === 0)) continue;
    hasAnything = true;

    lines.push(`<b>${WEEKDAY_NAMES[wd]}</b>`);

    let n = 1;
    for (const lesson of day.both) {
      lines.push(lessonLine(lesson, n++));
    }

    if (day.week1.length > 0 || day.week2.length > 0) {
      if (day.week1.length > 0) {
        lines.push('  <b>1-я неделя:</b>');
        let n1 = 1;
        for (const lesson of day.week1) lines.push('  ' + lessonLine(lesson, n1++));
      }
      if (day.week2.length > 0) {
        lines.push('  <b>2-я неделя:</b>');
        let n2 = 1;
        for (const lesson of day.week2) lines.push('  ' + lessonLine(lesson, n2++));
      }
    }

    lines.push('');
  }

  if (!hasAnything) {
    lines.push('Расписание ещё не заполнено.');
  }

  return lines.join('\n');
}
