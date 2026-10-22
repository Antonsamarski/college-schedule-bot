import { timingSafeEqual } from 'node:crypto';
import { createMaxBot } from '../lib/bot.js';
import { maxEnabled, maxWebhookSecret } from '../lib/max.js';

// Вебхук MAX: сюда MAX присылает сообщения и нажатия кнопок.
// Подписку на вебхук оформляет /api/tick (lib/max.js → ensureMaxSubscription).
const bot = createMaxBot();

function sameSecret(a, b) {
  if (typeof a !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).send('ok');
    return;
  }
  if (!maxEnabled()) {
    res.status(503).send('MAX_BOT_TOKEN is not set');
    return;
  }
  // Секрет задаётся при подписке, MAX присылает его в каждом запросе.
  if (!sameSecret(req.headers['x-max-bot-api-secret'], maxWebhookSecret())) {
    res.status(401).send('unauthorized');
    return;
  }

  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    await bot.handleUpdate(update);
  } catch (err) {
    console.error('MAX webhook error:', err);
  }
  // Всегда 200: иначе MAX будет повторять запрос, а через 8 часов отпишет бота.
  res.status(200).send('ok');
}
