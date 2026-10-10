// DEPLOYED COPY, for reference only: never built or deployed from here.
// Supabase project ovenyjguhkgiceddzwna, function incident-report v12
// (verify_jwt = true, deployed 2026-06-03), fetched 2026-09-30. Below this
// header the file is exactly what runs today; the repo had no copy of it.
// The ported version is ./index.ts.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

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
    `${SUPABASE_URL}/rest/v1/v_sweep_summary?select=sweep_id,generated_at,sweep_date,total_incidents,major_incidents&order=generated_at.desc&limit=30`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!r.ok) throw new Error(`sweeps ${r.status}: ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const sweepParam = url.searchParams.get("sweep_id");
    const sweep_id = sweepParam ? Number(sweepParam) : null;
    const [report, sweeps] = await Promise.all([
      rpc("fn_sweep_report", { p_sweep_id: sweep_id }),
      recentSweeps(),
    ]);
    return new Response(JSON.stringify({ report, sweeps }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
