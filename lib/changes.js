/**
 * Тихое отслеживание изменений расписания на сайте. Студентам ничего не
 * шлём — только копим слепки и сообщаем владельцу, что поменялось.
 *
 * Защита от ложных срабатываний:
 *  - изменение считается настоящим, только если новый вариант повторился при
 *    двух загрузках подряд (schedule_snapshots.pending_digest);
 *  - если разом «пропала» половина дней с парами — это сбой сайта, слепки не трогаем.
 */
import { createHash } from 'node:crypto';
import { query } from './db.js';
import { getActiveTerm, getLessonsForDay } from './schedule.js';
import { nowInTimezone, addDays, isoWeekday, weekParityForDate } from './time.js';
import { notifyOwner } from './ownerAlerts.js';
import { escapeHtml } from './format.js';

const TZ = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';
const WINDOW_DAYS = 14;
const WD = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

async function daySummary(groupId, dateKey) {
  const term = await getActiveTerm(groupId, dateKey);
  if (!term) return '';
  const weekday = isoWeekday(dateKey);
  const lessons = await getLessonsForDay(term.id, weekday, weekParityForDate(dateKey, term.date_start), dateKey, null, { raw: true });
  return lessons
    .map((l) => `${l.time_start} ${l.subject}${l.room ? ` · ${l.room}` : ''}${l.subgroup ? ` (${l.subgroup} подгр.)` : ''}`)
    .join('\n');
}
const hash = (s) => createHash('sha1').update(s).digest('hex');

/** Возвращает подтверждённые изменения [{dateKey, before, after}] и обновляет слепки. */
export async function detectScheduleChanges(groupId) {
  const { rows: [subs] } = await query(
    `SELECT (SELECT count(*) FROM users WHERE group_id = $1) + (SELECT count(*) FROM group_chats WHERE group_id = $1) AS n`, [groupId]);
  if (!Number(subs.n)) return { changes: [], skipped: 'no-subscribers' };

  const start = nowInTimezone(TZ).dateKey;
  const fresh = new Map();
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const dateKey = addDays(start, i);
    fresh.set(dateKey, await daySummary(groupId, dateKey));
  }
  const { rows: snaps } = await query(
    'SELECT * FROM schedule_snapshots WHERE group_id = $1 AND on_date >= $2::date', [groupId, start]);
  const old = new Map(snaps.map((s) => [s.on_date instanceof Date ? s.on_date.toISOString().slice(0, 10) : String(s.on_date).slice(0, 10), s]));

  const baseline = async (dateKey, summary) => query(
    `INSERT INTO schedule_snapshots (group_id, on_date, digest, summary, pending_digest) VALUES ($1, $2, $3, $4, NULL)
     ON CONFLICT (group_id, on_date) DO UPDATE SET digest = EXCLUDED.digest, summary = EXCLUDED.summary, pending_digest = NULL, updated_at = now()`,
    [groupId, dateKey, hash(summary), summary]);

  // Первый раз — просто запоминаем.
  if (old.size === 0) {
    for (const [d, s] of fresh) await baseline(d, s);
    return { changes: [], skipped: 'baseline' };
  }

  // Сбой сайта: половина дней с парами исчезла разом.
  const oldFilled = [...old.values()].filter((s) => s.summary).length;
  const newFilled = [...fresh.entries()].filter(([d, s]) => s && old.has(d)).length;
  if (oldFilled >= 3 && newFilled < oldFilled * 0.5) return { changes: [], skipped: 'glitch' };

  const changes = [];
  for (const [dateKey, summary] of fresh) {
    const prev = old.get(dateKey);
    if (!prev) { await baseline(dateKey, summary); continue; }
    const h = hash(summary);
    if (h === prev.digest) {
      if (prev.pending_digest) await query('UPDATE schedule_snapshots SET pending_digest = NULL WHERE id = $1', [prev.id]);
      continue;
    }
    if (prev.pending_digest === h) {
      changes.push({ dateKey, before: prev.summary || '', after: summary });
      await baseline(dateKey, summary);
    } else {
      await query('UPDATE schedule_snapshots SET pending_digest = $2 WHERE id = $1', [prev.id, h]);
    }
  }
  await query('DELETE FROM schedule_snapshots WHERE group_id = $1 AND on_date < $2::date', [groupId, start]);
  return { changes };
}

export function formatChange(groupName, c) {
  const [, m, d] = c.dateKey.split('-');
  const fmt = (s) => (s ? escapeHtml(s) : '<i>пар нет</i>');
  return `🔔 <b>${escapeHtml(groupName)}</b> · ${WD[isoWeekday(c.dateKey)]} ${d}.${m}\n<b>Было:</b>\n${fmt(c.before)}\n<b>Стало:</b>\n${fmt(c.after)}`;
}

/** Вызывается после загрузки группы. Никогда не бросает исключение. */
export async function reportScheduleChanges(group) {
  try {
    const { changes } = await detectScheduleChanges(group.id);
    if (!changes.length) return 0;
    const head = `📡 Расписание на сайте изменилось (${changes.length}). Студентам не сообщал.\n\n`;
    await notifyOwner(head + changes.slice(0, 8).map((c) => formatChange(group.name, c)).join('\n\n'));
    return changes.length;
  } catch (e) {
    console.error('reportScheduleChanges failed', e.message);
    return 0;
  }
}
