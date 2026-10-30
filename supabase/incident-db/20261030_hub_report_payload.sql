-- Incident reporting project (wfnvwtmpvzuxjmebqffq) — run once in its SQL editor.
--
-- The Attacked.ai Hub reads one published report (the incidents row plus its
-- child tables) through this function, with a read key kept in a private
-- schema. Anyone holding the public anon key can call it, but without the key
-- it answers null, so the subscriber-only sections (blast radius, controls,
-- vendors, comparables, causes, sources) never leave the database unkeyed.
-- Read-only and additive: no existing table, policy or row is changed.
--
-- The key itself is NOT in this file. Its SHA-256 is. The key lives only in
-- the site's environment (INCIDENT_REPORT_KEY on Vercel, .env locally).
create schema if not exists hub_private;
revoke all on schema hub_private from public, anon, authenticated;

create table if not exists hub_private.report_feed_keys (
  key_sha256 text primary key,
  label      text not null,
  created_at timestamptz not null default now()
);
revoke all on hub_private.report_feed_keys from public, anon, authenticated;

insert into hub_private.report_feed_keys (key_sha256, label)
values ('50f80d5fd9f175423e5f2c95a51e0cb8d413d50773d4f11dbb05bca997db33eb', 'attackedmap.vercel.app /api/report, issued 2026-10-30')
on conflict (key_sha256) do nothing;

create or replace function public.hub_report_payload(p_id text, p_key text)
returns jsonb
language sql
stable
security definer
set search_path = public, hub_private
as $$
  select case
    when not exists (
      select 1 from hub_private.report_feed_keys k
      where k.key_sha256 = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
    ) then null
    else (
      select jsonb_build_object(
        'incident', to_jsonb(inc),
        'reporter', (select to_jsonb(rep) from public.reporters rep where rep.code = inc.reporter_code limit 1),
        'blast', (select coalesce(jsonb_agg(to_jsonb(bl) order by bl.seq, bl.id), '[]'::jsonb) from public.incident_blast bl where bl.incident_id = inc.id),
        'sources', (select coalesce(jsonb_agg(to_jsonb(so) order by so.seq, so.id), '[]'::jsonb) from public.incident_sources so where so.incident_id = inc.id),
        'vendors', (select coalesce(jsonb_agg(
            (to_jsonb(ve) || jsonb_build_object(
              'logo', (select lo.logo from public.vendor_logos lo where lo.vendor_id = ve.id limit 1),
              'ctrls', (select coalesce(jsonb_agg(jsonb_build_object('ac', vc.ac, 't', vc.t) order by vc.seq, vc.id), '[]'::jsonb)
                        from public.incident_vendor_controls vc where vc.vendor_id = ve.id)
            )) order by ve.seq, ve.id), '[]'::jsonb)
          from public.incident_vendors ve where ve.incident_id = inc.id),
        'controls', (select coalesce(jsonb_agg(to_jsonb(co) order by co.seq, co.id), '[]'::jsonb) from public.incident_controls co where co.incident_id = inc.id),
        'comparables', (select coalesce(jsonb_agg(to_jsonb(cp) order by cp.seq, cp.id), '[]'::jsonb) from public.incident_comparables cp where cp.incident_id = inc.id),
        'causes', (select coalesce(jsonb_agg(to_jsonb(ca) order by ca.seq, ca.id), '[]'::jsonb) from public.incident_causes ca where ca.incident_id = inc.id),
        'guard_map', (select coalesce(jsonb_agg(to_jsonb(gm) order by gm.seq, gm.id), '[]'::jsonb) from public.incident_guard_map gm where gm.incident_id = inc.id)
      )
      from public.incidents inc
      where inc.id = p_id and inc.report_status = 'published'
    )
  end
$$;

revoke all on function public.hub_report_payload(text, text) from public;
grant execute on function public.hub_report_payload(text, text) to anon, authenticated;
