/**
 * Статус «сейчас» для расписания на сегодня: сколько минут до конца пары,
 * когда следующая, закончились ли пары. Показывается строкой над парами
 * в обычном расписании на сегодня (lib/digest.js → buildDateView).
 */
import { query } from './db.js';
import { maxUnpin } from './max.js';

const hhmmToMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

export function humanMinutes(m) {
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60); const r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}

/** Статус «сейчас» по списку пар дня. nowHHMM — "10:05". */
export function liveStatus(lessons, nowHHMM) {
  const nowMin = hhmmToMin(nowHHMM);
  const live = lessons.filter((l) => !String(l.subject).startsWith('❌ ОТМЕНА'));
  if (!live.length) return { kind: 'free', text: '🟢 Сегодня пар нет' };
  const slots = [...new Map(live.map((l) => [l.time_start, l])).values()]
    .map((l) => ({ start: hhmmToMin(l.time_start), end: l.time_end ? hhmmToMin(l.time_end) : hhmmToMin(l.time_start) + 90 }))
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

/**
 * Разовая уборка: раньше была кнопка «Живое расписание» с закреплённым
 * сообщением. Откреплять и удалять такие сообщения нужно один раз.
 */
export async function clearLegacyPins() {
  const { rows } = await query(`SELECT id, platform, telegram_id, state->'pin' AS pin FROM users WHERE state ? 'pin'`);
  let n = 0;
  for (const u of rows) {
    const pin = u.pin || {};
    try {
      if (u.platform === 'max') {
        if (pin.chatId) await maxUnpin(pin.chatId).catch(() => {});
      } else if (pin.mid) {
        const call = (m, body) => fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${m}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        await call('unpinChatMessage', { chat_id: u.telegram_id, message_id: pin.mid });
        await call('deleteMessage', { chat_id: u.telegram_id, message_id: pin.mid });
      }
    } catch (e) { console.error('legacy pin cleanup failed', u.id, e.message); }
    await query(`UPDATE users SET state = state - 'pin' WHERE id = $1`, [u.id]);
    n++;
  }
  return n;
}
