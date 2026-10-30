// reportsDb.js — the published briefings that live in the incident reporting
// database, through the site's own /api/report (api/report.mjs). The server
// renders the page and applies the subscriber lock; the browser only ever
// receives what the reader may see.
import { supabase } from "./supabaseClient";
import { reportShell } from "./reportPreview";

// Every published report's card data, newest first (shaped like the CMS rows
// of hub_reports_public). [] when the API is off or unreachable.
export async function listDbReports() {
  try {
    const r = await fetch("/api/report?list=1");
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j && j.reports) ? j.reports : [];
  } catch { return []; }
}

// The page for one report: the full briefing for a subscriber (the reader's
// access token goes along and the server checks it), the free preview for
// everyone else. null when the ref is not a database report (404) or the API
// is off, so the caller falls through to the baked files.
export async function fetchDbReportHtml(ref) {
  if (!ref) return null;
  try {
    let token = null;
    try { const { data } = await supabase.auth.getSession(); token = data?.session?.access_token || null; } catch { /* signed out */ }
    const r = await fetch(`/api/report?ref=${encodeURIComponent(ref)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" });
    if (!r.ok) return null;
    const html = await r.text();
    return reportShell(html) ? html : null;   // a real report shell, never the app's index page
  } catch { return null; }
}

// "Loose Harness, Tight Optics: …" → "loose harness tight optics", to pair a
// database report with the Hub incident that carries the same headline.
export const normTitle = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
