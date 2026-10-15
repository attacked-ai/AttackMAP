// reports.js — the CMS-published intelligence reports (public.hub_reports),
// shared by the Attacked Hub, the dashboard and the admin console.
//
// Readers see PUBLISHED reports only, through:
//   • view  hub_reports_public   — list columns, no html (anon-readable)
//   • rpc   report_html(p_ref)   — the standalone HTML for one report: the
//                                   full one for a subscriber, the preview
//                                   (header + Executive Summary) for anyone else
// Admins author through the admin_* functions (all gated by _is_admin()).
//
// A report either belongs to a DB incident (incident_id set → the incident's
// card gets the "Full report" treatment, like the 310 baked reports in
// public/reports/) or stands alone (a daily intelligence piece).

import { supabase } from "./supabaseClient";
import { isPreviewHtml, reportShell } from "./reportPreview";

const LIST_COLS = "id,ref,title,subtitle,summary,industry,primary_category,severity,incident_id,hero_image_url,author,tags,published_at,updated_at";

// Published reports, newest first. `{ industry }` narrows to one industry.
export async function listPublishedReports({ industry = null, limit = 200 } = {}) {
  let q = supabase.from("hub_reports_public").select(LIST_COLS).order("published_at", { ascending: false }).limit(limit);
  if (industry) q = q.eq("industry", industry);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// incident id (string) → ref, for the published reports that belong to an incident.
export async function publishedReportsByIncident() {
  const rows = await listPublishedReports({ limit: 1000 });
  const m = {};
  for (const r of rows) if (r.incident_id != null) m[String(r.incident_id)] = r.ref;
  return m;
}

// The full HTML of a published report, or null when the ref is not a CMS
// report (callers then fall back to the API / static file).
export async function fetchReportHtml(ref) {
  if (!ref) return null;
  const { data, error } = await supabase.rpc("report_html", { p_ref: ref });
  if (error) return null;
  return typeof data === "string" && data.length ? data : null;
}

// The full baked report for a subscriber. /reports-full/<ref>.html sits
// behind the server gate (middleware.js on Vercel, the Vite plugin locally),
// which checks the reader's access token against the database; everyone else
// reads the preview at /reports/<ref>.html. null when there is no session, the
// reader is not a subscriber, or the file is missing — the caller then shows
// the preview. getSession() refreshes an expired token first.
export async function fetchFullReport(ref) {
  if (!ref) return null;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return null;
    const r = await fetch(`/reports-full/${encodeURIComponent(ref)}.html`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!r.ok || r.redirected) return null;
    const html = await r.text();
    // A real report shell only — never the app's own index page (the dev
    // server answers unknown paths with it) or a preview.
    return reportShell(html) && !isPreviewHtml(html) ? html : null;
  } catch { return null; }
}

// ── Admin ──────────────────────────────────────────────────────────────────
const throwing = ({ data, error }) => { if (error) throw error; return data; };
const one = (rows) => (Array.isArray(rows) ? rows[0] || null : rows || null);

export const adminListReports = () => supabase.rpc("admin_list_reports").then(throwing);
export const adminGetReport = (id) => supabase.rpc("admin_get_report", { p_id: id }).then(throwing).then(one);
export const adminUpsertReport = (report) => supabase.rpc("admin_upsert_report", { p: report }).then(throwing).then(one);
export const adminSetReportStatus = (id, status) => supabase.rpc("admin_set_report_status", { p_id: id, p_status: status }).then(throwing).then(one);
export const adminDeleteReport = (id) => supabase.rpc("admin_delete_report", { p_id: id }).then(throwing);

// A new ref in the baked pattern: ATK-YYYY-MMDD-XXX (three letters from the title).
export function makeReportRef(title = "", date = new Date()) {
  const y = date.getUTCFullYear(); const m = String(date.getUTCMonth() + 1).padStart(2, "0"); const d = String(date.getUTCDate()).padStart(2, "0");
  const words = String(title).toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(THE|AND|FOR|WITH|FROM|OVER|INTO|AFTER)$/.test(w));
  const code = (words.map((w) => w[0]).join("").slice(0, 3) || "RPT").padEnd(3, "X");
  return `ATK-${y}-${m}${d}-${code}`;
}

// Upload a hero picture for a report into the public incident-media bucket
// (admin insert policy). Returns the public URL.
export async function uploadReportHero(ref, file) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `reports/${ref}.${ext}`;
  const { error } = await supabase.storage.from("incident-media").upload(path, file, { upsert: true, contentType: file.type || "image/jpeg", cacheControl: "31536000" });
  if (error) throw error;
  const { data } = supabase.storage.from("incident-media").getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}
