-- 20261030_reports_schema.sql — the intelligence briefings, inside the product
-- database (ovenyjguhkgiceddzwna), in their own schema `reports`.
--
-- Until now the 1,400+ published briefings lived only in the incident
-- reporting project (wfnvwtmpvzuxjmebqffq). This schema holds a copy of that
-- data so the whole product talks to one database:
--
--   reports.*        report data (briefings + their blast radius, sources,
--                    vendors, controls, comparables, causes, GUARD map)
--   sweep.*          map data (unchanged)
--   identity.*       readers, tiers, subscriptions (unchanged)
--
-- Access, from least to most:
--   public.report_briefings_public   a view of the PUBLISHED briefings' card
--                                    columns, readable with the anon key (the
--                                    Hub's Intelligence library);
--   public.report_payload(id, key)   one briefing with every child row, for the
--                                    site's server only (api/report.mjs holds the
--                                    key; the server then decides full page or
--                                    free preview per reader);
--   reports.* tables                 no public policy at all — the locked
--                                    sections never leave the database unkeyed.
--
-- The copy is filled by reports.sync_from_incident_db(connection) —
-- see 20261030_reports_sync.sql — which can be re-run any time.
-- Additive: nothing outside `reports` and the two public objects changes.

create schema if not exists reports;

-- ── Tables (one per table of the incident reporting project) ─────────────
create table if not exists reports.briefings (
  id                  text primary key,                  -- the report ref, e.g. ATK-EV-067
  industry_slug       text not null,
  title               text not null,
  subtitle            text,
  severity            integer,
  confidence          text,
  primary_category    text,
  categories          text[] default '{}'::text[],
  status              text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  image_url           text,
  disclosed_date      date,
  primary_date        date,
  ref                 text,
  kicker              text,
  standfirst          text,
  reporter_code       text,
  dek_tail            text,
  cause_tag           text,
  pull_quote          text,
  takeaway            text,
  footnote            text,
  chain_lead          text,
  narrative           jsonb,
  exec_bullets        jsonb,
  analyst_verdict     jsonb,
  categories_touched  jsonb,
  dossier             jsonb,
  metrics             jsonb,
  chain               jsonb,
  scenarios           jsonb,
  outlook             jsonb,
  frameworks          jsonb,
  severity_dims       jsonb,
  x                   jsonb,
  published_at        timestamptz,
  report_status       text not null default 'published',  -- published | pending | excluded
  entity              text,
  ticker              text,
  country             text,
  primary_subcategory text,
  location_name       text,
  location_country    text,
  location_lat        double precision,
  location_lng        double precision,
  countries_affected  text[],
  event_start         timestamptz,
  event_end           timestamptz,
  event_tz            text,
  disclosed_at        timestamptz,
  assessed_at         timestamptz,
  entity_legal_name   text,
  entity_cik          text,
  entity_lei          text,
  entity_website      text,
  entity_country      text,
  entity_hq_city      text,
  entity_hq_lat       double precision,
  entity_hq_lng       double precision,
  entity_org_key      text,
  run_id              bigint,
  writer              text,
  writer_saved_at     timestamptz,
  report_format       smallint,
  synced_at           timestamptz not null default now()  -- when this copy last refreshed the row
);
comment on table reports.briefings is 'Intelligence briefings (report data), copied from the incident reporting project. Not map data: the map reads sweep.incidents.';
create index if not exists briefings_published_idx on reports.briefings (report_status, published_at desc);
create index if not exists briefings_industry_idx on reports.briefings (industry_slug);

create table if not exists reports.blast (
  id bigint primary key, briefing_id text not null references reports.briefings(id) on delete cascade,
  seq integer, n text, r text, sev integer, d text, x jsonb,
  legal_name text, ticker text, cik text, lei text, country_code text, hq_city text,
  hq_lat double precision, hq_lng double precision, website text, org_key text, exposure_group text,
  entity_type text, pathway text, timeframe text, parent_name text, parent_ticker text, parent_cik text, id_note text
);
create index if not exists blast_briefing_idx on reports.blast (briefing_id, seq);

create table if not exists reports.sources (
  id bigint primary key, briefing_id text not null references reports.briefings(id) on delete cascade,
  seq integer, t text, s text, url text, publisher text, published_on date
);
create index if not exists sources_briefing_idx on reports.sources (briefing_id, seq);

create table if not exists reports.vendors (
  id bigint primary key, briefing_id text not null references reports.briefings(id) on delete cascade,
  seq integer, n text, maker text, dom text, kind text, vtype text, prod text, rat text, map text, x jsonb
);
create index if not exists vendors_briefing_idx on reports.vendors (briefing_id, seq);

create table if not exists reports.vendor_controls (
  id bigint primary key, vendor_id bigint not null references reports.vendors(id) on delete cascade,
  seq integer, ac text, t text
);
create index if not exists vendor_controls_vendor_idx on reports.vendor_controls (vendor_id, seq);

create table if not exists reports.vendor_logos (
  vendor_id bigint primary key references reports.vendors(id) on delete cascade,
  logo text
);

create table if not exists reports.controls (
  id bigint primary key, briefing_id text not null references reports.briefings(id) on delete cascade,
  seq integer, code text, cat text, name text, owner text, obj text, fail text, good text, x jsonb,
  mc_id text, subcat text, mc_confidence text, mc_why text
);
create index if not exists controls_briefing_idx on reports.controls (briefing_id, seq);

create table if not exists reports.comparables (
  id bigint primary key, briefing_id text not null references reports.briefings(id) on delete cascade,
  seq integer, case_name text, year text, what text, implication text, x jsonb
);
create index if not exists comparables_briefing_idx on reports.comparables (briefing_id, seq);

create table if not exists reports.causes (
  id bigint primary key, briefing_id text not null references reports.briefings(id) on delete cascade,
  seq integer, tier text, hyp text, rat text, why text, cats jsonb, bp jsonb, cmp jsonb, guard jsonb, x jsonb
);
create index if not exists causes_briefing_idx on reports.causes (briefing_id, seq);

create table if not exists reports.guard_map (
  id bigint primary key, briefing_id text not null references reports.briefings(id) on delete cascade,
  seq integer not null, cat text not null, subcat text not null, role text not null,
  confidence text, why text, mapped_by text, mapped_at timestamptz default now()
);
create index if not exists guard_map_briefing_idx on reports.guard_map (briefing_id, seq);

create table if not exists reports.reporters (
  code text primary key, name text not null, role text not null, desk text not null,
  outlet text not null default 'Attacked.ai Intelligence'
);

create table if not exists reports.industries (
  slug text primary key, name text not null, blurb text, sort integer default 100
);

-- The server's read key, hashed. The key itself lives only in the site's
-- environment (REPORT_FEED_KEY on Vercel, .env locally).
create table if not exists reports.feed_keys (
  key_sha256 text primary key,
  label      text not null,
  created_at timestamptz not null default now()
);
insert into reports.feed_keys (key_sha256, label)
values ('50f80d5fd9f175423e5f2c95a51e0cb8d413d50773d4f11dbb05bca997db33eb', 'attackedmap.vercel.app /api/report, issued 2026-10-30')
on conflict (key_sha256) do nothing;

-- Every sync run, for the admin to see what arrived.
create table if not exists reports.sync_log (
  id          bigserial primary key,
  part        text not null,
  counts      jsonb,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  error       text
);

-- ── Locked down: no table in `reports` is readable through the API ──────
revoke all on schema reports from public, anon, authenticated;
revoke all on all tables in schema reports from public, anon, authenticated;
alter default privileges in schema reports revoke all on tables from public, anon, authenticated;
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'reports' loop
    execute format('alter table reports.%I enable row level security', t);
  end loop;
end $$;

-- ── Public view: the published briefings' card data (anon-readable) ──────
create or replace view public.report_briefings_public
with (security_invoker = false) as
  select b.id, b.id as ref, b.title, b.subtitle, b.industry_slug, i.name as industry,
         b.severity, b.primary_category, b.categories, b.categories_touched,
         b.published_at, b.primary_date, b.image_url, b.reporter_code, b.entity, b.country, b.ticker, b.kicker
  from reports.briefings b
  left join reports.industries i on i.slug = b.industry_slug
  where b.report_status = 'published';
comment on view public.report_briefings_public is 'Published intelligence briefings, card columns only (no body, no child tables). Anon-readable for the Hub library.';
grant select on public.report_briefings_public to anon, authenticated;

-- ── One briefing with all of its child rows, for the site''s server ────────
-- null for an unknown or unpublished ref and for a wrong key alike.
create or replace function public.report_payload(p_id text, p_key text)
returns jsonb
language sql
stable
security definer
set search_path = reports, public
as $$
  select case
    when not exists (
      select 1 from reports.feed_keys k
      where k.key_sha256 = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
    ) then null
    else (
      select jsonb_build_object(
        'incident', to_jsonb(inc),
        'reporter', (select to_jsonb(rep) from reports.reporters rep where rep.code = inc.reporter_code limit 1),
        'blast', (select coalesce(jsonb_agg(to_jsonb(bl) order by bl.seq, bl.id), '[]'::jsonb) from reports.blast bl where bl.briefing_id = inc.id),
        'sources', (select coalesce(jsonb_agg(to_jsonb(so) order by so.seq, so.id), '[]'::jsonb) from reports.sources so where so.briefing_id = inc.id),
        'vendors', (select coalesce(jsonb_agg(
            (to_jsonb(ve) || jsonb_build_object(
              'logo', (select lo.logo from reports.vendor_logos lo where lo.vendor_id = ve.id limit 1),
              'ctrls', (select coalesce(jsonb_agg(jsonb_build_object('ac', vc.ac, 't', vc.t) order by vc.seq, vc.id), '[]'::jsonb)
                        from reports.vendor_controls vc where vc.vendor_id = ve.id)
            )) order by ve.seq, ve.id), '[]'::jsonb)
          from reports.vendors ve where ve.briefing_id = inc.id),
        'controls', (select coalesce(jsonb_agg(to_jsonb(co) order by co.seq, co.id), '[]'::jsonb) from reports.controls co where co.briefing_id = inc.id),
        'comparables', (select coalesce(jsonb_agg(to_jsonb(cp) order by cp.seq, cp.id), '[]'::jsonb) from reports.comparables cp where cp.briefing_id = inc.id),
        'causes', (select coalesce(jsonb_agg(to_jsonb(ca) order by ca.seq, ca.id), '[]'::jsonb) from reports.causes ca where ca.briefing_id = inc.id),
        'guard_map', (select coalesce(jsonb_agg(to_jsonb(gm) order by gm.seq, gm.id), '[]'::jsonb) from reports.guard_map gm where gm.briefing_id = inc.id)
      )
      from reports.briefings inc
      where inc.id = p_id and inc.report_status = 'published'
    )
  end
$$;
revoke all on function public.report_payload(text, text) from public;
grant execute on function public.report_payload(text, text) to anon, authenticated;

-- Counts per status, for the admin console and the sync check (no key needed).
create or replace function public.report_counts()
returns jsonb
language sql
stable
security definer
set search_path = reports, public
as $$
  select coalesce(jsonb_object_agg(report_status, n), '{}'::jsonb)
  from (select report_status, count(*) as n from reports.briefings group by 1) s
$$;
grant execute on function public.report_counts() to anon, authenticated;
