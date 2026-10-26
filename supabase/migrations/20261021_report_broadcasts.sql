-- 20261021_report_broadcasts.sql — the related broadcast (podcast episode) for a report.
--
-- Every intelligence briefing can carry one or more broadcast episodes: the
-- analyst conversation on that incident. The Attacked Hub shows them in a
-- "Related broadcast" panel the moment a report is opened (ReportFrame), and
-- the print document's last page carries the episode with a QR code
-- (D:/claude_work/nats-v2/tools/build_print.py --broadcast-json).
--
--   • report_ref  the briefing it belongs to: a baked report ref
--                 (ATK-2026-0908-NATS) or a CMS report ref (hub_reports.ref)
--   • audio_url   the episode file or page (mp3 / m4a / a Spotify or YouTube
--                 page); NULL = announced, not yet released ("coming soon")
--   • published   only published rows reach readers
--
-- Readers select straight from the table (anon-readable, like the rest of the
-- hub data — RLS stays off by the owner's rule). Admins write through the
-- admin_* functions, gated by _is_admin().

create table if not exists public.report_broadcasts (
  id           bigserial primary key,
  report_ref   text not null,
  series       text not null default 'Attacked.ai Briefing Room',
  episode      text,                        -- e.g. "Episode 12"
  title        text not null,
  audio_url    text,
  page_url     text,                        -- the episode's web page, if different from the audio file
  duration_sec integer,
  show_notes   text,
  published    boolean not null default true,
  published_at timestamptz not null default now(),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists report_broadcasts_ref_idx on public.report_broadcasts (report_ref, published, published_at desc);

grant select on public.report_broadcasts to anon, authenticated;

-- Admin: create or update one episode. p: { id?, report_ref, series?, episode?, title, audio_url?, page_url?, duration_sec?, show_notes?, published? }
create or replace function public.admin_upsert_broadcast(p jsonb)
returns setof public.report_broadcasts language plpgsql security definer set search_path to 'public' as $$
declare r public.report_broadcasts;
begin
  if not _is_admin() then raise exception 'not authorised'; end if;
  if coalesce(p->>'report_ref', '') = '' or coalesce(p->>'title', '') = '' then raise exception 'report_ref and title are required'; end if;
  if p ? 'id' and (p->>'id') is not null then
    update public.report_broadcasts
       set report_ref = p->>'report_ref', series = coalesce(nullif(p->>'series', ''), series), episode = nullif(p->>'episode', ''),
           title = p->>'title', audio_url = nullif(p->>'audio_url', ''), page_url = nullif(p->>'page_url', ''),
           duration_sec = nullif(p->>'duration_sec', '')::integer, show_notes = nullif(p->>'show_notes', ''),
           published = coalesce((p->>'published')::boolean, published), updated_at = now()
     where id = (p->>'id')::bigint
     returning * into r;
    if r.id is null then raise exception 'broadcast % not found', p->>'id'; end if;
  else
    insert into public.report_broadcasts (report_ref, series, episode, title, audio_url, page_url, duration_sec, show_notes, published, created_by)
    values (p->>'report_ref', coalesce(nullif(p->>'series', ''), 'Attacked.ai Briefing Room'), nullif(p->>'episode', ''), p->>'title',
            nullif(p->>'audio_url', ''), nullif(p->>'page_url', ''), nullif(p->>'duration_sec', '')::integer, nullif(p->>'show_notes', ''),
            coalesce((p->>'published')::boolean, true), auth.uid())
    returning * into r;
  end if;
  return next r;
end $$;

create or replace function public.admin_delete_broadcast(p_id bigint)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not _is_admin() then raise exception 'not authorised'; end if;
  delete from public.report_broadcasts where id = p_id;
end $$;

-- Admin: every episode, newest first (drafts included).
create or replace function public.admin_list_broadcasts()
returns setof public.report_broadcasts language plpgsql security definer set search_path to 'public' as $$
begin
  if not _is_admin() then raise exception 'not authorised'; end if;
  return query select * from public.report_broadcasts order by published_at desc, id desc;
end $$;

revoke all on function public.admin_upsert_broadcast(jsonb) from public;
revoke all on function public.admin_delete_broadcast(bigint) from public;
revoke all on function public.admin_list_broadcasts() from public;
grant execute on function public.admin_upsert_broadcast(jsonb) to authenticated;
grant execute on function public.admin_delete_broadcast(bigint) to authenticated;
grant execute on function public.admin_list_broadcasts() to authenticated;
