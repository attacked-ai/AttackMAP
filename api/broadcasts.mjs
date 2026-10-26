// api/broadcasts.mjs — the published broadcast episodes of one briefing, for
// a copy of the report that has no host page to hand them over (a reader who
// opens /reports/<ref>.html directly, the print build, a partner embed).
// A Vercel Node function; the Vite dev server mounts the same handler at
// /api/broadcasts (vite.config.js), so localhost behaves alike.
//
//   GET /api/broadcasts?ref=ATK-2026-0908-NATS
//   200 { ref, episodes: [...public columns...], broadcast: <card shape> | null }
//   400 bad ref
//
// Reads public.report_broadcasts with the anon key (the table is anon-readable
// by design, like the rest of the hub data). A database without the table
// answers an empty list, never an error: the report then keeps its baked line.
// Cached for a minute at the edge: an episode published in the admin console
// reaches every copy within that.
import { frameBroadcast, publicEpisode, sortEpisodes } from "../src/lib/broadcastShape.js";

const OPTS = {
  supabaseUrl: process.env.VITE_SUPABASE_URL || "https://ovenyjguhkgiceddzwna.supabase.co",
  anonKey: process.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_23l5g7MVvgkKuUIctG-e9w_cWYnAtM5",
};
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;

function send(res, status, body, cache = "private, no-store") {
  res.statusCode = status;
  res.setHeader("cache-control", cache);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export async function episodesFor(ref, opts = OPTS) {
  const url = `${opts.supabaseUrl.replace(/\/$/, "")}/rest/v1/report_broadcasts?report_ref=eq.${encodeURIComponent(ref)}&published=eq.true&order=published_at.desc&limit=5&select=*`;
  const r = await fetch(url, { headers: { apikey: opts.anonKey, Authorization: `Bearer ${opts.anonKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) return [];
  const rows = await r.json();
  return sortEpisodes(Array.isArray(rows) ? rows : []);
}

// opts: the Vite dev server passes its own env (process.env carries no VITE_ vars there).
export default async function handler(req, res, opts = OPTS) {
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (req.method !== "GET") return send(res, 405, { error: "get_only" });
  let ref = "";
  try { ref = (new URL(req.url || "/", "http://local").searchParams.get("ref") || "").trim(); } catch { /* bad url */ }
  if (!REF.test(ref)) return send(res, 400, { error: "bad_ref" });
  let eps = [];
  try { eps = await episodesFor(ref, opts && opts.supabaseUrl ? opts : OPTS); } catch { eps = []; }
  return send(res, 200, { ref, episodes: eps.map(publicEpisode), broadcast: frameBroadcast(eps) },
    "public, max-age=30, s-maxage=60, stale-while-revalidate=300");
}
