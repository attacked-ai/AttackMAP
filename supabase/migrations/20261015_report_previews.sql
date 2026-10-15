-- 20261015_report_previews.sql — free readers get the preview of a CMS report.
--
-- Until now report_html() handed the FULL report to anyone (anon included);
-- the subscriber lock was client-side only. From here:
--   • hub_reports.html_preview holds the free-reader copy (header, dossier,
--     Executive Summary; Subscribe in place of the rest and of Download PDF),
--     made by the admin console on every save (src/lib/reportPreview.js,
--     renderReport(..., { preview: true })).
--   • report_html() returns html to subscribers (is_subscriber(): tier
--     enterprise or admin) and html_preview to everyone else; a report with
--     no preview yet gets a title-only stub, never the full text.
--   • admin_upsert_report() stores html_preview; a save that changes html
--     without sending a preview (an older admin build) clears it, so a stale
--     preview never outlives its report.
-- The baked reports (public/reports) are gated separately: middleware.js.

alter table public.hub_reports add column if not exists html_preview text;

create or replace function public._html_esc(t text)
returns text language sql immutable set search_path = public as $$
  select replace(replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;

create or replace function public._report_stub(p_ref text, p_title text, p_subtitle text, p_summary text)
returns text language sql immutable set search_path = public as $$
  select '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'
    || _html_esc(p_title) || ' · Preview</title><style>body{margin:0;background:#fff;color:#1A1A1A;font:16px/1.6 Inter,system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:72px 22px}'
    || '.k{font:600 11px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#8A6D00}h1{font-size:34px;line-height:1.15;letter-spacing:-.02em;margin:14px 0 10px}'
    || '.s{color:#4A463E;font-size:18px}.lock{margin-top:36px;border-top:1px solid #E6E2D8;padding-top:28px}.lock h2{font-size:20px;margin:0 0 8px}'
    || 'button{margin-top:16px;background:#FCBD00;color:#0f0f0f;border:0;padding:12px 20px;font:700 12px/1 Inter,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}'
    || '@media print{body>*{display:none!important}body::before{content:"Download PDF is available to Attacked.ai subscribers.";display:block;padding:40px;font:600 16px Inter,sans-serif}}</style></head>'
    || '<body><main data-locked="preview"><div class="k">' || _html_esc(p_ref) || '</div><h1>' || _html_esc(p_title) || '</h1>'
    || case when coalesce(p_subtitle, '') <> '' then '<p class="s">' || _html_esc(p_subtitle) || '</p>' else '' end
    || case when coalesce(p_summary, '') <> '' then '<p>' || _html_esc(p_summary) || '</p>' else '' end
    || '<section class="lock" id="r-lock"><h2>The full briefing is for subscribers</h2><p>The complete analysis, sources and the Download PDF are part of an Attacked.ai subscription.</p>'
    || '<button type="button" data-subscribe onclick="subscribe()">Subscribe to read the full briefing</button></section></main>'
    || '<script>function subscribe(){ try{ window.top.location.href=''/?subscribe''; }catch(e){ location.href=''/?subscribe''; } } window.subscribe=subscribe;</script></body></html>'
$$;

create or replace function public.report_html(p_ref text)
returns text language sql stable security definer set search_path to 'public' as $$
  select case when public.is_subscriber() then r.html
              else coalesce(r.html_preview, public._report_stub(r.ref, r.title, r.subtitle, r.summary)) end
    from public.hub_reports r
   where r.ref = p_ref and r.status = 'published'
$$;

create or replace function public.admin_upsert_report(p jsonb)
returns setof hub_reports language plpgsql security definer set search_path to 'public' as $function$
declare r public.hub_reports; v_tags text[];
begin
  if not _is_admin() then raise exception 'not authorised'; end if;
  select coalesce(array_agg(x), '{}') into v_tags from jsonb_array_elements_text(coalesce(p->'tags', '[]'::jsonb)) x;
  if (p->>'id') is null then
    insert into public.hub_reports (ref, title, subtitle, summary, industry, primary_category, severity, incident_id, hero_image_url, author, tags, data, brand, html, html_preview, created_by)
    values (p->>'ref', p->>'title', p->>'subtitle', p->>'summary', p->>'industry', p->>'primary_category', (p->>'severity')::smallint, (p->>'incident_id')::bigint, p->>'hero_image_url', p->>'author', v_tags, p->'data', p->'brand', p->>'html', p->>'html_preview', auth.uid())
    returning * into r;
  else
    update public.hub_reports
       set ref = coalesce(p->>'ref', ref), title = coalesce(p->>'title', title), subtitle = p->>'subtitle', summary = p->>'summary',
           industry = p->>'industry', primary_category = p->>'primary_category', severity = (p->>'severity')::smallint,
           incident_id = (p->>'incident_id')::bigint, hero_image_url = p->>'hero_image_url', author = p->>'author', tags = v_tags,
           data = case when p ? 'data' then p->'data' else data end,
           brand = case when p ? 'brand' then p->'brand' else brand end,
           html = case when p ? 'html' then p->>'html' else html end,
           html_preview = case when p ? 'html_preview' then p->>'html_preview' when p ? 'html' then null else html_preview end,
           updated_at = now()
     where id = (p->>'id')::bigint
    returning * into r;
  end if;
  return next r;
end $function$;
