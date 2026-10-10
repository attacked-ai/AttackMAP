// daily-digest — Supabase Edge Function, also run as a Cloud Run service
// Sends the personalised daily brief to every email_subscribed=true profile.
//
// ── v18 · PORTABLE (2026-09-30) ─────────────────────────────────────────────
//   • Callers must be internal: x-internal-token or the service-role key
//     (_shared/auth.ts). The gate runs first, so a dry run — which lists every
//     reader's address — only ever answers an internal caller.
//   • Mail goes through _shared/mail.ts: Resend when RESEND_API_KEY is set,
//     else Gmail SMTP as before. Each message carries an Idempotency-Key.
//   • List-Unsubscribe on every brief (see unsubscribeHeaders); a reader with
//     no unsubscribe_token is skipped instead of getting "?unsubscribe=null".
//   • "day" must be YYYY-MM-DD (it goes into a PostgREST filter).
//   • Listens on env PORT when set (Cloud Run), else Deno's default 8000.
//
// ── v17 · INDUSTRY-LED (2026-09-22) ─────────────────────────────────────────
// One brief, two depths. Every reader's mail is built from four preferences
// captured at sign-up and on the dashboard's Configure alerts page:
//   • profiles.industry          the ONE primary industry from sign-up. It
//                                decides what leads the brief ("In your
//                                industry"). watch_industries (the legacy
//                                list) adds extra industries when present.
//   • profiles.watch_categories  GUARD codes (= incidents.primary_category).
//                                Empty or all 13 ⇒ every category.
//   • profiles.min_severity      1..5 (default 3). Only incidents at or above
//                                it are mailed; the rest are counted in a
//                                "below your threshold" line. Column added by
//                                migration 20260922_brief_prefs.sql — until
//                                it is applied the default applies.
//   • profiles.digest_frequency  "daily" (each sweep) | "weekly" (Mondays,
//                                covering the prior 7 days).
//
// Sections, in order:
//   1. Hey {name} — what moved, the reader's own filter line, Configure alerts.
//   2. IN YOUR INDUSTRY — full cards for the matching incidents (lead cards,
//      then a numbered list). Quiet sweep ⇒ "nothing new" + what the industry
//      saw earlier this week, so the mail is never empty by accident.
//   3. ACROSS ALL SECTORS — HIGH/CRITICAL incidents outside the reader's
//      industry as a numbered list (their categories still apply).
//   4. Free: the Premium strip (→ /?subscribe). Subscriber: dashboard link.
//
// TIER DEPTH
//   free        headline, summary, entity, classification, and a LOCKED line
//               with the COUNTS of what a subscriber would see (from the
//               public incident_layer_counts view). Buttons open the incident
//               on the Attacked Hub (/?hub&open=<id>) and on the map
//               (/?map&incident=<id>&date=<day>).
//   subscriber  (tier enterprise, admin) the same card plus "Why it matters",
//               the named blast radius (top 3), GUARD controls (top 2), the
//               peer watchlist and the lead source. Rows come from the
//               subscriber-only tables, read with the service role because the
//               Phase 2 lock (20260922_subscriber_layer_lock.sql) hides them
//               from everyone else.
//
// SEND RULE: a reader is skipped only when nothing cleared their filters in
// their industry (today, and earlier this week for daily readers) AND nothing
// HIGH/CRITICAL happened elsewhere.
//
// TESTING (zero send / zero spam risk):
//   POST { "dryRun": true }            → partitions + renders every reader,
//                                        returns per-reader counts + subject,
//                                        SENDS NOTHING.
//   POST { "dryRun": true, "to": "x@y" } → also returns the rendered HTML for
//                                        that one address.
//   POST { "to": "x@y" }               → sends ONLY to that address (bypasses
//                                        the weekly gate). Safe single-recipient.
//   POST { "day": "2026-09-11" }       → override the target day.
//   POST { "force": true }             → bypass the weekly Monday gate for all.
//
// PREVIEWS: scripts/render-email-templates.mjs loads everything above the
// serve call under Node and renders both tiers against live incidents.
//
// EMAIL BACKEND: _shared/mail.ts. Env: RESEND_API_KEY + MAIL_FROM, or the
// Gmail fallback GMAIL_USER + GMAIL_APP_PASSWORD (+ SENDER_NAME).
// Trigger: daily at 08:00 UTC (a pg_cron job on Supabase, currently inactive;
// Cloud Scheduler on Google Cloud). See deploy/gcp/functions/README.md.
//
// The preview renderer drops the two _shared imports below along with
// everything from the serve call on; keep sendMail/requireInternal out of the
// rendering code above it.

import { idemKey, mailProvider, mailSetupError, sendMail } from "../_shared/mail.ts";
import { requireInternal } from "../_shared/auth.ts";

const APP_URL            = Deno.env.get("APP_URL")            ?? "https://attackedmap.vercel.app";
const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")       ?? "https://ovenyjguhkgiceddzwna.supabase.co";
const SERVICE_KEY        = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Social links — mirror the site footer (src/auth/SiteFooter.jsx).
const SOCIAL = {
  linkedin:  "https://www.linkedin.com/company/attacked-ai",
  x:         "https://x.com/attacked_ai",
  facebook:  "https://www.facebook.com/attacked.ai",
  youtube:   "https://www.youtube.com/@attacked-ai",
  instagram: "https://www.instagram.com/attacked.ai",
};

const GOLD     = "#FCBD00";
const OBSIDIAN = "#1A1A1A";
const DEEP     = "#080808";
const MUTED    = "#A8A8A8";
const ORANGE   = "#FF8C5A";

// Full taxonomy sizes — used to tell "watch everything" (all selected) apart
// from a genuine focus (a subset). Mirror src/lib/taxonomy.js.
const INDUSTRY_COUNT = 43;
const CATEGORY_COUNT = 13;
const WEEKLY_SEND_DOW = 1; // Monday (UTC). Weekly readers receive only today.

const DEFAULT_MIN_SEVERITY = 3;      // MEDIUM and above — the alerts page default
const CROSS_SECTOR_MIN_SEVERITY = 4; // outside the reader's industry: HIGH+
const LEAD_CARDS = { free: 4, subscriber: 6 };  // full cards before the list
const LIST_MAX = 8;                              // numbered rows after the cards
const CROSS_MAX = { free: 5, subscriber: 8 };   // cross-sector rows
const EARLIER_MAX = 5;                           // quiet-day "earlier this week" rows

const SEVERITY_LABEL: Record<number, string> = { 5: "CRITICAL", 4: "HIGH", 3: "MEDIUM", 2: "LOW", 1: "MINIMAL" };
const SEVERITY_COLOR: Record<number, string> = { 5: "#FF3B30", 4: ORANGE, 3: GOLD, 2: "#34C759", 1: "#8E8E93" };
const CATEGORY_NAME: Record<string, string> = {
  CYB: "Cyber Security", DAT: "Data & Privacy", TEC: "Technology", GEO: "Geopolitical",
  PHY: "Physical Security", OPS: "Operational", TPR: "Third-Party Risk", REG: "Regulatory",
  FIN: "Financial", STR: "Strategic", REP: "Reputational", PPL: "People & Human Capital",
  ENV: "Environmental",
};
const EXPOSURE_LABEL: Record<string, string> = {
  internal: "Internal", supply_chain: "Supply chain", customer_counterparty: "Customer / counterparty",
  competitive_peer: "Peer", regulatory: "Regulator", financial_market: "Financial market",
};

const INTER = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// App deep links. The Hub and the map open the SAME incident the card shows.
const hubUrl = (id: unknown) => `${APP_URL}/?hub&open=${encodeURIComponent(String(id))}`;
const mapUrl = (i: any) => `${APP_URL}/?map&incident=${encodeURIComponent(String(i.id))}${i.incident_day ? `&date=${i.incident_day}` : ""}`;
const ALERTS_URL    = `${APP_URL}/?subscriptions`;
const SUBSCRIBE_URL = `${APP_URL}/?subscribe`;
const DASHBOARD_URL = `${APP_URL}/?dashboard`;
const MAP_URL       = `${APP_URL}/?map`;
const unsubscribeUrl = (token: unknown) => `${APP_URL}/?unsubscribe=${encodeURIComponent(String(token))}`;

// List-Unsubscribe gives mail clients their own "Unsubscribe" button. The
// one-click form (RFC 8058, List-Unsubscribe-Post) has the client POST to the
// link with no page in between, so it is only advertised when env
// UNSUBSCRIBE_POST_URL names an endpoint that unsubscribes on a POST (the token
// is appended to it). The ?unsubscribe= link is a browser page: a POST to it
// would unsubscribe nobody, so on its own it is offered as a plain link.
function unsubscribeHeaders(token: unknown): Record<string, string> {
  const post = (Deno.env.get("UNSUBSCRIBE_POST_URL") ?? "").trim();
  if (post) {
    return { "List-Unsubscribe": `<${post}${encodeURIComponent(String(token))}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  }
  return { "List-Unsubscribe": `<${unsubscribeUrl(token)}>` };
}

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

// "Fri, 11 Sep 2026" and the shorter "11 Sep 2026".
function formatDate(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toUTCString().slice(0, 16);
}
const shortDate = (iso: string) => formatDate(iso).slice(5);

// Cut at a word boundary and add an ellipsis.
function trim(s: unknown, n: number): string {
  const t = String(s ?? "").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\-–—]$/, "") + "…";
}

const sevOf = (i: any) => { const n = Number(i?.severity); return n >= 1 && n <= 5 ? Math.round(n) : 1; };
const bySev = (arr: any[]) => [...arr].sort((a, b) => sevOf(b) - sevOf(a) || (Number(b.id) || 0) - (Number(a.id) || 0));
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ── Preference helpers ──────────────────────────────────────────────────────
// A focus set is null when the reader watches everything (empty array, or the
// full taxonomy selected). Otherwise it's the subset they chose.
function asFocusSet(arr: unknown, fullCount: number): Set<string> | null {
  if (!Array.isArray(arr)) return null;
  const vals = arr.map((v) => String(v).trim()).filter(Boolean);
  if (vals.length === 0 || vals.length >= fullCount) return null;
  return new Set(vals);
}

function clampSev(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : DEFAULT_MIN_SEVERITY;
}

// "Oil & Gas (Integrated & E&P)" → "Oil & Gas" for subject lines and prose.
const shortIndustry = (s: unknown) => String(s ?? "").replace(/\s*\([^)]*\)/g, "").trim();

// Friendly first-name from an email local-part: "razor.q@acme.com" → "Razor".
function nameFromEmail(email: string): string {
  const local = String(email || "").split("@")[0] || "there";
  const first = local.split(/[._\-+]/)[0].replace(/[0-9]+/g, "");
  if (!first) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}
function firstName(p: any): string {
  const n = String(p?.full_name || "").trim().split(/\s+/)[0];
  return n || nameFromEmail(p?.email);
}

function categoryLabel(catSet: Set<string> | null): string {
  if (!catSet) return `All ${CATEGORY_COUNT} categories`;
  const names = [...catSet].map((c) => CATEGORY_NAME[c] || c);
  return names.slice(0, 3).join(" · ") + (names.length > 3 ? ` +${names.length - 3}` : "");
}

type Prefs = {
  industries: string[]; primary: string; catSet: Set<string> | null;
  minSev: number; weekly: boolean; isSubscriber: boolean; name: string;
};
function readerPrefs(p: any): Prefs {
  const primary = String(p?.industry || "").trim();
  const extra = asFocusSet(p?.watch_industries, INDUSTRY_COUNT);
  const industries = [...new Set([primary, ...(extra ? [...extra] : [])].filter(Boolean))];
  return {
    industries,
    primary: primary || industries[0] || "",
    catSet: asFocusSet(p?.watch_categories, CATEGORY_COUNT),
    minSev: clampSev(p?.min_severity),
    weekly: p?.digest_frequency === "weekly",
    // Subscriber = profiles.tier enterprise (Design Partner retired 2026-09-21).
    isSubscriber: p?.tier === "enterprise" || p?.tier === "admin",
    name: firstName(p),
  };
}

// ── Subscriber layer (rows) + free counts ───────────────────────────────────
type Layer = { blast: Map<number, any[]>; controls: Map<number, any[]>; peers: Map<number, any[]>; sources: Map<number, any[]> };
const EMPTY_LAYER: Layer = { blast: new Map(), controls: new Map(), peers: new Map(), sources: new Map() };

// Accepts either an array of rows carrying incident_id, or an object keyed by
// incident id (the shape the preview fixture uses).
function groupRows(x: unknown): Map<number, any[]> {
  const m = new Map<number, any[]>();
  if (Array.isArray(x)) {
    for (const r of x) { const k = Number(r?.incident_id); if (!m.has(k)) m.set(k, []); m.get(k)?.push(r); }
  } else if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) if (Array.isArray(v)) m.set(Number(k), v);
  }
  return m;
}
function makeLayer(src: any): Layer {
  return {
    blast:    groupRows(src?.blast_radius ?? src?.blast),
    controls: groupRows(src?.adaptive_controls ?? src?.controls),
    peers:    groupRows(src?.peer_watchlist ?? src?.peers),
    sources:  groupRows(src?.sources),
  };
}

// Counts of the locked layer, embedded on the incident row as layer_counts(*)
// (public.incident_layer_counts — readable by everyone, rows are not).
function countsOf(i: any): { blast: number; controls: number; peers: number; sources: number } | null {
  const l = Array.isArray(i?.layer_counts) ? i.layer_counts[0] : i?.layer_counts;
  if (!l) return null;
  return { blast: Number(l.blast) || 0, controls: Number(l.controls) || 0, peers: Number(l.peers) || 0, sources: Number(l.sources) || 0 };
}

// ── Shared email shell (top nav · hero banner · body · feedback · footer) ────
function shell(title: string, bodyHtml: string, unsubUrl: string, eyebrowText: string, isSubscriber: boolean) {
  const navLink = (href: string, label: string) =>
    `<a href="${href}" style="color:${MUTED};text-decoration:none;font-family:${INTER};font-size:11px;">${escape(label)}</a>`;
  const fb = (mood: string, label: string) =>
    `<a href="${APP_URL}/?feedback=${mood}" style="display:inline-block;padding:9px 18px;margin:0 4px;border:1px solid #3a3a3a;border-radius:4px;color:#EDEDED;text-decoration:none;font-family:${INTER};font-size:12px;font-weight:600;">${escape(label)}</a>`;
  const footCol = (heading: string, links: [string, string][]) =>
    `<td style="vertical-align:top;padding-right:18px;">` +
      `<div style="font-family:${INTER};font-size:10px;font-weight:700;color:#585858;letter-spacing:0.16em;text-transform:uppercase;margin-bottom:12px;">${escape(heading)}</div>` +
      links.map(([href, label]) =>
        `<a href="${href}" style="display:block;font-family:${INTER};font-size:13px;font-weight:500;color:${MUTED};text-decoration:none;line-height:2.1;">${escape(label)}</a>`).join("") +
    `</td>`;

  const upgradeBlock = isSubscriber
    ? `<div style="font-family:${INTER};font-size:17px;font-weight:800;color:#FFF;letter-spacing:-0.01em;margin-bottom:6px;">Your dashboard</div>` +
      `<div style="font-family:${INTER};font-size:13px;color:${MUTED};line-height:1.55;margin-bottom:14px;max-width:340px;">Every incident in your industry with the full blast radius, GUARD controls and peer watchlist.</div>` +
      `<a href="${DASHBOARD_URL}" style="display:inline-block;padding:11px 24px;background:${GOLD};color:${OBSIDIAN};text-decoration:none;border-radius:4px;font-family:${INTER};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Open →</a>`
    : `<div style="font-family:${INTER};font-size:17px;font-weight:800;color:#FFF;letter-spacing:-0.01em;margin-bottom:6px;">Subscribe</div>` +
      `<div style="font-family:${INTER};font-size:13px;color:${MUTED};line-height:1.55;margin-bottom:14px;max-width:340px;">Named blast radius, GUARD controls and peer watchlists on every incident — plus Impact Assessments, Watchlists and Pathways &amp; simulation for your organisation.</div>` +
      `<a href="${SUBSCRIBE_URL}" style="display:inline-block;padding:11px 24px;background:${GOLD};color:${OBSIDIAN};text-decoration:none;border-radius:4px;font-family:${INTER};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">See plans →</a>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head>` +
    `<body style="margin:0;padding:28px 16px;background:${DEEP};font-family:${INTER};color:#FFF;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:620px;margin:0 auto;">` +

    // ── Top nav ────────────────────────────────────────────────
    `<tr><td style="padding:0 4px 14px;text-align:center;">` +
      navLink(DASHBOARD_URL, "Dashboard") + ` &nbsp;|&nbsp; ` +
      navLink(MAP_URL, "Attack Map") + ` &nbsp;|&nbsp; ` +
      navLink(ALERTS_URL, "Configure alerts") + ` &nbsp;|&nbsp; ` +
      navLink(unsubUrl, "Unsubscribe") +
    `</td></tr>` +

    // ── Hero banner ────────────────────────────────────────────
    `<tr><td style="padding:0;">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-radius:8px;overflow:hidden;"><tr>` +
        `<td style="padding:0;background:#0a0a0a;">` +
          `<img src="${APP_URL}/email-hero-digest.png" width="620" alt="" style="display:block;width:100%;border:0;">` +
          `<div style="padding:20px 28px 22px;text-align:center;">` +
            `<div style="font-family:${INTER};font-size:30px;font-weight:800;color:#FFF;letter-spacing:-0.015em;line-height:1;">Attacked<span style="color:${GOLD};">.ai</span><sup style="font-size:13px;color:#FFF;margin-left:1px;font-weight:600;">™</sup></div>` +
            `<div style="font-family:${INTER};font-size:11px;color:${MUTED};letter-spacing:0.18em;text-transform:uppercase;margin-top:12px;font-weight:700;">${escape(eyebrowText)}</div>` +
          `</div>` +
        `</td>` +
      `</tr></table>` +
    `</td></tr>` +

    // ── Body ───────────────────────────────────────────────────
    `<tr><td style="padding:18px 0 0;">${bodyHtml}</td></tr>` +

    // ── Feedback ───────────────────────────────────────────────
    `<tr><td style="padding:2px 0 0;">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${OBSIDIAN};border:1px solid #333;border-radius:8px;"><tr>` +
        `<td style="padding:24px 20px;text-align:center;">` +
          `<div style="font-family:${INTER};font-size:16px;font-weight:700;color:#FFF;margin-bottom:14px;">How was today's brief?</div>` +
          fb("awesome", "Awesome") + fb("decent", "Decent") + fb("notgreat", "Not great") +
        `</td>` +
      `</tr></table>` +
    `</td></tr>` +

    // ── Site-style footer (logo · upgrade/dashboard · columns · social) ─
    `<tr><td style="padding:32px 24px 12px;margin-top:18px;border-top:1px solid #333;">` +
      `<div style="font-family:${INTER};font-size:20px;font-weight:700;color:#FFF;letter-spacing:-0.01em;line-height:1;margin-bottom:22px;">Attacked<span style="color:${GOLD};">.ai</span><sup style="font-size:10px;color:#FFF;margin-left:1px;font-weight:600;">™</sup></div>` +
      upgradeBlock +

      `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:32px;"><tr style="vertical-align:top;">` +
        footCol("Explore", [
          [MAP_URL, "Attack Map"],
          [`${APP_URL}/?hub`, "Attacked Hub"],
          [DASHBOARD_URL, "Dashboard"],
          [SUBSCRIBE_URL, "Plans"],
        ]) +
        footCol("Resources", [
          [`${APP_URL}/?legal=faq`, "FAQ"],
          [`${APP_URL}/?legal=scam`, "Scam warning"],
          [`mailto:hello@attacked.ai`, "Contact us"],
        ]) +
        footCol("Legal", [
          [`${APP_URL}/?legal=privacy`, "Privacy policy"],
          [`${APP_URL}/?legal=terms`, "Terms of use"],
          [`${APP_URL}/?legal=cookies`, "Cookie preferences"],
          [`${APP_URL}/?legal=accessibility`, "Accessibility"],
        ]) +
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
        `You receive this because you signed up to Attacked.ai and chose to get the brief. ` +
        `<a href="${ALERTS_URL}" style="color:#888;text-decoration:underline;">Manage alerts</a> · ` +
        `<a href="${unsubUrl}" style="color:#888;text-decoration:underline;">Unsubscribe</a>` +
      `</div>` +
    `</td></tr>` +

    `</table></body></html>`;
}

// ── Building blocks ───────────────────────────────────────────────────────────
function card(innerHtml: string, pad = "22px", imageUrl = ""): string {
  const img = imageUrl
    ? `<tr><td style="padding:0;"><img src="${escape(imageUrl)}" width="618" alt="" style="display:block;width:100%;height:auto;border-radius:8px 8px 0 0;border:0;"></td></tr>`
    : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${OBSIDIAN};border:1px solid #333;border-radius:8px;margin-bottom:16px;overflow:hidden;">${img}<tr><td style="padding:${pad};">${innerHtml}</td></tr></table>`;
}
const kicker = (text: string, color = GOLD, mb = 6) =>
  `<div style="font-family:${INTER};font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;color:${color};margin:0 0 ${mb}px;">${text}</div>`;
const goldBtn = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;padding:11px 22px;background:${GOLD};color:${OBSIDIAN};text-decoration:none;border-radius:4px;font-family:${INTER};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">${label}</a>`;
const quietLink = (href: string, label: string) =>
  `<a href="${href}" style="font-family:${INTER};font-size:12px;color:${MUTED};text-decoration:underline;">${label}</a>`;

// Section header, outside the cards: kicker + title + optional sub-line.
function sectionHead(kick: string, title: string, sub = ""): string {
  return `<div style="padding:8px 4px 12px;">${kicker(kick)}` +
    `<div style="font-family:${INTER};font-size:20px;font-weight:800;color:#FFF;letter-spacing:-0.015em;line-height:1.2;">${escape(title)}</div>` +
    (sub ? `<div style="font-family:${INTER};font-size:12.5px;color:${MUTED};margin-top:5px;line-height:1.5;">${sub}</div>` : "") +
  `</div>`;
}

// Rough read-time from how many incidents we render in full.
function readTime(cards: number, rows: number): number {
  return Math.max(1, Math.round(cards * 0.6 + rows * 0.15));
}

// ── Incident card (both tiers; depth differs) ────────────────────────────────
function incidentCard(i: any, tier: "free" | "subscriber", layer: Layer): string {
  const sev = sevOf(i);
  const cat = CATEGORY_NAME[i.primary_category] || i.primary_category || "Operational";
  const place = [i.country, i.industry || i.sector].filter(Boolean).map(escape).join(" · ");

  const meta = `<div style="font-family:${INTER};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:${SEVERITY_COLOR[sev]};margin-bottom:7px;">` +
    `${SEVERITY_LABEL[sev]} · ${escape(cat)}${place ? `<span style="color:${MUTED};font-weight:600;">&nbsp;&nbsp;${place}</span>` : ""}</div>`;
  const headline = `<h2 style="font-family:${INTER};font-size:19px;font-weight:800;color:#FFF;line-height:1.25;letter-spacing:-0.015em;margin:0 0 10px;">${escape(i.headline || "")}</h2>`;
  const entity = i.entity ? `<div style="font-family:${INTER};font-size:11px;color:${GOLD};letter-spacing:0.06em;margin-bottom:10px;font-weight:700;text-transform:uppercase;">${escape(i.entity)}</div>` : "";
  const summary = i.summary
    ? `<p style="font-family:${INTER};font-size:13px;color:#D2D2D2;line-height:1.6;margin:0 0 14px;">${escape(trim(i.summary, tier === "subscriber" ? 420 : 240))}</p>`
    : "";

  let depth = "";
  if (tier === "subscriber") {
    if (i.severity_rationale) {
      depth += `<div style="padding:11px 13px;background:rgba(252,189,0,0.07);border-left:3px solid ${GOLD};border-radius:0 4px 4px 0;font-family:${INTER};font-size:12px;color:#FFF;line-height:1.55;margin-bottom:14px;"><b style="color:${GOLD};">Why it matters →</b> ${escape(trim(i.severity_rationale, 320))}</div>`;
    }
    const blast = (layer.blast.get(Number(i.id)) || []).slice(0, 3);
    const controls = (layer.controls.get(Number(i.id)) || []).slice(0, 2);
    const peers = (layer.peers.get(Number(i.id)) || []).map((p: any) => p.name).filter(Boolean).slice(0, 5);
    const source = (layer.sources.get(Number(i.id)) || [])[0];
    const block = (label: string, rows: string) =>
      `<div style="margin:0 0 12px;padding:12px 14px;background:#141414;border:1px solid #2a2a2a;border-radius:6px;">${kicker(label, MUTED, 8)}${rows}</div>`;
    if (blast.length) {
      depth += block("Who else is exposed", blast.map((b: any) =>
        `<div style="margin-bottom:8px;"><span style="font-family:${INTER};font-size:12.5px;font-weight:700;color:#FFF;">${escape(b.name)}</span>` +
        (b.exposure_group ? `<span style="font-family:${INTER};font-size:10px;color:${GOLD};font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-left:8px;">${escape(EXPOSURE_LABEL[b.exposure_group] || b.exposure_group)}</span>` : "") +
        (b.transmission_mechanism ? `<div style="font-family:${INTER};font-size:12px;color:${MUTED};line-height:1.5;margin-top:2px;">${escape(trim(b.transmission_mechanism, 150))}</div>` : "") +
        `</div>`).join(""));
    }
    if (controls.length) {
      depth += block("GUARD controls", controls.map((c: any) =>
        `<div style="margin-bottom:8px;">` +
        (c.control_id ? `<span style="font-family:${INTER};font-size:10.5px;font-weight:700;color:${GOLD};letter-spacing:0.06em;">${escape(c.control_id)}</span> ` : "") +
        `<span style="font-family:${INTER};font-size:12px;color:#D2D2D2;line-height:1.5;">${escape(trim(c.statement, 220))}</span></div>`).join(""));
    }
    if (peers.length) {
      depth += block("Peers to watch", `<div style="font-family:${INTER};font-size:12.5px;color:#EDEDED;line-height:1.6;">${peers.map(escape).join(" · ")}</div>`);
    }
    if (source) {
      depth += `<div style="font-family:${INTER};font-size:11.5px;color:${MUTED};line-height:1.5;margin:0 0 14px;">Source: ` +
        (source.url ? `<a href="${escape(source.url)}" style="color:${MUTED};text-decoration:underline;">` : "") +
        `${escape(source.publisher || "")}${source.publisher && source.title ? " — " : ""}${escape(trim(source.title, 90))}` +
        (source.url ? `</a>` : "") + `</div>`;
    }
  } else {
    const c = countsOf(i);
    const inner = c
      ? `<b style="color:#FFF;">${plural(c.blast, "exposed organisation")}</b> · <b style="color:#FFF;">${plural(c.controls, "GUARD control")}</b> · <b style="color:#FFF;">${plural(c.peers, "peer")} to watch</b>`
      : `Named blast radius, GUARD controls and the peer watchlist`;
    depth += `<div style="padding:10px 12px;margin:0 0 14px;background:#141414;border:1px dashed #3a3a3a;border-radius:4px;font-family:${INTER};font-size:12px;color:${MUTED};line-height:1.55;">` +
      `🔒 ${inner} — <a href="${SUBSCRIBE_URL}" style="color:${GOLD};text-decoration:none;font-weight:700;">subscriber only</a></div>`;
  }

  const actions = `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>` +
    `<td>${goldBtn(hubUrl(i.id), "Open in Attack Hub →")}</td>` +
    `<td style="text-align:right;vertical-align:middle;"><a href="${mapUrl(i)}" style="font-family:${INTER};font-size:12px;color:#EDEDED;text-decoration:none;font-weight:600;">View on map →</a></td>` +
  `</tr></table>`;

  // The stored picture (incidents.image_url) tops the card when the incident has one.
  return card(meta + headline + entity + summary + depth + actions, "22px", i.image_url || "");
}

// Numbered list of incidents — headline links to the Hub, a small map link.
function listRows(items: any[], showIndustry: boolean): string {
  return items.map((i, idx) => {
    const sev = sevOf(i);
    const place = [showIndustry ? (i.industry || i.sector) : null, i.country].filter(Boolean).map(escape).join(" · ");
    return `<tr>` +
      `<td style="vertical-align:top;padding:13px 12px 13px 0;border-top:1px solid #2a2a2a;width:22px;font-family:${INTER};font-size:15px;font-weight:800;color:${GOLD};line-height:1.3;">${idx + 1}</td>` +
      `<td style="vertical-align:top;padding:13px 0;border-top:1px solid #2a2a2a;">` +
        `<a href="${hubUrl(i.id)}" style="font-family:${INTER};font-size:13.5px;color:#EDEDED;line-height:1.4;font-weight:600;text-decoration:none;display:block;margin-bottom:3px;">${escape(i.headline || "")}</a>` +
        `<div style="font-family:${INTER};font-size:10px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;color:${SEVERITY_COLOR[sev]};">${SEVERITY_LABEL[sev]}` +
          (place ? `<span style="color:${MUTED};font-weight:600;"> · ${place}</span>` : "") +
          `<a href="${mapUrl(i)}" style="color:${MUTED};font-weight:600;text-decoration:none;margin-left:10px;">map →</a></div>` +
      `</td>` +
    `</tr>`;
  }).join("");
}
function listCard(title: string, items: any[], showIndustry: boolean): string {
  if (!items.length) return "";
  return card(
    (title ? `<div style="font-family:${INTER};font-size:16px;font-weight:800;color:#FFF;letter-spacing:-0.01em;margin-bottom:2px;">${escape(title)}</div>` : "") +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${listRows(items, showIndustry)}</table>`
  );
}

// ── Partition: one reader's pools ─────────────────────────────────────────────
type Partition = {
  prefs: Prefs; pool: any[]; mine: any[]; mineHidden: number; weekMine: any[]; elsewhere: any[];
  periodLabel: string; windowWord: string; targetDay: string;
};
function partitionForProfile(p: any, dayIncidents: any[], weekIncidents: any[], targetDay: string, weekStart: string): Partition {
  const prefs = readerPrefs(p);
  const pool = prefs.weekly ? weekIncidents : dayIncidents;
  const indSet = new Set(prefs.industries);
  const inInd = (i: any) => indSet.size > 0 && indSet.has(String(i.industry || "").trim());
  const catOk = (i: any) => !prefs.catSet || (!!i.primary_category && prefs.catSet.has(i.primary_category));
  const sevOk = (i: any) => sevOf(i) >= prefs.minSev;

  const mine = indSet.size ? bySev(pool.filter((i) => inInd(i) && catOk(i) && sevOk(i))) : [];
  const mineHidden = indSet.size ? pool.filter((i) => inInd(i) && !(catOk(i) && sevOk(i))).length : 0;
  // Daily readers on a quiet day still see what their industry saw this week.
  const weekMine = (!prefs.weekly && indSet.size)
    ? bySev(weekIncidents.filter((i) => i.incident_day !== targetDay && inInd(i) && catOk(i) && sevOk(i)))
    : [];
  // Outside the industry only HIGH/CRITICAL travels (never below the reader's
  // own floor). Readers with no industry get everything at their floor.
  const crossFloor = indSet.size ? Math.max(CROSS_SECTOR_MIN_SEVERITY, prefs.minSev) : prefs.minSev;
  const elsewhere = bySev(pool.filter((i) => !inInd(i) && catOk(i) && sevOf(i) >= crossFloor));

  const periodLabel = prefs.weekly ? `${shortDate(weekStart)} – ${shortDate(targetDay)}` : shortDate(targetDay);
  const windowWord = prefs.weekly ? "this week" : "since the last sweep";
  return { prefs, pool, mine, mineHidden, weekMine, elsewhere, periodLabel, windowWord, targetDay };
}

// ── Sections ──────────────────────────────────────────────────────────────────
function introCard(part: Partition, tier: "free" | "subscriber"): string {
  const { prefs, pool, mine, weekMine, elsewhere, windowWord } = part;
  const ind = escape(shortIndustry(prefs.primary) || prefs.primary);
  const hi = elsewhere.length ? `<b style="color:#FFF;">${elsewhere.length}</b> high or critical elsewhere` : "";
  let lead: string;
  if (!prefs.industries.length) {
    lead = `<b style="color:#FFF;">${plural(pool.length, "incident")}</b> hit the wire ${windowWord}; <b style="color:#FFF;">${elsewhere.length}</b> cleared your S${prefs.minSev}+ floor. ` +
      `<a href="${ALERTS_URL}" style="color:${GOLD};text-decoration:none;font-weight:700;">Set your industry →</a> and the brief will lead with what matters to you.`;
  } else if (mine.length) {
    lead = `<b style="color:#FFF;">${plural(mine.length, "new incident")}</b> in <b style="color:#FFF;">${ind}</b> ${windowWord}${hi ? `, and ${hi}` : ""}. Here is what moved.`;
  } else {
    lead = `Nothing new in <b style="color:#FFF;">${ind}</b> cleared your filters ${windowWord}.` +
      (weekMine.length ? ` <b style="color:#FFF;">${weekMine.length}</b> did earlier this week` : "") +
      (hi ? `${weekMine.length ? ", and " : " "}${hi}.` : (weekMine.length ? "." : ""));
  }
  const cards = Math.min(mine.length, LEAD_CARDS[tier]) + (prefs.industries.length ? 0 : Math.min(elsewhere.length, 3));
  const rows = Math.max(0, mine.length - cards) + Math.min(elsewhere.length, CROSS_MAX[tier]) + (mine.length ? 0 : Math.min(weekMine.length, EARLIER_MAX));
  const filters = `<div style="margin-top:14px;padding-top:12px;border-top:1px solid #2a2a2a;font-family:${INTER};font-size:11.5px;color:${MUTED};line-height:1.8;">` +
    `Your brief · <span style="color:#FFF;">${prefs.industries.length ? prefs.industries.map(escape).join(" · ") : "No industry set"}</span> · ${escape(categoryLabel(prefs.catSet))} · <span style="color:#FFF;">S${prefs.minSev}+</span> · ${prefs.weekly ? "Weekly" : "Daily"} · ${readTime(cards, rows)} min read` +
    `&nbsp;&nbsp;<a href="${ALERTS_URL}" style="color:${GOLD};text-decoration:none;font-weight:700;">Configure alerts →</a></div>`;
  return card(
    `<div style="font-family:${INTER};font-size:16px;font-weight:700;color:#FFF;margin-bottom:12px;">Hey ${escape(prefs.name)},</div>` +
    `<p style="font-family:${INTER};font-size:14px;color:#D8D8D8;line-height:1.6;margin:0;">${lead}</p>` + filters
  );
}

function industrySection(part: Partition, tier: "free" | "subscriber", layer: Layer): string {
  const { prefs, mine, mineHidden, weekMine, windowWord } = part;
  if (!prefs.industries.length) return "";
  const ind = escape(shortIndustry(prefs.primary) || prefs.primary);
  const title = prefs.industries.length === 1 ? prefs.primary : `${prefs.primary} +${prefs.industries.length - 1}`;
  let html = sectionHead("In your industry", title,
    mine.length ? `${plural(mine.length, "incident")} at S${prefs.minSev}+ ${windowWord}` : `Nothing new ${windowWord}`);

  if (mine.length) {
    const lead = mine.slice(0, LEAD_CARDS[tier]);
    const rest = mine.slice(LEAD_CARDS[tier], LEAD_CARDS[tier] + LIST_MAX);
    html += lead.map((i) => incidentCard(i, tier, layer)).join("");
    html += listCard(`Also in ${shortIndustry(prefs.primary) || prefs.primary}`, rest, false);
    if (mine.length > LEAD_CARDS[tier] + LIST_MAX) {
      html += `<div style="text-align:center;margin:-6px 0 16px;">${quietLink(DASHBOARD_URL, `+ ${mine.length - LEAD_CARDS[tier] - LIST_MAX} more on your dashboard →`)}</div>`;
    }
  } else {
    html += card(
      `<p style="font-family:${INTER};font-size:14px;color:#D8D8D8;line-height:1.6;margin:0;">Nothing new in <b style="color:#FFF;">${ind}</b> cleared your filters ${windowWord}. We only fill this section when something does.</p>` +
      (weekMine.length
        ? `<div style="margin-top:16px;">${kicker("Earlier this week", MUTED, 2)}<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${listRows(weekMine.slice(0, EARLIER_MAX), false)}</table></div>`
        : `<p style="font-family:${INTER};font-size:12.5px;color:${MUTED};line-height:1.6;margin:12px 0 0;">A quiet week in ${ind} so far. ${quietLink(DASHBOARD_URL, "Your dashboard")} keeps the full history.</p>`)
    );
  }
  if (mineHidden > 0) {
    html += `<div style="font-family:${INTER};font-size:12px;color:${MUTED};line-height:1.6;margin:-6px 4px 16px;">${plural(mineHidden, `more ${ind} incident`)} ${windowWord} ${mineHidden === 1 ? "was" : "were"} below S${prefs.minSev} or outside your categories — ${quietLink(DASHBOARD_URL, "see them on your dashboard →")}</div>`;
  }
  return html;
}

function crossSection(part: Partition, tier: "free" | "subscriber", layer: Layer): string {
  const { prefs, elsewhere, windowWord } = part;
  if (!elsewhere.length) return "";
  if (!prefs.industries.length) {
    // No industry on file: the classic brief — top three in full, then the list.
    const lead = elsewhere.slice(0, 3);
    const rest = elsewhere.slice(3, 3 + CROSS_MAX[tier] + 5);
    return sectionHead("Across all sectors", "What moved", `${plural(elsewhere.length, "incident")} at S${prefs.minSev}+ ${windowWord}`) +
      lead.map((i) => incidentCard(i, tier, layer)).join("") + listCard("More from the sweep", rest, true) +
      (elsewhere.length > lead.length + rest.length ? `<div style="text-align:center;margin:-6px 0 16px;">${quietLink(MAP_URL, `+ ${elsewhere.length - lead.length - rest.length} more on the live map →`)}</div>` : "");
  }
  const ind = shortIndustry(prefs.primary) || prefs.primary;
  const rows = elsewhere.slice(0, CROSS_MAX[tier]);
  return sectionHead("Across all sectors", "High and critical elsewhere", `${plural(elsewhere.length, "incident")} outside ${escape(ind)} ${windowWord} · S${Math.max(CROSS_SECTOR_MIN_SEVERITY, prefs.minSev)}+`) +
    listCard("", rows, true) +
    (elsewhere.length > rows.length ? `<div style="text-align:center;margin:-6px 0 16px;">${quietLink(MAP_URL, `+ ${elsewhere.length - rows.length} more on the live map →`)}</div>` : "");
}

function closingCard(part: Partition, tier: "free" | "subscriber"): string {
  const ind = escape(shortIndustry(part.prefs.primary) || "your industry");
  if (tier === "subscriber") {
    return card(
      `<div style="font-family:${INTER};font-size:15px;font-weight:800;color:#FFF;letter-spacing:-0.01em;margin-bottom:8px;">Every ${ind} incident, with the full layer.</div>` +
      `<div style="font-family:${INTER};font-size:13.5px;color:#D8D8D8;line-height:1.55;margin-bottom:16px;">Your dashboard holds the complete blast radius, GUARD controls and peer watchlist for each incident in this brief, and the full report where one exists.</div>` +
      goldBtn(DASHBOARD_URL, "Open your dashboard →")
    );
  }
  return card(
    kicker("Organisation intelligence") +
    `<div style="font-family:${INTER};font-size:17px;font-weight:800;color:#FFF;letter-spacing:-0.01em;margin-bottom:8px;">What could this mean for us?</div>` +
    `<div style="font-family:${INTER};font-size:13.5px;color:#D8D8D8;line-height:1.55;margin-bottom:16px;">Subscribers see the named blast radius, GUARD controls and the peer watchlist on every incident above — plus Impact Assessments, Watchlists and Pathways &amp; simulation for your own organisation.</div>` +
    goldBtn(SUBSCRIBE_URL, "See plans →")
  );
}

function briefHtml(part: Partition, tier: "free" | "subscriber", layer: Layer, unsubUrl: string): string {
  const { prefs, periodLabel } = part;
  const body = introCard(part, tier) + industrySection(part, tier, layer) + crossSection(part, tier, layer) + closingCard(part, tier);
  const eyebrow = `${prefs.industries.length ? shortIndustry(prefs.primary) + " · " : ""}${prefs.weekly ? "Weekly" : "Daily"} brief · ${periodLabel}`;
  return shell(`${prefs.weekly ? "Weekly" : "Daily"} brief — ${periodLabel}`, body, unsubUrl, eyebrow, tier === "subscriber");
}

function subjectFor(part: Partition): string {
  const { prefs, mine, elsewhere, periodLabel } = part;
  const ind = shortIndustry(prefs.primary) || prefs.primary;
  const hi = elsewhere.length ? ` · ${elsewhere.length} high or critical elsewhere` : "";
  if (!prefs.industries.length) return `${plural(elsewhere.length, "incident")} at S${prefs.minSev}+ — ${periodLabel}`;
  if (prefs.weekly) return `Your week in ${ind}: ${plural(mine.length, "incident")}${hi} — ${periodLabel}`;
  if (mine.length) return `${mine.length} new in ${ind}${hi} — ${periodLabel}`;
  return `Quiet in ${ind}${hi} — ${periodLabel}`;
}

// Backward-compatible names (the preview renderer and older callers).
function freeDigestHtml(part: Partition, layer: Layer, unsubUrl: string) { return briefHtml(part, "free", layer, unsubUrl); }
function partnerDigestHtml(part: Partition, layer: Layer, unsubUrl: string) { return briefHtml(part, "subscriber", layer, unsubUrl); }

// Build the per-reader brief. `layer` carries the subscriber-only rows for the
// lead incidents (EMPTY_LAYER renders the free depth for everyone). Returns
// everything the caller needs to send or report (dry run).
function buildForProfile(p: any, dayIncidents: any[], weekIncidents: any[], targetDay: string, weekStart: string, layer: Layer = EMPTY_LAYER) {
  const part = partitionForProfile(p, dayIncidents, weekIncidents, targetDay, weekStart);
  const tier: "free" | "subscriber" = part.prefs.isSubscriber ? "subscriber" : "free";
  // No token ⇒ no working unsubscribe link. Such a reader is never sent a brief
  // (see the send loop); a dry run still renders one, pointing at Configure alerts.
  const unsubUrl = p.unsubscribe_token ? unsubscribeUrl(p.unsubscribe_token) : ALERTS_URL;
  const html = tier === "subscriber" ? partnerDigestHtml(part, layer, unsubUrl) : freeDigestHtml(part, layer, unsubUrl);
  const empty = part.mine.length === 0 && part.weekMine.length === 0 && part.elsewhere.length === 0;
  return {
    isPartner: part.prefs.isSubscriber, weekly: part.prefs.weekly,
    industry: part.prefs.primary || null, minSev: part.prefs.minSev,
    categories: part.prefs.catSet ? [...part.prefs.catSet] : "all",
    matched: part.mine.length, hidden: part.mineHidden, weekMatched: part.weekMine.length,
    elsewhere: part.elsewhere.length, pool: part.pool.length, empty,
    leadIds: part.mine.slice(0, LEAD_CARDS[tier]).map((i) => Number(i.id)),
    subject: subjectFor(part), html,
  };
}

// ── Plumbing ────────────────────────────────────────────────────────────────
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

// The incident columns the brief renders, plus the public counts embed.
const INCIDENT_COLS = "id,headline,summary,entity,sector,industry,country,severity,primary_category,severity_rationale,incident_day,image_url,layer_counts(*)";

const PROFILE_COLS = "id,email,tier,full_name,industry,unsubscribe_token,watch_industries,watch_categories,digest_frequency";
// min_severity arrives with migration 20260922_brief_prefs.sql. PostgREST
// rejects the WHOLE select on one unknown column, so until the owner applies
// it the fallback select keeps the function alive (everyone at the default).
async function fetchProfiles(): Promise<any[]> {
  const filter = `&email_subscribed=eq.true&tier=in.(free,enterprise,admin)&limit=10000`;
  try { return await pgFetch(`profiles?select=${PROFILE_COLS},min_severity${filter}`); }
  catch (err) {
    console.warn("[daily-digest] profiles without min_severity:", (err as Error)?.message);
    return await pgFetch(`profiles?select=${PROFILE_COLS}${filter}`);
  }
}

// Subscriber-only rows for the lead incidents, read with the service role.
async function loadLayer(ids: number[]): Promise<Layer> {
  const uniq = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!uniq.length) return EMPTY_LAYER;
  const list = `in.(${uniq.join(",")})`;
  const [blast_radius, adaptive_controls, peer_watchlist, sources] = await Promise.all([
    pgFetch(`blast_radius?select=incident_id,name,exposure_group,transmission_mechanism,impact_score&incident_id=${list}&order=incident_id.asc,impact_score.desc.nullslast,id.asc&limit=2000`),
    pgFetch(`adaptive_controls?select=incident_id,control_id,statement&incident_id=${list}&order=incident_id.asc,id.asc&limit=2000`),
    pgFetch(`peer_watchlist?select=incident_id,name&incident_id=${list}&order=incident_id.asc,id.asc&limit=2000`),
    pgFetch(`sources?select=incident_id,title,url,publisher&incident_id=${list}&order=incident_id.asc,id.asc&limit=2000`),
  ]);
  return makeLayer({ blast_radius, adaptive_controls, peer_watchlist, sources });
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (req) => {
  // Machines only, and before anything else: a dry run lists reader addresses.
  const denied = await requireInternal(req);
  if (denied) return denied;

  let body: any = {};
  try {
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    else {
      const u = new URL(req.url);
      body = {
        day: u.searchParams.get("day"),
        to: u.searchParams.get("to"),
        dryRun: u.searchParams.get("dryRun") === "true",
        force: u.searchParams.get("force") === "true",
      };
    }
  } catch { /* noop */ }

  const targetDay: string = body?.day || yesterdayISO();
  // targetDay is written into the PostgREST filter below, so only a real date passes.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDay) || Number.isNaN(Date.parse(`${targetDay}T00:00:00Z`))) {
    return jsonResponse({ ok: false, error: "day must be YYYY-MM-DD" }, 400);
  }
  const weekStart = addDaysISO(targetDay, -6);
  const onlyTo: string | null = body?.to || null;
  const dryRun: boolean = body?.dryRun === true;
  const force: boolean = body?.force === true;

  // One fetch covering the widest window any reader needs (weekly = 7 days;
  // daily readers also get the week for the quiet-day fallback).
  const weekIncidents: any[] = await pgFetch(
    `incidents?select=${INCIDENT_COLS}` +
    `&incident_day=gte.${weekStart}&incident_day=lte.${targetDay}` +
    `&latitude=not.is.null&longitude=not.is.null&order=incident_day.asc,severity.desc.nullslast,id.desc&limit=800`,
  );
  const dayIncidents = weekIncidents.filter((i) => i.incident_day === targetDay);

  if (weekIncidents.length === 0) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: "no incidents", day: targetDay }),
      { headers: { "Content-Type": "application/json" } });
  }

  let profiles: any[] = await fetchProfiles();
  if (onlyTo) profiles = profiles.filter((p) => p.email === onlyTo);

  const sendDow = new Date().getUTCDay(); // 0=Sun … 1=Mon

  // Subscriber-only rows, once, for every subscriber's lead incidents.
  const leadIds: number[] = [];
  for (const p of profiles) {
    const part = partitionForProfile(p, dayIncidents, weekIncidents, targetDay, weekStart);
    if (!part.prefs.isSubscriber) continue;
    const lead = part.prefs.industries.length ? part.mine.slice(0, LEAD_CARDS.subscriber) : part.elsewhere.slice(0, 3);
    for (const i of lead) leadIds.push(Number(i.id));
  }
  let layer = EMPTY_LAYER;
  try { layer = await loadLayer(leadIds); }
  catch (err) { console.warn("[daily-digest] layer load failed, subscriber cards render without rows:", (err as Error)?.message); }

  // ── Dry run: partition + render, send nothing ──────────────────────────────
  // Lists every reader's address; only internal callers get this far (see the gate).
  if (dryRun) {
    const report = profiles.map((p) => {
      const b = buildForProfile(p, dayIncidents, weekIncidents, targetDay, weekStart, layer);
      const weeklyGated = b.weekly && sendDow !== WEEKLY_SEND_DOW && !force;
      return {
        email: p.email, tier: p.tier, frequency: p.digest_frequency || "daily",
        industry: b.industry, min_severity: b.minSev, categories: b.categories,
        matched: b.matched, hidden: b.hidden, earlier_this_week: b.weekMatched, elsewhere: b.elsewhere, pool: b.pool,
        has_unsubscribe_token: !!p.unsubscribe_token,
        would_send: !weeklyGated && !b.empty && !!p.unsubscribe_token, subject: b.subject,
        ...(onlyTo ? { html: b.html } : {}),
      };
    });
    return jsonResponse({ ok: true, dryRun: true, version: 18, provider: mailProvider(), day: targetDay, week_start: weekStart,
      day_incidents: dayIncidents.length, week_incidents: weekIncidents.length, layer_incidents: leadIds.length, recipients: report.length, report });
  }

  // ── Real send ──────────────────────────────────────────────────────────────
  const setupError = mailSetupError();
  if (setupError) return jsonResponse({ ok: false, error: setupError }, 500);

  const results = { free: 0, subscriber: 0, skipped_weekly: 0, skipped_empty: 0, skipped_no_unsubscribe: 0, failed: 0, errors: [] as any[] };
  for (const p of profiles) {
    const b = buildForProfile(p, dayIncidents, weekIncidents, targetDay, weekStart, layer);

    // Cadence gate: weekly readers receive only on the weekly send-day, unless
    // explicitly forced or single-recipient tested.
    if (b.weekly && sendDow !== WEEKLY_SEND_DOW && !force && !onlyTo) { results.skipped_weekly++; continue; }
    if (b.empty) { results.skipped_empty++; continue; } // nothing to say to this reader this period
    // A bulk mail always carries a working unsubscribe link, so no token, no mail.
    if (!p.unsubscribe_token) { results.skipped_no_unsubscribe++; continue; }

    const res = await sendMail({
      to: p.email, subject: b.subject, html: b.html,
      headers: unsubscribeHeaders(p.unsubscribe_token),
      // Same day, reader and email ⇒ same key: a retry or a re-run cannot mail it twice.
      idempotencyKey: await idemKey("daily-digest", targetDay, p.id, b.subject, b.html),
    });
    if (res.ok) {
      if (b.isPartner) results.subscriber++;
      else results.free++;
    } else {
      results.failed++;
      results.errors.push({ email: p.email, error: res.error });
    }
  }

  return jsonResponse({ ok: true, provider: mailProvider(), version: 18, day: targetDay,
    day_incidents: dayIncidents.length, week_incidents: weekIncidents.length, ...results });
});
