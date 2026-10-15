import { query } from './db.js';

// Тексты по умолчанию — используются, пока админ их не переопределил.
export const DEFAULT_TEXTS = {
  welcome: [
    '👋 <b>Привет! Я бот-расписание.</b>',
    '',
    'Умею каждый день присылать тебе пары: вечером на завтра и утром на сегодня — во время, которое ты сам выберешь.',
    '',
    'Выбери действие в меню ниже 👇',
  ].join('\n'),

  help: [
    '<b>Как это работает</b>',
    '',
    '1. «👥 Учебная группа» → «🌐 Выбрать группу с сайта ssaa.ru» — форма обучения, курс, группа. Расписание загрузится само и будет обновляться автоматически.',
    '2. Там же укажи подгруппу — тогда буду показывать только твои пары.',
    '3. Настрой время утренней и вечерней рассылки (кнопка «⏰ Время рассылок»).',
    '4. Дальше бот сам каждый день будет присылать пары в нужное время.',
    '',
    'Команды: /today — на сегодня, /tomorrow — на завтра, /week — на неделю, /teacher Фамилия — где преподаватель, /menu — главное меню.',
    '',
    '<i>Расписания нет на сайте?</i> Группу можно создать вручную и заполнить по шаблону или через промпт для нейросети.',
  ].join('\n'),

  group_welcome: [
    '👋 <b>Привет! Я бот-расписание.</b>',
    '',
    'В этом чате я могу каждый день присылать всей группе пары: вечером на завтра и утром на сегодня.',
    '',
    '⚠️ Настраивать (выбирать учебную группу, расписание, время рассылки) может только администратор чата. Остальные могут пользоваться кнопками «на сегодня/на завтра».',
    '',
    'Выбери действие в меню ниже 👇',
  ].join('\n'),
};

// Список текстов, доступных для редактирования в админ-панели: ключ -> подпись.
export const EDITABLE_TEXT_LABELS = {
  welcome: 'Приветствие (главное меню, личка)',
  group_welcome: 'Приветствие (в групповом чате)',
  help: 'Текст помощи (/help)',
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
