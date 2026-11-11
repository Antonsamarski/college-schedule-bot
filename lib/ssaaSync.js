/**
 * Перенос расписания с ssaa.ru в базу бота и его автоматическое обновление.
 *
 * Группа, выбранная "с сайта", хранит в groups.source_params параметры для
 * запроса. Перед тем как показать или разослать расписание, вызывается
 * ensureGroupFresh(): если с прошлой загрузки прошло больше SYNC_TTL,
 * расписание перекачивается. Ошибка сайта ничего не ломает — бот просто
 * показывает то, что уже сохранено, а ошибка пишется в groups.sync_error.
 */
import { query, getPool } from './db.js';
import { fetchSsaaGroups, fetchSsaaLessons } from './ssaa.js';
import { reportScheduleChanges } from './changes.js';

const SYNC_TTL_MS = Number(process.env.SSAA_SYNC_HOURS || 6) * 3600_000;
// Если сайт лежит — не пытаемся на каждом сообщении, а ждём 20 минут.
const RETRY_AFTER_ERROR_MS = 20 * 60_000;
// Группы, у которых есть подписчики, обновляем чаще — чтобы вовремя замечать правки на сайте.
const SUBSCRIBED_TTL_MS = Number(process.env.SSAA_SUBSCRIBED_SYNC_MIN || 60) * 60_000;
const HAS_SUBS_SQL = `((SELECT count(*) FROM users WHERE group_id = groups.id) + (SELECT count(*) FROM group_chats WHERE group_id = groups.id)) > 0`;
// Сколько максимум ждём обновления перед ответом пользователю. Если сайт
// тормозит — показываем уже сохранённое расписание, не заставляя ждать.
const FRESH_WAIT_MS = 5000;
const MAX_PERIODS_PER_SYNC = 3;

function mondayOf(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() - (dow - 1));
  return dt.toISOString().slice(0, 10);
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function shortDate(dateKey) {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}

/** "Осень 2026" / "Весна 2027", а для коротких периодов (сессии) — "Сессия 26 окт – 14 ноя". */
export function termNameForPeriod(p) {
  const days = (Date.parse(p.dateEnd) - Date.parse(p.dateStart)) / 86_400_000;
  if (days < 50) return `Сессия ${shortDate(p.dateStart)} – ${shortDate(p.dateEnd)}`;
  const [y, m] = p.dateStart.split('-').map(Number);
  return m >= 7 ? `Осень ${y}` : `Весна ${y}`;
}

/**
 * Границы семестра в базе. Начало сдвигаем на понедельник первой "1-й
 * недели" — тогда бейджик "1-я/2-я неделя" совпадает с сайтом.
 */
export function termBounds(period, lessons) {
  const all = lessons.flatMap((l) => l.dates);
  const week1 = lessons.filter((l) => l.week === 1).flatMap((l) => l.dates).sort();
  const starts = [period.dateStart, week1[0] && mondayOf(week1[0]), ...all].filter(Boolean).sort();
  const ends = [period.dateEnd, ...all].filter(Boolean).sort();
  return { dateStart: starts[0], dateEnd: ends[ends.length - 1] };
}

async function saveTerm(client, groupId, period, lessons) {
  const { dateStart, dateEnd } = termBounds(period, lessons);
  const name = termNameForPeriod(period);

  const { rows } = await client.query(
    `INSERT INTO terms (group_id, name, date_start, date_end, source_period)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (group_id, source_period) WHERE source_period IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name, date_start = EXCLUDED.date_start, date_end = EXCLUDED.date_end
     RETURNING id`,
    [groupId, name, dateStart, dateEnd, period.period]
  );
  const termId = rows[0].id;

  await client.query('DELETE FROM lessons WHERE term_id = $1', [termId]);
  if (lessons.length === 0) return termId;

  const positions = {};
  const values = [];
  const params = [];
  for (const l of lessons) {
    const k = `${l.week}_${l.weekday}`;
    positions[k] = (positions[k] || 0) + 1;
    const base = params.length;
    params.push(
      termId, l.weekday, ((((Number(l.week) || 1) - 1) % 2) + 1), positions[k], l.time_start, l.time_end,
      l.subject, l.room, l.teacher, l.subgroup, l.lesson_type, l.dates.length ? l.dates : null
    );
    values.push(`(${Array.from({ length: 12 }, (_, i) => `$${base + i + 1}`).join(',')})`);
  }
  await client.query(
    `INSERT INTO lessons (term_id, weekday, week_parity, position, time_start, time_end,
                          subject, room, teacher, subgroup, lesson_type, dates)
     VALUES ${values.join(',')}`,
    params
  );
  return termId;
}

/** Загружает с сайта все периоды группы (до MAX_PERIODS_PER_SYNC) и сохраняет. */
export async function syncGroup(group) {
  const src = group.source_params;
  if (!src) return { skipped: true };

  const all = await fetchSsaaGroups();
  const periods = all
    .filter((g) => g.key === group.source_key)
    .sort((a, b) => String(b.dateEnd).localeCompare(String(a.dateEnd)))
    .slice(0, MAX_PERIODS_PER_SYNC);
  if (periods.length === 0) {
    throw new Error('Группы больше нет в расписании на сайте');
  }

  // Качаем параллельно — у serverless-функции всего 10 секунд.
  const fetched = await Promise.all(periods.map(async (p) => ({ p, lessons: await fetchSsaaLessons(p) })));

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const { p, lessons } of fetched) await saveTerm(client, group.id, p, lessons);
    await client.query('UPDATE groups SET synced_at = now(), sync_error = NULL WHERE id = $1', [group.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await reportScheduleChanges(group); // тихо, только владельцу
  return { periods: fetched.length, lessons: fetched.reduce((s, f) => s + f.lessons.length, 0) };
}

/**
 * Создаёт (или находит) группу бота для группы с сайта и сразу загружает
 * расписание. row — элемент из parseGroupsPage().
 */
export async function importSsaaGroup(row, createdBy) {
  const params = { form: row.form, faculty: row.faculty, course: row.course, group: row.group };

  let { rows } = await query('SELECT * FROM groups WHERE source_key = $1', [row.key]);
  let group = rows[0];
  if (!group) {
    // Группа с таким же названием могла быть создана вручную — привязываем её.
    ({ rows } = await query(
      `INSERT INTO groups (name, created_by, source_key, source_params) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET source_key = EXCLUDED.source_key, source_params = EXCLUDED.source_params
       RETURNING *`,
      [row.title, createdBy, row.key, JSON.stringify(params)]
    ));
    group = rows[0];
  }

  const result = await syncGroup(group);
  return { group, ...result };
}

const inFlight = new Map();

/** Обновляет группу с сайта, если данные устарели. Никогда не бросает исключение. */
export async function ensureGroupFresh(groupId) {
  if (inFlight.has(groupId)) return inFlight.get(groupId);

  const job = (async () => {
    try {
      const { rows } = await query(`SELECT *, ${HAS_SUBS_SQL} AS has_subs FROM groups WHERE id = $1`, [groupId]);
      const group = rows[0];
      if (!group?.source_key) return;
      const age = group.synced_at ? Date.now() - new Date(group.synced_at).getTime() : Infinity;
      if (age < (group.has_subs ? SUBSCRIBED_TTL_MS : SYNC_TTL_MS)) return;
      const sinceAttempt = group.sync_attempted_at ? Date.now() - new Date(group.sync_attempted_at).getTime() : Infinity;
      if (group.sync_error && sinceAttempt < RETRY_AFTER_ERROR_MS) return;
      await query('UPDATE groups SET sync_attempted_at = now() WHERE id = $1', [groupId]);
      await syncGroup(group);
    } catch (e) {
      console.error(`ssaa sync failed for group ${groupId}:`, e);
      await query('UPDATE groups SET sync_error = $1 WHERE id = $2', [String(e.message || e).slice(0, 500), groupId]).catch(() => {});
    } finally {
      inFlight.delete(groupId);
    }
  })();

  inFlight.set(groupId, job);
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, FRESH_WAIT_MS); });
  await Promise.race([job, timeout]);
  clearTimeout(timer);
}

/**
 * Фоновая подгрузка для поиска преподавателя: чтобы видеть его пары во всех
 * группах, в боте должны быть загружены все группы колледжа, а не только те,
 * что выбрали пользователи. Вызывается из api/tick.js после рассылки:
 * за один вызов догружает недостающие группы и обновляет устаревшие, пока
 * не кончится budgetMs. 32 группы колледжа набираются за несколько тиков.
 */
const PRELOAD_FORMS = (process.env.SSAA_PRELOAD_FORMS || '11,13').split(',').map((s) => s.trim()).filter(Boolean);

export async function backgroundSync(budgetMs = 4000) {
  const startedAt = Date.now();
  const left = () => budgetMs - (Date.now() - startedAt);
  const done = { imported: 0, refreshed: 0, errors: 0 };
  if (PRELOAD_FORMS.length === 0) return done;

  let all;
  try {
    all = await fetchSsaaGroups();
  } catch (e) {
    console.error('backgroundSync: groups list failed', e);
    return { ...done, errors: 1, error: String(e.message || e).slice(0, 700) };
  }

  const { rows: existing } = await query(
    `SELECT id, name, source_key, source_params, synced_at, sync_error, sync_attempted_at, ${HAS_SUBS_SQL} AS has_subs FROM groups WHERE source_key IS NOT NULL`
  );
  const byKey = new Map(existing.map((g) => [g.source_key, g]));
  const today = new Date().toISOString().slice(0, 10);

  // 1) группы колледжа, которых ещё нет в боте
  const seen = new Set();
  const missing = [];
  for (const g of all) {
    if (!PRELOAD_FORMS.includes(g.form) || byKey.has(g.key) || seen.has(g.key)) continue;
    seen.add(g.key);
    const periods = all.filter((x) => x.key === g.key);
    const current = periods.find((p) => p.dateStart <= today && today <= p.dateEnd) || periods[0];
    missing.push(current);
  }
  for (const row of missing) {
    if (left() < 1500) return done;
    try {
      await importSsaaGroup(row, null);
      done.imported++;
    } catch (e) {
      done.errors++;
      console.error('backgroundSync import failed', row.key, e.message);
    }
  }

  // 2) самые давно обновлённые
  const stale = existing
    .filter((g) => !g.synced_at || Date.now() - new Date(g.synced_at).getTime() > (g.has_subs ? SUBSCRIBED_TTL_MS : SYNC_TTL_MS))
    .filter((g) => !(g.sync_error && g.sync_attempted_at && Date.now() - new Date(g.sync_attempted_at).getTime() < RETRY_AFTER_ERROR_MS))
    .sort((a, b) => new Date(a.synced_at || 0) - new Date(b.synced_at || 0));
  for (const g of stale) {
    if (left() < 1500) return done;
    try {
      await query('UPDATE groups SET sync_attempted_at = now() WHERE id = $1', [g.id]);
      await syncGroup(g);
      done.refreshed++;
    } catch (e) {
      done.errors++;
      await query('UPDATE groups SET sync_error = $1 WHERE id = $2', [String(e.message || e).slice(0, 500), g.id]).catch(() => {});
    }
  }
  return done;
}
