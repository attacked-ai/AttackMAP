-- Daily brief v17: the reader's MINIMUM SEVERITY becomes a stored preference.
-- The Configure alerts page has offered "Minimum severity" (S1..S5) since the
-- dashboard shipped, but nothing persisted it; the brief now honours it, so
-- the profile needs the column.
--
-- Run in the Supabase SQL editor (project ovenyjguhkgiceddzwna). Safe at any
-- time; nothing changes for readers until daily-digest v17 is deployed.
--
-- What it does:
--   1. identity.profiles.min_severity  smallint 1..5, default 3 (MEDIUM and
--      above — the same default the alerts page shows).
--   2. public.profiles (the PostgREST view the app reads and writes through)
--      gains the column. CREATE OR REPLACE VIEW appends it at the END of the
--      column list, which Postgres allows without dropping the view — so the
--      existing grants and the security_invoker option stay exactly as they
--      are (no DROP VIEW, no re-grant dance).
--   3. The own-row UPDATE policy on identity.profiles already lets a signed-in
--      reader write their own row through the view; no policy change.

alter table identity.profiles
  add column if not exists min_severity smallint not null default 3;

alter table identity.profiles
  drop constraint if exists profiles_min_severity_range;
alter table identity.profiles
  add constraint profiles_min_severity_range check (min_severity between 1 and 5);

create or replace view public.profiles with (security_invoker = true) as
select id, email, tier, company, role, approved_at, created_at, updated_at,
       email_subscribed, unsubscribe_token, stripe_customer_id, full_name,
       industry, country, company_size, watch_industries, watch_categories,
       digest_frequency, onboarded_at, avatar_url,
       min_severity
  from identity.profiles;

alter view public.profiles set (security_invoker = true);

notify pgrst, 'reload schema';

-- Check:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'profiles' order by ordinal_position;
--   → ends with avatar_url, min_severity
--   select reloptions from pg_class where oid = 'public.profiles'::regclass;   → {security_invoker=true}
