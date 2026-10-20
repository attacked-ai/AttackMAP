-- Incident pictures live in the backend (2026-09-23). APPLIED to project
-- ovenyjguhkgiceddzwna on 2026-09-23 through the write connection; kept here
-- as the record and for any future environment.
--
-- Until now every surface invented an incident picture in the browser at
-- render time (an on-the-fly AI image from the headline, or a category stock
-- photo). Now one picture per incident is generated ONCE by the incident-images
-- edge function, stored in the public `incident-media` bucket, and every
-- surface reads incidents.image_url.
--
-- 1. Columns on the table + the public view (CREATE OR REPLACE VIEW appends
--    columns at the end, so grants and security_invoker are untouched).
alter table sweep.incidents
  add column if not exists image_url text,
  add column if not exists image_source text,      -- 'generated' | 'manual'
  add column if not exists image_credit text,
  add column if not exists image_prompt text,      -- what the generator was asked, for regeneration
  add column if not exists image_updated_at timestamptz;

create or replace view public.incidents with (security_invoker = true) as
 select id, sweep_id, headline, summary, secondary_mappings, entity, sector, location_name, country, latitude, longitude,
        event_date, disclosure_date, primary_category, primary_subcategory_code, primary_subcategory_name, severity,
        severity_rationale, incident_day, industry, industry_id, article_body, origin, confidence,
        image_url, image_source, image_credit, image_updated_at, image_prompt
   from sweep.incidents;
alter view public.incidents set (security_invoker = true);

-- 2. The admin override writes the real table (the old body targeted
--    public.incidents.image_url, which had been dropped, and a vi_incidents
--    table that no longer exists). A manual picture is marked as such and is
--    never replaced by the generator.
create or replace function public.admin_set_incident_media(p_source text, p_incident_id bigint, p_image_url text, p_article_body text)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not _is_admin() then
    raise exception 'not authorised';
  end if;
  update sweep.incidents
     set image_url        = nullif(btrim(p_image_url), ''),
         image_source     = case when nullif(btrim(p_image_url), '') is null then null else 'manual' end,
         image_updated_at = now(),
         article_body     = coalesce(nullif(btrim(p_article_body), ''), article_body)
   where id = p_incident_id;
end;
$function$;

notify pgrst, 'reload schema';

-- 3. Keep new sweeps illustrated: every 10 minutes the function takes the next
--    incidents without a picture (12 per call, ~1 minute). Run AFTER the
--    function is deployed:  supabase functions deploy incident-images
-- select cron.schedule(
--   'incident-images-10min', '*/10 * * * *',
--   $$ select net.http_post(
--        url := 'https://ovenyjguhkgiceddzwna.supabase.co/functions/v1/incident-images',
--        headers := jsonb_build_object('Content-Type', 'application/json'),
--        body := jsonb_build_object('limit', 12, 'source', 'pg_cron'),
--        timeout_milliseconds := 125000); $$
-- );
-- Undo: select cron.unschedule('incident-images-10min');

-- 4. Backfill of the existing incidents: node scripts/backfill-incident-images.mjs
--    (drives the same function with parallel workers on disjoint id partitions).

-- Checks
--   select count(*) filter (where image_url is not null) as with_picture, count(*) from sweep.incidents;
--   select image_source, count(*) from sweep.incidents group by 1;
