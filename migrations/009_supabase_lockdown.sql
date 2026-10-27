-- Supabase открывает таблицы схемы public через публичный REST API (роли anon
-- и authenticated). Боту это не нужно: он подключается к базе напрямую
-- владельцем таблиц, на которого RLS не действует. Закрываем всё.
-- На обычном Postgres (без ролей Supabase) просто включает RLS.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
