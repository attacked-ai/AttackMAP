// data.js — everything the signed-in dashboard reads, in one place.
//
// All reads go through the public `incidents` view with the anon/user key, the
// same way the map does. The free view never fetches subscriber-only ROWS; it
// asks for COUNTS so the reader sees the shape of what is locked without the
// detail. Subscribers (and admins) additionally load the rows for the incident
// they open — with their own JWT, so the row policies let them through.
//
// Counts come in one of two shapes, detected once per session:
//   "layer" — after Phase 2 Part A (supabase/migrations/20260922_subscriber_
//             layer_lock.sql): incidents?select=...,layer_counts(*), a computed
//             relationship on a view that bypasses the row lock, so free readers
//             keep the counts after the rows are locked.
//   "embed" — before it: the five (count) sub-selects on the public views.
//
// One stale column name 400s the whole select (see reference: PostgREST column
// drift), so the column list is defined ONCE here and reused.

import { supabase } from "../lib/supabaseClient";
import { publishedReportsByIncident } from "../lib/reports";
import { subscriberLayer } from "../lib/api";
import { CATEGORY_NAME, SEVERITY } from "../lib/taxonomy";
import { GCP } from "../lib/backend";

// Columns without counts. Used for list rows where the counts are not shown
// until the reader opens the incident; loadCounts() fills them in then.
export const COLS_LIGHT =
  "id,headline,summary,entity,sector,industry,country,location_name,severity,severity_rationale,confidence," +
  "primary_category,primary_subcategory_code,primary_subcategory_name,secondary_mappings,incident_day,event_date,article_body,image_url";
const COUNT_EMBEDS = "sources(count),blast_radius(count),peer_watchlist(count),adaptive_controls(count),historical_analogues(count)";
// Legacy full list (embed shape); kept for anything that still imports it.
export const COLS = `${COLS_LIGHT},${COUNT_EMBEDS}`;

let countsMode = null; // "layer" | "embed"
export async function detectCountsMode() {
  if (countsMode) return countsMode;
  const { error } = await supabase.from("incident_layer_counts").select("incident_id").limit(1);
  countsMode = error ? "embed" : "layer";
  return countsMode;
}
// The card column list for the current session's counts shape.
export async function cols() { return `${COLS_LIGHT},${(await detectCountsMode()) === "layer" ? "layer_counts(*)" : COUNT_EMBEDS}`; }
const countsSelect = async () => `id,${(await detectCountsMode()) === "layer" ? "layer_counts(*)" : COUNT_EMBEDS}`;

const cnt = (x) => (Array.isArray(x) && x[0] ? Number(x[0].count) : 0);
const layer = (r) => (Array.isArray(r.layer_counts) ? r.layer_counts[0] : r.layer_counts) || null;
const hasCounts = (r) => Array.isArray(r.blast_radius) || !!layer(r);
const counts = (r) => {
  const l = layer(r);
  if (l) return { sources: Number(l.sources) || 0, blast: Number(l.blast) || 0, peers: Number(l.peers) || 0, controls: Number(l.controls) || 0, analogues: Number(l.analogues) || 0 };
  return { sources: cnt(r.sources), blast: cnt(r.blast_radius), peers: cnt(r.peer_watchlist), controls: cnt(r.adaptive_controls), analogues: cnt(r.historical_analogues) };
};

export function shape(r) {
  return {
    id: r.id, headline: r.headline, summary: r.summary || "", entity: r.entity, country: r.country,
    place: r.location_name, industry: r.industry, sector: r.sector, severity: r.severity || 1,
    sevLabel: SEVERITY[r.severity] || "—", rationale: r.severity_rationale || "", confidence: r.confidence,
    cat: r.primary_category, catName: CATEGORY_NAME[r.primary_category] || r.primary_category,
    subcat: r.primary_subcategory_name, subcode: r.primary_subcategory_code,
    secondary: Array.isArray(r.secondary_mappings)
      ? r.secondary_mappings.slice(0, 4).map((s) => ({ cat: s.category, name: s.subcategory_name })) : [],
    day: r.incident_day, date: r.event_date, body: r.article_body || null,
    // The stored picture; incidentPhoto() (lib/images.js) reads i.image_url.
    image_url: r.image_url || null,
    n: hasCounts(r) ? counts(r) : null,
  };
}

const live = (q) => q.not("incident_day", "is", null).not("latitude", "is", null);
const throwing = ({ data, error }) => { if (error) throw error; return data || []; };

// Wave 1 — what "Your Industry" needs to paint: the cards (with counts, since
// the teaser is on every card), the light rows for the stats, and two counts.
// Everything else comes in loadIndustryExtras() once this has rendered.
// Firing all eight at once tripped the anon statement timeout: the count
// sub-selects are cheap alone but contend with each other in parallel.
export async function loadIndustry(industry) {
  const C = await cols();
  const [cards, light, briefTotalRes, dayRes] = await Promise.all([
    live(supabase.from("incidents").select(C).eq("industry", industry))
      .order("incident_day", { ascending: false }).order("severity", { ascending: false }).order("id", { ascending: false }).limit(24).then(throwing),
    // light rows for the category breakdown + week/today counts (whole industry)
    live(supabase.from("incidents").select("primary_category,severity,incident_day,country").eq("industry", industry)).limit(2000).then(throwing),
    supabase.from("incidents").select("id", { count: "exact", head: true }).eq("industry", industry).not("article_body", "is", null),
    live(supabase.from("incidents").select("incident_day")).order("incident_day", { ascending: false }).limit(1).then(throwing),
  ]);

  const latestDay = dayRes[0]?.incident_day || null;
  const days = [...new Set(light.map((r) => r.incident_day))].sort();
  const weekDays = new Set(days.slice(-7));
  const cats = {}; const countries = new Set();
  let today = 0, week = 0, critical = 0;
  for (const r of light) {
    cats[r.primary_category] = (cats[r.primary_category] || 0) + 1;
    if (r.incident_day === latestDay) today++;
    if (weekDays.has(r.incident_day)) week++;
    if (r.severity >= 4) critical++;
    if (r.country) countries.add(r.country);
  }

  return {
    industry, latestDay,
    total: light.length, today, week, critical, countries: countries.size,
    cats: Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ code, name: CATEGORY_NAME[code] || code, n })),
    briefings: briefTotalRes.count || 0,
    incidents: cards.map(shape),
    briefs: [], latest: [], hub: [],   // filled by loadIndustryExtras()
  };
}

// Wave 2 — list rows without count embeds (counts load on open). Runs after
// wave 1 has painted, sequentially, so nothing contends with the cards query.
export async function loadIndustryExtras(industry) {
  const briefs = await live(supabase.from("incidents").select(COLS_LIGHT).eq("industry", industry).not("article_body", "is", null))
    .order("incident_day", { ascending: false }).order("severity", { ascending: false }).limit(6).then(throwing);
  const latest = await live(supabase.from("incidents").select(COLS_LIGHT).gte("severity", 3))
    .order("incident_day", { ascending: false }).order("severity", { ascending: false }).order("id", { ascending: false }).limit(14).then(throwing);
  const hub = await live(supabase.from("incidents").select(COLS_LIGHT).not("article_body", "is", null))
    .order("incident_day", { ascending: false }).order("severity", { ascending: false }).limit(30).then(throwing);
  return { briefs: briefs.map(shape), latest: latest.map(shape), hub: hub.map(shape) };
}

// The five child counts for ONE incident — for rows that arrived via
// COLS_LIGHT and are now being opened.
export async function loadCounts(id) {
  const rows = await supabase.from("incidents")
    .select(await countsSelect())
    .eq("id", id).limit(1).then(throwing);
  return rows[0] ? shape({ ...rows[0], severity: 1 }).n : { sources: 0, blast: 0, peers: 0, controls: 0, analogues: 0 };
}

// Subscriber layer for one incident. Free readers never call this.
// Through the API when VITE_API_URL is set (the server checks the tier and,
// after RLS closes these tables, is the only reader); PostgREST otherwise, or
// when the API cannot be reached.
export async function loadIncidentDetail(id) {
  try { const viaApi = await subscriberLayer(id); if (viaApi) return viaApi; }
  catch (e) { if (e && e.status) throw new Error(e.message); }
  const eq = (t, cols) => supabase.from(t).select(cols).eq("incident_id", id).then(throwing);
  const [blast, controls, peers, analogues, sources] = await Promise.all([
    eq("blast_radius", "id,name,type,country,exposure_group,reason,impact_score,transmission_mechanism,impact_horizon,recommended_action_for_them"),
    eq("adaptive_controls", "id,control_id,parent_mc_id,statement,rationale,kind"),
    eq("peer_watchlist", "id,name,country,exposure_reason"),
    eq("historical_analogues", "id,event_name,entity,year,summary,outcome"),
    eq("sources", "id,title,url,publisher"),
  ]);
  return { blast, controls, peers, analogues, sources };
}

// Corpus-wide numbers for the map card; cached for the session.
let corpusCache = null;
export async function loadCorpus() {
  if (corpusCache) return corpusCache;
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await live(supabase.from("incidents").select("country,incident_day")).range(from, from + 999).then(throwing);
    rows.push(...page); if (page.length < 1000) break;
  }
  corpusCache = {
    incidents: rows.length,
    countries: new Set(rows.map((r) => r.country).filter(Boolean)).size,
    days: new Set(rows.map((r) => r.incident_day)).size,
  };
  return corpusCache;
}

// Alerts page persistence — the same RPC the retired subscriptions page used.
export async function savePrefs({ watchIndustries, watchCategories, frequency, subscribed }) {
  const { error } = await supabase.rpc("update_subscription_prefs", {
    p_watch_industries: watchIndustries, p_watch_categories: watchCategories,
    p_digest_frequency: frequency, p_email_subscribed: subscribed,
  });
  if (error) throw error;
}

// ── Attack Hub ─────────────────────────────────────────────────────────────
// The reading room needs the WHOLE industry (not the 24-card window the home
// view paints) plus a broad cross-sector feed, all as light rows. Loaded once
// per industry when the reader first opens the Hub; the home view never waits
// on it.
export async function loadHub(industry) {
  // Two light selects with no count embeds; they do not contend, so run both at once.
  const [mine, world] = await Promise.all([
    live(supabase.from("incidents").select(COLS_LIGHT).eq("industry", industry))
      .order("incident_day", { ascending: false }).order("severity", { ascending: false }).order("id", { ascending: false }).limit(2000).then(throwing),
    live(supabase.from("incidents").select(COLS_LIGHT).neq("industry", industry).gte("severity", 3))
      .order("incident_day", { ascending: false }).order("severity", { ascending: false }).order("id", { ascending: false }).limit(300).then(throwing),
  ]);
  return { mine: mine.map(shape), world: world.map(shape) };
}

// ── Baked reports ──────────────────────────────────────────────────────────
// 310 incidents carry a full pre-rendered briefing at public/reports/<ref>.html.
// The DB no longer holds the ref (hub_ref went in the schema restructure), so
// public/reports/manifest.json maps incident id -> ref, rebuilt from the
// report titles on 2026-09-21. Cached for the session; {} on any failure so
// callers fall back to the structured brief.
let reportIndex = null;
export async function loadReportIndex() {
  if (reportIndex) return reportIndex;
  let baked = {};
  try {
    const r = await fetch(GCP ? "/api/reports/manifest.json" : "/reports/manifest.json", { cache: "force-cache" });
    const m = await r.json();
    baked = (m && m.byIncident) || {};
  } catch { baked = {}; }
  // CMS-published reports (public.hub_reports) that belong to an incident;
  // a CMS report wins over a baked one for the same incident (2026-09-28).
  let cms = {};
  try { cms = await publishedReportsByIncident(); } catch { cms = {}; }
  reportIndex = { ...baked, ...cms };
  return reportIndex;
}
export const reportRefFor = (id) => (reportIndex ? reportIndex[String(id)] || null : null);
