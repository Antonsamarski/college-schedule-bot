import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDaySchedule, formatTeacherDay, formatWeekSchedule, splitMessage, escapeHtml, shortName } from '../lib/format.js';
import { dedupeTeachers, teacherKey, splitTeacherField } from '../lib/teacherSearch.js';
import { parseScheduleText, padTime } from '../lib/schedule.js';
import { isDue } from '../api/tick.js';
import { nowInTimezone, mondayKeyOf, addDays, parseUserDate, relativeDayLabel, isoWeekday } from '../lib/time.js';

const L = (o) => ({ time_end: null, room: null, teacher: null, subgroup: null, lesson_type: null, ...o });

test('преподаватели без дублей и склеек', () => {
  const list = dedupeTeachers([
    'Иванова А.И.',
    'Иванова Анна Ивановна',
    'иванова  а. и.',
    'Ратцева Арина Алексеевна, Корнилов Михаил Валентинович',
    'Корнилов Михаил Валентинович',
    '',
  ]);
  assert.deepEqual(list, ['Иванова Анна Ивановна', 'Корнилов Михаил Валентинович', 'Ратцева Арина Алексеевна']);
  assert.equal(teacherKey('Ёлкина Е.Е.'), teacherKey('Елкина Елена Евгеньевна'));
  assert.deepEqual(splitTeacherField('Петров Б.Б.; Сидоров В.В.'), ['Петров Б.Б.', 'Сидоров В.В.']);
});

test('расписание дня: номер пары, карточка, преподаватель, подгруппы', () => {
  const text = formatDaySchedule({
    kind: 'morning', dateLabel: 'пятница, 16 октября', weekParity: 1, nowHHMM: '10:00', lessons: [
      L({ time_start: '09:45', time_end: '11:15', subject: 'Анатомия', room: 'А1', teacher: 'Ратцева Арина Алексеевна', subgroup: 1, lesson_type: 'ЛПЗ' }),
      L({ time_start: '09:45', time_end: '11:15', subject: 'Анатомия', room: 'А2', teacher: 'Корнилов Михаил Валентинович', subgroup: 2, lesson_type: 'ЛПЗ' }),
      L({ time_start: '11:30', time_end: '13:00', subject: 'Философия <ПЗ>', room: '410', lesson_type: 'лекция', teacher: 'Акимова Татьяна Олеговна' }),
    ],
  });
  assert.match(text, /Доброе утро/);
  assert.match(text, /🗓 <b>ПЯТНИЦА, 16 ОКТЯБРЯ<\/b>/);
  assert.match(text, /Сегодня {2}· {2}1-я неделя/);
  assert.match(text, /▪️ <b>2 пара<\/b> {2}· {2}09:45 – 11:15 {3}🔴 <b>сейчас<\/b>/);
  assert.equal(text.match(/АНАТОМИЯ/g).length, 1, 'предмет у подгрупп пишется один раз');
  assert.match(text, /<i>1 подгруппа<\/i> {2}👤 <b>Ратцева Арина Алексеевна<\/b> {2}· {2}📍 ауд\. А1/);
  assert.match(text, /<i>2 подгруппа<\/i> {2}👤 <b>Корнилов Михаил Валентинович<\/b> {2}· {2}📍 ауд\. А2/);
  assert.match(text, /▪️ <b>3 пара<\/b> {2}· {2}11:30 – 13:00\n<blockquote><b>ФИЛОСОФИЯ &lt;ПЗ&gt;<\/b>\n👤 <b>Акимова Татьяна Олеговна<\/b>\n📍 ауд\. 410 {2}· {2}<i>лекция<\/i><\/blockquote>/);
  assert.match(text, /Итого: 2 пары {2}· {2}с 09:45 до 13:00/);
  assert.doesNotMatch(text, /Окно/, 'между 2-й и 3-й парой окна нет');
  assert.doesNotMatch(text, /[📐🧲🏀💻🏛🧬🌿🧠]/u, 'без эмодзи у предметов');
});

test('окно между парами помечается', () => {
  const text = formatDaySchedule({
    kind: 'date', dateLabel: 'вторник, 20 октября', lessons: [
      L({ time_start: '08:00', time_end: '09:30', subject: 'История' }),
      L({ time_start: '14:00', time_end: '15:30', subject: 'Химия' }),
    ],
  });
  assert.match(text, /☕️ <i>Окно — 2–3 пары · 09:45 – 13:00<\/i>/);
  assert.match(text, /2 окна/);

  const one = formatDaySchedule({
    kind: 'date', dateLabel: 'среда', lessons: [
      L({ time_start: '08:00', time_end: '09:30', subject: 'А' }),
      L({ time_start: '11:30', time_end: '13:00', subject: 'Б' }),
    ],
  });
  assert.match(one, /Окно — 2 пара · 09:45 – 11:15/);
  assert.match(one, /1 окно/);

  // Обед 13:00–14:00 между 3-й и 4-й — не окно.
  const lunch = formatDaySchedule({
    kind: 'date', dateLabel: 'четверг', lessons: [
      L({ time_start: '11:30', time_end: '13:00', subject: 'А' }),
      L({ time_start: '14:00', time_end: '15:30', subject: 'Б' }),
    ],
  });
  assert.doesNotMatch(lunch, /Окно/);

  // Своё расписание (не по сетке звонков): окно — перерыв больше 1 ч 15 мин.
  const custom = formatDaySchedule({
    kind: 'date', dateLabel: 'пятница', lessons: [
      L({ time_start: '08:30', time_end: '10:00', subject: 'А' }),
      L({ time_start: '12:00', time_end: '13:30', subject: 'Б' }),
    ],
  });
  assert.match(custom, /Окно — 10:00 – 12:00 · 2 ч/);
});

test('пары преподавателя на день и неделя с датами', () => {
  const t = formatTeacherDay('Корнилов Михаил Валентинович', [
    L({ id: 1, time_start: '08:00', time_end: '09:30', subject: 'Анатомия', room: 'А2', group_name: 'Колледж · 2 курс · 3 группа', subgroup: 2 }),
    L({ id: 2, time_start: '14:00', time_end: '15:30', subject: 'Анатомия', room: 'А1', group_name: 'Колледж · 2 курс · 4 группа' }),
  ], { dateLabel: 'понедельник, 19 октября', relLabel: 'сегодня', current: { id: 1, time_start: '08:00', room: 'А2', group_name: 'Колледж · 2 курс · 3 группа' } });
  assert.match(t, /^👤 <b>КОРНИЛОВ МИХАИЛ ВАЛЕНТИНОВИЧ<\/b>/);
  assert.match(t, /🗓 Понедельник, 19 октября {2}· {2}<i>Сегодня<\/i>/);
  assert.match(t, /🔴 <b>Сейчас на паре:<\/b> ауд\. А2, Колледж/);
  assert.match(t, /▪️ <b>1 пара<\/b> {2}· {2}08:00 – 09:30 {3}🔴 <b>сейчас<\/b>/);
  assert.match(t, /👥 <b>Колледж · 2 курс · 3 группа<\/b>, 2 подгруппа/);
  assert.match(t, /Окно — 2–3 пары/);

  const w = formatWeekSchedule({ 1: [L({ time_start: '08:00', time_end: '09:30', subject: 'А', room: '101', teacher: 'Иванова Анна Ивановна' })] }, { name: 'Осень 2026' }, 1, null,
    { mondayKey: '2026-10-12', todayKey: '2026-10-16' });
  assert.match(w, /🗓 <b>НЕДЕЛЯ<\/b> {2}12\.10 – 18\.10/);
  assert.match(w, /▫️ <b>ПОНЕДЕЛЬНИК<\/b> {2}· {2}12\.10\n<blockquote><b>1<\/b> {2}08:00 {3}<b>А<\/b>\n {10}👤 <b>Иванова А\. И\.<\/b> {2}· {2}📍 ауд\. 101<\/blockquote>/);
  assert.match(w, /◾️ <b>ПЯТНИЦА<\/b> {2}· {2}16\.10 {3}<i>сегодня<\/i>\n<blockquote><i>пар нет<\/i><\/blockquote>/);
});

test('пустой день', () => {
  assert.match(formatDaySchedule({ kind: 'evening', dateLabel: 'воскресенье', lessons: [] }), /ПАР НЕТ/);
});

test('длинные сообщения делятся под лимит Telegram', () => {
  const big = Array.from({ length: 200 }, (_, i) => `📌 <b>День ${i}</b>\nстрока`).join('\n\n');
  const parts = splitMessage(big);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 3900));
  assert.equal(parts.join('\n\n'), big);
});

test('время 8:30 приводится к 08:30', () => {
  assert.equal(padTime('8:30'), '08:30');
  const parsed = parseScheduleText('ПН\n8:30-10:00 Математика | 305\n10:10-11:40 Физика');
  assert.equal(parsed[1][0].time_start, '08:30');
});

test('окно рассылки: пропуск минуты cron не теряет рассылку', () => {
  assert.equal(isDue('20:00', '20:00'), true);
  assert.equal(isDue('20:00', '20:07'), true);
  assert.equal(isDue('20:00', '20:20'), false);
  assert.equal(isDue('20:00', '19:59'), false);
  assert.equal(isDue(null, '20:00'), false);
});

test('время и даты', () => {
  assert.match(nowInTimezone('Europe/Moscow').hhmm, /^([01]\d|2[0-3]):[0-5]\d$/, 'никаких "24:05"');
  assert.equal(mondayKeyOf('2026-10-18'), '2026-10-12');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(escapeHtml('a<b>&'), 'a&lt;b&gt;&amp;');
  assert.equal(shortName('Ратцева Арина Алексеевна'), 'Ратцева А. А.');
});

test('даты, введённые в чат', () => {
  const today = '2026-10-16';
  assert.equal(parseUserDate('20.10', today), '2026-10-20');
  assert.equal(parseUserDate('20.10.26', today), '2026-10-20');
  assert.equal(parseUserDate('20/10', today), '2026-10-20');
  assert.equal(parseUserDate('5.1', today), '2027-01-05', 'январь — уже следующий год');
  assert.equal(parseUserDate('1.09', today), '2026-09-01', 'недавнее прошлое — этот год');
  assert.equal(parseUserDate('2026-11-03', today), '2026-11-03');
  assert.equal(parseUserDate('31.02', today), null);
  assert.equal(parseUserDate('Иванова', today), null);
  assert.equal(relativeDayLabel('2026-10-17', today), 'завтра');
  assert.equal(relativeDayLabel('2026-10-15', today), 'вчера');
  assert.equal(relativeDayLabel('2026-10-25', today), null);
  assert.equal(isoWeekday('2026-10-18'), 7);
});

test('набор кастомных эмодзи (EMOJI_PACK) и запасной вариант', async () => {
  const icons = await import('../lib/icons.js');
  process.env.EMOJI_PACK = 'test_pack';
  await icons.loadEmojiPack(async () => ({ stickers: [{ emoji: '👤', custom_emoji_id: '111' }, { emoji: '📍', custom_emoji_id: '222' }] }));
  assert.equal(icons.ic('teacher'), '<tg-emoji emoji-id="111">👤</tg-emoji>');
  assert.equal(icons.ic('gap'), '☕️', 'нет в наборе — обычный эмодзи');
  const text = `${icons.ic('teacher')} <b>Иванова</b> · ${icons.ic('room')} 101`;
  assert.ok(icons.hasCustomEmoji(text));
  assert.equal(icons.stripCustomEmoji(text), '👤 <b>Иванова</b> · 📍 101');
  delete process.env.EMOJI_PACK;
});
