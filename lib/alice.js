/**
 * Навык Яндекс.Алисы: диктует расписание. Группа, подгруппа и часовой пояс
 * берутся из записи владельца бота (навык приватный, работает на устройствах
 * его аккаунта). В сайт ssaa.ru не ходим: у Алисы на ответ всего 3 секунды,
 * расписание читаем из базы — её обновляет фоновая синхронизация.
 */
import { query } from './db.js';
import { getActiveTerm, getLessonsForDay, groupHasSubgroups } from './schedule.js';
import { nowInTimezone, tomorrowDateKey, nextWeekdayIso, weekParityForDate, formatHumanDate, minutesOf } from './time.js';

const OWNER_ID = (process.env.ALICE_USER_ID || process.env.ADMIN_TELEGRAM_IDS || '8181483439').split(',')[0].trim();
const PAUSE = ' sil <[300]> ';

async function loadOwner() {
  const { rows: [u] } = await query(
    `SELECT group_id, subgroup, timezone FROM users WHERE platform = 'telegram' AND telegram_id = $1`, [OWNER_ID]);
  return u && u.group_id ? u : null;
}

/** Пары дня без отменённых. null — семестра нет. */
async function lessonsOn(sub, dateKey, weekdayIso) {
  const term = await getActiveTerm(sub.group_id, dateKey);
  if (!term) return null;
  const subgroup = sub.subgroup && (await groupHasSubgroups(sub.group_id)) ? sub.subgroup : null;
  const parity = weekParityForDate(dateKey, term.date_start);
  const all = await getLessonsForDay(term.id, weekdayIso, parity, dateKey, subgroup);
  return all.filter((l) => !String(l.subject).startsWith('❌ ОТМЕНА'));
}

const timeWords = (t) => {
  const h = Number(t.slice(0, 2)); const m = Number(t.slice(3, 5));
  return m ? `${h} ${String(m).padStart(2, '0')}` : `${h} ровно`;
};
const clean = (s) => String(s || '').replace(/[«»"]/g, '').replace(/\s+/g, ' ').trim();

function one(l) {
  const parts = [clean(l.subject)];
  if (l.lesson_type) parts.push(clean(l.lesson_type));
  if (l.room) parts.push(`аудитория ${clean(l.room)}`);
  if (l.teacher) parts.push(clean(l.teacher));
  return parts.join(', ');
}

/** Пары по слотам времени: одновременные (подгруппы) идут в одну «пару». */
function slotsOf(lessons) {
  const m = new Map();
  for (const l of lessons) m.set(l.time_start, [...(m.get(l.time_start) || []), l]);
  return [...m.entries()].map(([start, items]) => ({ start, items }));
}

function describe(slot, i) {
  const head = `${i === 0 ? 'Первая' : i + 1 + '-я'} пара, в ${timeWords(slot.start)}: `;
  return head + slot.items.map(one).join('. Или: ') + '.';
}

function dayText(lessons, label) {
  if (lessons === null) return `${label} занятий нет: в расписании нет семестра.`;
  const slots = slotsOf(lessons);
  if (!slots.length) return `${label} пар нет.`;
  const n = slots.length;
  const word = n === 1 ? 'одна пара' : n < 5 ? `${n} пары` : `${n} пар`;
  return `${label} ${word}.${PAUSE}` + slots.map(describe).join(PAUSE);
}

/** Ответ на фразу пользователя: сегодня / завтра / следующая пара. */
export async function aliceAnswer(command = '') {
  const sub = await loadOwner();
  if (!sub) return 'Не могу найти твою группу. Выбери её в боте.';
  const cmd = String(command).toLowerCase();
  const now = nowInTimezone(sub.timezone);

  if (/завтра/.test(cmd)) {
    const dk = tomorrowDateKey(now.dateKey);
    const wd = nextWeekdayIso(now.weekdayIso);
    return dayText(await lessonsOn(sub, dk, wd), `Завтра, ${formatHumanDate(dk, wd)},`);
  }

  const lessons = await lessonsOn(sub, now.dateKey, now.weekdayIso);

  if (/следующ|ближайш|скоро/.test(cmd)) {
    if (!lessons || !lessons.length) return 'Сегодня пар нет.';
    const nowMin = minutesOf(now.hhmm);
    const slots = slotsOf(lessons);
    const i = slots.findIndex((s) => minutesOf(s.start) > nowMin);
    if (i < 0) return 'На сегодня пары закончились.';
    const next = slots[i];
    const left = minutesOf(next.start) - nowMin;
    return `Следующая через ${left} мин.${PAUSE}${describe(next, i)}`;
  }

  return dayText(lessons, `Сегодня, ${formatHumanDate(now.dateKey, now.weekdayIso)},`);
}
