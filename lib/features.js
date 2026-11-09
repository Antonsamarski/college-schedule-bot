/**
 * Бета-режим, бета-тестеры, старосты и приглашения-ссылки.
 *
 * У каждой новой функции три состояния (feature_flags.state):
 *   off  — выключена у всех;
 *   beta — видят владелец бота и бета-тестеры;
 *   all  — видят все.
 * Переключается через /admin, без передеплоя.
 */
import { randomBytes } from 'node:crypto';
import { query } from './db.js';

// Список функций, которыми управляет /admin: ключ -> подпись.
export const FEATURES = {
  invite: 'Позвать одногруппников',
  anon: 'Анонимки',
};

let flagCache = null;
let flagCacheAt = 0;
const FLAG_TTL_MS = 30_000;

async function loadFlags() {
  const now = Date.now();
  if (flagCache && now - flagCacheAt < FLAG_TTL_MS) return flagCache;
  const { rows } = await query('SELECT key, state FROM feature_flags');
  flagCache = Object.fromEntries(rows.map((r) => [r.key, r.state]));
  flagCacheAt = now;
  return flagCache;
}

export function clearFlagCache() { flagCache = null; }

export async function featureState(key) {
  const flags = await loadFlags();
  return flags[key] || 'off';
}

export async function setFeatureState(key, state) {
  await query(
    `INSERT INTO feature_flags (key, state, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [key, state]
  );
  clearFlagCache();
}

export async function isBetaTester(platform, userId) {
  const { rows } = await query(
    'SELECT 1 FROM beta_testers WHERE platform = $1 AND user_id = $2', [platform, userId]);
  return rows.length > 0;
}

/**
 * Доступна ли функция этому пользователю.
 * isOwner — владелец бота (ADMIN_*): видит всё всегда.
 */
export async function hasFeature(key, { platform, userId, isOwner }) {
  const state = await featureState(key);
  if (state === 'all') return true;
  if (state === 'off') return Boolean(isOwner); // владельцу показываем даже выключенное — для проверки
  // beta:
  if (isOwner) return true;
  return isBetaTester(platform, userId);
}

export async function addBetaTester(platform, userId) {
  await query(
    `INSERT INTO beta_testers (platform, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [platform, userId]);
}

export async function removeBetaTester(platform, userId) {
  await query('DELETE FROM beta_testers WHERE platform = $1 AND user_id = $2', [platform, userId]);
}

export async function listBetaTesters() {
  const { rows } = await query('SELECT platform, user_id, added_at FROM beta_testers ORDER BY added_at');
  return rows;
}

// ---------- приглашения-ссылки ----------

const token = () => randomBytes(9).toString('base64url'); // 12 символов, влезает в deep-link

/** kind: 'group' | 'beta'. Возвращает токен для deep-link. */
export async function createInvite({ kind, groupId = null, createdBy = null, maxUses = null, expiresAt = null }) {
  const t = token();
  await query(
    `INSERT INTO invites (token, kind, group_id, created_by, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [t, kind, groupId, createdBy, maxUses, expiresAt]);
  return t;
}

/** Берёт приглашение по токену, если оно ещё действует. Иначе null. */
export async function getValidInvite(tokenStr) {
  if (!tokenStr) return null;
  const { rows } = await query('SELECT * FROM invites WHERE token = $1', [tokenStr]);
  const inv = rows[0];
  if (!inv) return null;
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return null;
  if (inv.max_uses != null && inv.uses >= inv.max_uses) return null;
  return inv;
}

export async function markInviteUsed(tokenStr) {
  await query('UPDATE invites SET uses = uses + 1 WHERE token = $1', [tokenStr]);
}

/** Сколько человек пришло по приглашениям (для статистики, без имён). */
export async function inviteStats() {
  const { rows } = await query(
    `SELECT i.kind, count(u.id)::int AS people
     FROM invites i LEFT JOIN users u ON u.invited_by = i.token
     GROUP BY i.kind`);
  return Object.fromEntries(rows.map((r) => [r.kind, r.people]));
}
