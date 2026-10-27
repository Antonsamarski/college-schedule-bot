import { timingSafeEqual } from 'node:crypto';
import { query } from '../lib/db.js';
import { buildTodayDigest, buildTomorrowDigest } from '../lib/digest.js';
import { nowInTimezone, minutesOf } from '../lib/time.js';
import { backgroundSync } from '../lib/ssaaSync.js';
import { loadEmojiPack, stripCustomEmoji, hasCustomEmoji } from '../lib/icons.js';
import {
  maxEnabled, maxSend, maxDelete, ensureMaxSubscription, maxTokenFingerprint,
} from '../lib/max.js';

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// Рассылка уходит, если сейчас в промежутке [время рассылки, +SEND_WINDOW_MIN).
// Раньше требовалось точное совпадение минуты: стоило cron-job.org пропустить
// один вызов (а он иногда пропускает), и рассылка за день терялась.
const SEND_WINDOW_MIN = 20;
// Функции дано 30 секунд (vercel.json). Рассылке — до 20 с: что не успели,
// уйдёт на следующем тике (окно SEND_WINDOW_MIN это позволяет). Остаток — на
// подгрузку групп с сайта, но так, чтобы уложиться в 27 с.
const TIME_BUDGET_MS = 20_000;
const PRELOAD_BUDGET_MS = 12_000;
const FUNCTION_BUDGET_MS = 27_000;
// Сколько рассылок отправляем одновременно. Telegram пускает до 30 сообщений
// в секунду на бота, MAX — до 30 запросов в секунду: 6 потоков с запасом.
const SEND_CONCURRENCY = 6;

async function tg(method, payload) {
  return fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const resp = await tg('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: replyMarkup,
  });
  if (resp.ok) {
    const data = await resp.json().catch(() => ({}));
    return { ok: true, messageId: data.result?.message_id };
  }
  // Кастомные эмодзи недоступны (нет Premium у владельца) — шлём с обычными.
  if (resp.status === 400 && hasCustomEmoji(text)) return sendTelegramMessage(chatId, stripCustomEmoji(text), replyMarkup);
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
/** Рассылка в MAX. Ошибки 4xx (бот заблокирован, чата нет) повтором не лечатся. */
async function sendMaxDigest(to, text) {
  try {
    const { mid } = await maxSend(to, text);
    return { ok: true, messageId: mid };
  } catch (e) {
    console.error('MAX send failed:', e.description || e.message || e);
    return { ok: false, retry: !e.status || e.status === 429 || e.status >= 500 };
  }
}

/**
 * Чтобы чат не засорялся: новая рассылка заменяет предыдущую — старую
 * удаляем (Telegram разрешает боту удалять свои сообщения в течение 48 часов).
 * Номера сообщений: в Telegram — числа, в MAX — строки, храним как есть.
 */
async function replacePreviousDigest(sub, { table, chatId, platform }, messageId) {
  const prev = sub.state?.lastDigestId;
  if (prev && prev !== messageId) {
    if (platform === 'max') await maxDelete(prev).catch(() => {});
    else await tg('deleteMessage', { chat_id: chatId, message_id: prev }).catch(() => {});
  }
  await query(
    `UPDATE ${table} SET state = jsonb_set(COALESCE(state, '{}'::jsonb), '{lastDigestId}', $1::jsonb) WHERE id = $2`,
    [JSON.stringify(messageId), sub.id]
  );
  sub.state = { ...(sub.state || {}), lastDigestId: messageId };
}

async function processSubscriber(sub, opts) {
  const { chatId, logTable, logIdColumn, platform, maxTo } = opts;
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
        const result = platform === 'max' ? await sendMaxDigest(maxTo, text) : await sendTelegramMessage(chatId, text);
        if (result.ok) {
          sent++;
          if (result.messageId) await replacePreviousDigest(sub, opts, result.messageId);
        }
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

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Тик запускают двое: внешний будильник (cron-job.org) с CRON_SECRET из
 * настроек Vercel и планировщик pg_cron в самой базе Supabase — у него свой
 * ключ, который лежит только в таблице app_secrets (см. миграцию 007).
 */
export async function isAuthorized(req) {
  const auth = req.headers['x-cron-secret'] || req.query?.secret;
  if (typeof auth !== 'string' || !auth) return false;
  if (sameSecret(auth, process.env.CRON_SECRET)) return true;
  try {
    const { rows } = await query(`SELECT value FROM app_secrets WHERE key = 'tick_secret'`);
    return sameSecret(auth, rows[0]?.value);
  } catch {
    return false; // таблицы ещё нет — пускаем только по CRON_SECRET
  }
}

export default async function handler(req, res) {
  if (!(await isAuthorized(req))) {
    res.status(401).send('unauthorized');
    return;
  }

  const startedAt = Date.now();
  await loadEmojiPack(async (name) => {
    const r = await tg('getStickerSet', { name });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description);
    return data.result;
  });
  const { rows: users } = await query(
    `SELECT * FROM users WHERE group_id IS NOT NULL AND (morning_time IS NOT NULL OR evening_time IS NOT NULL)`
  );
  const { rows: groupChats } = await query(
    `SELECT * FROM group_chats WHERE group_id IS NOT NULL AND (morning_time IS NOT NULL OR evening_time IS NOT NULL)`
  );

  const jobs = [
    ...users.map((u) => [u, {
      chatId: u.telegram_id, platform: u.platform || 'telegram', maxTo: { userId: u.telegram_id },
      logTable: 'sent_log', logIdColumn: 'user_id', table: 'users',
    }]),
    ...groupChats.map((g) => [g, {
      chatId: g.chat_id, platform: g.platform || 'telegram', maxTo: { chatId: g.chat_id },
      logTable: 'group_chat_sent_log', logIdColumn: 'group_chat_id', table: 'group_chats',
    }]),
  ].filter(([, o]) => o.platform !== 'max' || maxEnabled());

  let sentCount = 0;
  let skipped = 0;
  const errors = [];

  // Несколько потоков разбирают общую очередь. Раньше рассылки шли по одной,
  // и 90+ человек получали вечернее расписание 15 минут.
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const [sub, opts] = jobs[next++];
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        skipped++;
        continue;
      }
      const result = await processSubscriber(sub, opts);
      sentCount += result.sent;
      if (result.error) errors.push({ table: opts.logTable, id: sub.id, error: result.error });
    }
  }
  await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));

  // MAX: проверить подписку на вебхук (MAX отписывает бота после 8 часов
  // ошибок; после перевыпуска токена меняется секрет — переподписываемся).
  let max = null;
  if (maxEnabled()) {
    try {
      const fp = maxTokenFingerprint();
      const { rows } = await query(`SELECT value FROM app_secrets WHERE key = 'max_sub_fp'`);
      const force = rows[0]?.value !== fp;
      max = await ensureMaxSubscription({ force });
      if (force && max !== 'skipped') {
        await query(
          `INSERT INTO app_secrets (key, value) VALUES ('max_sub_fp', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [fp]);
      }
    } catch (e) {
      max = `error: ${e.description || e.message || e}`;
      console.error('MAX subscription check failed', e);
    }
  }

  // Остаток времени — на фоновую подгрузку групп с сайта (для поиска преподавателя).
  let preload = null;
  const leftMs = Math.min(PRELOAD_BUDGET_MS, FUNCTION_BUDGET_MS - (Date.now() - startedAt));
  if (leftMs > 9000) { // одна загрузка с сайта — до 8 с
    try {
      preload = await backgroundSync(leftMs);
    } catch (e) {
      console.error('backgroundSync failed', e);
    }
  }

  res.status(200).json({
    ok: true,
    max,
    preload,
    checkedUsers: users.length,
    checkedGroupChats: groupChats.length,
    sent: sentCount,
    deferred: skipped,
    errors,
  });
}
