// incidentReport.js — a published briefing straight from the database,
// rendered into the same standalone shell as the baked files in
// public/reports-full/.
//
// The product database holds every report as data in its `reports` schema
// (supabase/migrations/20261030_reports_schema.sql): reports.briefings
// (narrative, bullets, severity, scenarios, …) and the child tables (blast
// radius, sources, vendors, controls, comparables, causes), copied from the
// incident reporting project by reports.sync_from_incident_db. The baked
// files were made from exactly this data, as `const INCIDENT = {…}` inside one
// shared shell. This module does the same, live:
//
//   payload = await fetchReportPayload("ATK-EV-067", opts)   one DB call
//   json    = toIncidentJson(payload)                        the INCIDENT object
//   html    = renderFullReport(json)                         the full page
//
// The reports.* tables have no public read policy; the database function
// public.report_payload(p_id, p_key) hands a briefing out only with the read
// key (REPORT_FEED_KEY), which never reaches a browser. Free readers get the
// preview that src/lib/reportPreview.js cuts from the full page, server-side.
// Pure data work apart from the fetches; no Node-only or browser-only APIs.
import { REPORT_SHELL_V4, SHELL_PLACEHOLDER } from "./reportShellV4.js";
import { REPORTER_PHOTOS } from "./reporterPhotos.js";

// The product database (public values; the env wins when set). REPORTS_* lets
// the reports live elsewhere later without touching the code.
export const REPORTS_DB = {
  url: process.env.REPORTS_SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://ovenyjguhkgiceddzwna.supabase.co",
  anonKey: process.env.REPORTS_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_23l5g7MVvgkKuUIctG-e9w_cWYnAtM5",
  key: process.env.REPORT_FEED_KEY || "",
};

export const REPORT_REF = /^ATK-[A-Za-z0-9-]{2,60}$/;

// opts come from the Vite dev server (its .env), else the process env / defaults.
function cfg(opts = {}) {
  return {
    url: String(opts.reportsUrl || opts.supabaseUrl || REPORTS_DB.url).replace(/\/$/, ""),
    anon: opts.reportsAnonKey || opts.anonKey || REPORTS_DB.anonKey,
    key: opts.reportKey !== undefined ? opts.reportKey : REPORTS_DB.key,
  };
}

async function rest(c, path, init = {}) {
  const r = await fetch(`${c.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}`, Accept: "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`incident db ${r.status} on ${path.split("?")[0]}`);
  return r.json();
}

// One published report with all of its child rows, or null (unknown ref, not
// published, or a wrong key — the database answers null for all three).
export async function fetchReportPayload(id, opts = {}) {
  const c = cfg(opts);
  if (!REPORT_REF.test(String(id || ""))) return null;
  if (!c.key) throw new Error("REPORT_FEED_KEY is not set");
  const j = await rest(c, "rpc/report_payload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ p_id: id, p_key: c.key }) });
  return j && typeof j === "object" && j.incident ? j : null;
}

// ── The INCIDENT object ───────────────────────────────────────────────────
// Field for field what the baked files carry: the shell's script reads these
// names (I.blast, I.guardMap, …). Child rows keep only the keys the shell
// uses, so database housekeeping columns never reach the page.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (x == null ? "" : String(x));

export function toIncidentJson(p) {
  const i = (p && p.incident) || {};
  const rep = (p && p.reporter) || {};
  const code = str(i.reporter_code || rep.code);
  const author = str(rep.name);
  const role = str(rep.role);
  const desk = str(rep.desk);
  const published = i.published_at || i.created_at || null;
  const cats = arr(i.categories_touched).length ? arr(i.categories_touched) : arr(i.categories);
  return {
    id: str(i.id),
    ref: str(i.ref) || "ASSESSMENT v1 · point-in-time",
    asOf: fmtDay(published),
    desk: str(i.kicker).split(" · ")[0] || desk,
    blast: arr(p.blast).map((b) => ({ d: b.d, n: b.n, r: b.r, sev: b.sev })),
    chain: arr(i.chain),
    title: str(i.title),
    author,
    byline: author ? `Filed by ${author}${role ? ` · ${role}` : ""}` : "",
    causes: arr(p.causes).map((c) => ({ bp: c.bp, cats: c.cats, cmp: c.cmp, guard: c.guard, hyp: c.hyp, rat: c.rat, tier: c.tier, why: c.why })),
    kicker: str(i.kicker),
    status: str(i.status),
    dekTail: str(i.dek_tail),
    dossier: arr(i.dossier),
    metrics: arr(i.metrics),
    outlook: arr(i.outlook),
    sources: arr(p.sources).map((s) => ({ s: s.s, t: s.t })),
    vendors: arr(p.vendors).map((v) => ({ ctrls: arr(v.ctrls), dom: v.dom, kind: v.kind, logo: v.logo == null ? "" : v.logo, maker: v.maker, map: v.map, n: v.n, prod: v.prod, rat: v.rat, vtype: v.vtype })),
    causeTag: str(i.cause_tag),
    footnote: str(i.footnote),
    guardMap: arr(p.controls).map((c) => ({ cat: c.cat, code: c.code, fail: c.fail, good: c.good, name: c.name, obj: c.obj, owner: c.owner })),
    severity: i.severity,
    subtitle: str(i.subtitle),
    takeaway: str(i.takeaway),
    chainLead: str(i.chain_lead),
    narrative: arr(i.narrative),
    pullQuote: str(i.pull_quote),
    scenarios: arr(i.scenarios),
    assessedAt: `${fmtDay(i.assessed_at || published)} · ${str(i.event_tz) || "Asia/Calcutta"}`,
    confidence: str(i.confidence),
    frameworks: arr(i.frameworks),
    standfirst: str(i.standfirst),
    authorPhoto: REPORTER_PHOTOS[code] || "",
    authorTitle: [role, desk ? `${desk} Desk` : ""].filter(Boolean).join(" · "),
    comparables: arr(p.comparables).map((c) => ({ case: c.case_name, implication: c.implication, what: c.what, year: c.year })),
    execBullets: arr(i.exec_bullets),
    authorOutlet: str(rep.outlet) || "Attacked.ai Intelligence",
    reporterCode: code,
    severityDims: i.severity_dims || null,
    analystVerdict: arr(i.analyst_verdict),
    categoriesTouched: cats,
  };
}

// JSON that is safe inside a <script>: no "</script>", no raw line separators.
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029), BS = String.fromCharCode(92);
export const jsonSafe = (o) => JSON.stringify(o).replace(/</g, BS + "u003c").split(LS).join(BS + "u2028").split(PS).join(BS + "u2029");

// The full standalone page: the shared shell with this report's INCIDENT line.
export function renderFullReport(json) {
  return REPORT_SHELL_V4.replace(SHELL_PLACEHOLDER, () => jsonSafe(json));
}

// ── The library list ──────────────────────────────────────────────────────
// Every published report's card data from the anon-readable view
// public.report_briefings_public (card columns only; nothing from the child
// tables). Shaped like a row of the CMS view hub_reports_public, so the Hub
// renders both the same way. PostgREST answers at most 1,000 rows per
// request, so the list is read in pages of 1,000 until a short page comes back.
const LIST_SELECT = "id,title,subtitle,industry_slug,industry,severity,primary_category,categories,categories_touched,published_at,primary_date,image_url,reporter_code,entity,country,ticker";
const PAGE = 1000;
export async function listPublishedReports(opts = {}, { industry = null, limit = 5000 } = {}) {
  const c = cfg(opts);
  const q = new URLSearchParams({ select: LIST_SELECT, order: "published_at.desc,id.asc" });
  if (industry) q.set("industry_slug", `eq.${industry}`);
  const rows = [];
  for (let from = 0; from < limit; from += PAGE) {
    const page = await rest(c, `report_briefings_public?${q}`, { headers: { Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" } });
    rows.push(...arr(page));
    if (!Array.isArray(page) || page.length < PAGE) break;
  }
  return rows.filter((r) => r && REPORT_REF.test(String(r.id))).map((r) => ({
    id: r.id, ref: r.id, title: str(r.title), subtitle: str(r.subtitle), summary: "",
    industry: str(r.industry) || str(r.industry_slug), industry_slug: str(r.industry_slug),
    primary_category: r.primary_category || null, severity: r.severity ?? null, incident_id: null,
    hero_image_url: r.image_url || null, author: null,
    tags: arr(r.categories_touched).length ? r.categories_touched : arr(r.categories),
    published_at: r.published_at || null, primary_date: r.primary_date || null,
    entity: r.entity || null, country: r.country || null, ticker: r.ticker || null,
    source: "incident-db",
  }));
}
