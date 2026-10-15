import { query } from './db.js';

// Тексты по умолчанию — используются, пока админ их не переопределил.
export const DEFAULT_TEXTS = {
  welcome: [
    '🖤 <b>РАСПИСАНИЕ · САМАРСКИЙ ГАУ</b>',
    '',
    'Присылаю пары твоей группы прямо в Telegram: ☀️ утром — на сегодня, 🌙 вечером — на завтра.',
    '',
    '<blockquote>Расписание беру с сайта ssaa.ru и обновляю сам. Отмечаю окна между парами и показываю, где и когда ведёт пары любой преподаватель.</blockquote>',
    '',
    'Для начала выбери свою группу.',
  ].join('\n'),

  help: [
    '❔ <b>КАК ПОЛЬЗОВАТЬСЯ</b>',
    '',
    '<blockquote>☀️ 🌙 🗓  <b>Сегодня · Завтра · Неделя</b> — кнопки внизу экрана, дни листаются стрелками',
    '🗓 <b>Календарь</b> — пары на любую дату, дни с парами отмечены точкой',
    '👤 <b>Преподаватели</b> — где и когда ведёт пары, на любой день',
    '☕️ <b>Окно</b> — свободная пара между занятиями</blockquote>',
    '',
    'Можно просто написать в чат дату — <code>20.10</code> — или фамилию преподавателя.',
    '',
    '<i>Команды: /today /tomorrow /week /date /teacher /settings /support</i>',
  ].join('\n'),

  group_welcome: [
    '🖤 <b>РАСПИСАНИЕ · САМАРСКИЙ ГАУ</b>',
    '',
    'В этом чате буду присылать всей группе пары: утром на сегодня и вечером на завтра.',
    '',
    '<i>Настраивать бота может только администратор чата.</i>',
  ].join('\n'),

  donate: [
    '🖤 <b>ПОДДЕРЖАТЬ ПРОЕКТ</b>',
    '',
    'Бот бесплатный и без рекламы. Если он экономит тебе время — можно поддержать разработку любой суммой.',
    '',
    '<blockquote>💳 Карта: <code>2202 2050 4023 4269</code>\n<i>нажми на номер, чтобы скопировать</i></blockquote>',
    '',
    'Спасибо, что пользуешься!',
  ].join('\n'),
};

// Список текстов, доступных для редактирования в админ-панели: ключ -> подпись.
export const EDITABLE_TEXT_LABELS = {
  welcome: 'Приветствие (личка)',
  group_welcome: 'Приветствие (групповой чат)',
  help: 'Помощь',
  donate: 'Донат (реквизиты)',
};

let cache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000; // не ходим в базу чаще раза в 30 сек на "тёплом" инстансе

async function loadAll() {
  const now = Date.now();
  if (cache && now - cacheLoadedAt < CACHE_TTL_MS) return cache;

  const { rows } = await query('SELECT key, value FROM bot_texts');
  cache = {};
  for (const row of rows) cache[row.key] = row.value;
  cacheLoadedAt = now;
  return cache;
}

export async function getText(key) {
  const all = await loadAll();
  return all[key] ?? DEFAULT_TEXTS[key] ?? '';
}

export async function setText(key, value) {
  await query(
    `INSERT INTO bot_texts (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
  if (cache) cache[key] = value; // инвалидация "в лоб" — сразу обновляем кэш
}

export async function resetText(key) {
  await query('DELETE FROM bot_texts WHERE key = $1', [key]);
  if (cache) delete cache[key];
}
