-- 20261030_reports_sync.sql — fill and refresh `reports.*` from the incident
-- reporting project, database to database (dblink), no files in between.
-- PUBLISHED briefings only (the owner's decision, 2026-10-30): pending and
-- excluded work stays in the incident project.
--
-- Run once after 20261030_reports_schema.sql. Then the copy itself:
--
--   select reports.sync_from_incident_db('<connection string of the incident project>');
--
-- The connection string comes from the incident project's dashboard
-- (Connect → Session pooler, "postgresql://postgres.wfnvwtmpvzuxjmebqffq:…").
-- It is used for the duration of the call only; nothing stores it. Re-run the
-- same line whenever new briefings are published upstream: rows are upserted
-- by id and rows no longer published upstream are removed here. Each run
-- writes a line to reports.sync_log.
--
-- Parts, for a slow link: 'briefings', 'children', 'logos' (the vendor
-- logos; the slowest part), 'reference' (reporters, industries), or 'all'.
create extension if not exists dblink with schema extensions;

create or replace function reports.sync_from_incident_db(p_conn text, p_part text default 'all')
returns jsonb
language plpgsql
security definer
set search_path = reports, extensions, public
as $$
declare
  c jsonb := '{}'::jsonb;
  n bigint;
  log_id bigint;
  pub constant text := 'select id from public.incidents where report_status = ''published''';
begin
  insert into reports.sync_log (part) values (p_part) returning id into log_id;

  if p_part in ('all', 'reference') then
    insert into reports.reporters (code, name, role, desk, outlet)
    select * from dblink(p_conn, 'select code, name, role, desk, outlet from public.reporters')
      as t(code text, name text, role text, desk text, outlet text)
    on conflict (code) do update set name = excluded.name, role = excluded.role, desk = excluded.desk, outlet = excluded.outlet;
    get diagnostics n = row_count; c := c || jsonb_build_object('reporters', n);

    insert into reports.industries (slug, name, blurb, sort)
    select * from dblink(p_conn, 'select slug, name, blurb, sort from public.industries')
      as t(slug text, name text, blurb text, sort integer)
    on conflict (slug) do update set name = excluded.name, blurb = excluded.blurb, sort = excluded.sort;
    get diagnostics n = row_count; c := c || jsonb_build_object('industries', n);
  end if;

  if p_part in ('all', 'briefings') then
    insert into reports.briefings (
      id, industry_slug, title, subtitle, severity, confidence, primary_category, categories, status, created_at, updated_at,
      image_url, disclosed_date, primary_date, ref, kicker, standfirst, reporter_code, dek_tail, cause_tag, pull_quote, takeaway,
      footnote, chain_lead, narrative, exec_bullets, analyst_verdict, categories_touched, dossier, metrics, chain, scenarios,
      outlook, frameworks, severity_dims, x, published_at, report_status, entity, ticker, country, primary_subcategory,
      location_name, location_country, location_lat, location_lng, countries_affected, event_start, event_end, event_tz,
      disclosed_at, assessed_at, entity_legal_name, entity_cik, entity_lei, entity_website, entity_country, entity_hq_city,
      entity_hq_lat, entity_hq_lng, entity_org_key, run_id, writer, writer_saved_at, report_format, synced_at)
    select t.*, now() from dblink(p_conn, $q$
      select id, industry_slug, title, subtitle, severity, confidence, primary_category, categories, status, created_at, updated_at,
        image_url, disclosed_date, primary_date, ref, kicker, standfirst, reporter_code, dek_tail, cause_tag, pull_quote, takeaway,
        footnote, chain_lead, narrative, exec_bullets, analyst_verdict, categories_touched, dossier, metrics, chain, scenarios,
        outlook, frameworks, severity_dims, x, published_at, report_status, entity, ticker, country, primary_subcategory,
        location_name, location_country, location_lat, location_lng, countries_affected, event_start, event_end, event_tz,
        disclosed_at, assessed_at, entity_legal_name, entity_cik, entity_lei, entity_website, entity_country, entity_hq_city,
        entity_hq_lat, entity_hq_lng, entity_org_key, run_id, writer, writer_saved_at, report_format
      from public.incidents where report_status = 'published' $q$)
      as t(id text, industry_slug text, title text, subtitle text, severity integer, confidence text, primary_category text,
           categories text[], status text, created_at timestamptz, updated_at timestamptz, image_url text, disclosed_date date,
           primary_date date, ref text, kicker text, standfirst text, reporter_code text, dek_tail text, cause_tag text,
           pull_quote text, takeaway text, footnote text, chain_lead text, narrative jsonb, exec_bullets jsonb,
           analyst_verdict jsonb, categories_touched jsonb, dossier jsonb, metrics jsonb, chain jsonb, scenarios jsonb,
           outlook jsonb, frameworks jsonb, severity_dims jsonb, x jsonb, published_at timestamptz, report_status text,
           entity text, ticker text, country text, primary_subcategory text, location_name text, location_country text,
           location_lat double precision, location_lng double precision, countries_affected text[], event_start timestamptz,
           event_end timestamptz, event_tz text, disclosed_at timestamptz, assessed_at timestamptz, entity_legal_name text,
           entity_cik text, entity_lei text, entity_website text, entity_country text, entity_hq_city text,
           entity_hq_lat double precision, entity_hq_lng double precision, entity_org_key text, run_id bigint, writer text,
           writer_saved_at timestamptz, report_format smallint)
    on conflict (id) do update set
      industry_slug = excluded.industry_slug, title = excluded.title, subtitle = excluded.subtitle, severity = excluded.severity,
      confidence = excluded.confidence, primary_category = excluded.primary_category, categories = excluded.categories,
      status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at, image_url = excluded.image_url,
      disclosed_date = excluded.disclosed_date, primary_date = excluded.primary_date, ref = excluded.ref, kicker = excluded.kicker,
      standfirst = excluded.standfirst, reporter_code = excluded.reporter_code, dek_tail = excluded.dek_tail,
      cause_tag = excluded.cause_tag, pull_quote = excluded.pull_quote, takeaway = excluded.takeaway, footnote = excluded.footnote,
      chain_lead = excluded.chain_lead, narrative = excluded.narrative, exec_bullets = excluded.exec_bullets,
      analyst_verdict = excluded.analyst_verdict, categories_touched = excluded.categories_touched, dossier = excluded.dossier,
      metrics = excluded.metrics, chain = excluded.chain, scenarios = excluded.scenarios, outlook = excluded.outlook,
      frameworks = excluded.frameworks, severity_dims = excluded.severity_dims, x = excluded.x, published_at = excluded.published_at,
      report_status = excluded.report_status, entity = excluded.entity, ticker = excluded.ticker, country = excluded.country,
      primary_subcategory = excluded.primary_subcategory, location_name = excluded.location_name,
      location_country = excluded.location_country, location_lat = excluded.location_lat, location_lng = excluded.location_lng,
      countries_affected = excluded.countries_affected, event_start = excluded.event_start, event_end = excluded.event_end,
      event_tz = excluded.event_tz, disclosed_at = excluded.disclosed_at, assessed_at = excluded.assessed_at,
      entity_legal_name = excluded.entity_legal_name, entity_cik = excluded.entity_cik, entity_lei = excluded.entity_lei,
      entity_website = excluded.entity_website, entity_country = excluded.entity_country, entity_hq_city = excluded.entity_hq_city,
      entity_hq_lat = excluded.entity_hq_lat, entity_hq_lng = excluded.entity_hq_lng, entity_org_key = excluded.entity_org_key,
      run_id = excluded.run_id, writer = excluded.writer, writer_saved_at = excluded.writer_saved_at,
      report_format = excluded.report_format, synced_at = now();
    get diagnostics n = row_count; c := c || jsonb_build_object('briefings', n);

    -- briefings no longer published upstream go here too (children follow by cascade)
    delete from reports.briefings b where b.id not in (select id from dblink(p_conn, pub) as t(id text));
    get diagnostics n = row_count; c := c || jsonb_build_object('briefings_removed', n);
  end if;

  if p_part in ('all', 'children') then
    insert into reports.blast (id, briefing_id, seq, n, r, sev, d, x, legal_name, ticker, cik, lei, country_code, hq_city, hq_lat, hq_lng,
      website, org_key, exposure_group, entity_type, pathway, timeframe, parent_name, parent_ticker, parent_cik, id_note)
    select * from dblink(p_conn, $q$ select id, incident_id, seq, n, r, sev, d, x, legal_name, ticker, cik, lei, country_code, hq_city,
        hq_lat, hq_lng, website, org_key, exposure_group, entity_type, pathway, timeframe, parent_name, parent_ticker, parent_cik, id_note
      from public.incident_blast where incident_id in (select id from public.incidents where report_status = 'published') $q$)
      as t(id bigint, briefing_id text, seq integer, n text, r text, sev integer, d text, x jsonb, legal_name text, ticker text,
           cik text, lei text, country_code text, hq_city text, hq_lat double precision, hq_lng double precision, website text,
           org_key text, exposure_group text, entity_type text, pathway text, timeframe text, parent_name text, parent_ticker text,
           parent_cik text, id_note text)
    on conflict (id) do update set briefing_id = excluded.briefing_id, seq = excluded.seq, n = excluded.n, r = excluded.r,
      sev = excluded.sev, d = excluded.d, x = excluded.x, legal_name = excluded.legal_name, ticker = excluded.ticker, cik = excluded.cik,
      lei = excluded.lei, country_code = excluded.country_code, hq_city = excluded.hq_city, hq_lat = excluded.hq_lat,
      hq_lng = excluded.hq_lng, website = excluded.website, org_key = excluded.org_key, exposure_group = excluded.exposure_group,
      entity_type = excluded.entity_type, pathway = excluded.pathway, timeframe = excluded.timeframe, parent_name = excluded.parent_name,
      parent_ticker = excluded.parent_ticker, parent_cik = excluded.parent_cik, id_note = excluded.id_note;
    get diagnostics n = row_count; c := c || jsonb_build_object('blast', n);
    delete from reports.blast where id not in (select id from dblink(p_conn, 'select id from public.incident_blast') as t(id bigint));

    insert into reports.sources (id, briefing_id, seq, t, s, url, publisher, published_on)
    select * from dblink(p_conn, $q$ select id, incident_id, seq, t, s, url, publisher, published_on from public.incident_sources
      where incident_id in (select id from public.incidents where report_status = 'published') $q$)
      as t(id bigint, briefing_id text, seq integer, t text, s text, url text, publisher text, published_on date)
    on conflict (id) do update set briefing_id = excluded.briefing_id, seq = excluded.seq, t = excluded.t, s = excluded.s,
      url = excluded.url, publisher = excluded.publisher, published_on = excluded.published_on;
    get diagnostics n = row_count; c := c || jsonb_build_object('sources', n);
    delete from reports.sources where id not in (select id from dblink(p_conn, 'select id from public.incident_sources') as t(id bigint));

    insert into reports.vendors (id, briefing_id, seq, n, maker, dom, kind, vtype, prod, rat, map, x)
    select * from dblink(p_conn, $q$ select id, incident_id, seq, n, maker, dom, kind, vtype, prod, rat, map, x from public.incident_vendors
      where incident_id in (select id from public.incidents where report_status = 'published') $q$)
      as t(id bigint, briefing_id text, seq integer, n text, maker text, dom text, kind text, vtype text, prod text, rat text, map text, x jsonb)
    on conflict (id) do update set briefing_id = excluded.briefing_id, seq = excluded.seq, n = excluded.n, maker = excluded.maker,
      dom = excluded.dom, kind = excluded.kind, vtype = excluded.vtype, prod = excluded.prod, rat = excluded.rat, map = excluded.map, x = excluded.x;
    get diagnostics n = row_count; c := c || jsonb_build_object('vendors', n);
    delete from reports.vendors where id not in (select id from dblink(p_conn, 'select id from public.incident_vendors') as t(id bigint));

    insert into reports.vendor_controls (id, vendor_id, seq, ac, t)
    select * from dblink(p_conn, $q$ select c.id, c.vendor_id, c.seq, c.ac, c.t from public.incident_vendor_controls c
      join public.incident_vendors v on v.id = c.vendor_id
      where v.incident_id in (select id from public.incidents where report_status = 'published') $q$)
      as t(id bigint, vendor_id bigint, seq integer, ac text, t text)
    on conflict (id) do update set vendor_id = excluded.vendor_id, seq = excluded.seq, ac = excluded.ac, t = excluded.t;
    get diagnostics n = row_count; c := c || jsonb_build_object('vendor_controls', n);
    delete from reports.vendor_controls where id not in (select id from dblink(p_conn, 'select id from public.incident_vendor_controls') as t(id bigint));

    insert into reports.controls (id, briefing_id, seq, code, cat, name, owner, obj, fail, good, x, mc_id, subcat, mc_confidence, mc_why)
    select * from dblink(p_conn, $q$ select id, incident_id, seq, code, cat, name, owner, obj, fail, good, x, mc_id, subcat, mc_confidence, mc_why
      from public.incident_controls where incident_id in (select id from public.incidents where report_status = 'published') $q$)
      as t(id bigint, briefing_id text, seq integer, code text, cat text, name text, owner text, obj text, fail text, good text, x jsonb,
           mc_id text, subcat text, mc_confidence text, mc_why text)
    on conflict (id) do update set briefing_id = excluded.briefing_id, seq = excluded.seq, code = excluded.code, cat = excluded.cat,
      name = excluded.name, owner = excluded.owner, obj = excluded.obj, fail = excluded.fail, good = excluded.good, x = excluded.x,
      mc_id = excluded.mc_id, subcat = excluded.subcat, mc_confidence = excluded.mc_confidence, mc_why = excluded.mc_why;
    get diagnostics n = row_count; c := c || jsonb_build_object('controls', n);
    delete from reports.controls where id not in (select id from dblink(p_conn, 'select id from public.incident_controls') as t(id bigint));

    insert into reports.comparables (id, briefing_id, seq, case_name, year, what, implication, x)
    select * from dblink(p_conn, $q$ select id, incident_id, seq, case_name, year, what, implication, x from public.incident_comparables
      where incident_id in (select id from public.incidents where report_status = 'published') $q$)
      as t(id bigint, briefing_id text, seq integer, case_name text, year text, what text, implication text, x jsonb)
    on conflict (id) do update set briefing_id = excluded.briefing_id, seq = excluded.seq, case_name = excluded.case_name,
      year = excluded.year, what = excluded.what, implication = excluded.implication, x = excluded.x;
    get diagnostics n = row_count; c := c || jsonb_build_object('comparables', n);
    delete from reports.comparables where id not in (select id from dblink(p_conn, 'select id from public.incident_comparables') as t(id bigint));

    insert into reports.causes (id, briefing_id, seq, tier, hyp, rat, why, cats, bp, cmp, guard, x)
    select * from dblink(p_conn, $q$ select id, incident_id, seq, tier, hyp, rat, why, cats, bp, cmp, guard, x from public.incident_causes
      where incident_id in (select id from public.incidents where report_status = 'published') $q$)
      as t(id bigint, briefing_id text, seq integer, tier text, hyp text, rat text, why text, cats jsonb, bp jsonb, cmp jsonb, guard jsonb, x jsonb)
    on conflict (id) do update set briefing_id = excluded.briefing_id, seq = excluded.seq, tier = excluded.tier, hyp = excluded.hyp,
      rat = excluded.rat, why = excluded.why, cats = excluded.cats, bp = excluded.bp, cmp = excluded.cmp, guard = excluded.guard, x = excluded.x;
    get diagnostics n = row_count; c := c || jsonb_build_object('causes', n);
    delete from reports.causes where id not in (select id from dblink(p_conn, 'select id from public.incident_causes') as t(id bigint));

    insert into reports.guard_map (id, briefing_id, seq, cat, subcat, role, confidence, why, mapped_by, mapped_at)
    select * from dblink(p_conn, $q$ select id, incident_id, seq, cat, subcat, role, confidence, why, mapped_by, mapped_at
      from public.incident_guard_map where incident_id in (select id from public.incidents where report_status = 'published') $q$)
      as t(id bigint, briefing_id text, seq integer, cat text, subcat text, role text, confidence text, why text, mapped_by text, mapped_at timestamptz)
    on conflict (id) do update set briefing_id = excluded.briefing_id, seq = excluded.seq, cat = excluded.cat, subcat = excluded.subcat,
      role = excluded.role, confidence = excluded.confidence, why = excluded.why, mapped_by = excluded.mapped_by, mapped_at = excluded.mapped_at;
    get diagnostics n = row_count; c := c || jsonb_build_object('guard_map', n);
    delete from reports.guard_map where id not in (select id from dblink(p_conn, 'select id from public.incident_guard_map') as t(id bigint));
  end if;

  if p_part in ('all', 'logos') then
    insert into reports.vendor_logos (vendor_id, logo)
    select * from dblink(p_conn, $q$ select l.vendor_id, l.logo from public.vendor_logos l join public.incident_vendors v on v.id = l.vendor_id
      where v.incident_id in (select id from public.incidents where report_status = 'published') $q$)
      as t(vendor_id bigint, logo text)
    on conflict (vendor_id) do update set logo = excluded.logo;
    get diagnostics n = row_count; c := c || jsonb_build_object('vendor_logos', n);
    delete from reports.vendor_logos where vendor_id not in (select vendor_id from dblink(p_conn, 'select vendor_id from public.vendor_logos') as t(vendor_id bigint));
  end if;

  update reports.sync_log set counts = c, finished_at = now() where id = log_id;
  return c;
exception when others then
  update reports.sync_log set error = sqlerrm, finished_at = now() where id = log_id;
  raise;
end
$$;
revoke all on function reports.sync_from_incident_db(text, text) from public, anon, authenticated;
