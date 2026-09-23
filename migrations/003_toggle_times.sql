-- Когда пользователь выключает рассылку кнопкой (не текстом), мы хотим
-- запомнить последнее выбранное время, чтобы при повторном включении
-- не заставлять вводить его заново.
ALTER TABLE users ADD COLUMN IF NOT EXISTS morning_time_last TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS evening_time_last TEXT;
