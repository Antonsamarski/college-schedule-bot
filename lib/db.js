import pg from 'pg';

let pool;

// В serverless-окружении (Vercel) переиспользуем пул между вызовами одного
// "тёплого" инстанса функции — так быстрее и не упираемся в лимит соединений.
export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}
