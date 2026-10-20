-- 20260930_security_hardening.sql: close holes found in the 2026-09-30
-- production audit. Each was verified against the live catalog first.
--
-- 1. Anyone could INSERT into identity.partner_applications with any status
--    and any user_id (policy CHECK true). The AFTER INSERT trigger
--    handle_partner_approval then set that user's tier to 'partner', so an
--    anonymous caller could demote the admin, and the notify trigger mailed
--    whatever address the row carried. The flow was retired on 2026-09-21;
--    submit_partner_application() (security definer, status left at its
--    default) stays the only way in.
-- 2. trigger_daily_digest_now() and record_development() run as the owner,
--    check no caller, and were executable by anon: anyone could fire the
--    digest or write regulatory records. Now server-side only.
-- 3. Views recent_reports and upcoming_deadlines ran with the owner's rights
--    and accepted writes, so anon could write scan_runs / developments past
--    RLS. They now run as the caller (RLS applies) and are read-only to the app.
-- 4. Storage bucket avatars: anyone could upload, overwrite, delete and LIST
--    every file (listing reveals user ids). Now a signed-in reader writes only
--    <their user id>.<ext>; public URLs still serve the pictures.
-- 5. TRUNCATE was granted to anon/authenticated. RLS does not govern TRUNCATE.
begin;

-- 1 ─────────────────────────────────────────────────────────────────────────
drop policy if exists partner_apps_anyone_insert on identity.partner_applications;
revoke insert on identity.partner_applications from anon, authenticated;
revoke insert on public.partner_applications from anon, authenticated;

-- 2 ─────────────────────────────────────────────────────────────────────────
revoke execute on function public.trigger_daily_digest_now(text) from public, anon, authenticated;
revoke execute on function public.record_development(uuid, text, text, text, text, text, text, text, text, text, date, date, date, date, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.trigger_daily_digest_now(text) to service_role;
grant execute on function public.record_development(uuid, text, text, text, text, text, text, text, text, text, date, date, date, date, text, text, text, text, text, text, text, text) to service_role;

-- 3 ─────────────────────────────────────────────────────────────────────────
alter view public.recent_reports set (security_invoker = true);
alter view public.upcoming_deadlines set (security_invoker = true);
revoke insert, update, delete, truncate on public.recent_reports, public.upcoming_deadlines from anon, authenticated;

-- 4 ─────────────────────────────────────────────────────────────────────────
drop policy if exists avatars_read on storage.objects;
drop policy if exists avatars_write on storage.objects;
drop policy if exists avatars_update on storage.objects;
drop policy if exists avatars_delete on storage.objects;
-- The app uploads "<uid>.<ext>" with upsert, which needs select+insert+update.
create policy avatars_own_select on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and split_part(name, '.', 1) = auth.uid()::text);
create policy avatars_own_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and split_part(name, '.', 1) = auth.uid()::text);
create policy avatars_own_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and split_part(name, '.', 1) = auth.uid()::text)
  with check (bucket_id = 'avatars' and split_part(name, '.', 1) = auth.uid()::text);
create policy avatars_own_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and split_part(name, '.', 1) = auth.uid()::text);

-- 5 ─────────────────────────────────────────────────────────────────────────
revoke truncate on all tables in schema public, sweep, identity, ops, map, content, reference, cms from anon, authenticated;
alter default privileges for role postgres in schema public, sweep, identity, ops, map, content, reference, cms
  revoke truncate on tables from anon, authenticated;

commit;
