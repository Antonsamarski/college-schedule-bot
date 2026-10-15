import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDaySchedule, splitMessage, escapeHtml, shortName } from '../lib/format.js';
import { dedupeTeachers, teacherKey, splitTeacherField } from '../lib/teacherSearch.js';
import { parseScheduleText, padTime } from '../lib/schedule.js';
import { isDue } from '../api/tick.js';
import { nowInTimezone, mondayKeyOf, addDays } from '../lib/time.js';

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

test('расписание дня: номера пар и подгруппы в одной паре', () => {
  const text = formatDaySchedule({
    kind: 'morning', dateLabel: 'пятница, 16 октября', weekParity: 1, lessons: [
      L({ time_start: '09:45', time_end: '11:15', subject: 'Анатомия', room: 'А1', teacher: 'Ратцева А. А.', subgroup: 1, lesson_type: 'ЛПЗ' }),
      L({ time_start: '09:45', time_end: '11:15', subject: 'Анатомия', room: 'А2', teacher: 'Корнилов М. В.', subgroup: 2, lesson_type: 'ЛПЗ' }),
      L({ time_start: '11:30', time_end: '13:00', subject: 'Философия <ПЗ>', room: '410', lesson_type: 'лекция' }),
    ],
  });
  assert.match(text, /2️⃣ <b>09:45–11:15<\/b>/);
  assert.equal(text.match(/Анатомия/g).length, 1, 'предмет у подгрупп пишется один раз');
  assert.match(text, /1️⃣ подгр\. · 🚪 А1 · 👤 Ратцева А\. А\./);
  assert.match(text, /3️⃣ <b>11:30–13:00<\/b>/);
  assert.match(text, /Философия &lt;ПЗ&gt;/, 'HTML экранируется');
  assert.match(text, /📖 Лекция/);
  assert.match(text, /2 пары · с 09:45 до 13:00/);
});

test('пустой день', () => {
  assert.match(formatDaySchedule({ kind: 'evening', dateLabel: 'воскресенье', lessons: [] }), /Пар нет/);
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
