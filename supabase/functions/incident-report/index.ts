// incident-report — backend of the Daily Incident Brief dashboard (dashboard.html,
// live at attacked-daily-brief.vercel.app). The dashboard calls it from the
// browser: GET ?sweep_id=<id> (or none for the latest) with the public anon key.
//
// Returns { report, sweeps }:
//   report  fn_sweep_report(p_sweep_id): KPIs, categories, major incidents, the
//           full incident log, updates to earlier incidents, the 14-day trend
//   sweeps  the last 30 runs for the sweep picker
//
// Source was only on Supabase until 2026-09-30 (v12, kept verbatim in
// ./deployed.index.ts). Ported that day for Cloud Run:
//   • callers: the anon key, x-internal-token or the service-role key; anything
//     else 401 (_shared/auth.ts). CORS stays, since a browser calls this one.
//   • the answer is cut down to the fields dashboard.html renders (PICK below).
//     fn_sweep_report runs as service_role and carries more (ids, verdicts,
//     source titles); none of it is personal data today, and the whitelist keeps
//     it that way if the RPC grows. Add a field here when the dashboard needs it.
//   • errors no longer echo PostgREST's message (schema details) to the browser.
//   • listens on env PORT when set (Cloud Run), else Deno's default 8000.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireAnonOrInternal } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function rpc(fn: string, body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function recentSweeps() {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/v_sweep_summary?select=sweep_id,sweep_date,total_incidents&order=generated_at.desc&limit=30`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!r.ok) throw new Error(`sweeps ${r.status}: ${await r.text()}`);
  return await r.json();
}

// ── What the dashboard reads (dashboard.html render / updatesSection / taxBlock) ──
const PICK = {
  report: ["sweep_id", "sweep_date", "lookback_hours", "exec_line"],
  totals: ["total", "major", "critical", "avg_severity", "categories", "countries", "updates"],
  delta: ["total_change", "major_change"],
  category: ["label", "incidents", "major"],
  major: ["severity", "headline", "category", "entity", "country", "sector", "threat_actor"],
  incident: ["severity", "headline", "entity", "country", "sector", "threat_actor", "confidence",
    "category", "subcategory", "subcategory_code", "summary"],
  secondary: ["category", "subcategory_code", "subcategory_name", "why"],
  update: ["development_type", "severity_before", "severity_after", "confirmed", "headline", "what_changed",
    "update_date", "entity", "first_sweep_id", "first_sweep_date", "incident_headline"],
  source: ["url", "publisher"],
  trend: ["day", "total", "major"],
  sweep: ["sweep_id", "sweep_date", "total_incidents"],
};
function pick(o: any, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o && typeof o === "object") for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
const each = (a: unknown, f: (x: any) => unknown) => (Array.isArray(a) ? a.map(f) : []);

function forDashboard(rep: any) {
  return {
    ...pick(rep, PICK.report),
    totals: pick(rep?.totals, PICK.totals),
    delta: pick(rep?.delta, PICK.delta),
    categories: each(rep?.categories, (c) => pick(c, PICK.category)),
    major_incidents: each(rep?.major_incidents, (m) => pick(m, PICK.major)),
    incidents: each(rep?.incidents, (m) => ({ ...pick(m, PICK.incident), secondary: each(m?.secondary, (s) => pick(s, PICK.secondary)) })),
    updates: each(rep?.updates, (u) => ({ ...pick(u, PICK.update), sources: each(u?.sources, (s) => pick(s, PICK.source)) })),
    trend_14d: each(rep?.trend_14d, (p) => pick(p, PICK.trend)),
  };
}

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const denied = await requireAnonOrInternal(req, cors);
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    const sweepParam = url.searchParams.get("sweep_id");
    if (sweepParam && !/^\d+$/.test(sweepParam)) return json({ error: "sweep_id must be a number" }, 400);
    const sweep_id = sweepParam ? Number(sweepParam) : null;
    const [report, sweeps] = await Promise.all([
      rpc("fn_sweep_report", { p_sweep_id: sweep_id }),
      recentSweeps(),
    ]);
    return json({ report: forDashboard(report), sweeps: each(sweeps, (s) => pick(s, PICK.sweep)) });
  } catch (e) {
    console.error("[incident-report]", String(e));
    return json({ error: "report unavailable" }, 500);
  }
});
