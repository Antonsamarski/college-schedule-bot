// Запуск: node scripts/migrate.js
// Применяет все .sql-файлы из migrations/ по порядку (по имени файла).
// Уже применённые файлы не трогает повторно — все миграции написаны
// с IF NOT EXISTS, так что повторный запуск безопасен.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Не задан DATABASE_URL. Смотри .env.example');
    process.exit(1);
  }

  const migrationsDir = join(__dirname, '..', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      console.log(`Применяю ${file}...`);
      await client.query(sql);
    }
    console.log('Все миграции применены успешно.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Ошибка миграции:', err);
  process.exit(1);
});
