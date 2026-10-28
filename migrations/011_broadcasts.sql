-- Рассылки от владельца бота: текст, аудитория и прогресс (курсор по users.id),
-- чтобы длинную рассылку можно было дослать за несколько заходов.
CREATE TABLE IF NOT EXISTS broadcasts (
  id          SERIAL PRIMARY KEY,
  audience    JSONB NOT NULL,
  body        TEXT NOT NULL,
  created_by  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  total       INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  cursor_id   INTEGER NOT NULL DEFAULT 0,
  done        BOOLEAN NOT NULL DEFAULT false
);

DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
