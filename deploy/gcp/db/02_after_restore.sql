-- ─────────────────────────────────────────────────────────────────────────
-- 02_after_restore.sql: run by migrate.sh after the Supabase data is in.
-- psql variables: old_base (Supabase public-storage URL prefix), new_base
-- (Cloud Storage public URL + bucket prefix).
--
-- 1. The same security fixes as supabase/migrations/20260930_security_hardening.sql
--    (minus storage policies: storage is Cloud Storage now, the API gates writes).
-- 2. Stored picture URLs point at Cloud Storage instead of Supabase Storage.
-- 3. PostgREST reloads its schema cache; statistics are refreshed.
-- ─────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP on
select set_config('attacked.old_base', :'old_base', false), set_config('attacked.new_base', :'new_base', false);

set role attacked_owner;

-- 1 ─────────────────────────────────────────────────────────────────────────
drop policy if exists partner_apps_anyone_insert on identity.partner_applications;
revoke insert on identity.partner_applications, public.partner_applications from anon, authenticated;

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('trigger_daily_digest_now', 'record_development') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

do $$
declare v text;
begin
  foreach v in array array['public.recent_reports', 'public.upcoming_deadlines'] loop
    if to_regclass(v) is not null then
      execute format('alter view %s set (security_invoker = true)', v);
      execute format('revoke insert, update, delete, truncate on %s from anon, authenticated', v);
    end if;
  end loop;
end $$;

do $$
declare s text;
begin
  foreach s in array array['public', 'sweep', 'identity', 'ops', 'map', 'content', 'reference', 'cms'] loop
    execute format('revoke truncate on all tables in schema %I from anon, authenticated', s);
  end loop;
end $$;

-- 2 ─────────────────────────────────────────────────────────────────────────
-- Every text/varchar/jsonb column in the app schemas that holds an old
-- Supabase public-storage URL gets the Cloud Storage one. The bucket name
-- follows the prefix: .../public/incident-media/x.jpg -> <new_base>incident-media/x.jpg
do $$
declare
  c record; n bigint; total bigint := 0;
  old_base text := current_setting('attacked.old_base');
  new_base text := current_setting('attacked.new_base');
begin
  for c in
    select col.table_schema, col.table_name, col.column_name, col.data_type
    from information_schema.columns col
    join information_schema.tables t on t.table_schema = col.table_schema and t.table_name = col.table_name
    where t.table_type = 'BASE TABLE'
      and col.table_schema = any(array['public','sweep','identity','ops','map','content','reference','cms'])
      and col.data_type in ('text', 'character varying', 'jsonb')
  loop
    if c.data_type = 'jsonb' then
      execute format('update %I.%I set %I = replace(%I::text, %L, %L)::jsonb where %I::text like %L',
        c.table_schema, c.table_name, c.column_name, c.column_name, old_base, new_base, c.column_name, '%' || old_base || '%');
    else
      execute format('update %I.%I set %I = replace(%I, %L, %L) where %I like %L',
        c.table_schema, c.table_name, c.column_name, c.column_name, old_base, new_base, c.column_name, '%' || old_base || '%');
    end if;
    get diagnostics n = row_count;
    if n > 0 then
      raise notice 'rewrote % picture URL row(s) in %.%.%', n, c.table_schema, c.table_name, c.column_name;
      total := total + n;
    end if;
  end loop;
  raise notice 'picture URLs rewritten: % row(s)', total;
end $$;

reset role;

-- 3 ─────────────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';
analyze;
