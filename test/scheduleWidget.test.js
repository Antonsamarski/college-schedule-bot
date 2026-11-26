import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { createBot } from '../lib/bot.js';
import { getPool } from '../lib/db.js';
import { clearFlagCache } from '../lib/features.js';
import { scheduleDayData, subscribeScheduleWidgets } from '../lib/scheduleWidget.js';
import { SCHEDULE_WIDGET_HTML } from '../lib/scheduleWidgetHtml.js';

test('widget payload is bounded, with controls for days larger than one page', () => {
  const long = '"\\🧪'.repeat(200);
  const lesson = { subject: long, teacher: long, room: long, lesson_type: long, time_start: '08:00', time_end: '09:30' };
  const data = { route: 't', title: 'Понедельник, 23 ноября', group: long, empty: 'Пар нет.', lessons: [lesson, lesson, lesson] };
  assert.ok(deflateSync(SCHEDULE_WIDGET_HTML, { level: 9 }).length <= 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(scheduleDayData({ ...data, page: 0 }))) <= 1024);
  const second = scheduleDayData({ ...data, page: 1 });
  assert.equal(second.page, 1);
  assert.equal(second.pages, 2);
  assert.equal(second.lessons.length, 1);
  assert.match(second.lessons[0][1], /…$/);
});

test('webhook subscription preserves the URL and existing update types', async () => {
  const url = 'https://fixture.vercel.app/api/webhook';
  const calls = [];
  const api = {
    getWebhookInfo: async () => ({ url, max_connections: 20, allowed_updates: ['message', 'callback_query'] }),
    setWebhook: async (...args) => calls.push(args),
  };
  await subscribeScheduleWidgets(api, 'fixture');
  assert.deepEqual(calls[0].slice(0, 2), [url, {
    allowed_updates: ['message', 'callback_query', 'widget_query'],
    max_connections: 20, secret_token: 'fixture',
  }]);
  api.getWebhookInfo = async () => ({ url, allowed_updates: [] });
  await subscribeScheduleWidgets(api, 'fixture');
  assert.equal(calls.length, 1);
});

test('widget query receives beta schedule only from the requesting private chat', async (t) => {
  const pool = getPool();
  let betaAllowed = false;
  const sql = [];
  t.mock.method(pool, 'query', async (statement) => {
    sql.push(statement);
    if (statement.includes('FROM feature_flags')) return { rows: [] };
    if (statement.includes('FROM beta_testers')) return { rows: betaAllowed ? [{}] : [] };
    if (statement.includes('FROM users')) return { rows: [{ group_id: 7, timezone: 'Europe/Samara', subgroup: null }] };
    if (statement.includes('FROM groups')) return { rows: [{ id: 7, name: 'Группа 7' }] };
    if (statement.includes('FROM terms')) return { rows: [{ id: 8, date_start: '2026-09-01' }] };
    if (statement.includes('FROM lessons')) return { rows: [{ subject: 'Механика', time_start: '08:00' }] };
    throw new Error('Unexpected query');
  });
  clearFlagCache();
  const token = process.env.BOT_TOKEN;
  process.env.BOT_TOKEN = '1:fixture';
  t.after(() => {
    if (token === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = token;
    clearFlagCache();
  });
  const bot = createBot();
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  const answers = [];
  bot.api.config.use(async (prev, method, payload) => {
    assert.equal(method, 'answerWidgetQuery');
    answers.push(JSON.parse(payload.data));
    return { ok: true, result: true };
  });
  const event = { id: 'query', from: { id: 42 }, chat: { type: 'private', id: 42 }, message_id: 7 };
  await bot.handleUpdate({ update_id: 1, widget_query: { ...event, data: 'schedule:t:0' } });
  assert.match(answers[0].error, /беты/);
  assert.equal(sql.some((statement) => statement.includes('FROM users')), false);
  betaAllowed = true;
  await bot.handleUpdate({ update_id: 2, widget_query: { ...event, data: 'schedule:w' } });
  assert.equal(answers[1].days.length, 7);
  await bot.handleUpdate({ update_id: 3, widget_query: { ...event, data: 'schedule:d0:0' } });
  assert.equal(answers[2].lessons[0][1], 'Механика');
  await bot.handleUpdate({ update_id: 4, widget_query: { ...event, chat: { type: 'group', id: -1 }, data: 'schedule:t:0' } });
  assert.match(answers[3].error, /личном чате/);
});

test('HTML switches from today to week, a weekday and the next page', async () => {
  class Element {
    children = [];
    set textContent(value) { this.text = value; this.children = []; }
    appendChild(element) { this.children.push(element); }
    addEventListener(event, handler) { this[event] = handler; }
    removeAttribute() {}
    setAttribute() {}
  }
  const elements = Object.fromEntries('today tomorrow week title group schedule pages previous next status'.split(' ').map((id) => [id, new Element()]));
  const empty = { route: 't', title: 'Сегодня', group: 'Группа', lessons: [], empty: 'Пар нет', page: 0, pages: 0 };
  const requests = [];
  const api = {
    chatData: JSON.stringify(empty),
    ready() {},
    async request(action) {
      requests.push(action);
      const data = action === 'schedule:w'
        ? { route: 'w', title: 'Неделя', group: 'Группа', days: [['Пн 23.11', 3]] }
        : { ...empty, route: 'd0', page: Number(action.at(-1)), pages: 2, lessons: [['08:00', 'Механика']] };
      return { result: JSON.stringify(data) };
    },
  };
  const document = { getElementById: (id) => elements[id], createElement: () => new Element() };
  runInNewContext(SCHEDULE_WIDGET_HTML.match(/<script>([\s\S]+)<\/script>/)[1], { TelegramWidget: api, document });
  const settle = () => new Promise(setImmediate);
  elements.week.click();
  await settle();
  assert.equal(elements.title.text, 'Неделя');
  elements.schedule.children[0].children[0].click();
  await settle();
  elements.next.click();
  await settle();
  assert.deepEqual(requests, ['schedule:w', 'schedule:d0:0', 'schedule:d0:1']);
  assert.equal(elements.schedule.children.at(-1).text, '2 / 2');
});
