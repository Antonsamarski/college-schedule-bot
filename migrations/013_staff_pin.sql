-- Староста группы: журнал действий и возможность отключить его объявления.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mute_staff BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS staff_log (
  id              SERIAL PRIMARY KEY,
  group_id        INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_platform  TEXT NOT NULL,
  actor_id        BIGINT NOT NULL,
  action          TEXT NOT NULL,          -- announce | cancel | room | undo
  detail          TEXT,
  recipients      INTEGER,
  override_id     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_log_group ON staff_log(group_id, created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
