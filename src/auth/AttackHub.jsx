// ─────────────────────────────────────────────────────────────────────────
// AttackHub — the public Attacked Hub (?hub), FT-style editorial front page.
//
// Financial-Times homepage layout (centred masthead, category nav that doubles
// as a filter, 3-column hero, Top Stories, Spotlight, per-category section bands
// with "More in X" rails, GUARD Analysis op-eds, a cinematic Deconstructed band,
// Most Critical, and a paginated Latest grid) — rendered in our brand: white
// body, gold #FCBD00, single Inter typeface, dark SiteNav/SiteFooter.
//
// Fully data-driven and scalable: the live feed merges `incidents` +
// `vi_incidents` (as the map does) and every section/band/KPI is derived from
// that array, so it grows with the data. Clicking any incident opens the full
// briefing in-hub (ArticleView) — no navigation away. CTAs route to the map.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useRef } from "react";
import { supabase } from "../lib/supabaseClient";
import { isSubscriber } from "../lib/taxonomy";
import { prepareReportFrame } from "../lib/reportLock";
import { reportHtml } from "../lib/api";
import { fetchFullReport, fetchReportHtml, listPublishedReports } from "../lib/reports";
import { useAuth } from "./AuthProvider";
import { AuthModal } from "./AuthModal";
import { SiteNav } from "./SiteNav";
import { SiteFooter } from "./SiteFooter";
import { SEVERITY_INK, SEVERITY_CHIP } from "../brand.js";

const GOLD = "#FCBD00", GOLD_D = "#8A6D00", OB = "#1A1A1A";  // GOLD_D = the reference's --gold-text; 4.92:1 on white  // GOLD_D darkened from #8A6D00: on the cream ground (#F5F3ED) it measured 4.43:1, just under the 4.5 minimum for the 10px kicker labels.
const SEV_C = { 5: "#FF3B30", 4: "#FF6B35", 3: GOLD, 2: "#34C759", 1: "#8E8E93" };
const SEV_L = { 5: "CRITICAL", 4: "HIGH", 3: "MEDIUM", 2: "LOW", 1: "MINIMAL" };
const CAT_NAME = {
  CYB: "Cyber", DAT: "Data & Privacy", ENV: "Environmental", FIN: "Financial", GEO: "Geopolitical",
  OPS: "Operations", PHY: "Physical Security", PPL: "People", REG: "Regulatory", REP: "Reputation",
  STR: "Strategic", TEC: "Technology", TPR: "Third Party",
};
// Shorter labels for the single-line category nav (full names used in headings).
const CAT_SHORT = {
  CYB: "Cyber", DAT: "Data", ENV: "Environment", FIN: "Financial", GEO: "Geopolitical",
  OPS: "Operations", PHY: "Physical", PPL: "People", REG: "Regulatory", REP: "Reputation",
  STR: "Strategic", TEC: "Technology", TPR: "Third Party",
};
const CATEGORY_IMG = {
  CYB: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=1000&h=667&q=70&auto=format&fit=crop",
  DAT: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=1000&h=667&q=70&auto=format&fit=crop",
  FIN: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1000&h=667&q=70&auto=format&fit=crop",
  GEO: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1000&h=667&q=70&auto=format&fit=crop",
  REG: "https://images.unsplash.com/photo-1589829545856-d10d557cf95f?w=1000&h=667&q=70&auto=format&fit=crop",
  PHY: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=1000&h=667&q=70&auto=format&fit=crop",
  PPL: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=1000&h=667&q=70&auto=format&fit=crop",
  TEC: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=1000&h=667&q=70&auto=format&fit=crop",
  STR: "https://images.unsplash.com/photo-1605810230434-7631ac76ec81?w=1000&h=667&q=70&auto=format&fit=crop",
  REP: "https://images.unsplash.com/photo-1495020689067-958852a7765e?w=1000&h=667&q=70&auto=format&fit=crop",
  TPR: "https://images.unsplash.com/photo-1556761175-5973dc0f32e7?w=1000&h=667&q=70&auto=format&fit=crop",
  OPS: "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=1000&h=667&q=70&auto=format&fit=crop",
  ENV: "https://images.unsplash.com/photo-1473773508845-188df298d2d1?w=1000&h=667&q=70&auto=format&fit=crop",
  _default: "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?w=1000&h=667&q=70&auto=format&fit=crop",
};
const PAGE_SIZE = 12;

// A varied image pool so a single-category view doesn't repeat one photo on
// every card. Big "lead" slots stay thematic (imLead); small cards spread across
// the pool deterministically by incident id (imVaried), so the same incident
// always gets the same image but neighbours differ.
// Extra serious risk/intel imagery (verified-loading) to widen the variety pool
// so single-category pages don't repeat photos.
const EXTRA_POOL = [
  "1526374965328-7f61d4dc18c5", "1510511336377-1a9caa095849", "1551288049-bebda4e38f71",
  "1597852074816-d933c7d2b988", "1488229297570-58520851e868", "1590283603385-17ffb3a7f29f",
  "1612178991541-b48cc8e92a4d", "1502920917128-1aa500764cbd", "1494412574643-ff11b0a5c1c3",
  "1473341304170-971dccb5ac1e", "1486406146926-c627a92ad1ab", "1581092160562-40aa08e78837",
  "1589578527966-fdac0f44566c", "1444723121867-7a241cacace9", "1581094794329-c8112a89af12",
  "1504384764586-bb4cdc1707b0", "1526628953301-3e589a6a8b74",
].map(id => `https://images.unsplash.com/photo-${id}?w=1000&h=667&q=70&auto=format&fit=crop`);
const IMG_POOL = [...Object.keys(CATEGORY_IMG).filter(k => k !== "_default").map(k => CATEGORY_IMG[k]), ...EXTRA_POOL];
function hashId(id) { let h = 5381; const s = String(id); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; }
const imLead = (a) => a.image_url || CATEGORY_IMG[a.primary_category] || CATEGORY_IMG._default;
const imVaried = (a) => a.image_url || IMG_POOL[hashId(a.id) % IMG_POOL.length] || CATEGORY_IMG._default;
const catName = (a) => CAT_NAME[a.primary_category] || a.primary_category || "OPS";
const place = (a) => [a.entity, a.country].filter(Boolean).join(" · ");
const fmtDay = (iso) => { try { return new Date(iso + "T00:00:00Z").toUTCString().slice(0, 16); } catch { return iso || ""; } };
const fmtShort = (iso) => { try { return new Date(iso + "T00:00:00Z").toUTCString().slice(5, 11); } catch { return iso || ""; } };

// Scoped FT CSS — everything namespaced under .hubft so it can't collide with
// the rest of the app. Injected once. Hover/zoom/responsive live here; data and
// layout are React. A single Inter typeface throughout.
const HUB_CSS = `
.hubft{--gold:${GOLD};--gold-d:${GOLD_D};--ink:#0A0A0A;--sub:#3F3F46;--mut:#71717A;--line:#E7E7E9;--rule:#D6D6DA;--ob:${OB};--paper:#FFFFFF;--paper-2:#FAFAFA;--paper-3:#F4F4F5;--paper-warm:#FAFAFA;--gold-tint:#FEF8E3;--gold-edge:#EBCB5B;background:#FFFFFF;color:var(--ink);font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.hubft button,.hubft select,.hubft input,.hubft textarea,.hubft optgroup{font-family:Inter,system-ui,sans-serif}
.hubft .wrap{max-width:1280px;margin:0 auto;padding:0 clamp(18px,4vw,44px)}
.hubft .kick{font-size:10px;font-weight:700;letter-spacing:.17em;text-transform:uppercase;color:var(--gold-d)}
.hubft .sev{display:inline-block;font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:2px 7px;border-radius:0;border:1px solid;white-space:nowrap}
.hubft .by{font-size:11px;color:var(--mut)}
.hubft img{display:block}
.hubft .mast{text-align:center;padding:34px 0 22px;border-bottom:1px solid var(--line);background:radial-gradient(ellipse 60% 100% at 50% 0%,rgba(252,189,0,.07),transparent 70%)}
.hubft .mast .bar{width:54px;height:3px;background:var(--gold);margin:0 auto 18px}
.hubft .mast h1{font-size:clamp(44px,6.6vw,78px);font-weight:600;line-height:.95;letter-spacing:-.055em;text-wrap:balance}
.hubft .mast h1 i{color:var(--gold-d);font-style:italic}
.hubft .mast p{max-width:560px;margin:12px auto 0;font-size:14px;line-height:1.55;color:var(--mut)}
.hubft .kpis{display:flex;justify-content:center;flex-wrap:wrap;margin-top:18px}
.hubft .kpis .k{padding:0 22px;border-right:1px solid var(--line)}
.hubft .kpis .k:last-child{border-right:none}
.hubft .kpis .v{font-size:21px;font-weight:700}
.hubft .kpis .l{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);margin-top:2px}
.hubft .catnav{border-bottom:1px solid var(--rule);background:rgba(255,255,255,.92);backdrop-filter:blur(12px)}
.hubft .catnav .wrap{display:flex;flex-wrap:nowrap;justify-content:safe center;gap:0;overflow-x:auto;scrollbar-width:none}
.hubft .catnav .wrap::-webkit-scrollbar{display:none}
.hubft .catnav button{padding:12px 9px;background:none;border:none;cursor:pointer;font-family:inherit;font-size:11.5px;font-weight:500;letter-spacing:0;text-transform:uppercase;color:var(--mut);white-space:nowrap;border-bottom:2px solid transparent}
.hubft .catnav button.on{color:var(--ink);font-weight:700;border-bottom-color:var(--gold)}
.hubft .catnav button:hover{color:var(--ink)}
.hubft .filterbar{display:flex;justify-content:flex-end;align-items:center;gap:10px;flex-wrap:wrap;padding:18px 0 0}
.hubft .filterbar .cnt{margin-right:auto;font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}
.hubft select{appearance:none;-webkit-appearance:none;padding:7px 28px 7px 11px;border-radius:0;cursor:pointer;outline:none;background:#fff;border:1px solid var(--line);color:var(--sub);font-family:inherit;font-size:11px;font-weight:500;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236E6A60' stroke-width='2.5'><path d='M6 9l6 6 6-6'/></svg>");background-repeat:no-repeat;background-position:right 9px center}
.hubft select.act{background-color:rgba(252,189,0,.12);border-color:rgba(252,189,0,.4);color:var(--gold-d)}
.hubft .clr{padding:7px 12px;border-radius:0;cursor:pointer;background:transparent;border:1px solid var(--line);color:var(--mut);font-family:inherit;font-size:10.5px;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.hubft .sh{display:flex;align-items:center;gap:18px;margin:4px 0 16px}
.hubft .sh .ln{flex:1;border-top:1px solid rgba(252,189,0,.42)}
.hubft .sh h2{font-weight:700;font-size:17px;letter-spacing:.2em;text-transform:uppercase;white-space:nowrap}
.hubft .sh.l{justify-content:flex-start;border-bottom:2px solid var(--gold);padding-bottom:8px;margin-bottom:18px;gap:12px}
.hubft .sh.l .ln{display:none}.hubft .sh.l h2{font-size:20px;letter-spacing:-.01em;text-transform:none}
.hubft .sh.l .sq{width:9px;height:9px;border-radius:0;box-shadow:0 0 0 3px var(--gold-tint)}
.hubft .sh.l .more{margin-left:auto;font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--gold-d);background:none;border:none;cursor:pointer;font-family:inherit;text-transform:uppercase}
.hubft .sec{padding:20px 0 0}
.hubft .hero{display:grid;grid-template-columns:.92fr 1.5fr .92fr;gap:28px;padding:18px 0 0;align-items:start}
.hubft .col{display:flex;flex-direction:column}
.hubft .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hubft .rm{font-size:11px;font-weight:600;color:var(--gold-d);letter-spacing:.06em;text-transform:uppercase}
.hubft .lead{cursor:pointer}
.hubft .lead .img{border:1px solid var(--line);overflow:hidden;margin-bottom:15px;transition:border-color .22s,box-shadow .22s}
.hubft .lead .img img{width:100%}
.hubft .lead:hover .img{border-color:var(--gold);box-shadow:0 16px 38px rgba(20,20,20,.13)}
.hubft .lead h2{font-size:clamp(24px,2.8vw,34px);font-weight:700;line-height:1.1;letter-spacing:-.01em;margin:11px 0 0}
.hubft .lead:hover h2{color:var(--gold-d)}
.hubft .lead .dek{margin-top:13px;font-size:15px;line-height:1.66;color:var(--sub);-webkit-line-clamp:4;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .side{cursor:pointer;padding-bottom:18px}
.hubft .side h3{font-size:21px;font-weight:600;line-height:1.08;letter-spacing:-.034em;margin:9px 0 0}
.hubft .side:hover h3{color:var(--gold-d)}
.hubft .side .dek{margin-top:9px;font-size:13px;line-height:1.55;color:var(--sub);-webkit-line-clamp:3;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .side+.side{border-top:1px solid var(--line);padding-top:18px}
.hubft .picks-h{font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;padding-bottom:11px;border-bottom:2px solid var(--ink)}
.hubft .ri{display:flex;gap:12px;padding:12px 0;border-top:1px solid var(--line);cursor:pointer}
.hubft .rail .ri:first-child{border-top:none}
.hubft .ri .num{font-size:20px;font-weight:700;color:var(--gold-d);line-height:1;min-width:24px}
.hubft .ri h4{font-size:18px;font-weight:600;line-height:1.16;-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .ri:hover h4{color:var(--gold-d)}
.hubft .ridek{font-size:13px;line-height:1.5;color:var(--sub);margin-top:5px;-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .mrow{display:flex;align-items:center;gap:7px;margin-bottom:3px;flex-wrap:wrap}
.hubft .g4{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}
.hubft .story{cursor:pointer}
.hubft .story .img{border:1px solid var(--line);overflow:hidden;margin-bottom:11px}
.hubft .story .img img{width:100%}
.hubft .story h3{font-size:20px;font-weight:600;line-height:1.1;letter-spacing:-.032em;margin-top:7px;-webkit-line-clamp:3;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .story:hover h3{color:var(--gold-d)}
.hubft .spot{display:grid;grid-template-columns:1.7fr 1fr;gap:30px;align-items:start}
.hubft .spot .big,.hubft .spot .aside{cursor:pointer}
.hubft .spot .img{overflow:hidden;border:1px solid var(--line);margin-bottom:12px}
.hubft .spot .img img{width:100%}
.hubft .spot .big h3{font-size:26px;font-weight:700;line-height:1.08;margin-top:6px}
.hubft .spot .big:hover h3{color:var(--gold-d)}
.hubft .spot .big .dek{margin-top:11px;font-size:14px;color:var(--sub);line-height:1.6;-webkit-line-clamp:3;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .spot .aside{display:block;margin-bottom:22px}
.hubft .spot .aside h3{font-size:23px;font-weight:600;line-height:1.14;margin-top:6px}
.hubft .spot .aside:hover h3{color:var(--gold-d)}
.hubft .band{display:grid;grid-template-columns:1.5fr 1fr;gap:34px;align-items:start}
.hubft .band .feat{cursor:pointer}
.hubft .band .feat .img{overflow:hidden;border:1px solid var(--line);margin-bottom:13px}
.hubft .band .feat .img img{width:100%}
.hubft .band .feat h3{font-size:24px;font-weight:700;line-height:1.1;margin-top:6px}
.hubft .band .feat:hover h3{color:var(--gold-d)}
.hubft .band .feat .dek{margin-top:10px;font-size:14px;color:var(--sub);line-height:1.6;-webkit-line-clamp:3;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .morehead{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);padding-bottom:10px;border-bottom:1px solid var(--ink)}
.hubft .moreitem{display:block;padding:12px 0;border-top:1px solid var(--line);cursor:pointer}
.hubft .moreitem:first-of-type{border-top:none}
.hubft .moreitem h4{font-size:18px;font-weight:600;line-height:1.18;-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .moreitem:hover h4{color:var(--gold-d)}
.hubft .analysis{background:#FAF8F3;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.hubft .an3{display:grid;grid-template-columns:repeat(3,1fr);gap:30px}
.hubft .opc{cursor:pointer}
.hubft .opc .q{font-size:34px;line-height:0;color:var(--gold-d);height:18px}
.hubft .opc h3{font-size:23px;font-weight:700;line-height:1.18;margin-top:6px}
.hubft .opc:hover h3{color:var(--gold-d)}
.hubft .opc p{margin-top:9px;font-size:13px;color:var(--sub);line-height:1.6;-webkit-line-clamp:4;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .opc .auth{display:flex;align-items:center;gap:10px;margin-top:13px}
.hubft .opc .av{width:38px;height:38px;border-radius:50%;background:rgba(252,189,0,.14);border:1px solid var(--gold-d);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--gold-d)}
.hubft .opc .an{font-size:12px;font-weight:700}.hubft .opc .ad{font-size:10px;color:var(--mut)}
.hubft .decon{background:var(--ob);color:#fff}
.hubft .decon .in{display:grid;grid-template-columns:1.3fr 1fr;gap:34px;align-items:center}
.hubft .decon .img{position:relative;overflow:hidden;border-radius:0;cursor:pointer}
.hubft .decon .img img{width:100%}
.hubft .decon .tag{display:inline-block;margin-top:12px;background:var(--gold);color:#1A1A1A;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:5px 11px}
.hubft .decon h2{font-size:clamp(28px,3vw,40px);font-weight:700;line-height:1.08}
.hubft .decon p{margin-top:14px;font-size:14px;color:#bdbdbd;line-height:1.66}
.hubft .decon .steps{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
.hubft .decon .step{font-size:10px;color:#A8A8A8;border:1px solid #333;border-radius:0;padding:5px 9px}
.hubft .decon .step b{color:var(--gold)}
.hubft .btn{display:inline-block;background:var(--gold);color:#1A1A1A;border:none;cursor:pointer;font-family:inherit;font-size:11.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;padding:12px 24px;border-radius:0;transition:transform .15s}
.hubft .btn:hover{transform:translateY(-2px)}
.hubft .btn.gh{background:transparent;color:#fff;border:1px solid #444}
.hubft .crit{display:grid;grid-template-columns:1fr 1fr;gap:0 48px}
.hubft .latest{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,290px),1fr));gap:26px}
.hubft .goldband{background:var(--gold);color:#14130F;margin:34px 0 10px}.hubft .goldband .in{display:grid;grid-template-columns:1.5fr repeat(3,1fr)}.hubft .goldband .c{padding:26px 26px;border-left:1px solid rgba(20,19,15,.18)}.hubft .goldband .c:first-child{border-left:none}.hubft .goldband .lede{font-size:18px;font-weight:600;line-height:1.28;letter-spacing:-.03em;max-width:30ch}.hubft .goldband strong{display:block;font-size:36px;line-height:1;font-weight:600;letter-spacing:-.05em}.hubft .goldband em{font-style:normal;display:block;margin-top:9px;font-size:10.5px;text-transform:uppercase;letter-spacing:.13em;font-weight:700;opacity:.72;line-height:1.35}@media(max-width:860px){.hubft .goldband .in{grid-template-columns:1fr 1fr}.hubft .goldband .c:nth-child(3){border-left:none}}.hubft .pullquote{margin:46px 0;padding-top:22px;border-top:5px solid var(--gold);font-size:clamp(22px,2.2vw,31px);line-height:1.24;letter-spacing:-.035em;font-weight:600;color:var(--ink)}
.hubft .metric{background:var(--paper-3);border:1px solid var(--line);padding:18px}
/* Picture frame: always the picture's own 3:2 shape, so a 3:2 picture fills it
   whole; any other shape is shown whole (contain) on a soft blurred copy of
   itself. Nothing stretched, nothing cut off. */
.hubft .nimg{position:relative;display:block;width:100%;aspect-ratio:3/2;overflow:hidden;background:var(--paper-3,#EFEDE6)}
.hubft .nimg img{position:absolute;inset:0;width:100%;height:100%;display:block}
.hubft .nimg .fill{object-fit:cover}
.hubft .nimg .whole{object-fit:contain}
.hubft .nimg .backdrop{object-fit:cover;filter:blur(18px) saturate(1.1);transform:scale(1.12);opacity:.55}
@supports not (aspect-ratio:1/1){.hubft .nimg{height:0;padding-top:66.6667%}.hubft .nimg img{top:0;left:0}}
/* A long unbroken word (an .onion address, a wallet id) must not widen a column
   past the screen and push half a picture off it. */
.hubft .hero>*,.hubft .g4>*,.hubft .spot>*,.hubft .band>*,.hubft .an3>*,.hubft .decon .in>*,.hubft .crit>*{min-width:0}
.hubft .dek,.hubft .ridek,.hubft .card p{overflow-wrap:anywhere}
.hubft .imgcap{font-size:11px;letter-spacing:.02em;color:var(--mut);margin-top:8px;font-style:italic}
.hubft .card{border:1px solid var(--line);border-radius:0;overflow:hidden;background:var(--paper-2);box-shadow:none;cursor:pointer;transition:border-color .2s,box-shadow .2s,transform .2s;display:flex;flex-direction:column}
.hubft .card:hover{border-color:var(--gold);border-top:3px solid var(--gold);margin-top:-2px;box-shadow:0 24px 70px rgba(18,20,24,.14);transform:translateY(-3px)}
.hubft .card .img{overflow:hidden}
.hubft .card .img img{width:100%}
.hubft .card .bd{padding:0 17px 19px}
.hubft .card .crow{display:flex;align-items:center;gap:7px;margin:13px 0 7px;flex-wrap:wrap}
.hubft .card .day{margin-left:auto;font-size:10px;color:var(--mut)}
.hubft .card h3{font-size:19px;font-weight:600;line-height:1.12;letter-spacing:-.032em;-webkit-line-clamp:3;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .card:hover h3{color:var(--gold-d)}
.hubft .card p{margin-top:9px;font-size:12.5px;line-height:1.55;color:var(--sub);-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.hubft .pager{margin-top:44px;display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap}
.hubft .pager button{min-width:38px;padding:8px 12px;border-radius:0;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:600;background:#fff;color:var(--ink);border:1px solid var(--line)}
.hubft .pager button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.hubft .pager button:disabled{color:#767061;cursor:default}
.hubft .cta{margin-top:54px;text-align:center;padding:42px 24px;background:var(--ob);border-radius:0}
.hubft .cta h3{font-size:30px;font-weight:700;color:#fff}
.hubft .cta p{max-width:470px;margin:10px auto 0;font-size:13.5px;color:#A8A8A8;line-height:1.6}
.hubft .empty{padding:90px 0;text-align:center;color:var(--mut);font-size:13px}
@media(max-width:980px){.hubft .hero{grid-template-columns:1fr;gap:28px}.hubft .hero>.lead{order:-1}.hubft .g4{grid-template-columns:1fr 1fr}.hubft .band{grid-template-columns:1fr;gap:24px}.hubft .spot{grid-template-columns:1fr;gap:24px}.hubft .an3{grid-template-columns:1fr 1fr}.hubft .decon .in{grid-template-columns:1fr;gap:22px}}
@media(max-width:680px){.hubft .g4{grid-template-columns:1fr 1fr}.hubft .an3{grid-template-columns:1fr}.hubft .crit{grid-template-columns:1fr}.hubft .sh.l{flex-wrap:wrap}.hubft .sh.l .more{margin-left:auto}.hubft .sh h2{white-space:normal}}
@media(max-width:460px){.hubft .g4{grid-template-columns:1fr}}
/* Responsive pass 2026-10-07 (phones, landscape phones, tablets). */
/* Gold band: one column on phones, hairlines between the lede and the stats. */
@media(max-width:560px){.hubft .goldband .in{grid-template-columns:1fr}.hubft .goldband .c{padding:20px 22px;border-left:none;border-top:1px solid rgba(20,19,15,.18)}.hubft .goldband .c:first-child{border-top:none}.hubft .goldband .lede{max-width:none}}
/* Filter bar on phones: count left on its own row, full-width select, both dates on one row. */
@media(max-width:560px){.hubft .filterbar{justify-content:flex-start}.hubft .filterbar .cnt{flex:1 1 100%}.hubft .filterbar select{flex:1 1 100%;width:100%;min-width:0}.hubft .filterbar .dr{flex:1 1 100%;min-width:0}.hubft .filterbar .dr input{flex:1 1 0;min-width:0}}
/* Galaxy Fold cover (<=300px): a little more room for the date text beside the
   calendar icon, and the Deconstructed button keeps its arrow on its line. */
@media(max-width:300px){.hubft .filterbar .dr{gap:4px!important}.hubft .filterbar .dr input{padding:6px 4px!important}.hubft .decon .btn{padding-left:14px;padding-right:14px}}
/* Tablets and landscape phones (561-980px, where the layout is stacked and the
   bar wraps): the count starts at the left edge instead of floating mid-row
   with the controls. */
@media(min-width:561px) and (max-width:980px){.hubft .filterbar .cnt{margin-right:auto!important}}
/* iOS zooms into a focused control under 16px; only WebKit on iOS matches this.
   Portrait phones and phones held sideways (landscape height <=500px). */
@supports (-webkit-touch-callout:none){@media(max-width:560px),(max-height:500px){.hubft .filterbar select,.hubft .filterbar input[type="date"]{font-size:16px!important}.hubft .filterbar select{max-width:100%}}}
/* "More in X" buttons: a taller hit area, same layout (the margins cancel the padding). */
.hubft .sh.l button.more{padding-top:12px;padding-bottom:12px;margin-top:-12px;margin-bottom:-12px}
/* Report view: the Hub's back button and the report frame. */
.hubft .rf-back{top:12px;left:24px}
@media(max-width:560px){.hubft .rf-back{left:13px}}
@media(max-width:360px){.hubft .rf-long{display:none}}
/* Centred on the report's 44px reader bar on short landscape screens (reportLock.js).
   The bar shrinks when the FRAME is <=500px tall, and the frame is the window
   minus the nav (64px on windows over 500px tall), hence 564px here. */
@media (orientation:landscape) and (max-height:564px){.hubft .rf-back{top:7px}}
.hubft .rframe{width:100%;border:none;display:block;height:calc(100vh - var(--nav-h,64px));height:calc(100dvh - var(--nav-h,64px))}
/* Landscape phones: a picture no taller than the screen under the nav.
   width:100% because the hero lead is a flex column, where auto side margins
   would otherwise shrink the frame to nothing. max-width:980px keeps short
   desktop windows (devtools docked, split screen) on the desktop layout. */
@media (orientation:landscape) and (max-height:500px) and (max-width:980px){.hubft .hero .lead .img,.hubft .band .feat .img,.hubft .spot .img,.hubft .decon .img,.hubft .art-img{width:100%;max-width:calc((100vh - var(--nav-h,64px)) * 1.5);max-width:calc((100dvh - var(--nav-h,64px)) * 1.5);margin-left:auto;margin-right:auto}}
/* Reports and GUARD Analysis sit inside main.wrap already: no second inset. */
.hubft .reports>.wrap,.hubft .analysis>.wrap{padding-left:0;padding-right:0}
/* Section heads on phones: Deconstructed keeps its square beside the title;
   centred heads keep their gold rules and stay centred when they wrap. */
@media(max-width:680px){.hubft .decon .sh.l{flex-wrap:nowrap;align-items:flex-start}.hubft .decon .sh.l .sq{flex:none;margin-top:23px}.hubft .decon .sh.l h2{min-width:0}.hubft .sh:not(.l) .ln{min-width:16px}.hubft .sh:not(.l) h2{text-align:center}}
/* Live stays pinned at the end of the category strip while it scrolls. It
   sticks at the strip's content edge, so a white block of its own covers the
   gutter to its right, where the scrolled categories would otherwise show
   through. Being part of Live, the block also takes the taps there (a shadow
   would let them reach the hidden category). Its width is the strip's side
   padding (.hubft .wrap, or .r-pad at 768px and under), so it never makes the
   strip scroll further. bottom:-2px also covers Live's 2px bottom border row.
   At every width: the category list comes from the feed, so the strip can
   overflow on laptops too. When it does not overflow, sticky does nothing and
   Live stays at the end (the extra padding comes out of its auto margin). */
.hubft .catnav .live{position:sticky;right:0;z-index:1;padding-left:18px!important;background:linear-gradient(90deg,rgba(255,255,255,0),#fff 14px)!important}
.hubft .catnav .live::after{content:"";position:absolute;top:0;bottom:-2px;left:100%;width:clamp(18px,4vw,44px);background:#fff}
@media(max-width:768px){.hubft .catnav .live::after{width:20px}}
`;

function HubStyles() {
  useEffect(() => {
    if (document.getElementById("attacked-fonts")) return;
    const l = document.createElement("link");
    l.id = "attacked-fonts"; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap";
    document.head.appendChild(l);
  }, []);
  return <style>{HUB_CSS}</style>;
}

// Category-themed image with a severity-gradient fallback, in a 3:2 frame.
// Every picture is framed 3:2 (the shape of the stored and category pictures)
// and shown whole: a picture of another shape (the bundled /incidents ones are
// 1:1 and 5:3) is fitted inside on a blurred copy of itself instead of being
// cropped. `height` is ignored now; the frame's width sets its height.
const FRAME = 3 / 2;
// Keyed by article: a slot that switches to another incident (the filtered
// view's lead) starts clean instead of inheriting the last one's fallback state.
function NewsImage(props) {
  const a = props.a || {};
  return <NewsImageBody key={a._key || a.id || a.headline} {...props} />;
}
function NewsImageBody({ a, lead }) {
  const [failed, setFailed] = useState(false);
  const [catFailed, setCatFailed] = useState(false);
  // null until the picture is measured; meanwhile it is shown whole (contain),
  // so a picture that is not 3:2 is never cropped while it loads.
  const [whole, setWhole] = useState(null);
  const sev = SEV_C[a.severity] || GOLD;

  // The stored picture (incidents.image_url) first, else the category photo.
  // No live AI picture: the free generator stamps a "pollinations.ai" mark in
  // the corner (nologo is ignored), which the old crop hid and a whole picture
  // shows; main has used the category photo since 2026-09-30 (ced6eb2).
  let primary = a.image_url || CATEGORY_IMG[a.primary_category] || CATEGORY_IMG._default;

  // Specific overrides for the images we generated via Gemini
  if (a.headline) {
    if (a.headline.includes("Rocket Lab")) {
      primary = "/incidents/rocket_lab_iridium_1782896030009.png";
    } else if (a.headline.includes("The Founder-Fused Brand")) {
      primary = "/incidents/corporate_reputation_crisis_1782896048377.png";
    } else if (a.headline.includes("EU Anti-Subsidy Duties")) {
      primary = "/incidents/eu_chinese_ev_1782896064535.png";
    } else if (a.headline.includes("China's Rare-Earth Valve")) {
      primary = "/incidents/rare_earth_valve_1782896707184.png";
    } else if (a.headline.includes("When the Balance Sheet Is the Breach")) {
      primary = "/incidents/northvolt_fraud_probe_1782896738561.png";
    } else if (a.headline.includes("Concentration-Risk Ransomware")) {
      primary = "/incidents/dealership_ransomware_1782896754530.png";
    } else if (a.headline.includes("The Yield Trap")) {
      primary = "/incidents/yield_trap_gigafactory.png";
    } else if (a.headline.includes("BMW–Northvolt")) {
      primary = "/incidents/bmw_northvolt_contract.png";
    } else if (a.headline.includes("The Fuse, Not the Shot")) {
      primary = "/incidents/pentagon_catl_fuse.png";
    } else if (a.headline.includes("SPAC-Fraud Wells Notice")) {
      primary = "/incidents/spac_fraud_faraday.png";
    } else if (a.headline.includes("Regulatory Enforcement Sets a New Recall-Compliance Bar")) {
      primary = "/incidents/nhtsa_ford_recall.png";
    } else if (a.headline.includes("Strategic Repricing of a Legacy-OEM EV Program")) {
      primary = "/incidents/ford_lightning_scrap.png";
    } else if (a.headline.includes("Cruise Robotaxi Exit")) {
      primary = "/incidents/gm_cruise_exit.png";
    } else if (a.headline.includes("First-of-Kind FTC Enforcement")) {
      primary = "/incidents/ftc_gm_onstar.png";
    } else if (a.headline.includes("California's First Data-Minimization Strike")) {
      primary = "/incidents/california_gm_ccpa.png";
    } else if (a.headline.includes("The Sovereign Cost Reset")) {
      primary = "/incidents/sovereign_cost_reset.png";
    } else if (a.headline.includes("When One Country Owns the Valve")) {
      primary = "/incidents/drc_cobalt_ban.png";
    } else if (a.headline.includes("Akira's Battery-Supply Gambit")) {
      primary = "/incidents/akira_lges_breach.png";
    }
  }

  const catImg = CATEGORY_IMG[a.primary_category] || CATEGORY_IMG._default;

  // Ultimate fallback — branded dark placeholder (no external image at all)
  if (catFailed) {
    return (
      <div className="nimg" style={{
        background: `radial-gradient(ellipse 120% 100% at 30% 0%, ${sev}22, transparent 60%), linear-gradient(135deg, #141417, ${OB} 70%)`,
        border: "1px solid rgba(255,255,255,0.05)",
      }}>
        <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 0, background: sev }} />
        <span style={{ color: "rgba(255,255,255,0.55)", fontWeight: 700, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase" }}>
          {CAT_NAME[a.primary_category] || a.primary_category || "Incident"}
        </span>
        </div>
      </div>
    );
  }

  // If primary image failed, try the category fallback image
  if (failed) {
    return <Framed src={catImg} alt={CAT_NAME[a.primary_category] || "Incident"} whole={whole} setWhole={setWhole} onFail={() => setCatFailed(true)} />;
  }

  // When the primary IS the category photo, a failure goes straight to the
  // placeholder (re-rendering the same URL would never fire another error).
  return <Framed src={primary} alt={a.headline || ""} whole={whole} setWhole={setWhole} onFail={() => (primary === catImg ? setCatFailed(true) : setFailed(true))} />;
}

// The 3:2 frame. On load, a picture within 0.5% of 3:2 fills it ("fill",
// cover: under a pixel lost); anything else is shown whole ("whole", contain)
// over a blurred, enlarged copy of itself. Until measured it is shown whole
// without the copy. (At 4% the 1.52:1 photos lost ~2.5 px a side; owner: hide nothing.)
function Framed({ src, alt, whole, setWhole, onFail }) {
  const onLoad = (e) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (w && h) setWhole(Math.abs(w / h - FRAME) / FRAME > 0.005);
  };
  return (
    <span className="nimg">
      {whole === true && <img className="backdrop" src={src} alt="" aria-hidden="true" />}
      <img className={whole === false ? "fill" : "whole"} src={src} alt={alt} loading="lazy" onLoad={onLoad} onError={onFail} />
    </span>
  );
}

const SevChip = ({ a }) => (
  <span className="sev" style={{ background: SEVERITY_CHIP[a.severity] || "#FBF1D9", color: SEVERITY_INK[a.severity] || "#7A6000", borderColor: `${SEV_C[a.severity]}55` }}>
    {SEV_L[a.severity] || "—"}
  </span>
);
const Kick = ({ children }) => <span className="kick">{children}</span>;

// ── In-hub reader ──────────────────────────────────────────────────────────
function ArticleView({ article, onBack, onMap, user }) {
  const [full, setFull] = useState(article);
  const [expanded, setExpanded] = useState(false);
  // Load this article's full body + detail fields on open (the feed list
  // omits them to stay fast). Map's schema is already flat — no jsonb
  // parsing needed, just select the extra columns directly.
  useEffect(() => {
    let cancelled = false;
    setFull(article);
    (async () => {
      try {
        const { data: rows } = await supabase
          .from("incidents")
          // Only columns public.incidents actually has: PostgREST rejects the
          // WHOLE select on one unknown name, and this request is what loads the
          // article text — threat_actor / if_you_operate_x_then_y /
          // financial_impact_disclosed left with the schema restructure and were
          // silently 400ing it. The three fields below degrade to nothing.
          .select("article_body,summary,entity,country,location_name,primary_subcategory_name,severity_rationale,image_url")
          .eq("id", article.id).limit(1);
        const r = rows && rows[0];
        if (!r || cancelled) return;
        setFull(prev => ({
          ...prev,
          article_body: r.article_body || prev.article_body,
          primary_subcategory_name: r.primary_subcategory_name || prev.primary_subcategory_name,
          entity: r.entity || prev.entity,
          country: r.country || prev.country,
          location_name: r.location_name || r.country || prev.location_name,
          severity_rationale: r.severity_rationale || prev.severity_rationale,
          image_url: r.image_url || prev.image_url,
        }));
      } catch { /* keep the lightweight version */ }
    })();
    return () => { cancelled = true; };
  }, [article && article.id]);
  const a = full;
  const meta = [a.entity, a.location_name || a.country, a.industry || a.sector].filter(Boolean).join("   ·   ");
  const body = a.article_body || a.summary || "";
  const longBody = body.length > 360;
  const Block = ({ label, children }) => !children ? null : (
    <section style={{ marginTop: 30 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: GOLD_D, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 15.5, lineHeight: 1.72, color: "#3D3A33" }}>{children}</div>
    </section>
  );
  return (
    <main className="r-pad" style={{ padding: "28px 36px 56px", background: "#FFFFFF", color: "#0A0A0A", fontFamily: "Inter, sans-serif" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: "6px 0", color: "#6E6A60", fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>← Back to the feed</button>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
          <SevChip a={a} />
          <span className="kick" style={{ color: GOLD_D }}>{a.primary_subcategory_name || catName(a)}</span>
          <span style={{ fontSize: 11.5, color: "#6E6A60", fontWeight: 600 }}>{fmtDay(a.incident_day)}</span>
        </div>
        <h1 style={{ margin: "14px 0 0", fontSize: "clamp(32px, 4.4vw, 52px)", fontWeight: 600, lineHeight: 1.02, letterSpacing: "-0.045em", textWrap: "balance" }}>{a.headline}</h1>
        {meta && <div style={{ marginTop: 14, fontSize: 12.5, color: "#6E6A60", fontWeight: 600 }}>{meta}</div>}
        <div className="art-img" style={{ marginTop: 24, overflow: "hidden", border: "1px solid #E6E3DB" }}>
          <div style={{ width: "100%", overflow: "hidden" }}><NewsImage a={a} lead /></div>
        </div>
        {body && (
          <p style={{ margin: "26px 0 0", fontSize: 16.5, lineHeight: 1.78, color: "#14130F", whiteSpace: "pre-line",
            ...(longBody && !expanded ? { display: "-webkit-box", WebkitLineClamp: 5, WebkitBoxOrient: "vertical", overflow: "hidden" } : {}) }}>{body}</p>
        )}
        {(longBody || a.severity_rationale || a.threat_actor || a.if_you_operate_x_then_y || a.financial_impact_disclosed) && (
          <button onClick={() => setExpanded(v => !v)} style={{ marginTop: 16, padding: "10px 18px", borderRadius: 0, cursor: "pointer", background: "transparent", border: `1px solid rgba(252,189,0,0.3)`, color: GOLD_D, fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{expanded ? "Read less ↑" : "Read more ↓"}</button>
        )}
        {expanded && (
          <>
            <Block label="Why this severity">{a.severity_rationale}</Block>
            <Block label="Threat actor">{a.threat_actor}</Block>
            <Block label="If you operate this, then">{a.if_you_operate_x_then_y}</Block>
            <Block label="Disclosed financial impact">{a.financial_impact_disclosed}</Block>
          </>
        )}
        <div style={{ marginTop: 44, padding: "32px 26px", textAlign: "center", background: OB, borderRadius: 0 }}>
          <div style={{ fontSize: 26, fontWeight: 600, color: "#fff", letterSpacing: "-0.035em" }}>See the blast radius on the map.</div>
          <p style={{ margin: "10px auto 0", maxWidth: 440, fontSize: 13, color: "#A8A8A8", lineHeight: 1.6 }}>Blast radius, adaptive controls and vendor Defence Ratings for this incident — live on the Attack Map.</p>
          <button onClick={onMap} style={{ marginTop: 18, padding: "12px 26px", background: GOLD, color: OB, border: "none", borderRadius: 0, cursor: "pointer", fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{user ? "Open on the map →" : "Sign up to open the map →"}</button>
        </div>
      </div>
    </main>
  );
}

// ReportFrame — when a pre-baked full briefing exists for this incident
// (public/reports/<id>.html), render that exact report inside the hub via an
// iframe, with a slim back/CTA bar on top. Faithful to the baked design; no
// re-rendering. Falls back to ArticleView when no report file exists.
// Free readers get the PREVIEW — header, key figures and the Executive
// Summary, Download PDF off (scripts/build-report-previews.mjs); the full
// report reaches subscribers only, through the server gate. The public Hub is
// not a way around the paywall.
// Design review (localhost only — import.meta.env.DEV is false in the live
// build): ?design=blur shows the blurred-sections preview from
// public/reports-blur/ instead of the live one.
const PREVIEW_DIR = (() => {
  if (!import.meta.env.DEV) return "reports";
  try { return new URLSearchParams(window.location.search).get("design") === "blur" ? "reports-blur" : "reports"; } catch { return "reports"; }
})();

function ReportFrame({ article, onBack, onMap, user, subscriber, authReady }) {
  const ref = useRef(null);
  const reportRef = article.reportRef || article.id;
  // Where the HTML comes from, in order:
  //   1. the reports CMS (report_html) — authored in the admin console,
  //      published only; the database hands a free reader the preview;
  //   2. the API, which applies the subscriber lock server-side;
  //   3. a subscriber: the full baked file from /reports-full/ (gated);
  //   4. everyone else: the preview baked at public/reports/<ref>.html.
  // 1-3 render through srcdoc, which keeps the frame same-origin so
  // prepareReportFrame can still reach in (licence line, responsive layer).
  // Nothing is fetched until the session has settled, so a subscriber never
  // sees the preview flash first and a tier change re-fetches.
  const [doc, setDoc] = useState(undefined);
  useEffect(() => {
    if (!authReady) return;
    let dead = false; setDoc(undefined);
    (async () => {
      let html = null;
      try { html = await fetchReportHtml(reportRef); } catch { /* not a CMS report */ }
      if (!html) { try { html = await reportHtml(reportRef); } catch { /* API off or refused */ } }
      if (!html && subscriber) html = await fetchFullReport(reportRef);
      if (!dead) setDoc(html || null);
    })();
    return () => { dead = true; };
  }, [reportRef, subscriber, authReady]);
  useEffect(() => {
    const fr = ref.current; if (!fr) return;
    const onLoad = () => { prepareReportFrame(fr, { subscriber, onSubscribe: () => { window.location.href = "/?subscribe"; }, readerName: user?.email || "" }); };
    fr.addEventListener("load", onLoad);
    if (fr.contentDocument?.readyState === "complete" && fr.contentDocument.body?.children.length) onLoad();
    return () => fr.removeEventListener("load", onLoad);
  }, [article?.reportRef, subscriber, user?.email, doc]); // doc: the frame mounts only once the API answered
  return (
    <main style={{ background: "#FFFFFF", fontFamily: "Inter, sans-serif", position: "relative" }}>
      <button className="rf-back" onClick={onBack} style={{
        position: "absolute", zIndex: 20,
        display: "inline-flex", alignItems: "center", gap: 6,
        background: "rgba(255,255,255,0.9)", backdropFilter: "saturate(1.4) blur(6px)",
        border: "1px solid #D9D6CE", borderRadius: 0, padding: "7px 13px",
        color: "#3A362E", cursor: "pointer", fontFamily: "Inter, sans-serif",
        fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
      }}><span>← Back<span className="rf-long"> to the feed</span></span></button>
      {doc === undefined ? null : <iframe
        ref={ref}
        {...(doc ? { srcDoc: doc } : { src: `/${PREVIEW_DIR}/${encodeURIComponent(reportRef)}.html` })}
        title={article.headline || article.id}
        className="rframe"
      />}
    </main>
  );
}

// A published CMS report → the same article shape. Standalone reports (no
// incident_id) have no incident row behind them, so this is the whole record:
// the ref doubles as the id, and reportRef sends it straight to ReportFrame.
function reportArticle(r) {
  const day = (r.published_at || "").slice(0, 10);
  return {
    id: r.ref, _key: `rep-${r.ref}`, reportRef: r.ref,
    headline: r.title, summary: r.subtitle || r.summary || "", article_body: r.summary || "",
    severity: r.severity, primary_category: r.primary_category, primary_subcategory_name: null,
    industry: r.industry, sector: r.industry,
    entity: null, country: null, location_name: null,
    image_url: r.hero_image_url || null,
    incident_day: day, event_date: day, sortDay: day,
    confidence: null, status: null, reporter: null, data: null,
    _report: r,
  };
}

// One incident row → the article shape the Hub renders (list rows and the
// ?open= single fetch share it, so a deep-opened article looks like a listed one).
const HUB_COLS = "id,headline,summary,entity,country,location_name,industry,sector,severity,confidence,primary_category,primary_subcategory_name,event_date,incident_day,image_url";

function shapeRow(r, reportByIncident = {}) {
    const day = r.incident_day || r.event_date || null;
    return {
      id: r.id,
      _key: `m-${r.id}`,
      reportRef: r.hub_ref || reportByIncident[String(r.id)] || null,
      headline: r.headline,
      summary: r.summary || "",
      article_body: r.summary || "",   // full body loads on open
      severity: r.severity,
      primary_category: r.primary_category,
      primary_subcategory_name: r.primary_subcategory_name || null,
      image_url: r.image_url || null,
      industry: r.industry || null,
      sector: r.sector || r.industry || null,
      entity: r.entity || null,
      country: r.country || null,
      location_name: r.location_name || null,
      reporter: r.reporter,
      confidence: r.confidence,
      status: null,
      incident_day: day,
      event_date: day,
      sortDay: day,
      data: null,
    };
}

export function AttackHub() {
  const { user, tier, loading: authLoading } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [reportIds, setReportIds] = useState(null);  // Set of incident ids with a baked report
  const [articles, setArticles] = useState([]);
  // Total rows in the incidents table. Distinct from articles.length,
  // which PostgREST caps at 1000 — see the fetch below.
  const [totalIncidents, setTotalIncidents] = useState(null);
  const [loading, setLoading] = useState(true);
  const [catFilter, setCatFilter] = useState("ALL");
  const [indFilter, setIndFilter] = useState("ALL");
  const [dayFilter, setDayFilter] = useState("ALL");
  const [dateFrom, setDateFrom] = useState("");   // range filter (ISO YYYY-MM-DD, "" = unbounded)
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(0);

  // Which incidents have a full report, from TWO sources:
  //   • the 310 baked files — manifest.json v2 carries byIncident:
  //     { "<incident id>": "<ref>" } (hub_ref left the DB in the restructure);
  //     the legacy array shape is still accepted;
  //   • the reports CMS — published rows in public.hub_reports_public, whose
  //     incident_id (when set) says which incident the report is about.
  // BOTH must feed reportIds, because the render gate below asks
  // reportIds.has(ref): a CMS ref would otherwise fall through to the plain
  // article view with no error anywhere. CMS wins a collision — it is the
  // authored, newer one. Either source failing leaves the other working.
  const [reportByIncident, setReportByIncident] = useState({});
  const [cmsReports, setCmsReports] = useState([]);   // published rows, for the reports section
  // Flagship baked reports pinned to the top of the Reports section
  // (manifest.json "featured"), so a briefing is not lost deep in the feed
  // once newer incidents push its incident card down.
  const [featuredReports, setFeaturedReports] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let baked = { refs: [], byIncident: {} };
      try {
        const r = await fetch("/reports/manifest.json");
        const m = r.ok ? await r.json() : null;
        if (Array.isArray(m)) baked = { refs: m, byIncident: {} };
        else if (m) baked = { refs: m.refs || Object.values(m.byIncident || {}), byIncident: m.byIncident || {} };
        if (m && Array.isArray(m.featured) && !cancelled) setFeaturedReports(m.featured.filter((f) => f && f.ref && f.title));
      } catch { /* no manifest — the CMS alone still works */ }
      let rows = [];
      try { rows = await listPublishedReports({ limit: 1000 }); } catch { /* CMS unreachable — the baked files alone still work */ }
      if (cancelled) return;
      const cmsByIncident = {};
      for (const row of rows) if (row && row.incident_id != null && row.ref) cmsByIncident[String(row.incident_id)] = row.ref;
      setReportIds(new Set([...baked.refs, ...rows.map(r => r && r.ref).filter(Boolean)]));
      setReportByIncident({ ...baked.byIncident, ...cmsByIncident });
      setCmsReports(rows);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The Attacked Hub reads from the primary Map DB (`supabase`), the
        // same 931-incident table the Attack Map renders from. Map's schema
        // is already flat (headline/summary/entity/country/... real columns,
        // not a jsonb blob), so this list query is lightweight by construction.
        // Each article's full body still lazy-loads on open (see ArticleView)
        // to keep this query cheap. `hub_ref` is a cheap jsonb-key extraction
        // (not a full blob fetch) used only to match this row to a pre-baked
        // /reports/<id>.html file, for the 310 incidents that originated in
        // the Attacked Hub — the other ~621 have no baked report and open via
        // the normal live ArticleView instead.
        // ORDER BY is REQUIRED here, not cosmetic. PostgREST caps every request
        // at 1000 rows regardless of .limit(), so .limit(5000) never returned
        // 5000 — it returned an arbitrary 1000. Without an ORDER BY, Postgres
        // is free to return rows in physical order, which is effectively
        // oldest-first, so the newest incidents were silently dropped: the DB
        // held 1092 rows through 14 Jul while the Hub showed nothing after
        // 9 Jul. Ordering newest-first guarantees the most recent briefings are
        // always in the window we do get back.
        const incRes = await supabase.from("incidents")
          // `reporter`, `image_url` and `raw` are gone from the restructured
          // schema for good. PostgREST rejects the whole select when ANY named
          // column is unknown, so asking for them 400'd this query outright
          // and the Hub rendered zero articles. Every consumer below already
          // falls back when they are absent (image_url -> CATEGORY_IMG,
          // hub_ref -> null), so leaving them out degrades gracefully.
          // `confidence` was restored to the public.incidents view and is safe.
          .select(HUB_COLS)
          .order("incident_day", { ascending: false, nullsFirst: false })
          .order("severity", { ascending: false })
          .limit(1000);
        // Every incident with a baked report is older than the 1000-row window
        // (they rank 1277+ today), so fetch them separately — light columns,
        // ~300 rows — and every report stays reachable from the Hub however
        // far the feed moves on.
        const repRes = await supabase.from("incidents")
          .select(HUB_COLS)
          .not("article_body", "is", null)
          .order("incident_day", { ascending: false, nullsFirst: false })
          .limit(400);
        const seenIds = new Set();
        const incRows = [...(incRes.data || []), ...(repRes.data || [])].filter(r => r && !seenIds.has(r.id) && seenIds.add(r.id));

        // True table size, for the counter in the gold strip. The rows we hold
        // are capped at 1000, so articles.length under-reports the corpus.
        const totalRes = await supabase.from("incidents")
          .select("id", { count: "exact", head: true });

        const mapped = incRows.map(r => shapeRow(r, reportByIncident));
        const sorted = mapped
          .filter(a => a.headline)
          .sort((a, b) => (a.sortDay || "") < (b.sortDay || "") ? 1 : (a.sortDay || "") > (b.sortDay || "") ? -1 : (b.severity || 0) - (a.severity || 0));
        if (!cancelled) {
          setArticles(sorted);
          if (typeof totalRes?.count === "number") setTotalIncidents(totalRes.count);
        }
      } catch { /* graceful empty */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  // Deep-link: /?hub&open=<id> opens that briefing directly.
  const didDeepOpen = React.useRef(false);
  useEffect(() => {
    if (didDeepOpen.current || !articles.length) return;
    let openId = null;
    try { openId = new URLSearchParams(window.location.search).get("open"); } catch { /* noop */ }
    if (!openId) { didDeepOpen.current = true; return; }
    const open = (a) => { didDeepOpen.current = true; setSelected(a); try { window.scrollTo({ top: 0, behavior: "instant" }); } catch { window.scrollTo(0, 0); } };
    const a = articles.find(x => String(x.id) === String(openId) || x.reportRef === openId);
    if (a) { open(a); return; }
    // Not in the loaded window (newest 1000 + the report rows) — an older
    // incident linked from the dashboard. Fetch that one row by id; the body
    // loads on open as for any article. A miss (bad id) stays on the feed.
    if (!/^\d+$/.test(String(openId))) { didDeepOpen.current = true; return; }
    didDeepOpen.current = true;
    supabase.from("incidents").select(HUB_COLS).eq("id", Number(openId)).limit(1)
      .then(({ data }) => { const r = data && data[0]; if (r && r.headline) { const one = shapeRow(r, reportByIncident); setArticles(prev => prev.some(x => x.id === one.id) ? prev : [one, ...prev]); open(one); } })
      .catch(() => { /* stay on the feed */ });
  }, [articles, reportByIncident]);

  // Deep link: /?hub&report=<ref> opens a published report directly — the
  // admin console's "Open on Hub" for standalone reports (incident-linked
  // ones use ?open=<incident id>, handled above).
  const didReportOpen = useRef(false);
  useEffect(() => {
    if (didReportOpen.current) return;
    let want = null;
    try { want = new URLSearchParams(window.location.search).get("report"); } catch { /* noop */ }
    if (!want) { didReportOpen.current = true; return; }
    if (!cmsReports.length) return;                    // wait for the index
    didReportOpen.current = true;
    const row = cmsReports.find(r => r && r.ref === want);
    if (row) { setSelected(reportArticle(row)); try { window.scrollTo({ top: 0, behavior: "instant" }); } catch { window.scrollTo(0, 0); } }
  }, [cmsReports]);

  const cats = ["ALL", ...Array.from(new Set(articles.map(a => a.primary_category).filter(Boolean)))];
  const inds = ["ALL", ...Array.from(new Set(articles.map(a => a.industry).filter(Boolean))).sort()];
  const days = ["ALL", ...Array.from(new Set(articles.map(a => a.incident_day).filter(Boolean))).sort((a, b) => a < b ? 1 : -1)];
  const liveDay = days.find(d => d !== "ALL") || "";       // newest incident day = "live now"
  const liveActive = !!liveDay && dateFrom === liveDay && dateTo === liveDay;
  const visible = articles
    .filter(a => catFilter === "ALL" || a.primary_category === catFilter)
    .filter(a => indFilter === "ALL" || a.industry === indFilter)
    .filter(a => dayFilter === "ALL" || a.incident_day === dayFilter)
    .filter(a => !dateFrom || (a.incident_day && a.incident_day >= dateFrom))
    .filter(a => !dateTo || (a.incident_day && a.incident_day <= dateTo));

  const isFiltered = catFilter !== "ALL" || indFilter !== "ALL" || dayFilter !== "ALL" || !!dateFrom || !!dateTo;
  const latestDay = articles[0]?.sortDay;

  // Editorial zoning (unfiltered, page 0). All derived from `visible`, so it scales.
  const featured = visible[0] || null;
  const leftLeads = visible.slice(1, 3);
  const picks = visible.slice(3, 8);
  const top = visible.slice(8, 12);
  const spotMain = visible[12], spotSide = visible.slice(13, 15);
  const byCat = {};
  for (const a of visible) (byCat[a.primary_category] = byCat[a.primary_category] || []).push(a);
  const bandCats = cats.filter(c => c !== "ALL" && (byCat[c] || []).length >= 4).slice(0, 4);
  const analysis = visible.filter(a => a.if_you_operate_x_then_y || a.severity_rationale).slice(0, 3);
  // Reports that stand on their own (no incident behind them); the
  // incident-linked ones already appear as that incident's card.
  const standaloneReports = cmsReports.filter(r => r && r.incident_id == null).slice(0, 6);
  const decon = visible.slice().sort((a, b) => (b.severity || 0) - (a.severity || 0))[0];
  const mostCritical = visible.slice().sort((a, b) => (b.severity || 0) - (a.severity || 0)).slice(0, 5);

  // Paginated grid — filtered view paginates everything; editorial paginates the tail.
  const gridAll = isFiltered ? visible.slice(5) : visible.slice(15);
  const pageCount = Math.max(1, Math.ceil(gridAll.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const gridPage = gridAll.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const pageWindow = (() => { let s = Math.max(0, safePage - 2); const e = Math.min(pageCount, s + 5); s = Math.max(0, e - 5); const w = []; for (let p = s; p < e; p++) w.push(p); return w; })();

  useEffect(() => { setPage(0); }, [catFilter, indFilter, dayFilter, dateFrom, dateTo]);

  function goToPage(p) { setPage(Math.max(0, Math.min(p, pageCount - 1))); try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); } }
  // "/?map": the bare "/" is the dashboard for a signed-in reader.
  function openMap() { if (user) window.location.href = "/?map"; else setAuthOpen(true); }
  function openArticle(a) { setSelected(a); try { window.scrollTo({ top: 0, behavior: "instant" }); } catch { window.scrollTo(0, 0); } }

  // ── card/rail builders (close over openArticle) ──
  // BBC-style red LIVE tag, shown on incidents from the latest ("live") day.
  const LiveTag = () => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#E0091C", fontWeight: 800, fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#E0091C", animation: "hubpulse 1.2s infinite" }} />LIVE
    </span>
  );
  const Card = (a) => (
    <article key={a._key || a.id} className="card" onClick={() => openArticle(a)}>
      <div className="img"><NewsImage a={a} /></div>
      <div className="bd">
        <div className="crow"><SevChip a={a} />{a.incident_day === liveDay && <LiveTag />}<Kick>{catName(a)}</Kick><span className="day">{fmtShort(a.incident_day)}</span></div>
        <h3>{a.headline}</h3>
        <div className="by">{place(a)}</div>
        {a.summary && <p>{a.summary}</p>}
      </div>
    </article>
  );
  const Story = (a) => (
    <article key={a._key || a.id} className="story" onClick={() => openArticle(a)}>
      <div className="img"><NewsImage a={a} /></div>
      <div className="row"><SevChip a={a} />{a.incident_day === liveDay && <LiveTag />}<Kick>{catName(a)}</Kick></div>
      <h3>{a.headline}</h3>
      {a.summary && <div className="ridek">{a.summary}</div>}
      <div className="by" style={{ marginTop: 6 }}>{place(a)}</div>
    </article>
  );
  const RailItem = (a, num) => (
    <div key={a._key || a.id} className="ri" onClick={() => openArticle(a)}>
      {num != null && <span className="num">{num}</span>}
      <div style={{ minWidth: 0 }}>
        <div className="mrow"><SevChip a={a} />{a.incident_day === liveDay && <LiveTag />}<Kick>{catName(a)}</Kick></div>
        <h4>{a.headline}</h4>
        {a.summary && <div className="ridek">{a.summary}</div>}
        <div className="by" style={{ marginTop: 6 }}>{place(a)}</div>
      </div>
    </div>
  );
  const MoreItem = (a) => (
    <div key={a._key || a.id} className="moreitem" onClick={() => openArticle(a)}>
      <div className="mrow" style={{ marginBottom: 4 }}><SevChip a={a} /><span className="by">{fmtShort(a.incident_day)}</span></div>
      <h4>{a.headline}</h4>
      {a.summary && <div className="ridek">{a.summary}</div>}
      <div className="by" style={{ marginTop: 6 }}>{place(a)}</div>
    </div>
  );
  const SideLead = (a) => (
    <div key={a._key || a.id} className="side" onClick={() => openArticle(a)}>
      <div className="row"><SevChip a={a} />{a.incident_day === liveDay && <LiveTag />}<Kick>{catName(a)}</Kick></div>
      <h3>{a.headline}</h3>
      {a.summary && <div className="dek">{a.summary}</div>}
      <div className="by" style={{ marginTop: 9 }}>{place(a)} · {fmtShort(a.incident_day)}</div>
    </div>
  );
  const OpCard = (a) => (
    <div key={a._key || a.id} className="opc" onClick={() => openArticle(a)}>
      <div className="q">“</div>
      <h3>{a.headline}</h3>
      <p>{a.if_you_operate_x_then_y || a.severity_rationale || a.summary}</p>
      <div className="auth"><span className="av">{(a.primary_category || "G").slice(0, 3)}</span>
        <div><div className="an">GUARD Analysis</div><div className="ad">{catName(a)} desk · {fmtShort(a.incident_day)}</div></div>
      </div>
    </div>
  );
  // Standalone reports: analyst pieces that are not about one incident. The
  // hero is the report's own picture when it has one; NewsImage falls back to
  // a category image when it does not, so both shapes look deliberate.
  // A pinned baked report → the article shape ReportFrame opens.
  const featuredArticle = (f) => ({
    id: f.incident ?? f.ref, _key: `feat-${f.ref}`, reportRef: f.ref,
    headline: f.title, summary: f.subtitle || "", article_body: f.subtitle || "",
    severity: f.severity, primary_category: f.category, primary_subcategory_name: null,
    industry: f.industry || null, sector: f.industry || null, entity: null, country: null, location_name: null,
    image_url: f.image || null, incident_day: f.day, event_date: f.day, sortDay: f.day,
    confidence: null, status: null, reporter: null, data: null,
  });
  const FeaturedReportCard = (f) => {
    const a = featuredArticle(f);
    return (
      <div key={`feat-${f.ref}`} className="opc" style={{ cursor: "pointer", padding: 0, overflow: "hidden", outline: `2px solid ${GOLD}`, outlineOffset: -2 }} onClick={() => openArticle(a)}>
        <NewsImage a={a} />
        <div style={{ padding: "16px 18px 18px" }}>
          <div className="mrow" style={{ marginBottom: 8, gap: 8 }}>
            <span style={{ background: GOLD, color: "#0F0F0F", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", padding: "3px 7px" }}>{f.kicker || "Featured briefing"}</span>
            <SevChip a={a} /><span className="by">{fmtShort(a.incident_day)}</span>
          </div>
          <h3 style={{ margin: "0 0 6px" }}>{f.title}</h3>
          {f.subtitle && <p style={{ margin: 0 }}>{f.subtitle}</p>}
          <div className="by" style={{ marginTop: 10 }}>{[f.industry, CAT_NAME[f.category] || f.category].filter(Boolean).join("  ·  ")}</div>
        </div>
      </div>
    );
  };
  const ReportCard = (r) => {
    const a = reportArticle(r);
    return (
      <div key={r.ref} className="opc" style={{ cursor: "pointer", padding: 0, overflow: "hidden" }} onClick={() => openArticle(a)}>
        <NewsImage a={a} />
        <div style={{ padding: "16px 18px 18px" }}>
          <div className="mrow" style={{ marginBottom: 8, gap: 8 }}><SevChip a={a} /><span className="by">{fmtShort(a.incident_day)}</span></div>
          <h3 style={{ margin: "0 0 6px" }}>{r.title}</h3>
          {r.subtitle && <p style={{ margin: 0 }}>{r.subtitle}</p>}
          <div className="by" style={{ marginTop: 10 }}>
            {[r.industry, CAT_NAME[r.primary_category] || r.primary_category].filter(Boolean).join("  ·  ")}
            {Array.isArray(r.tags) && r.tags.length ? `  ·  ${r.tags.slice(0, 3).join(", ")}` : ""}
          </div>
        </div>
      </div>
    );
  };
  const SecHead = ({ children }) => (
    <div className="sh"><span className="ln" /><h2>{children}</h2><span className="ln" /></div>
  );

  const Pager = () => pageCount <= 1 ? null : (
    <div className="pager">
      <button onClick={() => goToPage(safePage - 1)} disabled={safePage === 0}>← Prev</button>
      {pageWindow[0] > 0 && <><button onClick={() => goToPage(0)}>1</button><span style={{ color: "#9A9A98" }}>…</span></>}
      {pageWindow.map(p => <button key={p} className={p === safePage ? "on" : ""} onClick={() => goToPage(p)}>{p + 1}</button>)}
      {pageWindow[pageWindow.length - 1] < pageCount - 1 && <><span style={{ color: "#9A9A98" }}>…</span><button onClick={() => goToPage(pageCount - 1)}>{pageCount}</button></>}
      <button onClick={() => goToPage(safePage + 1)} disabled={safePage >= pageCount - 1}>Next →</button>
    </div>
  );

  return (
    <div className="hubft" style={{ minHeight: "100vh" }}>
      <HubStyles />
      <SiteNav active="hub" />

      {selected ? (
        // Resolve the ref at render time: the manifest can arrive after the
        // incident rows did, so the row's own reportRef may still be null.
        (() => { const ref = selected.reportRef || reportByIncident[String(selected.id)] || null; return reportIds && ref && reportIds.has(ref); })()
          ? <ReportFrame article={{ ...selected, reportRef: selected.reportRef || reportByIncident[String(selected.id)] }} onBack={() => setSelected(null)} onMap={openMap} user={user} subscriber={isSubscriber(tier)} authReady={!authLoading} />
          : <ArticleView article={selected} onBack={() => setSelected(null)} onMap={openMap} user={user} />
      ) : (
        <>
          {/* LIVE TICKER — breaking-news strip of the latest incidents */}
          {articles.length > 0 && (
            <div className="hub-ticker" role="region" aria-label="Live incidents ticker" style={{
              display: "flex", alignItems: "center", background: "#0c0c0c",
              borderBottom: "1px solid var(--line)", color: "#fff", height: 40, overflow: "hidden",
            }}>
              <style>{`
                @keyframes hubticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }
                .hub-ticker-track { animation: hubticker 90s linear infinite; }
                .hub-ticker:hover .hub-ticker-track { animation-play-state: paused; }
                @keyframes hubpulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
                .hub-ticker-item:hover .hti-h { color: #FCBD00; }
              `}</style>
              <div style={{
                flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 8,
                padding: "0 16px", height: "100%", background: "transparent", color: "#E0091C",
                fontWeight: 800, fontSize: 13, letterSpacing: "0.12em",
                borderRight: "1px solid rgba(255,255,255,0.14)",
              }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#E0091C", boxShadow: "0 0 8px #E0091C", animation: "hubpulse 1.2s infinite" }} />
                LIVE
              </div>
              <div style={{
                flex: 1, overflow: "hidden",
                WebkitMaskImage: "linear-gradient(90deg, transparent, #000 3%, #000 97%, transparent)",
                maskImage: "linear-gradient(90deg, transparent, #000 3%, #000 97%, transparent)",
              }}>
                <div className="hub-ticker-track" style={{ display: "inline-flex", alignItems: "center", width: "max-content", whiteSpace: "nowrap" }}>
                  {[...articles.slice(0, 24), ...articles.slice(0, 24)].map((a, i) => (
                    <span key={`${a.id}-${i}`} className="hub-ticker-item" onClick={() => openArticle(a)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 9, padding: "0 22px", cursor: "pointer", fontSize: 12.5 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 0, background: SEV_C[a.severity] || GOLD, flex: "0 0 auto" }} />
                      {/* Ticker sits on the DARK bar — keep the bright severity
                          colour here. SEVERITY_INK is for light grounds only;
                          using it here made these labels less legible, not more. */}
                      <span style={{ color: SEV_C[a.severity] || GOLD, fontWeight: 700, fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase" }}>{CAT_SHORT[a.primary_category] || a.primary_category || ""}</span>
                      <span className="hti-h" style={{ color: "#eaeaea", fontWeight: 500, transition: "color 120ms" }}>{a.headline}</span>
                      <span style={{ color: "#666" }}>·</span>
                      <span style={{ color: "#888", fontSize: 11 }}>{fmtShort(a.incident_day)}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* CATEGORY NAV (filter) */}
          <nav className="catnav">
            <div className="wrap r-pad">
              {cats.map(c => (
                <button key={c} className={catFilter === c ? "on" : ""} onClick={() => setCatFilter(c)}>
                  {c === "ALL" ? "All" : (CAT_SHORT[c] || CAT_NAME[c] || c)}
                </button>
              ))}
              
              {/* LIVE button moved to the side of REPUTATION (end of cats) */}
              <button
                className="live"
                onClick={() => { if (liveActive) { setDateFrom(""); setDateTo(""); } else if (liveDay) { setDateFrom(liveDay); setDateTo(liveDay); } }}
                title={liveActive ? "Showing the latest day — click to clear" : "Show only the latest live incidents"}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer",
                  padding: "0 4px", background: "transparent", border: "none",
                  fontFamily: "inherit", fontSize: 13, fontWeight: 800, letterSpacing: "0.1em",
                  textTransform: "uppercase", color: "#E0091C", marginLeft: "auto",
                  borderBottom: liveActive ? "2px solid #E0091C" : "2px solid transparent",
                }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#E0091C", animation: "hubpulse 1.2s infinite" }} />
                Live
              </button>
            </div>
          </nav>

          {/* BODY */}
          <main className="wrap r-pad" style={{ paddingBottom: 64 }}>
            {/* Secondary filters */}
            <div className="filterbar">
              <span className="cnt" style={{ fontSize: 18, fontWeight: 700, color: "#666", marginRight: 16 }}>
                {visible.length} BRIEFINGS{catFilter !== "ALL" ? ` · ${CAT_NAME[catFilter] || catFilter}` : ""}
              </span>
              <select className={indFilter !== "ALL" ? "act" : ""} value={indFilter} onChange={e => setIndFilter(e.target.value)}>
                {inds.map(i => <option key={i} value={i}>{i === "ALL" ? "All industries" : i}</option>)}
              </select>
              {(() => {
                const dStyle = (on) => ({
                  fontFamily: "inherit", fontSize: 12, padding: "6px 8px", borderRadius: 0,
                  border: `1px solid ${on ? "var(--gold-d)" : "var(--line)"}`, background: "#fff",
                  color: on ? "var(--ink)" : "var(--mut)", colorScheme: "light", cursor: "pointer",
                });
                return (
                  <span className="dr" title="Filter by date range" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input type="date" value={dateFrom} max={dateTo || undefined}
                      onChange={e => setDateFrom(e.target.value)} style={dStyle(!!dateFrom)} title="From" />
                    <span style={{ color: "var(--mut)", fontSize: 12 }}>→</span>
                    <input type="date" value={dateTo} min={dateFrom || undefined}
                      onChange={e => setDateTo(e.target.value)} style={dStyle(!!dateTo)} title="To" />
                  </span>
                );
              })()}
              {isFiltered && <button className="clr" onClick={() => { setCatFilter("ALL"); setIndFilter("ALL"); setDayFilter("ALL"); setDateFrom(""); setDateTo(""); }}>Clear ✕</button>}
            </div>

            {loading ? (
              <div className="empty">Loading the feed…</div>
            ) : !featured ? (
              <div className="empty">No briefings in this category yet.</div>
            ) : isFiltered ? (
              /* ── Filtered category view: editorial lead + rail, then grid ── */
              <section className="sec" style={{ paddingTop: 26 }}>
                <div className="sh l"><span className="sq" style={{ background: catFilter !== "ALL" ? (SEV_C[visible[0]?.severity] || GOLD) : GOLD }} /><h2>{catFilter !== "ALL" ? (CAT_NAME[catFilter] || catFilter) : "Filtered briefings"}</h2><span className="more" style={{ cursor: "default" }}>{visible.length} briefings</span></div>
                {safePage === 0 && visible[0] && (
                  <div className="band" style={{ marginBottom: 40 }}>
                    <div className="feat" onClick={() => openArticle(visible[0])}>
                      <div className="img"><NewsImage a={visible[0]} lead /></div>
                      <div className="row"><SevChip a={visible[0]} /><Kick>{catName(visible[0])}</Kick><span className="by">{fmtShort(visible[0].incident_day)}</span></div>
                      <h3>{visible[0].headline}</h3>
                      {visible[0].summary && <div className="dek">{visible[0].summary}</div>}
                      <div className="rm" style={{ marginTop: 12 }}>Read full briefing →</div>
                    </div>
                    {visible.length > 1 && (
                      <div><div className="morehead">Latest in {catFilter !== "ALL" ? (CAT_NAME[catFilter] || catFilter) : "this view"}</div>{visible.slice(1, 5).map(MoreItem)}</div>
                    )}
                  </div>
                )}
                {gridPage.length > 0 && <div className="latest">{gridPage.map(Card)}</div>}
                <Pager />
              </section>
            ) : (
              /* ── Full editorial front page ── */
              <>
                {safePage === 0 && (
                  <>
                    <section className="hero">
                      <div className="col">{leftLeads.map(SideLead)}</div>
                      <div className="lead col" onClick={() => openArticle(featured)}>
                        <div className="img"><NewsImage a={featured} lead /></div>
                        <div className="row"><Kick>Lead briefing</Kick><SevChip a={featured} /><span className="by">{fmtDay(featured.incident_day)}</span></div>
                        <h2>{featured.headline}</h2>
                        <div className="by" style={{ marginTop: 10 }}>{[featured.entity, featured.country, featured.industry || featured.sector].filter(Boolean).join("   ·   ")}</div>
                        {featured.summary && <p className="dek">{featured.summary}</p>}
                        <div className="rm" style={{ marginTop: 13 }}>Read full briefing →</div>
                      </div>
                      {picks.length > 0 && (
                        <aside className="col"><div className="picks-h">Editor's picks</div><div className="rail">{picks.map(a => RailItem(a))}</div></aside>
                      )}
                    </section>

                    {/* Gold evidence strip — the reference's single most
                        striking element, rebuilt against live sweep data.
                        Full-bleed gold with dark ink is the one place the
                        brand colour carries a whole block rather than an
                        accent, and it breaks the newspaper grid exactly where
                        the page would otherwise start to feel uniform. */}
                    {articles.length > 0 && (() => {
                      const crit = articles.filter(a => (a.severity || 0) >= 4).length;
                      const countries = new Set(articles.map(a => a.country).filter(Boolean)).size;
                      const cats = new Set(articles.map(a => a.primary_category).filter(Boolean)).size;
                      return (
                        <section className="goldband">
                          <div className="in">
                            <div className="c"><div className="lede">Every incident classified through GUARD, geolocated, and traced to the companies inside its blast radius.</div></div>
                            <div className="c"><strong>{(totalIncidents ?? articles.length).toLocaleString()}</strong><em>Briefings classified</em></div>
                            <div className="c"><strong>{crit}</strong><em>Critical &amp; high severity</em></div>
                            <div className="c"><strong>{countries || cats}</strong><em>{countries ? "Countries affected" : "GUARD categories live"}</em></div>
                          </div>
                        </section>
                      );
                    })()}

                    {featuredReports.slice(0, 1).map((f) => {
                      const a = featuredArticle(f);
                      return (
                        <section key={`featband-${f.ref}`} className="sec" aria-label="Featured briefing">
                          <div onClick={() => openArticle(a)} role="button" tabIndex={0}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openArticle(a); } }}
                            style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch", cursor: "pointer", background: "#0F0F11", color: "#fff", border: `1px solid ${GOLD}`, overflow: "hidden" }}>
                            <div style={{ flex: "1 1 320px", minHeight: 200, background: `#1a1a1d url("${f.image || ""}") center/cover no-repeat` }} />
                            <div style={{ flex: "1.4 1 380px", padding: "26px 28px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 10 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <span style={{ background: GOLD, color: "#0F0F0F", fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", padding: "4px 8px" }}>{f.kicker || "Featured briefing"}</span>
                                <span style={{ fontSize: 11, color: "#A8A8A8", letterSpacing: "0.06em", textTransform: "uppercase" }}>{[f.industry, fmtShort(f.day)].filter(Boolean).join("  ·  ")}</span>
                              </div>
                              <h2 style={{ margin: 0, fontSize: 28, lineHeight: 1.15, letterSpacing: "-0.02em", color: "#fff" }}>{f.title}</h2>
                              {f.subtitle && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: "#C9C9CF", maxWidth: "62ch" }}>{f.subtitle}</p>}
                              <span style={{ marginTop: 6, alignSelf: "flex-start", background: GOLD, color: "#0F0F0F", fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", padding: "11px 18px" }}>Read the briefing →</span>
                            </div>
                          </div>
                        </section>
                      );
                    })}

                    {top.length > 0 && (
                      <section className="sec"><SecHead>Top Stories</SecHead><div className="g4">{top.map(Story)}</div></section>
                    )}

                    {spotMain && (
                      <section className="sec"><SecHead>Spotlight</SecHead>
                        <div className="spot">
                          <div className="big" onClick={() => openArticle(spotMain)}>
                            <div className="img"><NewsImage a={spotMain} lead /></div>
                            <div className="row"><SevChip a={spotMain} /><Kick>{catName(spotMain)}</Kick><span className="by">{fmtShort(spotMain.incident_day)}</span></div>
                            <h3>{spotMain.headline}</h3>
                            {spotMain.summary && <div className="dek">{spotMain.summary}</div>}
                          </div>
                          <div>{spotSide.map(a => (
                            <div key={a._key || a.id} className="aside" onClick={() => openArticle(a)}>
                              <div className="img"><NewsImage a={a} /></div>
                              <div className="row"><SevChip a={a} />{a.incident_day === liveDay && <LiveTag />}<Kick>{catName(a)}</Kick></div>
                              <h3>{a.headline}</h3>
                              {a.summary && <div className="ridek">{a.summary}</div>}
                            </div>
                          ))}</div>
                        </div>
                      </section>
                    )}

                    {bandCats.map(c => {
                      const list = byCat[c] || [];
                      const lead = list[0]; const more = list.slice(1, 6);
                      return (
                        <section className="sec" key={c}>
                          <div className="sh l"><span className="sq" style={{ background: SEV_C[lead.severity] || GOLD }} /><h2>{CAT_NAME[c] || c}</h2><button className="more" onClick={() => setCatFilter(c)}>More in {CAT_NAME[c] || c} ›</button></div>
                          <div className="band">
                            <div className="feat" onClick={() => openArticle(lead)}>
                              <div className="img"><NewsImage a={lead} lead /></div>
                              <div className="row"><SevChip a={lead} /><Kick>{catName(lead)}</Kick><span className="by">{fmtShort(lead.incident_day)}</span></div>
                              <h3>{lead.headline}</h3>
                              {lead.summary && <div className="dek">{lead.summary}</div>}
                              <div className="rm" style={{ marginTop: 12 }}>Read full briefing →</div>
                            </div>
                            <div><div className="morehead">More in {CAT_NAME[c] || c}</div>{more.map(MoreItem)}</div>
                          </div>
                        </section>
                      );
                    })}

                    {(featuredReports.length > 0 || standaloneReports.length > 0) && (
                      <section className="reports sec" style={{ marginTop: 48, padding: "42px 0" }}>
                        <div className="wrap">
                          <div className="sh l"><span className="sq" style={{ background: GOLD }} /><h2>Reports</h2></div>
                          <div className="an3">{featuredReports.map(FeaturedReportCard)}{standaloneReports.slice(0, Math.max(0, 6 - featuredReports.length)).map(ReportCard)}</div>
                        </div>
                      </section>
                    )}

                    {analysis.length > 0 && (
                      <section className="analysis sec" style={{ marginTop: 48, padding: "42px 0" }}>
                        <div className="wrap"><div className="sh l"><span className="sq" style={{ background: GOLD }} /><h2>GUARD Analysis</h2><span className="more" style={{ cursor: "default" }}>Operator takeaways</span></div>
                          <div className="an3">{analysis.map(OpCard)}</div>
                        </div>
                      </section>
                    )}

                    {decon && (
                      <section className="decon sec" style={{ padding: "48px 0" }}>
                        <div className="wrap"><div className="sh l" style={{ borderBottomColor: "#333" }}><span className="sq" style={{ background: GOLD }} /><h2 style={{ color: "#fff" }}>Deconstructed · one incident, traced</h2></div>
                          <div className="in">
                            <div className="img" onClick={() => openArticle(decon)}><NewsImage a={decon} lead /><span className="tag">Blast radius</span></div>
                            <div>
                              <div className="row" style={{ marginBottom: 10 }}><SevChip a={decon} /><span className="kick" style={{ color: GOLD }}>{catName(decon)}</span></div>
                              <h2>{decon.headline}</h2>
                              <p>{(decon.severity_rationale || decon.summary || "").slice(0, 280)}</p>
                              <div className="steps"><span className="step"><b>1</b> Entry</span><span className="step"><b>2</b> Spread</span><span className="step"><b>3</b> Impact</span><span className="step"><b>4</b> Blast radius</span></div>
                              <div style={{ marginTop: 20, display: "flex", gap: 10, flexWrap: "wrap" }}>
                                <button className="btn" onClick={openMap}>Trace it on the map →</button>
                                <button className="btn gh" onClick={() => openArticle(decon)}>Read briefing</button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </section>
                    )}

                    {mostCritical.length > 0 && (
                      <section className="sec"><SecHead>Most Critical Today</SecHead>
                        <div className="crit">
                          <div className="rail">{mostCritical.slice(0, 3).map((a, i) => RailItem(a, i + 1))}</div>
                          <div className="rail">{mostCritical.slice(3, 5).map((a, i) => RailItem(a, i + 4))}</div>
                        </div>
                      </section>
                    )}
                  </>
                )}

                {gridAll.length > 0 && (
                  <section className="sec"><SecHead>{safePage === 0 ? "Latest Intelligence" : `Latest Intelligence · Page ${safePage + 1}`}</SecHead>
                    <div className="latest">{gridPage.map(Card)}</div>
                    <Pager />
                  </section>
                )}

                <div className="cta">
                  <h3>The full picture lives on the map.</h3>
                  <p>Blast radius, adaptive controls and vendor Defence Ratings for every briefing above — free to enter, thirty seconds to sign up.</p>
                  <button className="btn" style={{ marginTop: 20 }} onClick={openMap}>{user ? "Open the map →" : "Sign up free →"}</button>
                </div>
              </>
            )}
          </main>
        </>
      )}

      <SiteFooter />
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </div>
  );
}
