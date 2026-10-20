-- supabase/seed.sql — runs after the migrations on `supabase db reset` / first start.
--
-- Kept small. The data for local testing is the copy of the live database that
-- `npm run local:dump` writes to supabase/seed/*.sql (git-ignored: it is large,
-- and the exclusion list in scripts/docker-local.mjs, not git, keeps reader PII
-- out of it). Only small, committable, LOCAL-ONLY fixtures belong here; this file
-- is never pushed to live (db push applies migrations, not seeds).

-- Live has its own policies on storage.objects, but pg_dump leaves the storage
-- schema out. Without these, uploads from the local Admin pages and the profile
-- avatar fail with an RLS error. The two buckets themselves come from config.toml.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'local dev: public read') then
    create policy "local dev: public read" on storage.objects
      for select to anon, authenticated
      using (bucket_id in ('avatars', 'incident-media'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'local dev: authenticated write') then
    create policy "local dev: authenticated write" on storage.objects
      for all to authenticated
      using (bucket_id in ('avatars', 'incident-media'))
      with check (bucket_id in ('avatars', 'incident-media'));
  end if;
end $$;
