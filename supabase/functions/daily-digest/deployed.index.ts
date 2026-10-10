// DEPLOYED COPY, for reference only: never built or deployed from here.
// Supabase project ovenyjguhkgiceddzwna, function daily-digest v20
// (verify_jwt = false, last deployed 2026-06-18), fetched 2026-09-30.
// Below this header the file is what runs today. It is the June "v16/v19
// Partner" brief, OLDER than ./index.ts (v17 industry-led, 2026-09-22, never
// deployed). It still selects incidents.if_you_operate_x_then_y (dropped from
// incidents on 2026-07-28), so PostgREST should reject its incident query, and
// it only knows the retired "partner" tier. Its pg_cron job is inactive.
// Reconcile by deploying ./index.ts; nothing here needs keeping.

// daily-digest — Supabase Edge Function (Gmail SMTP backend)
// Sends the incident digest to all email_subscribed=true profiles.
//
// ── v16 · PERSONALISED ──────────────────────────────────────────────────────────
// Each reader's brief now leads with THEIR watchlist. Onboarding / Manage
// Subscription capture two preference axes plus a cadence:
//   • watch_industries  jsonb[]  — granular industry names (matches
//                                  incidents.industry exactly). Empty or all-43
//                                  ⇒ "watch everything" (no industry focus).
//   • watch_categories  jsonb[]  — GUARD codes (matches incidents
//                                  .primary_category). Empty or all-13 ⇒
//                                  "all risks" (no category focus).
//   • digest_frequency  text     — "daily" (every send) | "weekly" (Mondays,
//                                  covering the prior 7 days).
//
// When a reader has a focus, the brief leads with their watchlist matches, then
// the rest of the day — honouring BOTH curation AND full breadth at a glance.
// Readers who watch everything get the classic brief (backward-compatible).
//
// v18 · AlphaSignal-style layout: top nav · hero banner · intro · summary ·
// incident cards · signals · feedback · full site footer.
// v19 · Shield logo added to the hero header (consistent with welcome + auth).
//
// TESTING (zero send / zero spam risk):
//   POST { "dryRun": true }              → partition + render every subscriber,
//                                          SENDS NOTHING.
//   POST { "dryRun": true, "to": "x@y" } → also returns rendered HTML.
//   POST { "to": "x@y" }                 → send ONLY to that address.
//   POST { "day": "2026-06-12" }         → override the target day.
//   POST { "force": true }               → bypass weekly Monday gate.
//
// EMAIL BACKEND: Gmail SMTP (denomailer). Env: GMAIL_USER, GMAIL_APP_PASSWORD.

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const GMAIL_USER         = Deno.env.get("GMAIL_USER")         ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const SENDER_NAME        = Deno.env.get("SENDER_NAME")        ?? "Attacked.ai";
const APP_URL            = Deno.env.get("APP_URL")            ?? "https://attackedmap.vercel.app";
const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")       ?? "https://ovenyjguhkgiceddzwna.supabase.co";
const SERVICE_KEY        = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const HERO_URL           = `${APP_URL}/email-hero-digest.png`;
const LOGO_URL           = `${APP_URL}/attacked-ai-logo.png`;

// Social links — mirror the site footer (src/auth/SiteFooter.jsx).
const SOCIAL = {
  linkedin:  "https://www.linkedin.com/company/attacked-ai",
  x:         "https://x.com/attacked_ai",
  facebook:  "https://www.facebook.com/attacked.ai",
  youtube:   "https://www.youtube.com/@attacked-ai",
  instagram: "https://www.instagram.com/attacked.ai",
};

const GOLD     = "#F5B800";
const OBSIDIAN = "#1A1A1A";
const DEEP     = "#080808";
const MUTED    = "#A8A8A8";
const ORANGE   = "#FF8C5A";

const INDUSTRY_COUNT = 43;
const CATEGORY_COUNT = 13;
const WEEKLY_SEND_DOW = 1; // Monday (UTC).

const SEVERITY_LABEL: Record<number, string> = { 5: "CRITICAL", 4: "HIGH", 3: "MEDIUM", 2: "LOW", 1: "MINIMAL" };
const SEVERITY_COLOR: Record<number, string> = { 5: "#FF3B30", 4: ORANGE, 3: GOLD, 2: "#34C759", 1: "#8E8E93" };
const CATEGORY_NAME: Record<string, string> = {
  CYB: "Cyber", DAT: "Data", TEC: "Technology", GEO: "Geopolitical", PHY: "Physical",
  OPS: "Operations", TPR: "Third Party", REG: "Regulatory", FIN: "Financial",
  STR: "Strategic", REP: "Reputation", PPL: "People", ENV: "Environment",
};

const INTER = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escape(s: unknown): string {
  return String(s ?? "").replace(/[&<>\"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c as string] || c));
}

function isoMinusDays(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const yesterdayISO = () => isoMinusDays(1);

function addDaysISO(iso: string, delta: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toUTCString().slice(0, 16);
}

function asFocusSet(arr: unknown, fullCount: number): Set<string> | null {
  if (!Array.isArray(arr)) return null;
  const vals = arr.map((v) => String(v));
  if (vals.length === 0 || vals.length >= fullCount) return null;
  return new Set(vals);
}

function focusLabel(indSet: Set<string> | null, catSet: Set<string> | null): string {
  const parts: string[] = [];
  if (indSet) {
    const inds = [...indSet];
    parts.push(inds.slice(0, 3).join(" · ") + (inds.length > 3 ? ` +${inds.length - 3}` : ""));
  }
  if (catSet) {
    const cats = [...catSet].map((c) => CATEGORY_NAME[c] || c);
    parts.push(cats.slice(0, 3).join(" · ") + (cats.length > 3 ? ` +${cats.length - 3}` : ""));
  }
  return parts.join("   ·   ");
}

// ── Shared email shell (top nav · hero · body · feedback · footer) ────────────
function shell(title: string, bodyHtml: string, unsubUrl: string, periodLabel: string) {
  const navLink = (href: string, label: string) =>
    `<a href="${href}" style="color:${MUTED};text-decoration:none;font-family:${INTER};font-size:11px;">${escape(label)}</a>`;
  const fb = (mood: string, label: string) =>
    `<a href="${APP_URL}/?feedback=${mood}" style="display:inline-block;padding:9px 18px;margin:0 4px;border:1px solid #3a3a3a;border-radius:4px;color:#EDEDED;text-decoration:none;font-family:${INTER};font-size:12px;font-weight:600;">${escape(label)}</a>`;
  const footCol = (t: string, links: [string, string][]) =>
    `<td style="vertical-align:top;padding-right:18px;">` +
      `<div style="font-family:${INTER};font-size:10px;font-weight:700;color:#585858;letter-spacing:0.16em;text-transform:uppercase;margin-bottom:12px;">${escape(t)}</div>` +
      links.map(([href, label]) =>
        `<a href="${href}" style="display:block;font-family:${INTER};font-size:13px;font-weight:500;color:${MUTED};text-decoration:none;line-height:2.1;">${escape(label)}</a>`).join("") +
    `</td>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
    `<body style="margin:0;padding:28px 16px;background:${DEEP};font-family:${INTER};color:#FFF;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:620px;margin:0 auto;">` +
    `<tr><td style="padding:0 4px 14px;text-align:center;">` +
      navLink(`${APP_URL}/?map`, "Open the map") + ` &nbsp;|&nbsp; ` +
      navLink(`${APP_URL}/?pricing`, "Become a partner") + ` &nbsp;|&nbsp; ` +
      navLink(`${APP_URL}/?subscriptions`, "Manage") + ` &nbsp;|&nbsp; ` +
      navLink(unsubUrl, "Unsubscribe") +
    `</td></tr>` +
    `<tr><td style="padding:0;">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-radius:8px;overflow:hidden;"><tr>` +
        `<td style="padding:0;background:#0a0a0a;">` +
          `<img src="${HERO_URL}" width="620" alt="" style="display:block;width:100%;border:0;">` +
          `<div style="padding:20px 28px 22px;text-align:center;">` +
            `<img src="${LOGO_URL}" width="46" height="46" alt="Attacked.ai" style="display:block;margin:0 auto 12px;border:0;">` +
            `<div style="font-family:${INTER};font-size:30px;font-weight:800;color:#FFF;letter-spacing:-0.015em;line-height:1;">Attacked<span style="color:${GOLD};">.ai</span><sup style="font-size:13px;color:#FFF;margin-left:1px;font-weight:600;">™</sup></div>` +
            `<div style="font-family:${INTER};font-size:11px;color:${MUTED};letter-spacing:0.18em;text-transform:uppercase;margin-top:12px;font-weight:700;">Daily intelligence · ${escape(periodLabel)}</div>` +
          `</div>` +
        `</td>` +
      `</tr></table>` +
    `</td></tr>` +
    `<tr><td style="padding:18px 0 0;">${bodyHtml}</td></tr>` +
    `<tr><td style="padding:18px 0 0;">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${OBSIDIAN};border:1px solid #333;border-radius:8px;"><tr>` +
        `<td style="padding:24px 20px;text-align:center;">` +
          `<div style="font-family:${INTER};font-size:16px;font-weight:700;color:#FFF;margin-bottom:14px;">How was today's brief?</div>` +
          fb("awesome", "Awesome") + fb("decent", "Decent") + fb("notgreat", "Not great") +
        `</td>` +
      `</tr></table>` +
    `</td></tr>` +
    `<tr><td style="padding:32px 24px 12px;margin-top:18px;border-top:1px solid #333;">` +
      `<div style="font-family:${INTER};font-size:20px;font-weight:700;color:#FFF;letter-spacing:-0.01em;line-height:1;margin-bottom:22px;">Attacked<span style="color:${GOLD};">.ai</span><sup style="font-size:10px;color:#FFF;margin-left:1px;font-weight:600;">™</sup></div>` +
      `<div style="font-family:${INTER};font-size:17px;font-weight:800;color:#FFF;letter-spacing:-0.01em;margin-bottom:6px;">Subscribe</div>` +
      `<div style="font-family:${INTER};font-size:13px;color:${MUTED};line-height:1.55;margin-bottom:14px;max-width:320px;">The Daily Brief — every incident we catch, in your inbox.</div>` +
      `<a href="${APP_URL}/?subscriptions" style="display:inline-block;padding:11px 24px;background:${GOLD};color:${OBSIDIAN};text-decoration:none;border-radius:4px;font-family:${INTER};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Submit →</a>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:32px;"><tr style="vertical-align:top;">` +
        footCol("Explore", [[`${APP_URL}/`, "Attack Map"], [`${APP_URL}/?hub`, "Attacked Hub"], [`${APP_URL}/?pricing`, "Pricing"]]) +
        footCol("Resources", [[`${APP_URL}/?legal=faq`, "FAQ"], [`${APP_URL}/?legal=scam`, "Scam warning"], [`mailto:hello@attacked.ai`, "Contact us"]]) +
        footCol("Legal", [[`${APP_URL}/?legal=privacy`, "Privacy policy"], [`${APP_URL}/?legal=terms`, "Terms of use"], [`${APP_URL}/?legal=cookies`, "Cookie preferences"], [`${APP_URL}/?legal=accessibility`, "Accessibility"]]) +
      `</tr></table>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:36px;border-top:1px solid #333;"><tr>` +
        `<td style="padding-top:20px;font-family:${INTER};font-size:11.5px;color:#585858;font-weight:600;letter-spacing:0.04em;vertical-align:middle;">© 2026 Attacked.ai · GUARD framework</td>` +
        `<td style="padding-top:20px;text-align:right;font-family:${INTER};font-size:11.5px;color:${MUTED};vertical-align:middle;">` +
          `<a href="${SOCIAL.linkedin}" style="color:${MUTED};text-decoration:none;">LinkedIn</a> · ` +
          `<a href="${SOCIAL.x}" style="color:${MUTED};text-decoration:none;">X</a> · ` +
          `<a href="${SOCIAL.facebook}" style="color:${MUTED};text-decoration:none;">Facebook</a> · ` +
          `<a href="${SOCIAL.youtube}" style="color:${MUTED};text-decoration:none;">YouTube</a> · ` +
          `<a href="${SOCIAL.instagram}" style="color:${MUTED};text-decoration:none;">Instagram</a>` +
        `</td>` +
      `</tr></table>` +
      `<div style="margin-top:18px;font-family:${INTER};font-size:10.5px;color:#585858;line-height:1.7;">` +
        `You receive this because you subscribed to Attacked.ai intelligence. ` +
        `<a href="${APP_URL}/?subscriptions" style="color:#888;text-decoration:underline;">Manage subscription</a> · ` +
        `<a href="${unsubUrl}" style="color:#888;text-decoration:underline;">Unsubscribe</a>` +
      `</div>` +
    `</td></tr>` +
    `</table></body></html>`;
}

function card(innerHtml: string, pad = "22px"): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${OBSIDIAN};border:1px solid #333;border-radius:8px;margin-bottom:16px;"><tr><td style="padding:${pad};">${innerHtml}</td></tr></table>`;
}

function nameFromEmail(email: string): string {
  const local = String(email || "").split("@")[0] || "there";
  const first = local.split(/[._\-+]/)[0].replace(/[0-9]+/g, "");
  if (!first) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function readTime(shown: number): number {
  return Math.max(2, Math.round(shown * 0.5) + 1);
}

function introCard(name: string, pool: any[], criticalCount: number, countries: number): string {
  const lead = criticalCount > 0
    ? `${criticalCount} crossed into <b style="color:${GOLD};">HIGH or CRITICAL</b> — here's what actually moved, and what it means for you.`
    : `A quieter day, but the map never sleeps. Here's everything worth your attention.`;
  return card(
    `<div style="font-family:${INTER};font-size:16px;font-weight:700;color:#FFF;margin-bottom:12px;">Hey ${escape(name)},</div>` +
    `<p style="font-family:${INTER};font-size:14px;color:#D8D8D8;line-height:1.6;margin:0;">` +
      `<b style="color:#FFF;">${pool.length} incidents</b> hit the wire across <b style="color:#FFF;">${countries} ${countries === 1 ? "country" : "countries"}</b>. ${lead}` +
    `</p>`
  );
}

function summaryCard(shown: any[], pool: any[]): string {
  const rows = shown.map((i) => {
    const sev = i.severity || 1;
    return `<tr><td style="padding:11px 0;border-top:1px solid #2a2a2a;">` +
      `<div style="font-family:${INTER};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:${SEVERITY_COLOR[sev]};margin-bottom:3px;">${SEVERITY_LABEL[sev]} · ${escape(i.primary_category || "OPS")}</div>` +
      `<div style="font-family:${INTER};font-size:13px;color:#EDEDED;line-height:1.4;font-weight:500;">${escape(i.headline || "")}</div>` +
    `</td></tr>`;
  }).join("");
  return card(
    `<div style="font-family:${INTER};font-size:18px;font-weight:800;color:#FFF;letter-spacing:-0.01em;margin-bottom:4px;">Summary</div>` +
    `<div style="font-family:${INTER};font-size:12px;color:${MUTED};margin-bottom:6px;">Read time: ${readTime(shown.length)} min · ${pool.length} incidents tracked</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table>`
  );
}

const bySev = (arr: any[]) => [...arr].sort((a, b) => (b.severity || 0) - (a.severity || 0));

function incidentCard(i: any, isPartner: boolean): string {
  const sev = i.severity || 1;
  const sevColor = SEVERITY_COLOR[sev];
  const sevLabel = SEVERITY_LABEL[sev];
  const cat = i.primary_category || "OPS";
  const place = [escape(i.country || ""), escape(i.industry || i.sector || "")].filter(Boolean).join(" · ");

  const detail = isPartner
    ? (i.entity ? `<div style="font-family:${INTER};font-size:11px;color:${GOLD};letter-spacing:0.06em;margin-bottom:10px;font-weight:700;text-transform:uppercase;">${escape(i.entity)}</div>` : "") +
      `<p style="font-family:${INTER};font-size:13px;color:#D2D2D2;line-height:1.6;margin:0 0 12px;">${escape((i.summary || "").slice(0, 360))}${(i.summary && i.summary.length > 360) ? "…" : ""}</p>` +
      (i.if_you_operate_x_then_y
        ? `<div style="padding:11px 13px;background:rgba(245,184,0,0.07);border-left:3px solid ${GOLD};border-radius:0 4px 4px 0;font-family:${INTER};font-size:12px;color:#FFF;line-height:1.55;margin-bottom:14px;"><b style="color:${GOLD};">What to do →</b> ${escape(i.if_you_operate_x_then_y)}</div>`
        : "")
    : `<p style="font-family:${INTER};font-size:13px;color:${MUTED};line-height:1.6;margin:0 0 14px;">${place || "Live incident"}. Named blast radius, recommended actions and vendor Defence Ratings are <b style="color:#FFF;">partner-only</b>.</p>`;

  const btnHref = isPartner ? `${APP_URL}/?map` : `${APP_URL}/?pricing`;
  const btnLabel = isPartner ? "Open on map →" : "Unlock details →";

  return card(
    `<div style="font-family:${INTER};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:${sevColor};margin-bottom:7px;">${sevLabel} · ${escape(cat)}${place ? `<span style="color:${MUTED};font-weight:600;">&nbsp;&nbsp;${place}</span>` : ""}</div>` +
    `<h2 style="font-family:${INTER};font-size:19px;font-weight:800;color:#FFF;line-height:1.25;letter-spacing:-0.015em;margin:0 0 12px;">${escape(i.headline || "")}</h2>` +
    detail +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>` +
      `<td><a href="${btnHref}" style="display:inline-block;padding:11px 22px;background:${GOLD};color:${OBSIDIAN};text-decoration:none;border-radius:4px;font-family:${INTER};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">${btnLabel}</a></td>` +
      `<td style="text-align:right;vertical-align:bottom;"><a href="${APP_URL}/?map" style="font-family:${INTER};font-size:11px;color:${MUTED};text-decoration:none;font-style:italic;">forward →</a></td>` +
    `</tr></table>`
  );
}

function signalsCard(items: any[]): string {
  if (items.length === 0) return "";
  const rows = items.map((i, idx) => {
    const sev = i.severity || 1;
    const place = [escape(i.country || ""), escape(i.industry || i.sector || "")].filter(Boolean).join(" · ");
    return `<tr>` +
      `<td style="vertical-align:top;padding:13px 12px 13px 0;border-top:1px solid #2a2a2a;width:22px;font-family:${INTER};font-size:15px;font-weight:800;color:${GOLD};line-height:1.3;">${idx + 1}</td>` +
      `<td style="vertical-align:top;padding:13px 0;border-top:1px solid #2a2a2a;">` +
        `<div style="font-family:${INTER};font-size:13.5px;color:#EDEDED;line-height:1.4;font-weight:600;margin-bottom:3px;">${escape(i.headline || "")}</div>` +
        `<div style="font-family:${INTER};font-size:10px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;color:${SEVERITY_COLOR[sev]};">${SEVERITY_LABEL[sev]}${place ? `<span style="color:${MUTED};font-weight:600;"> · ${place}</span>` : ""}</div>` +
      `</td>` +
    `</tr>`;
  }).join("");
  return card(
    `<div style="font-family:${INTER};font-size:18px;font-weight:800;color:#FFF;letter-spacing:-0.01em;margin-bottom:2px;">Signals</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table>`
  );
}

function orderedPool(pool: any[], matched: any[], rest: any[], focus: string): any[] {
  return (focus && matched.length > 0)
    ? [...bySev(matched), ...bySev(rest)]
    : bySev(pool);
}

function digestStats(pool: any[]) {
  const sevCounts: Record<number, number> = { 5:0, 4:0, 3:0, 2:0, 1:0 };
  const countries = new Set<string>();
  for (const i of pool) {
    if (i.severity in sevCounts) sevCounts[i.severity]++;
    if (i.country) countries.add(i.country);
  }
  return { criticalCount: (sevCounts[5] || 0) + (sevCounts[4] || 0), countries: countries.size };
}

function freeDigestHtml(name: string, periodLabel: string, pool: any[], matched: any[], rest: any[], focus: string, unsubUrl: string) {
  const { criticalCount, countries } = digestStats(pool);
  const ordered = orderedPool(pool, matched, rest, focus);
  const lead = ordered.slice(0, 3);
  const signals = ordered.slice(3, 13);

  let body = introCard(name, pool, criticalCount, countries);
  if (focus && matched.length > 0) {
    body += `<div style="font-family:${INTER};font-size:11px;color:${GOLD};letter-spacing:0.1em;text-transform:uppercase;font-weight:700;margin:2px 4px 12px;">★ Leading with your watchlist · ${escape(focus)}</div>`;
  }
  body += summaryCard(lead, pool);
  body += lead.map((i) => incidentCard(i, false)).join("");
  body += card(
    `<div style="font-family:${INTER};font-size:10.5px;color:${GOLD};letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Design partner access</div>` +
    `<div style="font-family:${INTER};font-size:14px;color:#FFF;line-height:1.55;margin-bottom:16px;">Headlines tell you <i>what</i>. Partner access unlocks <i>who</i> — named entities, blast radius, adaptive controls and vendor Defence Ratings for every incident.</div>` +
    `<a href="${APP_URL}/?pricing" style="display:inline-block;padding:13px 26px;background:${GOLD};color:${OBSIDIAN};text-decoration:none;border-radius:4px;font-family:${INTER};font-size:12.5px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Become a partner →</a>`
  );
  body += signalsCard(signals);
  if (ordered.length > 13) {
    body += `<div style="text-align:center;margin:2px 0 4px;"><a href="${APP_URL}/?map" style="font-family:${INTER};font-size:12.5px;color:${MUTED};text-decoration:underline;">+ ${ordered.length - 13} more incidents on the live map →</a></div>`;
  }
  return shell(`Daily intelligence — ${periodLabel}`, body, unsubUrl, periodLabel);
}

function partnerDigestHtml(name: string, periodLabel: string, pool: any[], matched: any[], rest: any[], focus: string, unsubUrl: string) {
  const { criticalCount, countries } = digestStats(pool);
  const ordered = orderedPool(pool, matched, rest, focus);
  const lead = ordered.slice(0, 6);
  const signals = ordered.slice(6, 18);

  let body = introCard(name, pool, criticalCount, countries);
  if (focus && matched.length > 0) {
    body += `<div style="font-family:${INTER};font-size:11px;color:${GOLD};letter-spacing:0.1em;text-transform:uppercase;font-weight:700;margin:2px 4px 12px;">★ Leading with your watchlist · ${escape(focus)}</div>`;
  } else if (focus && matched.length === 0) {
    body += `<div style="font-family:${INTER};font-size:12.5px;color:${MUTED};line-height:1.5;margin:2px 4px 12px;">Nothing in your watchlist (<span style="color:#FFF;">${escape(focus)}</span>) ${periodLabel.includes("–") ? "this week" : "yesterday"} — here's the full brief.</div>`;
  }
  body += summaryCard(lead, pool);
  body += lead.map((i) => incidentCard(i, true)).join("");
  body += signalsCard(signals);
  body += card(
    `<div style="font-family:${INTER};font-size:14px;color:#FFF;line-height:1.55;margin-bottom:16px;">Open the live map for named blast radius, adaptive GUARD controls and vendor Defence Ratings on every incident above.</div>` +
    `<a href="${APP_URL}/?map" style="display:inline-block;padding:13px 26px;background:${GOLD};color:${OBSIDIAN};text-decoration:none;border-radius:4px;font-family:${INTER};font-size:12.5px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Open the full unlocked map →</a>`
  );
  if (ordered.length > 18) {
    body += `<div style="text-align:center;margin:2px 0 4px;"><a href="${APP_URL}/?map" style="font-family:${INTER};font-size:12.5px;color:${MUTED};text-decoration:underline;">+ ${ordered.length - 18} more incidents on the live map →</a></div>`;
  }
  return shell(`Daily intelligence — ${periodLabel} · Partner`, body, unsubUrl, periodLabel);
}

async function pgFetch(path: string, options: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`PostgREST ${r.status}: ${await r.text()}`);
  return r.json();
}

async function createSmtpClient() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD env vars are required");
  }
  return new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } },
  });
}

async function sendOne(client: SMTPClient, to: string, subject: string, html: string) {
  try {
    await client.send({ from: `${SENDER_NAME} <${GMAIL_USER}>`, to, subject, content: "This email is best viewed in an HTML-capable client.", html });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || String(err) };
  }
}

function buildForProfile(p: any, dayIncidents: any[], weekIncidents: any[], targetDay: string, weekStart: string) {
  const indSet = asFocusSet(p.watch_industries, INDUSTRY_COUNT);
  const catSet = asFocusSet(p.watch_categories, CATEGORY_COUNT);
  const focus = focusLabel(indSet, catSet);
  const weekly = p.digest_frequency === "weekly";
  const pool = weekly ? weekIncidents : dayIncidents;

  const matches = (i: any) => {
    const okInd = !indSet || (i.industry && indSet.has(i.industry));
    const okCat = !catSet || (i.primary_category && catSet.has(i.primary_category));
    return okInd && okCat;
  };
  const hasFocus = !!(indSet || catSet);
  const matched = hasFocus ? pool.filter(matches) : [];
  const rest = hasFocus ? pool.filter((i) => !matches(i)) : pool;

  const isPartner = p.tier === "partner" || p.tier === "admin";
  const periodLabel = weekly
    ? `${formatDate(weekStart)} – ${formatDate(targetDay)}`
    : formatDate(targetDay);

  const unsubUrl = `${APP_URL}/?unsubscribe=${p.unsubscribe_token}`;
  const name = nameFromEmail(p.email);
  const html = isPartner
    ? partnerDigestHtml(name, periodLabel, pool, matched, rest, hasFocus ? focus : "", unsubUrl)
    : freeDigestHtml(name, periodLabel, pool, matched, rest, hasFocus ? focus : "", unsubUrl);

  const lead = isPartner ? "🤝" : "🔔";
  const subject = (hasFocus && matched.length > 0)
    ? `${lead} ${matched.length} in your watchlist · ${pool.length} tracked — ${periodLabel}`
    : `${lead} ${pool.length} incidents — ${periodLabel} · ${isPartner ? "Partner" : "Daily"} brief`;

  return { isPartner, weekly, focus: hasFocus ? focus : "all", matched: matched.length, rest: rest.length, pool: pool.length, subject, html };
}

Deno.serve(async (req) => {
  let body: any = {};
  try {
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    else {
      const u = new URL(req.url);
      body = { day: u.searchParams.get("day"), to: u.searchParams.get("to"), dryRun: u.searchParams.get("dryRun") === "true", force: u.searchParams.get("force") === "true" };
    }
  } catch { /* noop */ }

  const targetDay: string = body?.day || yesterdayISO();
  const weekStart = addDaysISO(targetDay, -6);
  const onlyTo: string | null = body?.to || null;
  const dryRun: boolean = body?.dryRun === true;
  const force: boolean = body?.force === true;

  const weekIncidents: any[] = await pgFetch(
    `incidents?select=id,headline,summary,entity,sector,industry,country,severity,primary_category,if_you_operate_x_then_y,incident_day` +
    `&incident_day=gte.${weekStart}&incident_day=lte.${targetDay}` +
    `&latitude=not.is.null&longitude=not.is.null&order=incident_day.asc,severity.desc.nullslast,id.desc&limit=800`,
  );
  const dayIncidents = weekIncidents.filter((i) => i.incident_day === targetDay);

  if (dayIncidents.length === 0 && weekIncidents.length === 0) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: "no incidents", day: targetDay }), { headers: { "Content-Type": "application/json" } });
  }

  let profiles: any[] = await pgFetch(
    `profiles?select=id,email,tier,unsubscribe_token,watch_industries,watch_categories,digest_frequency` +
    `&email_subscribed=eq.true&tier=in.(free,partner,admin)&limit=10000`,
  );
  if (onlyTo) profiles = profiles.filter((p) => p.email === onlyTo);

  const sendDow = new Date().getUTCDay();

  if (dryRun) {
    const report = profiles.map((p) => {
      const b = buildForProfile(p, dayIncidents, weekIncidents, targetDay, weekStart);
      const weeklyGated = b.weekly && sendDow !== WEEKLY_SEND_DOW && !force;
      return { email: p.email, tier: p.tier, frequency: p.digest_frequency || "daily", focus: b.focus, matched: b.matched, rest: b.rest, pool: b.pool, would_send: !weeklyGated, subject: b.subject, ...(onlyTo ? { html: b.html } : {}) };
    });
    return new Response(JSON.stringify({ ok: true, dryRun: true, day: targetDay, week_start: weekStart, day_incidents: dayIncidents.length, week_incidents: weekIncidents.length, recipients: report.length, report }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  let client: SMTPClient;
  try {
    client = await createSmtpClient();
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message, hint: "set GMAIL_USER + GMAIL_APP_PASSWORD secrets" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const results = { free: 0, partner: 0, skipped_weekly: 0, failed: 0, errors: [] as any[] };
  for (const p of profiles) {
    const b = buildForProfile(p, dayIncidents, weekIncidents, targetDay, weekStart);
    if (b.weekly && sendDow !== WEEKLY_SEND_DOW && !force && !onlyTo) { results.skipped_weekly++; continue; }
    if (b.pool === 0) { continue; }
    const res = await sendOne(client, p.email, b.subject, b.html);
    if (res.ok) { if (b.isPartner) results.partner++; else results.free++; }
    else { results.failed++; results.errors.push({ email: p.email, error: res.error }); }
  }

  try { await client.close(); } catch { /* noop */ }

  return new Response(JSON.stringify({ ok: true, provider: "gmail-smtp", day: targetDay, day_incidents: dayIncidents.length, week_incidents: weekIncidents.length, ...results }), { headers: { "Content-Type": "application/json" } });
});
