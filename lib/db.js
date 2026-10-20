import pg from 'pg';

// По умолчанию node-postgres превращает колонки типа DATE в объекты JS Date,
// а весь код в проекте работает с датами как со строками "YYYY-MM-DD"
// (сравнение, форматирование и т.д.). Отключаем это для типа DATE (OID 1082),
// чтобы pg отдавал их как есть — строкой, без часовых поясов и сюрпризов.
pg.types.setTypeParser(1082, (val) => val);

let pool;

/** Neon/Supabase требуют SSL, а локальный Postgres (для разработки) — нет. */
export function sslFor(url = '') {
  return /sslmode=disable|@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false };
}

/**
 * Убирает из строки подключения sslmode и похожие параметры. Если их оставить,
 * pg считает sslmode=require строгой проверкой сертификата и перекрывает наш
 * `ssl` — а у пулера Supabase сертификат подписан собственным центром Supabase,
 * и подключение падает с "self-signed certificate in certificate chain".
 * SSL при этом остаётся включённым через sslFor().
 */
export function cleanUrl(url = '') {
  try {
    const u = new URL(url);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat', 'supa', 'pgbouncer']) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

/** Параметры подключения: DATABASE_URL (или POSTGRES_URL от интеграции Supabase). */
export function connectionConfig(url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '') {
  return { connectionString: cleanUrl(url), ssl: sslFor(url) };
}

// В serverless-окружении (Vercel) переиспользуем пул между вызовами одного
// "тёплого" инстанса функции — так быстрее и не упираемся в лимит соединений.
export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ ...connectionConfig(), max: 3 });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}
