import { timingSafeEqual } from 'node:crypto';
import { aliceAnswer } from '../lib/alice.js';
import { query } from '../lib/db.js';

// Вебхук навыка Яндекс.Алисы (Яндекс Диалоги → Webhook URL):
//   https://<домен>/api/alice?key=<ALICE_SECRET>
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
  let secret = process.env.ALICE_SECRET;
  if (!secret) {
    try {
      const { rows: [r] } = await query(`SELECT value FROM app_settings WHERE key = 'alice_secret'`);
      secret = r?.value;
    } catch { /* таблицы нет — ключа нет */ }
  }
  if (!sameSecret(req.query?.key, secret)) {
    res.status(401).send('unauthorized');
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const command = body.request?.command || body.request?.original_utterance || '';
  let text;
  try {
    text = await aliceAnswer(command);
  } catch (err) {
    console.error('Alice webhook error:', err);
    text = 'Не получилось достать расписание. Попробуй чуть позже.';
  }
  // Алиса принимает text и tts не длиннее 1024 символов: режем по границе предложения.
  const cut = (t) => {
    if (t.length <= 1000) return t;
    const head = t.slice(0, 1000);
    const i = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.'));
    return (i > 200 ? head.slice(0, i + 1) : head) + ' Остальное смотри в боте.';
  };
  text = cut(text);
  const plain = text.replace(/ sil <\[\d+\]> /g, ' ');
  res.status(200).json({
    version: body.version || '1.0',
    session: body.session,
    response: { text: plain, tts: text, end_session: true },
  });
}
