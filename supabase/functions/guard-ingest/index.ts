// guard-ingest — secure write gateway for the GUARD Full-Schema Uploader.
//
// WHY THIS EXISTS: RLS is enabled on the GUARD data tables (sweeps, incidents,
// blast_radius, …) with READ-only policies for the anon key. That (correctly)
// stops the browser uploader from writing directly. This function accepts the
// per-table row batches the uploader builds and inserts them using the SERVICE
// ROLE key (which bypasses RLS) — so the DB stays locked down to the public,
// but the uploader still works.
//
// AUTH: custom shared-secret in the `x-ingest-token` header (verify_jwt=false).
// The token lives only in the LOCAL uploader.html on the operator's machine —
// it is never shipped to the public website.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shared secret, read from the function's secrets (Supabase dashboard → Edge
// Functions → Secrets → INGEST_TOKEN). Must match INGEST_TOKEN in uploader.html.
// Until 2026-10-09 it was written here in the source, which is in a public git
// repository, so that old value is burnt: set a NEW one. Unset = every call refused.
const INGEST_TOKEN = (Deno.env.get("INGEST_TOKEN") ?? "").trim();
const MAX_ROWS = 5000;

// Constant-time: compare SHA-256 digests byte by byte.
const enc = new TextEncoder();
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

// Only these tables may be written through the gateway (blast-radius limiter).
const ALLOWED = new Set([
  "sweeps", "reporters", "category_results", "excluded_watchlist", "incidents",
  "secondary_mappings", "sources", "adaptive_objectives", "adaptive_master_controls",
  "secondary_adaptive_mappings", "vendors", "best_practices", "blast_radius",
  "peer_watchlist", "historical_analogues",
]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  if (!INGEST_TOKEN) return json({ error: "ingest is not configured" }, 503);
  const presented = (req.headers.get("x-ingest-token") ?? "").trim();
  if (!presented || !await safeEqual(presented, INGEST_TOKEN))
    return json({ error: "unauthorized" }, 401);

  let payload: { table?: string; rows?: unknown[] };
  try { payload = await req.json(); }
  catch { return json({ error: "invalid JSON body" }, 400); }

  const { table, rows } = payload;
  if (!table || !ALLOWED.has(table)) return json({ error: "table not allowed: " + table }, 400);
  if (!Array.isArray(rows)) return json({ error: "rows must be an array" }, 400);
  if (rows.length === 0) return json({ data: [] }); // no-op (mirrors uploader's empty-skip)
  if (rows.length > MAX_ROWS) return json({ error: `at most ${MAX_ROWS} rows per call` }, 413);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await supabase.from(table).insert(rows).select();
  if (error) return json({ error: error.message, code: error.code, details: error.details, hint: error.hint }, 400);
  return json({ data });
});
