import { query } from './db.js';

// Тексты по умолчанию — используются, пока админ их не переопределил.
export const DEFAULT_TEXTS = {
  welcome: [
    '🎓 <b>Расписание Самарского ГАУ</b>',
    '',
    'Привет! Я присылаю пары твоей группы прямо в Telegram:',
    '☀️ утром — на сегодня, 🌙 вечером — на завтра.',
    '',
    'Расписание беру с сайта ssaa.ru и обновляю сам — вводить ничего не нужно.',
    'Окна между парами отмечаю ☕, а ещё могу показать, где и когда ведёт пары любой преподаватель.',
    '',
    '👇 Для начала выбери свою группу',
  ].join('\n'),

  help: [
    '❓ <b>Как пользоваться</b>',
    '',
    '📅 <b>Сегодня / Завтра</b> — пары на день. Кнопками ◀️ ▶️ можно листать дни.',
    '📆 <b>Календарь</b> — пары на любую дату. Точкой • отмечены дни с парами.',
    '🗓 <b>Неделя</b> — вся неделя разом, с датами.',
    '👤 <b>Преподаватели</b> — где и когда ведёт пары: сегодня, завтра или в любой день.',
    '☕ <b>Окно</b> — свободная пара между занятиями.',
    '',
    'Можно просто написать в чат:',
    '• дату — <code>20.10</code> — покажу пары на этот день;',
    '• фамилию — <code>Иванова</code> — найду преподавателя.',
    '',
    'Команды: /today /tomorrow /week /date /teacher /settings /support',
  ].join('\n'),

  group_welcome: [
    '🎓 <b>Расписание Самарского ГАУ</b>',
    '',
    'В этом чате я буду присылать всей группе пары: утром на сегодня и вечером на завтра.',
    '',
    '⚠️ Настраивать бота (группа, время рассылки) может только администратор чата.',
  ].join('\n'),

  donate: [
    '💝 <b>Поддержать проект</b>',
    '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈',
    '',
    'Бот бесплатный и без рекламы. Если он экономит тебе время — можно поддержать разработку любой суммой 🙏',
    '',
    '💳 Карта: <code>2202 2050 4023 4269</code>',
    '<i>нажми на номер, чтобы скопировать</i>',
    '',
    'Спасибо, что ты с нами! ❤️',
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
