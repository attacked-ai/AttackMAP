-- 20261015_report_previews_backfill.sql — one-off: html_preview for the CMS
-- reports authored before previews existed (ATK-2026-0928-YAN, -EUF).
-- Cuts the stored full HTML exactly as renderReport(..., { preview: true })
-- does: the Executive Summary stays; every later section, the takeaway and
-- every Download PDF button go; a Subscribe band takes their place. Each
-- anchor must be found or the whole block aborts. Uploaded reports
-- (ATK-2026-0928-GCH) keep the title-only stub until an admin re-saves them.
do $$
declare
  r record; h text; a int; b int;
  lock_html text := '<section class="r-sec r-lock" id="r-lock" data-locked="preview">'
    || '<div class="r-sec-head"><span class="r-sec-num">01-10</span><span class="r-sec-eyebrow">Subscriber briefing</span></div>'
    || '<h2 class="r-sec-title">The full briefing is for subscribers</h2>'
    || '<p class="r-sec-note">Severity assessment, causal analysis, comparables, frameworks, blast radius, GUARD controls, vendor intelligence, outlook, scenarios, analyst verdict, board takeaway, sources and the Download PDF.</p>'
    || '<button class="r-btn primary" data-subscribe onclick="subscribe()">Subscribe to read the full briefing</button></section>' || chr(10) || '    ';
  print_css text := '@media print{body>*{display:none!important}body::before{content:"Download PDF is available to Attacked.ai subscribers.";display:block;padding:40px;font:600 16px Inter,sans-serif}}';
  sub_js text := 'function subscribe(){ try{ window.top.location.href=''/?subscribe''; }catch(e){ location.href=''/?subscribe''; } } window.subscribe=subscribe;';
  sum_item text := '<button class="r-nav-item" data-target="r-sum">Executive summary</button>';
  sec_id text;
begin
  for r in select hr.id, hr.ref, hr.html from public.hub_reports hr where hr.ref in ('ATK-2026-0928-YAN', 'ATK-2026-0928-EUF') loop
    h := r.html;
    a := position('<section class="r-sec" id="' in h);
    b := position('<div class="r-end">' in h);
    if a = 0 or b = 0 or b < a or position('<section id="r-sum">' in h) not between 1 and a then raise exception 'section anchors: %', r.ref; end if;
    h := substr(h, 1, a - 1) || lock_html || substr(h, b);
    h := regexp_replace(h, '<button class="r-nav-item" data-target="r-(?!sum")[a-z]+">[^<]*</button>', '', 'g');
    if (length(h) - length(replace(h, sum_item, ''))) / length(sum_item) <> 1 then raise exception 'nav anchor: %', r.ref; end if;
    h := replace(h, sum_item, sum_item || '<button class="r-nav-item" data-target="r-lock">Full briefing · subscribers</button>');
    h := replace(h, '<button class="r-btn primary" data-print>↓ Download PDF</button>', '<button class="r-btn primary" data-subscribe onclick="subscribe()">Subscribe · full report + PDF</button>');
    h := replace(h, '<button class="r-btn" data-print>↓ Download PDF</button>', '<button class="r-btn " data-subscribe onclick="subscribe()">Subscribe · full report + PDF</button>');
    h := replace(h, '<button class="r-btn ghost" data-print>↓ Download PDF</button>', '<button class="r-btn ghost" data-subscribe onclick="subscribe()">Subscribe for the PDF</button>');
    if position('data-print>' in h) > 0 then raise exception 'print buttons left: %', r.ref; end if;
    if (length(h) - length(replace(h, '</head>', ''))) / 7 <> 1 or (length(h) - length(replace(h, '</script>', ''))) / 9 <> 1 then raise exception 'head/script anchors: %', r.ref; end if;
    h := replace(h, '</title>', ' · Preview</title>');
    h := replace(h, '</head>', '<style>' || print_css || '</style></head>');
    h := replace(h, '</script>', sub_js || '</script>');
    foreach sec_id in array array['r-sev','r-fcam','r-comp','r-frame','r-blast','r-ctrl','r-vend','r-out','r-scen','r-verdict','r-src','r-board'] loop
      if position('id="' || sec_id || '"' in h) > 0 then raise exception 'locked section % left in %', sec_id, r.ref; end if;
    end loop;
    update public.hub_reports set html_preview = h where hub_reports.id = r.id;
  end loop;
end $$;
