import { timingSafeEqual } from 'node:crypto';
import { aliceAnswer } from '../lib/alice.js';

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
  if (!sameSecret(req.query?.key, process.env.ALICE_SECRET)) {
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
  const plain = text.replace(/ sil <\[\d+\]> /g, ' ');
  res.status(200).json({
    version: body.version || '1.0',
    session: body.session,
    response: { text: plain, tts: text, end_session: true },
  });
}
