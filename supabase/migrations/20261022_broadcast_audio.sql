-- 20261022_broadcast_audio.sql — the broadcast becomes a product feature:
-- the admin UPLOADS the episode, and every copy of the briefing plays it.
--
-- Builds on 20261021_report_broadcasts.sql (table + admin_* functions).
--
--   1. storage bucket `broadcasts` — public read (the player streams the file
--      straight from storage, no token), admin-only write. Objects live at
--      <report_ref>/<timestamp>-<file>.mp3, so one briefing's episodes sit
--      together and a re-upload never overwrites the file a reader is playing.
--   2. report_broadcasts gains the file's identity (audio_path/bytes/type — the
--      public URL stays in audio_url, as before, so every reader path is
--      unchanged), the hosts shown on the report's broadcast card, and a
--      sort_order for briefings with more than one episode.
--   3. admin_upsert_broadcast learns the new fields (same signature: p jsonb).
--
-- Table RLS stays OFF (owner's rule). Storage policies are per-bucket on
-- storage.objects, which already carries RLS on every Supabase project.

-- 1. the bucket ----------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('broadcasts', 'broadcasts', true, 104857600,
        array['audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/m4a','audio/aac','audio/ogg','audio/wav','audio/x-wav','audio/webm','audio/flac'])
on conflict (id) do update
   set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists broadcasts_public_read  on storage.objects;
drop policy if exists broadcasts_admin_insert on storage.objects;
drop policy if exists broadcasts_admin_update on storage.objects;
drop policy if exists broadcasts_admin_delete on storage.objects;
create policy broadcasts_public_read  on storage.objects for select to public
  using (bucket_id = 'broadcasts');
create policy broadcasts_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'broadcasts' and public._is_admin());
create policy broadcasts_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'broadcasts' and public._is_admin())
  with check (bucket_id = 'broadcasts' and public._is_admin());
create policy broadcasts_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'broadcasts' and public._is_admin());

-- 2. the file's identity, the hosts, the order ----------------------------------
alter table public.report_broadcasts
  add column if not exists audio_path  text,                               -- storage object name inside the bucket; null = external URL or no audio
  add column if not exists audio_bytes bigint,
  add column if not exists audio_type  text,
  add column if not exists hosts       jsonb not null default '[]'::jsonb,  -- [{name, role, photo?}] shown on the report's broadcast card
  add column if not exists sort_order  integer not null default 0;

comment on column public.report_broadcasts.audio_path is 'storage.objects.name in bucket broadcasts when the file was uploaded through the admin console; audio_url holds its public URL';
comment on column public.report_broadcasts.hosts is 'Extra hosts for the broadcast card: [{"name","role","photo"}]; the report''s own analyst is always shown first';

create index if not exists report_broadcasts_pub_idx on public.report_broadcasts (published, report_ref, sort_order, published_at desc);

-- 3. the admin write, with the new fields ---------------------------------------
-- p: { id?, report_ref, series?, episode?, title, audio_url?, audio_path?, audio_bytes?, audio_type?,
--      page_url?, duration_sec?, show_notes?, hosts?, published?, published_at?, sort_order? }
-- Keys that are absent keep their current value on an update; an explicit null
-- or '' clears the text fields.
create or replace function public.admin_upsert_broadcast(p jsonb)
returns setof public.report_broadcasts language plpgsql security definer set search_path to 'public' as $$
declare r public.report_broadcasts;
begin
  if not _is_admin() then raise exception 'not authorised'; end if;
  if coalesce(p->>'report_ref', '') = '' or coalesce(p->>'title', '') = '' then raise exception 'report_ref and title are required'; end if;
  if p ? 'hosts' and jsonb_typeof(p->'hosts') not in ('array', 'null') then raise exception 'hosts must be a list'; end if;

  if p ? 'id' and (p->>'id') is not null then
    update public.report_broadcasts
       set report_ref   = p->>'report_ref',
           series       = coalesce(nullif(p->>'series', ''), series),
           episode      = case when p ? 'episode'      then nullif(p->>'episode', '')      else episode end,
           title        = p->>'title',
           audio_url    = case when p ? 'audio_url'    then nullif(p->>'audio_url', '')    else audio_url end,
           audio_path   = case when p ? 'audio_path'   then nullif(p->>'audio_path', '')   else audio_path end,
           audio_bytes  = case when p ? 'audio_bytes'  then nullif(p->>'audio_bytes', '')::bigint  else audio_bytes end,
           audio_type   = case when p ? 'audio_type'   then nullif(p->>'audio_type', '')   else audio_type end,
           page_url     = case when p ? 'page_url'     then nullif(p->>'page_url', '')     else page_url end,
           duration_sec = case when p ? 'duration_sec' then nullif(p->>'duration_sec', '')::integer else duration_sec end,
           show_notes   = case when p ? 'show_notes'   then nullif(p->>'show_notes', '')   else show_notes end,
           hosts        = case when p ? 'hosts' and jsonb_typeof(p->'hosts') = 'array' then p->'hosts' else hosts end,
           published    = coalesce((p->>'published')::boolean, published),
           published_at = coalesce(nullif(p->>'published_at', '')::timestamptz, published_at),
           sort_order   = coalesce(nullif(p->>'sort_order', '')::integer, sort_order),
           updated_at   = now()
     where id = (p->>'id')::bigint
     returning * into r;
    if r.id is null then raise exception 'broadcast % not found', p->>'id'; end if;
  else
    insert into public.report_broadcasts
      (report_ref, series, episode, title, audio_url, audio_path, audio_bytes, audio_type, page_url, duration_sec, show_notes, hosts, published, published_at, sort_order, created_by)
    values
      (p->>'report_ref', coalesce(nullif(p->>'series', ''), 'Attacked.ai Briefing Room'), nullif(p->>'episode', ''), p->>'title',
       nullif(p->>'audio_url', ''), nullif(p->>'audio_path', ''), nullif(p->>'audio_bytes', '')::bigint, nullif(p->>'audio_type', ''),
       nullif(p->>'page_url', ''), nullif(p->>'duration_sec', '')::integer, nullif(p->>'show_notes', ''),
       case when jsonb_typeof(p->'hosts') = 'array' then p->'hosts' else '[]'::jsonb end,
       coalesce((p->>'published')::boolean, true), coalesce(nullif(p->>'published_at', '')::timestamptz, now()),
       coalesce(nullif(p->>'sort_order', '')::integer, 0), auth.uid())
    returning * into r;
  end if;
  return next r;
end $$;

revoke all on function public.admin_upsert_broadcast(jsonb) from public;
grant execute on function public.admin_upsert_broadcast(jsonb) to authenticated;

-- Readers: which briefings have a broadcast at all (the Hub marks their cards).
-- One row per ref, published episodes only. Anon-readable like the table.
create or replace view public.report_broadcast_refs as
  select report_ref, count(*)::integer as episodes, max(published_at) as latest_at,
         bool_or(audio_url is not null or page_url is not null) as released
    from public.report_broadcasts where published
   group by report_ref;
grant select on public.report_broadcast_refs to anon, authenticated;
