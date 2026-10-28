/**
 * «Живое расписание»: сообщение закреплено в чате с ботом, а бот каждые
 * несколько минут (тик планировщика) правит его: идёт пара — сколько минут
 * до конца, перерыв — когда следующая, пары кончились — «на сегодня всё».
 * Состояние хранится в users.state.pin = { mid, chatId, hash }.
 */
import { createHash } from 'node:crypto';
import { query } from './db.js';
import { getActiveTerm, getLessonsForDay, groupHasSubgroups } from './schedule.js';
import { formatDaySchedule } from './format.js';
import { nowInTimezone, formatHumanDate, weekParityForDate } from './time.js';
import { hasFeature } from './features.js';
import { maxEdit } from './max.js';
import { hasCustomEmoji, stripCustomEmoji } from './icons.js';

const OWNER_ID = (process.env.ADMIN_TELEGRAM_IDS || '8181483439').split(',')[0].trim();
const hhmmToMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

export function humanMinutes(m) {
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60); const r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}

/** Статус «сейчас» по списку пар дня. nowMin — минуты от полуночи. */
export function liveStatus(lessons, nowMin) {
  const live = lessons.filter((l) => !String(l.subject).startsWith('❌ ОТМЕНА'));
  if (!live.length) return { kind: 'free', text: '🟢 Сегодня пар нет' };
  const slots = [...new Map(live.map((l) => [l.time_start, l])).values()]
    .map((l) => ({ start: hhmmToMin(l.time_start), end: l.time_end ? hhmmToMin(l.time_end) : hhmmToMin(l.time_start) + 90, l }))
    .sort((a, b) => a.start - b.start);
  const cur = slots.find((s) => nowMin >= s.start && nowMin < s.end);
  if (cur) return { kind: 'now', text: `⏱ <b>До конца пары: ${humanMinutes(cur.end - nowMin)}</b>` };
  const next = slots.find((s) => s.start > nowMin);
  if (!next) return { kind: 'done', text: '🏁 <b>На сегодня пары закончились</b>' };
  const wait = next.start - nowMin;
  return slots.some((s) => s.end <= nowMin)
    ? { kind: 'break', text: `☕ <b>Перерыв</b> — следующая в ${hm(next.start)} (через ${humanMinutes(wait)})` }
    : { kind: 'before', text: `⏳ <b>Первая пара в ${hm(next.start)}</b> (через ${humanMinutes(wait)})` };
}

/** Текст закрепа для подписчика (строка users). Сайт здесь не дёргаем — расписание обновляет тик. */
export async function buildLiveText(sub) {
  const now = nowInTimezone(sub.timezone);
  const term = await getActiveTerm(sub.group_id, now.dateKey);
  if (!term) return '📌 <b>ЖИВОЕ РАСПИСАНИЕ</b>\n\n<b>Каникулы</b>\nНа сегодня в расписании нет семестра.';
  const subgroup = sub.subgroup && (await groupHasSubgroups(sub.group_id)) ? sub.subgroup : null;
  const parity = weekParityForDate(now.dateKey, term.date_start);
  const lessons = await getLessonsForDay(term.id, now.weekdayIso, parity, now.dateKey, subgroup);
  const st = liveStatus(lessons, hhmmToMin(now.hhmm));
  const body = formatDaySchedule({
    kind: 'date', dateLabel: formatHumanDate(now.dateKey, now.weekdayIso), relLabel: 'сегодня',
    lessons, weekParity: parity, subgroup, nowHHMM: now.hhmm,
  });
  return `📌 <b>ЖИВОЕ РАСПИСАНИЕ</b>\n${st.text}\n\n${body}`;
}

export const textHash = (t) => createHash('sha1').update(t).digest('hex');

async function tgEdit(chatId, mid, text) {
  const call = (t) => fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/editMessageText`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: mid, text: t, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  });
  let r = await call(text);
  if (r.status === 400 && hasCustomEmoji(text)) r = await call(stripCustomEmoji(text));
  if (r.ok) return 'ok';
  const body = await r.text().catch(() => '');
  if (r.status === 400 && /not modified/i.test(body)) return 'ok';
  if (r.status === 403 || (r.status === 400 && /not found|can't be edited|MESSAGE_ID_INVALID/i.test(body))) return 'gone';
  return 'retry'; // 429 / 5xx — попробуем на следующем тике
}

async function updateOne(u) {
  const pin = u.state?.pin;
  if (!pin?.mid) return 'skip';
  const text = await buildLiveText(u);
  const hash = textHash(text);
  if (hash === pin.hash) return 'same';
  let res;
  try {
    if (u.platform === 'max') { await maxEdit(pin.mid, text); res = 'ok'; }
    else res = await tgEdit(u.telegram_id, pin.mid, text);
  } catch (e) {
    res = e?.status === 404 || e?.status === 403 ? 'gone' : 'retry';
  }
  if (res === 'ok') {
    await query(`UPDATE users SET state = jsonb_set(state, '{pin,hash}', to_jsonb($1::text)) WHERE id = $2`, [hash, u.id]);
    return 'edited';
  }
  if (res === 'gone') {
    await query(`UPDATE users SET state = state - 'pin' WHERE id = $1`, [u.id]);
    return 'removed';
  }
  return 'retry';
}

/** Обновить все живые закрепы. deadline — Date.now()-метка, после которой не начинаем новые. */
export async function updatePins(deadline) {
  const { rows } = await query(
    `SELECT * FROM users WHERE state ? 'pin' AND group_id IS NOT NULL AND blocked_at IS NULL ORDER BY id`);
  const out = { edited: 0, same: 0, removed: 0, retry: 0, skipped: 0 };
  const queue = [];
  for (const u of rows) {
    const isOwner = u.platform === 'telegram' && String(u.telegram_id) === OWNER_ID;
    if (await hasFeature('pinned', { platform: u.platform, userId: u.telegram_id, isOwner })) queue.push(u);
    else out.skipped++;
  }
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      if (Date.now() > deadline) { out.skipped++; continue; }
      try {
        const r = await updateOne(u);
        if (r in out) out[r]++;
      } catch (e) { console.error('pin update failed', u.id, e.message); out.retry++; }
    }
  }));
  return out;
}
