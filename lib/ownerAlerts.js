/**
 * Тихие сообщения владельцу бота: тревоги о сбоях, утренняя сводка,
 * заметки об изменении расписания. Студентам из этого ничего не уходит.
 * Тревоги не чаще раза в час на один вид — чтобы не засыпать.
 */
import { query } from './db.js';

const OWNER_ID = (process.env.ADMIN_TELEGRAM_IDS || '8181483439').split(',')[0].trim();

export async function notifyOwner(text) {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_ID, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
    });
    return resp.ok;
  } catch (e) {
    console.error('notifyOwner failed', e.message);
    return false;
  }
}

async function getSecret(key) {
  const { rows } = await query('SELECT value FROM app_secrets WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
async function setSecret(key, value) {
  await query(
    `INSERT INTO app_secrets (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]);
}

/** Тревога о сбое: не чаще раза в cooldownMin минут на один kind. */
export async function alertOwner(kind, text, { cooldownMin = 60 } = {}) {
  try {
    const last = Number(await getSecret(`alert_last:${kind}`)) || 0;
    if (Date.now() - last < cooldownMin * 60_000) return false;
    // Сначала занимаем слот (даже если отправка не удастся — не долбим каждые 5 минут).
    await setSecret(`alert_last:${kind}`, Date.now());
    return await notifyOwner(`🚨 <b>${kind}</b>\n${text}`);
  } catch (e) {
    console.error('alertOwner failed', e.message);
    return false;
  }
}

/** Счётчик тревог за сутки — попадает в утреннюю сводку. */
export async function countAlertDay(dateKey) {
  try {
    const key = `alerts_count:${dateKey}`;
    await setSecret(key, (Number(await getSecret(key)) || 0) + 1);
  } catch { /* не критично */ }
}

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  return b >= 2 && b <= 4 ? few : many;
};

/**
 * Утренняя сводка: раз в сутки после SUMMARY_HOUR по времени бота.
 * Занимаем слот атомарно (INSERT ... ON CONFLICT DO NOTHING), чтобы два тика не прислали дважды.
 */
export async function maybeSendMorningSummary({ dateKey, hhmm, hour = 8 }) {
  if (Number(hhmm.slice(0, 2)) < hour) return false;
  const { rows } = await query(
    `INSERT INTO app_secrets (key, value) VALUES ('summary_date', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE app_secrets.value <> EXCLUDED.value
     RETURNING key`, [dateKey]);
  if (!rows.length) return false;

  const { rows: [u] } = await query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE group_id IS NOT NULL)::int with_group,
            count(*) FILTER (WHERE platform = 'max')::int max_users,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int new_day,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours' AND invited_by IS NOT NULL)::int new_invited,
            count(*) FILTER (WHERE blocked_at IS NOT NULL)::int blocked,
            count(*) FILTER (WHERE blocked_at > now() - interval '24 hours')::int blocked_day
     FROM users`);
  const { rows: [d] } = await query(
    `SELECT (SELECT count(*) FROM sent_log WHERE sent_at > now() - interval '24 hours')::int a,
            (SELECT count(*) FROM group_chat_sent_log WHERE sent_at > now() - interval '24 hours')::int b`);
  const { rows: [g] } = await query(
    `SELECT count(*)::int total, count(*) FILTER (WHERE sync_error IS NOT NULL)::int broken FROM groups WHERE source_key IS NOT NULL`);
  const alerts = Number(await getSecret(`alerts_count:${await prevDay(dateKey)}`)) || 0;

  const lines = [
    '☀️ <b>Сводка за сутки</b>',
    '',
    `👤 Пользователей: ${u.total} (с группой ${u.with_group}, в MAX ${u.max_users})`,
    `🆕 Новых за сутки: ${u.new_day}${u.new_invited ? ` (по приглашениям: ${u.new_invited})` : ''}`,
    `📨 Рассылок доставлено за сутки: ${d.a + d.b}`,
    u.blocked_day ? `🚫 Заблокировали бота за сутки: ${u.blocked_day} (всего ${u.blocked})` : null,
    `📚 Групп с сайта: ${g.total}${g.broken ? `, с ошибкой загрузки: ${g.broken}` : ''}`,
    alerts ? `⚠️ Тревог было: ${alerts}` : '✅ Тревог не было',
  ].filter((x) => x !== null);
  await notifyOwner(lines.join('\n'));
  return true;
}

async function prevDay(dateKey) {
  const dt = new Date(`${dateKey}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
export { plural };
