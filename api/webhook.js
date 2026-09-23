import { createBot } from '../lib/bot.js';

const bot = createBot();
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
    }
    await bot.handleUpdate(req.body);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('ok'); // Telegram не должен получать 5xx и ретраить бесконечно
  }
}
