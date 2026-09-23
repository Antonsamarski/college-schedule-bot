import pg from 'pg';

// По умолчанию node-postgres превращает колонки типа DATE в объекты JS Date,
// а весь код в проекте работает с датами как со строками "YYYY-MM-DD"
// (сравнение, форматирование и т.д.). Отключаем это для типа DATE (OID 1082),
// чтобы pg отдавал их как есть — строкой, без часовых поясов и сюрпризов.
pg.types.setTypeParser(1082, (val) => val);

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
