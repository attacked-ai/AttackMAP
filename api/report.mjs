// api/report.mjs — a published briefing from the incident reporting database,
// as a page. A Vercel Node function; the Vite dev server mounts the same
// handler at /api/report (vite.config.js), so localhost behaves alike.
//
//   GET /api/report?ref=ATK-EV-067          the report page (text/html)
//       with Authorization: Bearer <access token> of a subscriber → the full
//       briefing (private, never cached); anyone else → the free preview
//       (header, key figures, Executive Summary; the rest locked), cached.
//   GET /api/report?list=1[&industry=slug]  every published report's card data
//       { reports: [...], count }, cached for five minutes at the edge.
//   404 unknown ref / not published · 400 bad ref · 405 not GET
//
// The subscriber decision is the one middleware.js makes for /reports-full/
// (src/lib/reportGate.js → rpc is_subscriber on the app's own database), so a
// report from the database is locked exactly like a baked file. The free
// preview is cut from the full page by src/lib/reportPreview.js on the
// server: no locked paragraph is ever sent to a free reader's browser.
import { bearerToken, isSubscriberToken } from "../src/lib/reportGate.js";
import { makeReportPreview, stubPreview } from "../src/lib/reportPreview.js";
import { REPORT_REF, fetchReportPayload, listPublishedReports, renderFullReport, toIncidentJson } from "./_lib/incidentReport.js";

// The app's own database, for the subscriber check (public values; env wins).
const LIVE = {
  supabaseUrl: process.env.VITE_SUPABASE_URL || "https://ovenyjguhkgiceddzwna.supabase.co",
  anonKey: process.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_23l5g7MVvgkKuUIctG-e9w_cWYnAtM5",
};
const NO_STORE = "private, no-store";
const PUBLIC_5M = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";

function send(res, status, body, { type = "application/json; charset=utf-8", cache = NO_STORE, headers = {} } = {}) {
  res.statusCode = status;
  res.setHeader("cache-control", cache);
  res.setHeader("content-type", type);
  res.setHeader("x-robots-tag", "noindex");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

// Previews keyed by ref, for a few minutes: the cut is pure string work but
// not free, and the free side of a report changes only when the row does.
const previews = new Map();
const PREVIEW_TTL = 5 * 60 * 1000;

export function previewOf(ref, full, json) {
  const hit = previews.get(ref);
  if (hit && hit.until > Date.now() && hit.full === full) return hit.html;
  let html;
  try { html = makeReportPreview(full, { design: "lock" }).html; }
  catch { html = stubPreview({ ref, title: json.title, subtitle: json.subtitle, summary: json.standfirst }); }
  if (previews.size > 500) previews.delete(previews.keys().next().value);
  previews.set(ref, { html, full, until: Date.now() + PREVIEW_TTL });
  return html;
}

// opts: the Vite dev server passes its own env (process.env carries no VITE_ vars there).
export default async function handler(req, res, opts = {}) {
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (req.method !== "GET") return send(res, 405, { error: "get_only" });
  let u;
  try { u = new URL(req.url || "/", "http://local"); } catch { return send(res, 400, { error: "bad_url" }); }
  const live = opts.supabaseUrl ? { supabaseUrl: opts.supabaseUrl, anonKey: opts.anonKey } : LIVE;

  if (u.searchParams.get("list")) {
    const industry = (u.searchParams.get("industry") || "").trim() || null;
    if (industry && !/^[a-z0-9-]{1,60}$/.test(industry)) return send(res, 400, { error: "bad_industry" });
    try {
      const reports = await listPublishedReports(opts, { industry });
      return send(res, 200, { reports, count: reports.length }, { cache: PUBLIC_5M, headers: { "access-control-allow-origin": "*" } });
    } catch (e) { return send(res, 502, { error: "incident_db_unreachable", detail: String((e && e.message) || e) }); }
  }

  const ref = (u.searchParams.get("ref") || "").trim();
  if (!REPORT_REF.test(ref)) return send(res, 400, { error: "bad_ref" });
  let payload;
  try { payload = await fetchReportPayload(ref, opts); }
  catch (e) { return send(res, 502, { error: "incident_db_unreachable", detail: String((e && e.message) || e) }); }
  if (!payload) return send(res, 404, { error: "not_found", ref });
  const json = toIncidentJson(payload);
  const full = renderFullReport(json);

  const token = bearerToken(req.headers && req.headers.authorization);
  const subscriber = token ? await isSubscriberToken(token, live) : false;
  if (subscriber) return send(res, 200, full, { type: "text/html; charset=utf-8", cache: NO_STORE, headers: { vary: "authorization", "x-report-edition": "full" } });
  return send(res, 200, previewOf(ref, full, json), { type: "text/html; charset=utf-8", cache: token ? NO_STORE : PUBLIC_5M, headers: { vary: "authorization", "x-report-edition": "preview" } });
}
