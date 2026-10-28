/**
 * Староста группы: правки расписания на день (отмена пары, другая аудитория),
 * журнал действий и лимиты. Сами экраны — в lib/bot.js.
 *
 * Правки хранятся в lesson_overrides и накладываются поверх расписания с
 * сайта (lib/schedule.js → applyOverrides), поэтому после очередной загрузки
 * с сайта они не пропадают. Каждое действие попадает в staff_log, а владельцу
 * приходит тихое уведомление.
 */
import { query } from './db.js';
import { createInvite } from './features.js';
import { getActiveTerm, getLessonsForDay } from './schedule.js';
import { isoWeekday, weekParityForDate } from './time.js';
import { notifyOwner } from './ownerAlerts.js';
import { escapeHtml } from './format.js';

export const LIMITS = { announcePerDay: 3, editsPerDay: 10, announceChars: 700 };

export function createStaffInvite(groupId, createdBy) {
  return createInvite({
    kind: 'staff', groupId, createdBy, maxUses: 1,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
  });
}

export async function staffOfGroup(groupId) {
  const { rows } = await query('SELECT platform, user_id, added_at FROM staff WHERE group_id = $1 ORDER BY added_at', [groupId]);
  return rows;
}

/** Группы, где есть подписчики (из них владелец выбирает, где назначить старосту). */
export async function groupsWithSubscribers(limit = 40) {
  const { rows } = await query(
    `SELECT g.id, g.name, (SELECT count(*) FROM users u WHERE u.group_id = g.id)::int AS people,
            (SELECT count(*) FROM staff s WHERE s.group_id = g.id)::int AS staff
     FROM groups g WHERE EXISTS (SELECT 1 FROM users u WHERE u.group_id = g.id)
     ORDER BY people DESC, g.name LIMIT $1`, [limit]);
  return rows;
}

export async function countRecent(groupId, actions) {
  const { rows } = await query(
    `SELECT count(*)::int n FROM staff_log WHERE group_id = $1 AND action = ANY($2) AND created_at > now() - interval '24 hours'`,
    [groupId, actions]);
  return rows[0].n;
}

export async function logStaff({ groupId, platform, actorId, action, detail, recipients = null, overrideId = null }) {
  await query(
    `INSERT INTO staff_log (group_id, actor_platform, actor_id, action, detail, recipients, override_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [groupId, platform, actorId, action, detail, recipients, overrideId]);
}

export async function recentLog(groupId, limit = 10) {
  const { rows } = await query('SELECT * FROM staff_log WHERE group_id = $1 ORDER BY id DESC LIMIT $2', [groupId, limit]);
  return rows;
}

/** Пары дня «как на сайте» (без правок) — из них староста выбирает, что менять. */
export async function rawLessons(groupId, dateKey) {
  const term = await getActiveTerm(groupId, dateKey);
  if (!term) return [];
  const rows = await getLessonsForDay(term.id, isoWeekday(dateKey), weekParityForDate(dateKey, term.date_start), dateKey, null, { raw: true });
  const seen = new Set();
  return rows.filter((l) => (seen.has(l.time_start) ? false : seen.add(l.time_start)));
}

/** Сохранить правку (заменяет прежнюю на ту же пару). Возвращает её id. */
export async function setOverride({ groupId, dateKey, timeStart, action, newRoom = null, createdBy }) {
  await query('DELETE FROM lesson_overrides WHERE group_id = $1 AND on_date = $2::date AND time_start = $3', [groupId, dateKey, timeStart]);
  const { rows } = await query(
    `INSERT INTO lesson_overrides (group_id, on_date, time_start, action, new_room, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [groupId, dateKey, timeStart, action, newRoom, createdBy]);
  return rows[0].id;
}

export async function getOverride(id, groupId) {
  const { rows } = await query('SELECT * FROM lesson_overrides WHERE id = $1 AND group_id = $2', [id, groupId]);
  return rows[0] || null;
}

export async function removeOverride(id, groupId) {
  const { rowCount } = await query('DELETE FROM lesson_overrides WHERE id = $1 AND group_id = $2', [id, groupId]);
  return rowCount > 0;
}

export async function activeOverrides(groupId, fromDate) {
  const { rows } = await query(
    `SELECT * FROM lesson_overrides WHERE group_id = $1 AND on_date >= $2::date ORDER BY on_date, time_start`, [groupId, fromDate]);
  return rows;
}

/** Тихое уведомление владельцу о любом действии старосты. */
export async function tellOwner(groupName, platform, actorId, text) {
  await notifyOwner(`👑 <b>${escapeHtml(groupName)}</b> · староста ${platform} ${actorId}\n${text}`);
}
