// middleware.js — Vercel Routing Middleware: the subscriber gate in front of
// /reports-full/ (the full reports). Free readers and direct links get the
// preview at /reports/<ref>.html; the Hub fetches the full file with the
// reader's access token (src/lib/reports.js → fetchFullReport). The decision
// itself lives in src/lib/reportGate.js, shared with the Vite dev server so
// localhost behaves the same.
//
// The matcher is deliberately wider than /reports-full/: anything mentioning
// "report", any percent-encoded path and any dot-segment path runs through the
// gate, which canonicalises the path before deciding — so an encoded spelling
// of the folder is gated too. Every other request (the app, its assets) never
// invokes this.
import { FULL_PREFIX, PREVIEW_PREFIX, decide } from "./src/lib/reportGate.js";

export const config = {
  matcher: ["/(.*[rR][eE][pP][oO][rR][tT].*)", "/(.*%.*)", "/(.*\\.\\..*)"],
};

// Public values (they ship in the app bundle too); the env wins when set.
const OPTS = {
  supabaseUrl: process.env.VITE_SUPABASE_URL || "https://ovenyjguhkgiceddzwna.supabase.co",
  anonKey: process.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_23l5g7MVvgkKuUIctG-e9w_cWYnAtM5",
};

// The two helpers @vercel/functions exports, inline (no dependency).
const next = (headers = {}) => new Response(null, { headers: { ...headers, "x-middleware-next": "1" } });
const rewrite = (url, headers = {}) => new Response(null, { headers: { ...headers, "x-middleware-rewrite": String(url) } });

export default async function middleware(request) {
  const url = new URL(request.url);
  const d = await decide(url.pathname, request.headers.get("authorization"), OPTS);
  const noStore = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };
  switch (d.action) {
    case "pass": return next();
    case "serve": return d.exact ? next(noStore) : rewrite(new URL(FULL_PREFIX + d.file, url), noStore);
    case "deny": return new Response(JSON.stringify({ error: "subscribers_only" }), { status: 403, headers: { ...noStore, "content-type": "application/json" } });
    case "preview": return new Response(null, { status: 302, headers: { ...noStore, location: PREVIEW_PREFIX + d.file } });
    default: return new Response("Not found", { status: 404, headers: noStore });
  }
}
