// DEPLOYED COPY, for reference only: never built or deployed from here.
// Supabase project ovenyjguhkgiceddzwna, function welcome-email v5
// (verify_jwt = false, last deployed 2026-06-18), fetched 2026-09-30.
// Below this header the file is what runs today: the June "Design Partner"
// welcome (generic top incidents, Design Partner card, /?pricing links). It is
// OLDER than ./index.ts (v2, personalised to the sign-up industry, 2026-09-22),
// which was committed but never deployed. Reconcile by deploying ./index.ts.

// welcome-email — Supabase Edge Function (Gmail SMTP backend)
//
// One-time branded welcome email, fired when onboarding completes
// (profiles.onboarded_at NULL → set) via a DB trigger with { user_id }.
//
// Structure mirrors McKinsey's welcome mail — but image-rich:
//   1. Editorial hero (baked "Narrow your blast radius." headline + radar)
//   2. "Now make the most of your account" greeting + benefits checklist
//   3. "Today's top incidents" — 3 real rows, each with a category IMAGE
//   4. 3 feature cards (image + title + CTA): Map / Hub / Design Partner
//   5. Calibration summary card
//   6. Footer — "Follow our thinking" socials + manage subscription + unsubscribe
//
// Email-safe: pure <table> layout, inline styles, absolute image URLs.

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const GMAIL_USER         = Deno.env.get("GMAIL_USER")         ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const SENDER_NAME        = Deno.env.get("SENDER_NAME")        ?? "Attacked.ai";
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

const GOLD = "#F5B800", OBSIDIAN = "#1A1A1A", DEEP = "#080808", MUTED = "#A8A8A8", GREEN = "#34C759", ORANGE = "#FF8C5A";
const INTER = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const SEV_LABEL: Record<number,string> = { 5:"CRITICAL", 4:"HIGH", 3:"MEDIUM", 2:"LOW", 1:"MINIMAL" };
const SEV_COLOR: Record<number,string> = { 5:"#FF3B30", 4:ORANGE, 3:GOLD, 2:GREEN, 1:"#8E8E93" };

// Category → banner image (same stable Unsplash set as the landing + hub).
const CATEGORY_IMG: Record<string,string> = {
  CYB: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=240&q=60&auto=format&fit=crop",
  DAT: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=240&q=60&auto=format&fit=crop",
  FIN: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=240&q=60&auto=format&fit=crop",
  GEO: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=240&q=60&auto=format&fit=crop",
  REG: "https://images.unsplash.com/photo-1589829545856-d10d557cf95f?w=240&q=60&auto=format&fit=crop",
  PHY: "https://images.unsplash.com/photo-1518709268805-4e9042af2176?w=240&q=60&auto=format&fit=crop",
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
  map:     "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=360&q=60&auto=format&fit=crop",
  hub:     "https://images.unsplash.com/photo-1495020689067-958852a7765e?w=360&q=60&auto=format&fit=crop",
  partner: "https://images.unsplash.com/photo-1605810230434-7631ac76ec81?w=360&q=60&auto=format&fit=crop",
};

function escape(s: unknown): string {
  return String(s ?? "").replace(/[&<>\"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c as string] || c));
}

function shell(title: string, tagline: string, bodyHtml: string, unsubUrl: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
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
    `<tr><td style="padding:0;"><img src="${HERO_URL}" width="600" alt="Narrow your blast radius — welcome to Attacked.ai" style="display:block;width:100%;border:0;"></td></tr>` +
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
        `<a href="${APP_URL}/?subscriptions" style="color:#585858;text-decoration:underline;font-family:${INTER};font-size:10.5px;">Manage subscription</a>` +
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

function welcomeHtml(profile: any, incidents: any[], unsubUrl: string) {
  const firstName = (profile.full_name || profile.email || "there").split(" ")[0].split("@")[0];
  const watchInds: string[] = Array.isArray(profile.watch_industries) ? profile.watch_industries : [];
  const watchCats: string[] = Array.isArray(profile.watch_categories) ? profile.watch_categories : [];
  const freq = profile.digest_frequency === "weekly" ? "Weekly rollup" : "Daily brief";
  const watchingLabel = (!watchInds.length || watchInds.length >= 40) ? "All industries" : `${watchInds.length} industries`;
  const riskLabel = (!watchCats.length || watchCats.length >= 13) ? "All 13 categories" : watchCats.join(" · ");

  const benefit = (txt: string) =>
    `<tr><td style="padding:7px 0;vertical-align:top;width:22px;"><span style="color:${GOLD};font-weight:800;">✓</span></td>` +
    `<td style="padding:7px 0;font-family:${INTER};font-size:13.5px;color:#FFF;line-height:1.55;">${txt}</td></tr>`;

  const incidentRows = incidents.slice(0, 3).map((i) => {
    const c = SEV_COLOR[i.severity] || GOLD;
    const img = CATEGORY_IMG[i.primary_category as string] || CATEGORY_IMG._default;
    return `<tr><td style="padding:12px 0;border-top:1px solid #2a2a2a;">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>` +
        `<td style="width:72px;vertical-align:top;padding-right:14px;">` +
          `<img src="${img}" alt="" width="72" height="54" style="display:block;border-radius:5px;object-fit:cover;">` +
        `</td>` +
        `<td style="vertical-align:top;">` +
          `<div style="font-family:${INTER};font-size:9.5px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;margin-bottom:4px;color:${c};">${SEV_LABEL[i.severity] || "—"} · ${escape(i.primary_category || "OPS")} · ${escape(i.country || "")}</div>` +
          `<div style="font-family:${INTER};font-size:14px;font-weight:600;color:#FFF;line-height:1.4;">${escape(i.headline || "")}</div>` +
        `</td>` +
      `</tr></table>` +
    `</td></tr>`;
  }).join("");

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

  const body =
    `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Welcome aboard, ${escape(firstName)}</div>` +
    `<h1 style="font-family:${INTER};font-size:25px;font-weight:800;color:#FFF;margin:0 0 12px;line-height:1.25;letter-spacing:-0.015em;">Thanks for joining. Now make the most of your account.</h1>` +
    `<p style="font-family:${INTER};font-size:14px;color:${MUTED};line-height:1.6;margin:0 0 20px;">Your intelligence briefing is calibrated. Explore everything your account unlocks — tuned to your world.</p>` +

    `<table cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 4px;">` +
      benefit("Your <b>daily brief</b> — every classified incident, led by the industries you watch.") +
      benefit("The <b>live attack map</b> — every incident geolocated and GUARD-classified.") +
      benefit("The <b>Attacked Hub</b> — the editorial feed of the latest daily sweep.") +
      benefit("Locked, for now: named blast radius, adaptive controls and vendor Defence Ratings — with <b style=\"color:#F5B800;\">Design Partner</b> access.") +
    `</table>` +

    (incidents.length ?
      `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin:26px 0 0;">Today's top incidents</div>` +
      `<table cellpadding="0" cellspacing="0" width="100%" style="margin-top:4px;">${incidentRows}</table>` : "") +

    `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin:28px 0 12px;">Start here</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr style="vertical-align:top;">` +
      featureCard(FEATURE_IMG.map, "Live map", "Open the map", "Every incident, geolocated and classified.", "Explore", `${APP_URL}/?map`) +
      featureCard(FEATURE_IMG.hub, "The hub", "Read the feed", "The latest sweep, written for operators.", "Browse", `${APP_URL}/?hub`) +
      featureCard(FEATURE_IMG.partner, "Go deeper", "Design Partner", "Blast radius, controls, vendor ratings.", "Apply", `${APP_URL}/?pricing`) +
    `</tr></table>` +

    `<div style="margin-top:28px;padding:18px 20px;background:${DEEP};border:1px solid ${GOLD}55;border-radius:8px;">` +
      `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:10px;">Your calibration</div>` +
      `<table cellpadding="0" cellspacing="0" width="100%">` +
        sumRow("Watching", watchingLabel, false) +
        sumRow("Risk lens", riskLabel) +
        sumRow("Briefing", `${freq} → your inbox`) +
      `</table>` +
    `</div>` +

    `<div style="margin-top:26px;">` +
      `<a href="${APP_URL}/?map" style="display:inline-block;padding:13px 26px;background:${GOLD};color:${OBSIDIAN};text-decoration:none;border-radius:5px;font-family:${INTER};font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Open the live map →</a>` +
      `<a href="${APP_URL}/?subscriptions" style="display:inline-block;margin-left:10px;padding:13px 22px;background:transparent;color:#FFF;border:1px solid #333;text-decoration:none;border-radius:5px;font-family:${INTER};font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">Manage subscription</a>` +
    `</div>`;

  return shell(`Welcome to Attacked.ai`, `Account activated · ${freq}`, body, unsubUrl);
}

async function createSmtpClient() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error("GMAIL creds missing");
  return new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } } });
}

Deno.serve(async (req) => {
  let userId: string | null = null;
  try { const body = await req.json().catch(() => ({})); userId = body?.user_id ?? null; } catch { /* noop */ }
  if (!userId) return new Response(JSON.stringify({ ok: false, error: "user_id required" }), { status: 400, headers: { "Content-Type": "application/json" } });

  const profiles = await pgFetch(`profiles?id=eq.${userId}&select=email,full_name,industry,watch_industries,watch_categories,digest_frequency,unsubscribe_token&limit=1`);
  const profile = profiles?.[0];
  if (!profile) return new Response(JSON.stringify({ ok: false, error: "profile not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

  const latest = await pgFetch(`incidents?select=incident_day&order=incident_day.desc&limit=1`);
  const latestDay = latest?.[0]?.incident_day;
  let incidents: any[] = [];
  if (latestDay) incidents = await pgFetch(`incidents?select=headline,country,severity,primary_category&incident_day=eq.${latestDay}&latitude=not.is.null&order=severity.desc.nullslast,id.desc&limit=3`);

  const unsubUrl = `${APP_URL}/?unsubscribe=${profile.unsubscribe_token}`;
  const html = welcomeHtml(profile, incidents, unsubUrl);

  let client: SMTPClient;
  try { client = await createSmtpClient(); }
  catch (err) { return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } }); }

  try {
    const firstName = (profile.full_name || profile.email || "").split(" ")[0].split("@")[0];
    await client.send({
      from: `${SENDER_NAME} <${GMAIL_USER}>`,
      to: profile.email,
      subject: `Welcome to Attacked.ai${firstName ? ", " + firstName : ""} — your briefing is live`,
      content: "This email is best viewed in an HTML-capable client.",
      html,
    });
  } catch (err) {
    try { await client.close(); } catch { /* noop */ }
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  try { await client.close(); } catch { /* noop */ }

  return new Response(JSON.stringify({ ok: true, provider: "gmail-smtp", to: profile.email }), { headers: { "Content-Type": "application/json" } });
});
