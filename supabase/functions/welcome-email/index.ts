// welcome-email — Supabase Edge Function (Gmail SMTP backend)
//
// One-time branded welcome email, fired by the DB trigger
// trg_welcome_on_onboarded (identity.profiles.onboarded_at NULL → set) with
// { user_id }. Since 2026-09-22 the sign-up form is the end of onboarding:
// AuthModal stamps onboarded_at together with the profile basics, so the mail
// goes out the moment the 6-digit code is accepted.
//
// ── v2 · PERSONALISED TO THE SIGN-UP INDUSTRY ───────────────────────────────
//   1. Hero (logo + baked "Narrow your blast radius." banner)
//   2. "Welcome aboard, {name}" → "You're set up for {industry}." + what the
//      daily brief will do for them (industry, categories, severity floor)
//   3. "Your first {industry} brief" — the three strongest incidents in THEIR
//      industry from the last 7 days, as free-depth cards: thumbnail, headline,
//      summary, the locked counts line, Hub + map links. Falls back to the
//      sweep's top three when the industry has nothing yet.
//   4. "Start here" — Dashboard / Live map / Plans
//   5. "Your calibration" — industry, categories, minimum severity, cadence,
//      with a Configure alerts link
//   6. Footer — socials + manage alerts + unsubscribe
//
// TESTING: POST { "user_id": "<uuid>", "dryRun": true } → { subject, html },
// nothing sent. The preview renderer (scripts/render-email-templates.mjs)
// loads everything above the serve call under Node.
//
// Email-safe: pure <table> layout, inline styles, absolute image URLs.
//
// ── 2026-09-30 · portable to Cloud Run ──────────────────────────────────────
//   • Callers must be internal: x-internal-token or the service-role key
//     (_shared/auth.ts). Before, anyone could POST a user_id and have that
//     account mailed, or read its address back from a dry run.
//   • Mail goes through _shared/mail.ts: Resend when RESEND_API_KEY is set,
//     else Gmail SMTP (GMAIL_USER + GMAIL_APP_PASSWORD, SENDER_NAME) as before.
//   • user_id must be a UUID; a profile without an unsubscribe token gets the
//     Configure alerts link instead of "?unsubscribe=null".
//   • Listens on env PORT when set (Cloud Run), else Deno's default 8000.
// On Google Cloud the trigger's net.http_post is queued in the outbox and the
// API delivers it here (deploy/gcp/functions/README.md).

import { idemKey, mailProvider, mailSetupError, sendMail } from "../_shared/mail.ts";
import { requireInternal } from "../_shared/auth.ts";

const APP_URL            = Deno.env.get("APP_URL")            ?? "https://attackedmap.vercel.app";
const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")       ?? "https://ovenyjguhkgiceddzwna.supabase.co";
const SERVICE_KEY        = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LOGO_URL           = `${APP_URL}/attacked-ai-logo.png`;
const HERO_URL           = `${APP_URL}/email-hero-welcome.png`;

// Social links — mirror the site footer + daily-digest.
const SOCIAL = {
  linkedin:  "https://www.linkedin.com/company/attacked-ai",
  x:         "https://x.com/attacked_ai",
  facebook:  "https://www.facebook.com/attacked.ai",
  youtube:   "https://www.youtube.com/@attacked-ai",
  instagram: "https://www.instagram.com/attacked.ai",
};

const GOLD = "#FCBD00", OBSIDIAN = "#1A1A1A", DEEP = "#080808", MUTED = "#A8A8A8", GREEN = "#34C759", ORANGE = "#FF8C5A";
const INTER = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const SEV_LABEL: Record<number,string> = { 5:"CRITICAL", 4:"HIGH", 3:"MEDIUM", 2:"LOW", 1:"MINIMAL" };
const SEV_COLOR: Record<number,string> = { 5:"#FF3B30", 4:ORANGE, 3:GOLD, 2:GREEN, 1:"#8E8E93" };
const CATEGORY_COUNT = 13;
const CATEGORY_NAME: Record<string, string> = {
  CYB: "Cyber Security", DAT: "Data & Privacy", TEC: "Technology", GEO: "Geopolitical",
  PHY: "Physical Security", OPS: "Operational", TPR: "Third-Party Risk", REG: "Regulatory",
  FIN: "Financial", STR: "Strategic", REP: "Reputational", PPL: "People & Human Capital",
  ENV: "Environmental",
};

// Category → banner image (same stable Unsplash set as the landing + hub).
const CATEGORY_IMG: Record<string,string> = {
  CYB: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=240&q=60&auto=format&fit=crop",
  DAT: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=240&q=60&auto=format&fit=crop",
  FIN: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=240&q=60&auto=format&fit=crop",
  GEO: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=240&q=60&auto=format&fit=crop",
  REG: "https://images.unsplash.com/photo-1589829545856-d10d557cf95f?w=240&q=60&auto=format&fit=crop",
  PHY: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=240&q=60&auto=format&fit=crop",
  PPL: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=240&q=60&auto=format&fit=crop",
  TEC: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=240&q=60&auto=format&fit=crop",
  STR: "https://images.unsplash.com/photo-1605810230434-7631ac76ec81?w=240&q=60&auto=format&fit=crop",
  REP: "https://images.unsplash.com/photo-1495020689067-958852a7765e?w=240&q=60&auto=format&fit=crop",
  TPR: "https://images.unsplash.com/photo-1556761175-5973dc0f32e7?w=240&q=60&auto=format&fit=crop",
  OPS: "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=240&q=60&auto=format&fit=crop",
  ENV: "https://images.unsplash.com/photo-1473773508845-188df298d2d1?w=240&q=60&auto=format&fit=crop",
  _default: "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?w=240&q=60&auto=format&fit=crop",
};
// Feature-card images.
const FEATURE_IMG = {
  dashboard: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=360&q=60&auto=format&fit=crop",
  map:       "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=360&q=60&auto=format&fit=crop",
  plans:     "https://images.unsplash.com/photo-1605810230434-7631ac76ec81?w=360&q=60&auto=format&fit=crop",
};

// App deep links — the same ones the daily brief uses.
const hubUrl = (id: unknown) => `${APP_URL}/?hub&open=${encodeURIComponent(String(id))}`;
const mapUrl = (i: any) => `${APP_URL}/?map&incident=${encodeURIComponent(String(i.id))}${i.incident_day ? `&date=${i.incident_day}` : ""}`;
const ALERTS_URL    = `${APP_URL}/?subscriptions`;
const SUBSCRIBE_URL = `${APP_URL}/?subscribe`;
const DASHBOARD_URL = `${APP_URL}/?dashboard`;
const MAP_URL       = `${APP_URL}/?map`;

function escape(s: unknown): string {
  return String(s ?? "").replace(/[&<>\"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c as string] || c));
}
function trim(s: unknown, n: number): string {
  const t = String(s ?? "").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\-–—]$/, "") + "…";
}
const sevOf = (i: any) => { const n = Number(i?.severity); return n >= 1 && n <= 5 ? Math.round(n) : 1; };
const shortIndustry = (s: unknown) => String(s ?? "").replace(/\s*\([^)]*\)/g, "").trim();
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
function firstNameOf(profile: any): string {
  return String(profile?.full_name || profile?.email || "there").split(" ")[0].split("@")[0] || "there";
}
function clampSev(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : 3;
}
function categoryLabel(arr: unknown): string {
  const vals = Array.isArray(arr) ? arr.map((v) => String(v).trim()).filter(Boolean) : [];
  if (!vals.length || vals.length >= CATEGORY_COUNT) return `All ${CATEGORY_COUNT} categories`;
  const names = vals.map((c) => CATEGORY_NAME[c] || c);
  return names.slice(0, 3).join(" · ") + (names.length > 3 ? ` +${names.length - 3}` : "");
}
function countsOf(i: any): { blast: number; controls: number; peers: number } | null {
  const l = Array.isArray(i?.layer_counts) ? i.layer_counts[0] : i?.layer_counts;
  if (!l) return null;
  return { blast: Number(l.blast) || 0, controls: Number(l.controls) || 0, peers: Number(l.peers) || 0 };
}

function shell(title: string, tagline: string, bodyHtml: string, unsubUrl: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head>` +
    `<body style="margin:0;padding:32px 16px;background:${DEEP};font-family:${INTER};color:#FFFFFF;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:${OBSIDIAN};border:1px solid #333;border-radius:10px;overflow:hidden;">` +
    `<tr><td style="padding:22px 28px 18px;border-bottom:1px solid #333;">` +
      `<table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
        `<td style="vertical-align:middle;padding-right:12px;"><img src="${LOGO_URL}" alt="Attacked.ai" width="42" height="42" style="display:block;"></td>` +
        `<td style="vertical-align:middle;">` +
          `<div style="font-family:${INTER};font-size:20px;font-weight:700;color:#FFF;letter-spacing:-0.01em;line-height:1;">Attacked<span style="color:${GOLD};">.ai</span><sup style="font-size:10px;color:#FFF;margin-left:1px;font-weight:600;">™</sup></div>` +
          `<div style="font-family:${INTER};font-size:10.5px;color:${MUTED};letter-spacing:0.14em;text-transform:uppercase;margin-top:5px;font-weight:600;">${escape(tagline)}</div>` +
        `</td>` +
      `</tr></table>` +
    `</td></tr>` +
    `<tr><td style="padding:0;"><img src="${HERO_URL}" width="600" alt="" style="display:block;width:100%;border:0;"></td></tr>` +
    `<tr><td style="padding:28px;">${bodyHtml}</td></tr>` +
    `<tr><td style="padding:24px 28px 22px;border-top:1px solid #333;text-align:center;">` +
      `<div style="font-family:${INTER};font-size:11px;color:#FFF;font-weight:700;letter-spacing:0.04em;margin-bottom:12px;">Follow our thinking</div>` +
      `<div style="font-family:${INTER};font-size:12px;color:${MUTED};margin-bottom:18px;">` +
        `<a href="${SOCIAL.linkedin}" style="color:${MUTED};text-decoration:none;">LinkedIn</a> &nbsp;·&nbsp; ` +
        `<a href="${SOCIAL.x}" style="color:${MUTED};text-decoration:none;">X</a> &nbsp;·&nbsp; ` +
        `<a href="${SOCIAL.facebook}" style="color:${MUTED};text-decoration:none;">Facebook</a> &nbsp;·&nbsp; ` +
        `<a href="${SOCIAL.youtube}" style="color:${MUTED};text-decoration:none;">YouTube</a> &nbsp;·&nbsp; ` +
        `<a href="${SOCIAL.instagram}" style="color:${MUTED};text-decoration:none;">Instagram</a>` +
      `</div>` +
      `<div style="font-family:${INTER};font-size:10.5px;color:#585858;letter-spacing:0.10em;text-transform:uppercase;font-weight:600;">` +
        `© 2026 Attacked.ai · GUARD framework<br><br>` +
        `<a href="${ALERTS_URL}" style="color:#585858;text-decoration:underline;font-family:${INTER};font-size:10.5px;">Manage alerts</a>` +
        `&nbsp;&nbsp;·&nbsp;&nbsp;` +
        `<a href="${unsubUrl}" style="color:#585858;text-decoration:underline;font-family:${INTER};font-size:10.5px;">Unsubscribe</a>` +
      `</div>` +
    `</td></tr></table></body></html>`;
}

async function pgFetch(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) throw new Error(`PostgREST ${r.status}: ${await r.text()}`);
  return r.json();
}

// One incident as a free-depth card: thumbnail, classification, headline,
// summary, the locked counts line, Hub + map links.
function incidentCard(i: any): string {
  const sev = sevOf(i);
  const c = SEV_COLOR[sev] || GOLD;
  // The incident's stored picture (incidents.image_url); category stock as fallback.
  const img = i.image_url || CATEGORY_IMG[i.primary_category as string] || CATEGORY_IMG._default;
  const cat = CATEGORY_NAME[i.primary_category] || i.primary_category || "Operational";
  const n = countsOf(i);
  const locked = n
    ? `<b style="color:#FFF;">${plural(n.blast, "exposed organisation")}</b> · <b style="color:#FFF;">${plural(n.controls, "GUARD control")}</b> · <b style="color:#FFF;">${plural(n.peers, "peer")} to watch</b>`
    : `Named blast radius, GUARD controls and the peer watchlist`;
  return `<tr><td style="padding:14px 0;border-top:1px solid #2a2a2a;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>` +
      `<td style="width:72px;vertical-align:top;padding-right:14px;">` +
        `<img src="${img}" alt="" width="72" height="54" style="display:block;border-radius:5px;object-fit:cover;">` +
      `</td>` +
      `<td style="vertical-align:top;">` +
        `<div style="font-family:${INTER};font-size:9.5px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;margin-bottom:4px;color:${c};">${SEV_LABEL[sev]} · ${escape(cat)}${i.country ? `<span style="color:${MUTED};"> · ${escape(i.country)}</span>` : ""}</div>` +
        `<a href="${hubUrl(i.id)}" style="font-family:${INTER};font-size:14.5px;font-weight:700;color:#FFF;line-height:1.35;text-decoration:none;display:block;">${escape(i.headline || "")}</a>` +
        (i.entity ? `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.06em;font-weight:700;text-transform:uppercase;margin-top:4px;">${escape(i.entity)}</div>` : "") +
        (i.summary ? `<div style="font-family:${INTER};font-size:12.5px;color:#D2D2D2;line-height:1.55;margin-top:6px;">${escape(trim(i.summary, 200))}</div>` : "") +
      `</td>` +
    `</tr></table>` +
    `<div style="margin:10px 0 0;padding:8px 11px;background:${DEEP};border:1px dashed #3a3a3a;border-radius:4px;font-family:${INTER};font-size:11.5px;color:${MUTED};line-height:1.5;">🔒 ${locked} — <a href="${SUBSCRIBE_URL}" style="color:${GOLD};text-decoration:none;font-weight:700;">subscriber only</a></div>` +
    `<div style="margin-top:9px;font-family:${INTER};font-size:11.5px;font-weight:700;letter-spacing:0.04em;">` +
      `<a href="${hubUrl(i.id)}" style="color:${GOLD};text-decoration:none;">Open in Attack Hub →</a>` +
      `<a href="${mapUrl(i)}" style="color:${MUTED};text-decoration:none;margin-left:16px;">View on map →</a>` +
    `</div>` +
  `</td></tr>`;
}

function welcomeHtml(profile: any, incidents: any[], unsubUrl: string) {
  const name = firstNameOf(profile);
  const industry = String(profile?.industry || "").trim();
  const ind = shortIndustry(industry) || industry;
  const minSev = clampSev(profile?.min_severity);
  const cats = categoryLabel(profile?.watch_categories);
  const weekly = profile?.digest_frequency === "weekly";
  const freq = weekly ? "Weekly brief" : "Daily brief";
  const inIndustry = industry ? incidents.filter((i) => String(i.industry || "").trim() === industry) : [];
  const shown = (inIndustry.length ? inIndustry : incidents).slice(0, 3);

  const benefit = (txt: string) =>
    `<tr><td style="padding:7px 0;vertical-align:top;width:22px;"><span style="color:${GOLD};font-weight:800;">✓</span></td>` +
    `<td style="padding:7px 0;font-family:${INTER};font-size:13.5px;color:#FFF;line-height:1.55;">${txt}</td></tr>`;

  const featureCard = (img: string, label: string, title: string, blurb: string, cta: string, href: string) =>
    `<td width="33%" style="vertical-align:top;padding:0 6px;">` +
      `<a href="${href}" style="text-decoration:none;display:block;background:${DEEP};border:1px solid #333;border-radius:8px;overflow:hidden;">` +
        `<img src="${img}" alt="" width="100%" height="86" style="display:block;width:100%;height:86px;object-fit:cover;">` +
        `<div style="padding:12px 13px 14px;">` +
          `<div style="font-family:${INTER};font-size:9px;font-weight:700;color:${GOLD};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:5px;">${label}</div>` +
          `<div style="font-family:${INTER};font-size:14px;font-weight:700;color:#FFF;line-height:1.25;margin-bottom:6px;">${title}</div>` +
          `<div style="font-family:${INTER};font-size:11px;color:${MUTED};line-height:1.5;margin-bottom:10px;">${blurb}</div>` +
          `<div style="font-family:${INTER};font-size:10.5px;font-weight:700;color:${GOLD};letter-spacing:0.06em;text-transform:uppercase;">${cta} →</div>` +
        `</div>` +
      `</a>` +
    `</td>`;

  const sumRow = (k: string, v: string, top = true) =>
    `<tr><td style="padding:7px 0;font-family:${INTER};font-size:12.5px;color:${MUTED};${top ? "border-top:1px solid rgba(255,255,255,0.05);" : ""}">${k}</td>` +
    `<td style="padding:7px 0;font-family:${INTER};font-size:12.5px;color:#FFF;font-weight:600;text-align:right;${top ? "border-top:1px solid rgba(255,255,255,0.05);" : ""}">${escape(v)}</td></tr>`;

  const headline = industry ? `You're set up for ${escape(industry)}.` : "Thanks for joining. Now make the most of your account.";
  const intro = industry
    ? `From the next sweep, your <b style="color:#FFF;">${freq.toLowerCase()}</b> lands at 08:00 UTC with every <b style="color:#FFF;">${escape(ind)}</b> incident at <b style="color:#FFF;">S${minSev}+</b> across ${escape(cats).toLowerCase()}, plus anything high or critical elsewhere. Here is where ${escape(ind)} stands today.`
    : `Your account is live. <a href="${ALERTS_URL}" style="color:${GOLD};text-decoration:none;font-weight:700;">Set your industry →</a> and the daily brief will lead with what matters to you.`;

  const firstBriefTitle = industry
    ? (inIndustry.length ? `Your first ${escape(ind)} brief` : `Nothing in ${escape(ind)} this week — the sweep's top incidents`)
    : "Today's top incidents";
  const firstBriefSub = industry && inIndustry.length
    ? `${plural(inIndustry.length, "incident")} in the last 7 days · the three strongest`
    : "";

  const body =
    `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Welcome aboard, ${escape(name)}</div>` +
    `<h1 style="font-family:${INTER};font-size:25px;font-weight:800;color:#FFF;margin:0 0 12px;line-height:1.25;letter-spacing:-0.015em;">${headline}</h1>` +
    `<p style="font-family:${INTER};font-size:14px;color:${MUTED};line-height:1.6;margin:0 0 6px;">${intro}</p>` +

    (shown.length ?
      `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin:26px 0 0;">${firstBriefTitle}</div>` +
      (firstBriefSub ? `<div style="font-family:${INTER};font-size:12px;color:${MUTED};margin-top:4px;">${firstBriefSub}</div>` : "") +
      `<table cellpadding="0" cellspacing="0" width="100%" style="margin-top:6px;">${shown.map(incidentCard).join("")}</table>` : "") +

    `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin:26px 0 4px;">What you get</div>` +
    `<table cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 4px;">` +
      benefit(`Your <b>dashboard</b> — every ${industry ? escape(ind) : "industry"} incident, classified, with the sector-level signals.`) +
      benefit(`The <b>${freq.toLowerCase()}</b> — ${industry ? `${escape(ind)} at S${minSev}+, ${escape(cats).toLowerCase()}` : "your industry, your categories, your severity floor"}, plus high or critical incidents elsewhere. <a href="${ALERTS_URL}" style="color:${GOLD};text-decoration:none;font-weight:700;">Configure alerts →</a>`) +
      benefit("The <b>live attack map</b> and the <b>Attacked Hub</b> — every incident geolocated, GUARD-classified and written up.") +
      benefit(`Locked, for now: named blast radius, GUARD controls, the peer watchlist, and Impact Assessments, Watchlists and Pathways for your organisation — when you <a href="${SUBSCRIBE_URL}" style="color:${GOLD};text-decoration:none;font-weight:700;">subscribe</a>.`) +
    `</table>` +

    `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin:28px 0 12px;">Start here</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr style="vertical-align:top;">` +
      featureCard(FEATURE_IMG.dashboard, "Your dashboard", industry ? escape(ind) : "Your industry", "Every incident in your industry, with the signals.", "Open", DASHBOARD_URL) +
      featureCard(FEATURE_IMG.map, "Live map", "Open the map", "Every incident, geolocated and classified.", "Explore", MAP_URL) +
      featureCard(FEATURE_IMG.plans, "Go deeper", "See plans", "Blast radius, controls, peers, assessments.", "Compare", SUBSCRIBE_URL) +
    `</tr></table>` +

    `<div style="margin-top:28px;padding:18px 20px;background:${DEEP};border:1px solid ${GOLD}55;border-radius:8px;">` +
      `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:10px;">Your calibration</div>` +
      `<table cellpadding="0" cellspacing="0" width="100%">` +
        sumRow("Industry", industry || "Not set yet", false) +
        sumRow("Categories", cats) +
        sumRow("Minimum severity", `S${minSev} · ${SEV_LABEL[minSev].charAt(0) + SEV_LABEL[minSev].slice(1).toLowerCase()} and above`) +
        sumRow("Briefing", `${freq} → your inbox`) +
      `</table>` +
      `<div style="margin-top:10px;font-family:${INTER};font-size:11.5px;"><a href="${ALERTS_URL}" style="color:${GOLD};text-decoration:none;font-weight:700;">Change any of this →</a></div>` +
    `</div>` +

    `<div style="margin-top:26px;">` +
      `<a href="${DASHBOARD_URL}" style="display:inline-block;padding:13px 26px;background:${GOLD};color:${OBSIDIAN};text-decoration:none;border-radius:5px;font-family:${INTER};font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Open your dashboard →</a>` +
      `<a href="${ALERTS_URL}" style="display:inline-block;margin-left:10px;padding:13px 22px;background:transparent;color:#FFF;border:1px solid #333;text-decoration:none;border-radius:5px;font-family:${INTER};font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">Configure alerts</a>` +
    `</div>`;

  return shell(`Welcome to Attacked.ai`, `Account activated · ${industry ? ind : freq}`, body, unsubUrl);
}

function welcomeSubject(profile: any): string {
  const name = firstNameOf(profile);
  const ind = shortIndustry(profile?.industry);
  return `Welcome to Attacked.ai${name !== "there" ? ", " + name : ""} — your ${ind ? ind + " " : ""}brief is live`;
}

// The three strongest incidents in the reader's industry over the last 7
// days of the corpus, falling back to the sweep's top three.
async function firstBriefIncidents(industry: string): Promise<any[]> {
  const cols = "id,headline,summary,entity,country,industry,severity,primary_category,incident_day,image_url,layer_counts(*)";
  const latest = await pgFetch(`incidents?select=incident_day&incident_day=not.is.null&order=incident_day.desc&limit=1`);
  const latestDay: string | undefined = latest?.[0]?.incident_day;
  if (!latestDay) return [];
  const d = new Date(latestDay + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 6);
  const weekStart = d.toISOString().slice(0, 10);
  if (industry) {
    const mine = await pgFetch(`incidents?select=${cols}&industry=eq.${encodeURIComponent(industry)}&incident_day=gte.${weekStart}&latitude=not.is.null&order=severity.desc.nullslast,incident_day.desc,id.desc&limit=3`);
    if (mine.length) return mine;
  }
  return await pgFetch(`incidents?select=${cols}&incident_day=eq.${latestDay}&latitude=not.is.null&order=severity.desc.nullslast,id.desc&limit=3`);
}

const PROFILE_COLS = "email,full_name,industry,tier,watch_categories,digest_frequency,unsubscribe_token";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (req) => {
  const denied = await requireInternal(req);
  if (denied) return denied;

  let userId: string | null = null; let dryRun = false;
  try { const body = await req.json().catch(() => ({})); userId = body?.user_id ?? null; dryRun = body?.dryRun === true; } catch { /* noop */ }
  if (!userId) return new Response(JSON.stringify({ ok: false, error: "user_id required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  // user_id goes into the PostgREST filter below, so only a real UUID passes.
  if (!UUID_RE.test(String(userId))) return new Response(JSON.stringify({ ok: false, error: "user_id must be a UUID" }), { status: 400, headers: { "Content-Type": "application/json" } });

  // min_severity arrives with migration 20260922_brief_prefs.sql; the fallback
  // select keeps the welcome alive until it is applied.
  let profiles: any[];
  try { profiles = await pgFetch(`profiles?id=eq.${userId}&select=${PROFILE_COLS},min_severity&limit=1`); }
  catch { profiles = await pgFetch(`profiles?id=eq.${userId}&select=${PROFILE_COLS}&limit=1`); }
  const profile = profiles?.[0];
  if (!profile) return new Response(JSON.stringify({ ok: false, error: "profile not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

  let incidents: any[] = [];
  try { incidents = await firstBriefIncidents(String(profile.industry || "").trim()); }
  catch (err) { console.warn("[welcome-email] incidents unavailable:", (err as Error)?.message); }

  const unsubUrl = profile.unsubscribe_token
    ? `${APP_URL}/?unsubscribe=${encodeURIComponent(String(profile.unsubscribe_token))}`
    : ALERTS_URL;
  const html = welcomeHtml(profile, incidents, unsubUrl);
  const subject = welcomeSubject(profile);

  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, dryRun: true, to: profile.email, industry: profile.industry, incidents: incidents.length, subject, html }),
      { headers: { "Content-Type": "application/json" } });
  }

  const setupError = mailSetupError();
  if (setupError) return new Response(JSON.stringify({ ok: false, error: setupError }), { status: 500, headers: { "Content-Type": "application/json" } });

  // Keyed on the user and the email itself: the trigger (or the GCP outbox) retrying
  // after a timeout cannot deliver the same welcome twice.
  const res = await sendMail({ to: profile.email, subject, html, idempotencyKey: await idemKey("welcome-email", userId, subject, html) });
  if (!res.ok) return new Response(JSON.stringify({ ok: false, provider: res.provider, error: res.error }), { status: 500, headers: { "Content-Type": "application/json" } });

  return new Response(JSON.stringify({ ok: true, provider: mailProvider(), to: profile.email, industry: profile.industry, incidents: incidents.length }), { headers: { "Content-Type": "application/json" } });
});
