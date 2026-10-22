-- Бот работает в двух мессенджерах: Telegram и MAX. Пользователи и групповые
-- чаты из обоих лежат в одних таблицах, platform показывает, откуда они.
-- Для MAX в users.telegram_id хранится user_id в MAX, в group_chats.chat_id —
-- chat_id в MAX (у MAX свои номера, поэтому уникальность — в паре с platform).
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'telegram';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_platform_check;
ALTER TABLE users ADD CONSTRAINT users_platform_check CHECK (platform IN ('telegram', 'max'));
ALTER TABLE group_chats DROP CONSTRAINT IF EXISTS group_chats_platform_check;
ALTER TABLE group_chats ADD CONSTRAINT group_chats_platform_check CHECK (platform IN ('telegram', 'max'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_telegram_id_key;
ALTER TABLE group_chats DROP CONSTRAINT IF EXISTS group_chats_chat_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_platform_id ON users(platform, telegram_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_chats_platform_id ON group_chats(platform, chat_id);
