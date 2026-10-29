-- Рассылка владельца может идти с фото: file_id картинки в Telegram.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS photo_file_id TEXT;
