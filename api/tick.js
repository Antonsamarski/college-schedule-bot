import { query } from '../lib/db.js';
import { buildTodayDigest, buildTomorrowDigest } from '../lib/digest.js';
import { nowInTimezone } from '../lib/time.js';

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

async function sendTelegramMessage(chatId, text) {
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error('sendMessage failed:', resp.status, body);
  }
}

async function alreadySent(table, idColumn, id, dateKey, kind) {
  const { rows } = await query(
    `SELECT 1 FROM ${table} WHERE ${idColumn} = $1 AND send_date = $2 AND kind = $3`,
    [id, dateKey, kind]
  );
  return rows.length > 0;
}

async function markSent(table, idColumn, id, dateKey, kind) {
  await query(
    `INSERT INTO ${table} (${idColumn}, send_date, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [id, dateKey, kind]
  );
}

/**
 * Общая логика для одного "подписчика" (личный пользователь или групповой
 * чат) — они одинаково устроены (group_id, morning_time, evening_time,
 * timezone), только шлём на разный chat_id и пишем в разный журнал.
 */
async function processSubscriber(sub, { chatId, logTable, logIdColumn }) {
  if (!sub.group_id) return 0;

  const { hhmm, dateKey } = nowInTimezone(sub.timezone);
  let sent = 0;

  if (sub.evening_time === hhmm && !(await alreadySent(logTable, logIdColumn, sub.id, dateKey, 'evening'))) {
    const text = await buildTomorrowDigest(sub.group_id, sub.timezone);
    await sendTelegramMessage(chatId, text);
    await markSent(logTable, logIdColumn, sub.id, dateKey, 'evening');
    sent++;
  }

  if (sub.morning_time === hhmm && !(await alreadySent(logTable, logIdColumn, sub.id, dateKey, 'morning'))) {
    const text = await buildTodayDigest(sub.group_id, sub.timezone);
    await sendTelegramMessage(chatId, text);
    await markSent(logTable, logIdColumn, sub.id, dateKey, 'morning');
    sent++;
  }

  return sent;
}

export default async function handler(req, res) {
  const auth = req.headers['x-cron-secret'] || req.query?.secret;
  if (auth !== process.env.CRON_SECRET) {
    res.status(401).send('unauthorized');
    return;
  }

  const { rows: users } = await query(
    `SELECT * FROM users WHERE group_id IS NOT NULL AND (morning_time IS NOT NULL OR evening_time IS NOT NULL)`
  );
  const { rows: groupChats } = await query(
    `SELECT * FROM group_chats WHERE group_id IS NOT NULL AND (morning_time IS NOT NULL OR evening_time IS NOT NULL)`
  );

  let sentCount = 0;

  for (const user of users) {
    sentCount += await processSubscriber(user, {
      chatId: user.telegram_id,
      logTable: 'sent_log',
      logIdColumn: 'user_id',
    });
  }

  for (const gc of groupChats) {
    sentCount += await processSubscriber(gc, {
      chatId: gc.chat_id,
      logTable: 'group_chat_sent_log',
      logIdColumn: 'group_chat_id',
    });
  }

  res.status(200).json({
    ok: true,
    checkedUsers: users.length,
    checkedGroupChats: groupChats.length,
    sent: sentCount,
  });
}
