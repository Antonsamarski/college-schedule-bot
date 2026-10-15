// Запуск: npm test  (база и интернет не нужны — только сохранённые ответы сайта)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGroupsPage, parseScheduleHtml, expandSubgroups, pickPeriod } from '../lib/ssaa.js';
import { termBounds, termNameForPeriod } from '../lib/ssaaSync.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('список групп со страницы ssaa.ru', () => {
  const groups = parseGroupsPage(fixture('ssaa_groups_page.html'));
  const g = groups.find((x) => x.key === 'ssaa:11:Колледж:2:3');
  assert.equal(g.title, 'Колледж · 2 курс · 3 группа');
  assert.equal(g.group, ' 3 группа'); // пробел в начале нужен сайту
  assert.equal(g.period, '3');
  assert.equal(g.dateStart, '2026-08-31');
  assert.equal(g.dateEnd, '2026-12-19');
  // у одной группы может быть несколько периодов (сессии заочников)
  assert.equal(groups.filter((x) => x.key === 'ssaa:3:Инженерный:2:1').length, 2);
});

test('выбор актуального периода', () => {
  const periods = [
    { period: 'a', dateStart: '2026-09-14', dateEnd: '2027-01-30' },
    { period: 'b', dateStart: '2026-10-12', dateEnd: '2026-10-31' },
  ];
  assert.equal(pickPeriod(periods, '2026-10-16').period, 'a');
  assert.equal(pickPeriod(periods, '2026-09-01').period, 'a'); // ближайший будущий
  assert.equal(pickPeriod(periods, '2027-03-01').period, 'b'); // последний по дате начала
});

test('разбор таблицы расписания', () => {
  const lessons = parseScheduleHtml(fixture('ssaa_college_2k_3gr.html'));
  assert.equal(lessons.length, 41);

  const first = lessons.find((l) => l.week === 1 && l.weekday === 2 && l.time_start === '08:00');
  assert.deepEqual(
    { subject: first.subject, room: first.room, type: first.lesson_type, teacher: first.teacher, subgroup: first.subgroup },
    { subject: 'Информатика', room: '519', type: 'ЛПЗ', teacher: 'Родионова Юлия Сергеевна', subgroup: null }
  );
  assert.equal(first.time_end, '09:30');
  assert.equal(first.dates[0], '2026-09-01');
  assert.equal(first.dates.at(-1), '2026-12-08');

  // "А1/А2" + два преподавателя → две записи, у каждой свой кабинет и преподаватель
  const fri = lessons.filter((l) => l.week === 1 && l.weekday === 5 && l.time_start === '09:45');
  assert.deepEqual(fri.map((l) => [l.subgroup, l.room, l.teacher]), [
    [1, 'А1', 'Ратцева Арина Алексеевна'],
    [2, 'А2', 'Корнилов Михаил Валентинович'],
  ]);

  // "-/Предмет" → только 2-я подгруппа
  const mon = lessons.find((l) => l.week === 1 && l.weekday === 1 && l.time_start === '08:00');
  assert.equal(mon.subgroup, 2);
  assert.equal(mon.room, 'А2');

  // пустой "Вид" и пустая аудитория не ломают разбор
  const sat = lessons.find((l) => l.week === 2 && l.weekday === 6);
  assert.equal(sat.subject, 'Самостоятельная работа студентов');
  assert.equal(sat.room, null);
  assert.equal(sat.lesson_type, null);
});

test('сырой HTML сервера: без <tr>, одинарные кавычки, незакрытая таблица', () => {
  // Именно так shedule.php отдаёт страницу на самом деле (браузер это
  // исправляет сам). Старый разбор "по строкам" находил здесь 0 пар.
  const raw = fixture('ssaa_college_2k_3gr_raw.html');
  assert.ok(!raw.includes('</table>'));
  assert.match(raw, /class='shedstrm'/);
  const clean = parseScheduleHtml(fixture('ssaa_college_2k_3gr.html'));
  const lessons = parseScheduleHtml(raw);
  assert.equal(lessons.length, 41);
  assert.deepEqual(lessons, clean);
});

test('подгруппы: все варианты записи', () => {
  assert.deepEqual(expandSubgroups({ subject: 'Химия', room: '101', teachers: ['A'] }),
    [{ subject: 'Химия', room: '101', teachers: ['A'], subgroup: null }]);
  assert.deepEqual(expandSubgroups({ subject: 'Химия/-', room: '101/-', teachers: ['A'] }),
    [{ subject: 'Химия', room: '101', teachers: ['A'], subgroup: 1 }]);
  assert.deepEqual(expandSubgroups({ subject: 'Химия/Физика', room: '1/2', teachers: ['A', 'B'] }).map((x) => [x.subject, x.teachers[0]]),
    [['Химия', 'A'], ['Физика', 'B']]);
});

test('семестр: начало на понедельник 1-й недели, название', () => {
  const lessons = parseScheduleHtml(fixture('ssaa_college_2k_3gr.html'));
  const b = termBounds({ dateStart: '2026-08-31', dateEnd: '2026-12-19' }, lessons);
  assert.deepEqual(b, { dateStart: '2026-08-31', dateEnd: '2026-12-19' });
  assert.equal(termNameForPeriod({ dateStart: '2026-08-31', dateEnd: '2026-12-19' }), 'Осень 2026');
  assert.equal(termNameForPeriod({ dateStart: '2027-02-08', dateEnd: '2027-06-30' }), 'Весна 2027');
  assert.equal(termNameForPeriod({ dateStart: '2026-10-26', dateEnd: '2026-11-14' }), 'Сессия 26 окт – 14 ноя');
});
