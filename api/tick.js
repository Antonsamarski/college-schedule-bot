import { query } from '../lib/db.js';
import { buildTodayDigest, buildTomorrowDigest } from '../lib/digest.js';
import { nowInTimezone, minutesOf } from '../lib/time.js';

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// Рассылка уходит, если сейчас в промежутке [время рассылки, +SEND_WINDOW_MIN).
// Раньше требовалось точное совпадение минуты: стоило cron-job.org пропустить
// один вызов (а он иногда пропускает), и рассылка за день терялась.
const SEND_WINDOW_MIN = 20;
// Vercel даёт функции 10 секунд. Что не успели — отправится на следующем тике
// (окно это позволяет), а не оборвётся на середине.
const TIME_BUDGET_MS = 8000;

async function sendTelegramMessage(chatId, text) {
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (resp.ok) return { ok: true };
  const body = await resp.text();
  console.error('sendMessage failed:', resp.status, body);
  // 403 — бот заблокирован/удалён из чата, 400 — чата нет: повтор не поможет.
  return { ok: false, retry: resp.status === 429 || resp.status >= 500 };
}

/**
 * "Застолбить" рассылку атомарно: вставка в журнал проходит только у одного
 * вызова, даже если два тика пришли одновременно — поэтому дублей не будет.
 */
async function claim(table, idColumn, id, dateKey, kind) {
  const { rows } = await query(
    `INSERT INTO ${table} (${idColumn}, send_date, kind) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING id`,
    [id, dateKey, kind]
  );
  return rows.length > 0;
}

async function unclaim(table, idColumn, id, dateKey, kind) {
  await query(`DELETE FROM ${table} WHERE ${idColumn} = $1 AND send_date = $2 AND kind = $3`, [id, dateKey, kind]);
}

export function isDue(sendTime, hhmm) {
  if (!sendTime) return false;
  const diff = minutesOf(hhmm) - minutesOf(sendTime);
  return diff >= 0 && diff < SEND_WINDOW_MIN;
}

/**
 * Один подписчик (личный пользователь или групповой чат). Ошибка на одном не
 * должна ронять рассылку остальным — поэтому ловится здесь и логируется.
 */
async function processSubscriber(sub, { chatId, logTable, logIdColumn }) {
  if (!sub.group_id) return { sent: 0, error: null };

  try {
    const { hhmm, dateKey } = nowInTimezone(sub.timezone);
    let sent = 0;

    for (const kind of ['evening', 'morning']) {
      const sendTime = kind === 'evening' ? sub.evening_time : sub.morning_time;
      if (!isDue(sendTime, hhmm)) continue;
      if (!(await claim(logTable, logIdColumn, sub.id, dateKey, kind))) continue;

      try {
        const text = kind === 'evening' ? await buildTomorrowDigest(sub) : await buildTodayDigest(sub);
        const result = await sendTelegramMessage(chatId, text);
        if (result.ok) sent++;
        else if (result.retry) await unclaim(logTable, logIdColumn, sub.id, dateKey, kind);
      } catch (e) {
        await unclaim(logTable, logIdColumn, sub.id, dateKey, kind);
        throw e;
      }
    }
    return { sent, error: null };
  } catch (e) {
    console.error(`processSubscriber failed for ${logIdColumn}=${sub.id} (chat ${chatId}):`, e);
    return { sent: 0, error: e.message || String(e) };
  }
}

export default async function handler(req, res) {
  const auth = req.headers['x-cron-secret'] || req.query?.secret;
  if (auth !== process.env.CRON_SECRET) {
    res.status(401).send('unauthorized');
    return;
  }

  const startedAt = Date.now();
  const { rows: users } = await query(
    `SELECT * FROM users WHERE group_id IS NOT NULL AND (morning_time IS NOT NULL OR evening_time IS NOT NULL)`
  );
  const { rows: groupChats } = await query(
    `SELECT * FROM group_chats WHERE group_id IS NOT NULL AND (morning_time IS NOT NULL OR evening_time IS NOT NULL)`
  );

  const jobs = [
    ...users.map((u) => [u, { chatId: u.telegram_id, logTable: 'sent_log', logIdColumn: 'user_id' }]),
    ...groupChats.map((g) => [g, { chatId: g.chat_id, logTable: 'group_chat_sent_log', logIdColumn: 'group_chat_id' }]),
  ];

  let sentCount = 0;
  let skipped = 0;
  const errors = [];

  for (const [sub, opts] of jobs) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      skipped++;
      continue;
    }
    const result = await processSubscriber(sub, opts);
    sentCount += result.sent;
    if (result.error) errors.push({ table: opts.logTable, id: sub.id, error: result.error });
  }

  res.status(200).json({
    ok: true,
    checkedUsers: users.length,
    checkedGroupChats: groupChats.length,
    sent: sentCount,
    deferred: skipped,
    errors,
  });
}
