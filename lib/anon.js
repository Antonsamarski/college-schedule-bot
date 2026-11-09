/**
 * Анонимки: владелец открывает «окно» на пару часов, в это время люди пишут друг
 * другу анонимно по личным ссылкам. Фильтра слов нет — только защита от спама и
 * инструменты против травли: получатель блокирует отправителя или жалуется,
 * владелец видит автора жалобы-сообщения и может забанить.
 */
import { randomBytes } from 'node:crypto';
import { query } from './db.js';
import { maxEnabled, maxSend } from './max.js';

const WINDOW_KEY = 'anon_until';
export const ANON_MAX_LEN = 1000;
const PER_WINDOW = 30; // сообщений от одного человека за одно окно
const PER_PAIR = 10;   // одному и тому же получателю за одно окно

export async function anonWindow() {
  const { rows: [r] } = await query(`SELECT value FROM app_settings WHERE key = $1`, [WINDOW_KEY]);
  const until = r ? new Date(r.value) : null;
  const open = Boolean(until && until.getTime() > Date.now());
  return { open, until: open ? until : null, lastUntil: until };
}

export async function openAnonWindow(hours) {
  const until = new Date(Date.now() + hours * 3_600_000);
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [WINDOW_KEY, until.toISOString()]);
  return until;
}

export async function closeAnonWindow() {
  await query(`UPDATE app_settings SET value = $2 WHERE key = $1`, [WINDOW_KEY, new Date(0).toISOString()]);
}

/** Личный код пользователя для ссылки (создаём при первом обращении). */
export async function getAnonCode(userId) {
  const { rows: [u] } = await query('SELECT anon_code FROM users WHERE id = $1', [userId]);
  if (u?.anon_code) return u.anon_code;
  for (let i = 0; i < 5; i++) {
    const code = randomBytes(6).toString('base64url'); // 8 символов, влезает в deep-link
    try {
      const { rows: [r] } = await query(
        'UPDATE users SET anon_code = $1 WHERE id = $2 AND anon_code IS NULL RETURNING anon_code', [code, userId]);
      if (r) return r.anon_code;
      return (await query('SELECT anon_code FROM users WHERE id = $1', [userId])).rows[0].anon_code;
    } catch (e) {
      if (e.code !== '23505') throw e; // коллизия кода — пробуем другой
    }
  }
  throw new Error('anon code collision');
}

export async function findUserByCode(code) {
  if (!/^[A-Za-z0-9_-]{6,16}$/.test(code || '')) return null;
  const { rows: [u] } = await query('SELECT * FROM users WHERE anon_code = $1', [code]);
  return u || null;
}

/** Можно ли from писать to прямо сейчас: баны, блокировки, лимиты. */
export async function canSendAnon(fromId, toId, until) {
  if (fromId === toId) return { ok: false, reason: 'self' };
  const { rows: [ban] } = await query('SELECT 1 FROM anon_bans WHERE user_id = $1', [fromId]);
  if (ban) return { ok: false, reason: 'banned' };
  const { rows: [{ total, pair }] } = await query(
    `SELECT count(*)::int total, count(*) FILTER (WHERE to_user = $2)::int pair
     FROM anon_messages WHERE from_user = $1 AND window_until = $3`, [fromId, toId, until]);
  if (total >= PER_WINDOW) return { ok: false, reason: 'limit' };
  if (pair >= PER_PAIR) return { ok: false, reason: 'pair' };
  const { rows: [blk] } = await query('SELECT 1 FROM anon_blocks WHERE blocker = $1 AND blocked = $2', [toId, fromId]);
  // Заблокированному не говорим: сообщение «уходит», но не доставляется.
  return { ok: true, suppressed: Boolean(blk) };
}

export async function recordAnon({ fromId, toId, body, until, replyTo = null, suppressed = false }) {
  const { rows: [m] } = await query(
    `INSERT INTO anon_messages (from_user, to_user, reply_to, body, window_until, suppressed)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [fromId, toId, replyTo, body, until, suppressed]);
  return m;
}

export async function markDelivered(id) {
  await query('UPDATE anon_messages SET delivered = true WHERE id = $1', [id]);
}

export async function getAnonMessage(id) {
  const { rows: [m] } = await query(
    `SELECT m.*, f.platform AS from_platform, f.telegram_id AS from_tg, f.username AS from_username
     FROM anon_messages m JOIN users f ON f.id = m.from_user WHERE m.id = $1`, [id]);
  return m || null;
}

export async function blockSender(blockerId, blockedId) {
  await query('INSERT INTO anon_blocks (blocker, blocked) VALUES ($1, $2) ON CONFLICT DO NOTHING', [blockerId, blockedId]);
}

export async function markReported(id) {
  await query('UPDATE anon_messages SET reported = true WHERE id = $1', [id]);
}

export async function banAnonUser(userId) {
  await query('INSERT INTO anon_bans (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
}

export async function anonStats(userId, until) {
  const { rows: [r] } = await query(
    `SELECT count(*) FILTER (WHERE to_user = $1 AND window_until = $2 AND NOT suppressed)::int got,
            count(*) FILTER (WHERE from_user = $1 AND window_until = $2)::int sent
     FROM anon_messages`, [userId, until]);
  return r;
}

export async function anonAdminStats(until) {
  const { rows: [r] } = await query(
    `SELECT count(*)::int total, count(DISTINCT from_user)::int senders,
            count(*) FILTER (WHERE reported)::int reports
     FROM anon_messages WHERE window_until = $1`, [until]);
  const { rows: [b] } = await query('SELECT count(*)::int n FROM anon_bans');
  return { ...r, bans: b.n };
}

/** Доставка пользователю в его мессенджер. { ok, blocked }. */
export async function deliverTo(user, text, kb) {
  try {
    if (user.platform === 'max') {
      if (!maxEnabled()) return { ok: false };
      await maxSend({ userId: user.telegram_id }, text, kb);
      return { ok: true };
    }
    const resp = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: user.telegram_id, text, parse_mode: 'HTML', reply_markup: kb,
        link_preview_options: { is_disabled: true },
      }),
    });
    return { ok: resp.ok, blocked: resp.status === 403 };
  } catch (e) {
    return { ok: false, blocked: e?.status === 403 || e?.status === 404 };
  }
}
