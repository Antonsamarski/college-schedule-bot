/**
 * Рассылка от владельца бота (только личные чаты людей, не групповые).
 * Прогресс хранится в broadcasts.cursor_id, поэтому если за один заход
 * (лимит функции) всем не отправили — досылаем кнопкой «Продолжить».
 * Кто заблокировал бота (403 в Telegram) — помечается users.blocked_at
 * и в следующих рассылках не участвует.
 */
import { query } from './db.js';
import { maxSend, maxEnabled, maxUploadImage } from './max.js';
import { hasCustomEmoji, stripCustomEmoji } from './icons.js';

const CONCURRENCY = 5;
const DEFAULT_BUDGET_MS = 15_000;

export const AUDIENCE_LABEL = {
  all: 'все пользователи',
  telegram: 'только Telegram',
  max: 'только MAX',
  testers: 'только бета-тестеры',
};

/** WHERE-условие и параметры для аудитории. Алиас таблицы users — u. */
function audienceWhere(aud, startIndex = 1) {
  const params = [];
  const conds = ['u.blocked_at IS NULL'];
  if (aud.type === 'telegram') { params.push('telegram'); conds.push(`u.platform = $${startIndex + params.length - 1}`); }
  if (aud.type === 'max') { params.push('max'); conds.push(`u.platform = $${startIndex + params.length - 1}`); }
  if (aud.type === 'testers') {
    conds.push('EXISTS (SELECT 1 FROM beta_testers b WHERE b.platform = u.platform AND b.user_id = u.telegram_id)');
  }
  if (aud.type === 'group') { params.push(Number(aud.groupId)); conds.push(`u.group_id = $${startIndex + params.length - 1}`); }
  return { where: conds.join(' AND '), params };
}

export async function audienceLabel(aud) {
  if (aud.type === 'group') {
    const { rows } = await query('SELECT name FROM groups WHERE id = $1', [aud.groupId]);
    return `группа ${rows[0]?.name || aud.groupId}`;
  }
  return AUDIENCE_LABEL[aud.type] || aud.type;
}

export async function countAudience(aud) {
  const { where, params } = audienceWhere(aud);
  const { rows } = await query(`SELECT count(*)::int AS n FROM users u WHERE ${where}`, params);
  return rows[0].n;
}

export async function createBroadcast(aud, body, createdBy, photoFileId = null) {
  const total = await countAudience(aud);
  const { rows } = await query(
    'INSERT INTO broadcasts (audience, body, created_by, total, photo_file_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [JSON.stringify(aud), body, createdBy, total, photoFileId]);
  return rows[0];
}

export async function getBroadcast(id) {
  const { rows } = await query('SELECT * FROM broadcasts WHERE id = $1', [id]);
  return rows[0] || null;
}

async function sendTelegram(chatId, text, photo) {
  const method = photo ? 'sendPhoto' : 'sendMessage';
  const call = (t) => fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(photo
      ? { chat_id: chatId, photo, caption: t || undefined, parse_mode: 'HTML' }
      : { chat_id: chatId, text: t, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  });
  let resp = await call(text);
  if (resp.status === 429) { await new Promise((r) => setTimeout(r, 1100)); resp = await call(text); }
  if (resp.status === 400 && hasCustomEmoji(text)) resp = await call(stripCustomEmoji(text));
  if (resp.ok) return { ok: true };
  return { ok: false, blocked: resp.status === 403 };
}

/** Фото для MAX: скачиваем из Telegram по file_id и загружаем в MAX (один раз на заход). */
async function prepareMaxImage(fileId) {
  const base = `https://api.telegram.org`;
  const info = await (await fetch(`${base}/bot${process.env.BOT_TOKEN}/getFile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId }),
  })).json();
  if (!info.ok) throw new Error(`getFile: ${info.description}`);
  const file = await fetch(`${base}/file/bot${process.env.BOT_TOKEN}/${info.result.file_path}`);
  if (!file.ok) throw new Error(`download: ${file.status}`);
  return maxUploadImage(Buffer.from(await file.arrayBuffer()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendOne(user, text, photo, maxToken) {
  try {
    if (user.platform === 'max') {
      if (!maxEnabled()) return { ok: false };
      const to = { userId: user.telegram_id };
      if (photo && maxToken) {
        // Только что загруженная картинка бывает «ещё не готова» — повторяем.
        for (let i = 0; i < 3; i++) {
          try {
            await maxSend(to, text, undefined, { attachments: [{ type: 'image', payload: { token: maxToken } }] });
            return { ok: true };
          } catch (e) {
            if (e?.status === 403 || e?.status === 404) throw e;
            if (i < 2 && /not\.?ready|processing/i.test(String(e?.description || e?.data?.code || ''))) { await sleep(1500); continue; }
            break; // не вышло с картинкой — отправим хотя бы текст
          }
        }
      }
      if (!text) return { ok: false };
      await maxSend(to, text);
      return { ok: true };
    }
    return await sendTelegram(user.telegram_id, text, photo);
  } catch (e) {
    // MAX: 403/404 — пользователь закрыл диалог с ботом.
    return { ok: false, blocked: e?.status === 403 || e?.status === 404 };
  }
}

/**
 * Отправить очередную порцию рассылки. Возвращает актуальную строку broadcasts.
 * Останавливается по бюджету времени; done=true, когда получатели закончились.
 */
export async function runBroadcast(id, { budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const started = Date.now();
  let b = await getBroadcast(id);
  if (!b || b.done) return b;
  const { where, params } = audienceWhere(b.audience, 2);
  let sent = 0; let failed = 0; let cursor = b.cursor_id; let finished = false;
  let maxImage; // токен картинки в MAX: undefined — ещё не готовили, null — не вышло

  while (Date.now() - started < budgetMs) {
    const { rows: batch } = await query(
      `SELECT u.id, u.platform, u.telegram_id FROM users u
       WHERE u.id > $1 AND ${where} ORDER BY u.id LIMIT ${CONCURRENCY * 4}`,
      [cursor, ...params]);
    if (!batch.length) { finished = true; break; }
    if (b.photo_file_id && maxImage === undefined && maxEnabled() && batch.some((u) => u.platform === 'max')) {
      try { maxImage = await prepareMaxImage(b.photo_file_id); } catch (e) { console.error('MAX image upload failed', e.message); maxImage = null; }
    }
    const queue = [...batch];
    const results = [];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (let u = queue.shift(); u; u = queue.shift()) results.push({ u, r: await sendOne(u, b.body, b.photo_file_id, maxImage) });
    }));
    const blockedIds = [];
    for (const { u, r } of results) {
      if (r.ok) sent++; else { failed++; if (r.blocked) blockedIds.push(u.id); }
    }
    if (blockedIds.length) await query('UPDATE users SET blocked_at = now() WHERE id = ANY($1::int[])', [blockedIds]);
    cursor = batch[batch.length - 1].id;
  }

  const { rows } = await query(
    `UPDATE broadcasts SET sent = sent + $2, failed = failed + $3, cursor_id = $4, done = $5 WHERE id = $1 RETURNING *`,
    [id, sent, failed, cursor, finished]);
  return rows[0];
}
