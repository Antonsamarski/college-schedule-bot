import { createBot } from '../lib/bot.js';
import { loadEmojiPack } from '../lib/icons.js';

const bot = createBot();

const COMMANDS = [
  { command: 'today', description: '📅 Пары на сегодня' },
  { command: 'tomorrow', description: '🌙 Пары на завтра' },
  { command: 'week', description: '🗓 Неделя' },
  { command: 'date', description: '📆 Календарь / пары на дату' },
  { command: 'teacher', description: '👤 Найти преподавателя' },
  { command: 'menu', description: '🏠 Главное меню' },
  { command: 'settings', description: '⚙️ Настройки' },
  { command: 'support', description: '💬 Написать в поддержку' },
  { command: 'donate', description: '💝 Поддержать проект' },
];
let initialized = false;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).send('ok');
    return;
  }

  // Проверяем секретный токен, который Telegram присылает в заголовке,
  // чтобы эндпоинт не мог дёргать кто угодно.
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).send('unauthorized');
    return;
  }

  try {
    if (!initialized) {
      await bot.init(); // подтягивает info о самом боте, делаем один раз на "тёплый" инстанс
      initialized = true;
      await loadEmojiPack((name) => bot.api.getStickerSet(name)); // EMOJI_PACK, если задан
      // Меню команд у поля ввода («/»). Не ждём — ответ пользователю важнее.
      bot.api.setMyCommands(COMMANDS).catch((e) => console.error('setMyCommands failed', e.description || e));
    }
    await bot.handleUpdate(req.body);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('ok'); // Telegram не должен получать 5xx и ретраить бесконечно
  }
}
