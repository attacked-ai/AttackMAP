// ═══════════════════════════════════════════════════════════════════════════
// ATTACKED.AI — attack-map-feed (Supabase Edge Function)
// ---------------------------------------------------------------------------
// Implements the feed_gating_spec: GATE SERVER-SIDE, RENDER CLIENT-SIDE BLIND.
// The public tier receives a payload that NEVER CONTAINED the locked fields —
// not blurred, not hidden, absent. The partner tier authenticates with a key.
//
// Endpoints (single function, routed by method + query):
//   GET  ?list=1                       → sweep index (public)
//   GET  ?date=YYYY-MM-DD              → PUBLIC-gated sweep (+ server teasers)
//   GET  ?date=...  + x-partner-key    → full partner sweep
//   POST ?action=upload                → upsert sweep        (x-admin-key)
//        body: { date_key, payload }
//   POST ?action=teasers&date=...      → generate + store redacted teasers
//        via claude-fable-5            (x-admin-key, needs ANTHROPIC_API_KEY)
//   POST ?action=ai                    → AI proxy             (x-admin-key)
//   POST ?action=guard                 → GUARD control mapping (x-admin-key)
//
// Secrets required (supabase secrets set):
//   ADMIN_FEED_KEY     — every POST action
//   PARTNER_FEED_KEY   — partner-tier reads
//   ANTHROPIC_API_KEY  — all AI: teasers, ?action=ai proxy, ?action=guard
//   GUARD_DB_URL       — GUARD framework project URL (?action=guard)
//   GUARD_SERVICE_KEY  — GUARD framework service-role key (?action=guard)
//   GUARD_CONTROLS_TABLE — optional; pins the controls table name
//
// v2 (v11.1 hardening): ?action=ai (client AI proxy — key stays server-side,
// model claude-fable-5, token-capped) and ?action=guard (server-side canonical
// GUARD control mapping).
// v3 (2026-10-09 audit): ?action=ai and ?action=guard required no key, so
// anyone could run Anthropic calls on the project's bill (the Origin check is
// optional and any non-browser client can forge Origin). Every POST action now
// needs x-admin-key; key comparisons are constant-time. Nothing on the public
// website calls these actions.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";

const FABLE_MODEL = "claude-fable-5";
const TABLE = "attack_map_sweeps";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-admin-key, x-partner-key",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function db() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// Constant-time: compare SHA-256 digests byte by byte.
const enc = new TextEncoder();
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}
async function keyMatches(presented: string | null, expected: string | undefined): Promise<boolean> {
  return !!expected && !!presented && await safeEqual(presented, expected);
}

// ── Incident content hash — MUST match the artifact's teaserKeyFor (djb2,
//    headline|event_date|entity, base36) so client and server agree on keys.
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function incidentHash(inc: Record<string, unknown>): string {
  return hashStr(
    [inc.headline, inc.event_date, inc.entity]
      .map((v) => (v == null ? "" : String(v)))
      .join("|"),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC REDACTION — deny-by-default whitelist. Anything not named here does
// not exist in the public payload. Gated structures are replaced by COUNTS.
// ═══════════════════════════════════════════════════════════════════════════
const PUBLIC_INCIDENT_FIELDS = [
  "headline", "summary", "event_date", "severity", "confidence",
  "country", "latitude", "longitude", "entity", "sector", "sources",
  "_enriched", "_verified", "_verification_status",
  "_occurrences", "_firstSeen", "_lastSeen", "_sourceDate",
];

function redactIncident(
  inc: Record<string, any>,
  teasers: Record<string, any> | null,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of PUBLIC_INCIDENT_FIELDS) {
    if (inc[f] !== undefined) out[f] = inc[f];
  }

  // Blast radius — ring shape only: which channels, how many in each.
  if (inc.blast_radius && typeof inc.blast_radius === "object") {
    const rings: Record<string, { count: number }> = {};
    for (const [ring, entities] of Object.entries(inc.blast_radius)) {
      const n = Array.isArray(entities) ? entities.length : 0;
      if (n > 0) rings[ring] = { count: n };
    }
    out.blast_radius_shape = rings;
  }

  // Peer watchlist — count only.
  if (Array.isArray(inc.peer_watchlist)) {
    out.peer_watchlist_count = inc.peer_watchlist.length;
  }

  // Vendors — names only (the v6 public contract), no intel fields.
  if (Array.isArray(inc.vendors)) {
    out.vendors = inc.vendors
      .map((v: any) =>
        typeof v === "string" ? v : (v?.name || v?.vendor || v?.product || null)
      )
      .filter(Boolean)
      .map((name: string) => ({ name }));
  }

  // GUARD controls family — counts only.
  const ctl = (k: string) => (Array.isArray(inc[k]) ? inc[k].length : 0);
  const controlCounts = {
    objectives: ctl("adaptive_objectives"),
    master_controls: ctl("adaptive_master_controls"),
    adaptive_controls: ctl("adaptive_controls"),
    secondary_mappings: ctl("secondary_adaptive_mappings"),
    best_practices: ctl("best_practices"),
  };
  if (Object.values(controlCounts).some((n) => n > 0)) {
    out.control_counts = controlCounts;
  }

  // Server-generated redacted teasers, if present for this incident.
  const t = teasers?.[incidentHash(inc)];
  if (t) out._teasers = t;

  out._gated = true;
  return out;
}

function redactSweep(
  sweep: Record<string, any>,
  teasers: Record<string, any> | null,
): Record<string, any> {
  const results: Record<string, any> = {};
  for (const [cat, payload] of Object.entries(sweep.results || {})) {
    const incs = Array.isArray((payload as any)?.incidents)
      ? (payload as any).incidents
      : [];
    results[cat] = { incidents: incs.map((i: any) => redactIncident(i, teasers)) };
  }
  return {
    results,
    newsroom: sweep.newsroom,
    generated_at: sweep.generated_at,
    lookback_hours: sweep.lookback_hours,
    schema_version: sweep.schema_version,
    _tier: "public",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEASER GENERATION — claude-fable-5, server-side, same redaction rules and
// leak-scrub as the artifact's v7 engine. Runs against the FULL payload the
// public never sees; stores only the scrubbed sentences.
// ═══════════════════════════════════════════════════════════════════════════
const NAME_STOPWORDS = new Set([
  "group", "international", "holdings", "holding", "limited", "company",
  "corporation", "incorporated", "systems", "global", "technologies",
  "technology", "services", "solutions", "enterprises", "industries",
  "partners", "brands",
]);

function collectLocked(inc: Record<string, any>) {
  const forbidden = new Set<string>();
  const addName = (n: unknown) => {
    if (typeof n === "string" && n.trim().length >= 4) forbidden.add(n.trim());
  };
  const pw = Array.isArray(inc.peer_watchlist) ? inc.peer_watchlist : [];
  const cp = Array.isArray(inc.blast_radius?.competitive_peer)
    ? inc.blast_radius.competitive_peer
    : [];
  const peers = (pw.length ? pw : cp).slice(0, 8).map((p: any) => {
    if (typeof p === "string") { addName(p); return { name: p }; }
    addName(p.name || p.entity);
    return {
      name: p.name || p.entity || null,
      country: p.country || null,
      reason: p.exposure_reason || p.reason || p.impact_rationale || null,
    };
  });
  const blast: any[] = [];
  for (const [ring, entities] of Object.entries(inc.blast_radius || {})) {
    const arr = Array.isArray(entities) ? entities : [];
    if (!arr.length) continue;
    blast.push({
      ring: ring.replace(/_/g, " "),
      entities: arr.slice(0, 6).map((e: any) => {
        if (typeof e === "string") { addName(e); return { name: e }; }
        addName(e.name || e.entity);
        return { name: e.name || e.entity || null, type: e.type || null, country: e.country || null };
      }),
    });
  }
  const ctlName = (c: any) => c && (c.name || c.title || c.objective || c.control || c.statement) || null;
  const controls = ([] as any[])
    .concat((inc.adaptive_objectives || []).map(ctlName))
    .concat((inc.adaptive_master_controls || []).map(ctlName))
    .concat((inc.adaptive_controls || []).map(ctlName))
    .filter(Boolean)
    .slice(0, 12);
  addName(inc.entity);
  return {
    peers, blast, controls,
    forbidden: Array.from(forbidden),
    hasAny: peers.length > 0 || blast.length > 0 || controls.length > 0,
  };
}

function scrub(
  teasers: Record<string, unknown> | null,
  forbidden: string[],
): Record<string, string> | null {
  if (!teasers || typeof teasers !== "object") return null;
  const out: Record<string, string> = {};
  for (const [slot, val] of Object.entries(teasers)) {
    if (typeof val !== "string" || !val.trim()) continue;
    const low = val.toLowerCase();
    let leaked = false;
    for (const name of forbidden) {
      const full = name.toLowerCase();
      if (full.length >= 4 && low.includes(full)) { leaked = true; break; }
      for (const tok of full.split(/[^a-z0-9]+/)) {
        if (tok.length >= 5 && !NAME_STOPWORDS.has(tok) && low.includes(tok)) {
          leaked = true;
          break;
        }
      }
      if (leaked) break;
    }
    if (!leaked) out[slot] = val.trim();
  }
  return Object.keys(out).length ? out : null;
}

function extractJson(text: string | null): any {
  if (!text) return null;
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const s = clean.indexOf("{");
    const e = clean.lastIndexOf("}");
    if (s === -1 || e <= s) return null;
    return JSON.parse(clean.slice(s, e + 1));
  } catch {
    return null;
  }
}

async function callFable(prompt: string, maxTokens: number): Promise<string | null> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: FABLE_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.content || [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim() || null;
  } catch {
    return null;
  }
}

function teaserPrompt(inc: Record<string, any>, locked: ReturnType<typeof collectLocked>): string {
  const want: string[] = [];
  if (locked.peers.length) want.push("peers");
  if (locked.blast.length) want.push("blast");
  if (locked.controls.length) want.push("controls");
  return [
    "You write redacted intelligence teasers for Attacked.ai, an enterprise risk product. Below is LOCKED premium content for one incident. Write one teaser sentence per requested section.",
    "",
    "ABSOLUTE RULES:",
    '- NEVER include any company, organisation, product, or person name from the data. Describe entities ONLY by sector, geography, and listing/size tier — e.g. "a US-listed semiconductor manufacturer", "two European logistics providers", "a FTSE-100 retailer".',
    "- One sentence per section, maximum 26 words. Declarative, present tense, in the register of The Economist. Specific enough to alarm; redacted enough to require unlock.",
    "- peers = who else shares this exposure and why. blast = who sits inside the cascade and through which channels. controls = which GUARD response domains the locked mapping spans.",
    "- No marketing language. Never use the words premium, subscribe, unlock, exclusive, or any call to action.",
    `- Respond with ONLY a JSON object, no preamble, no markdown fences, with exactly these keys: ${JSON.stringify(want)}.`,
    "",
    `INCIDENT: ${inc.headline || "—"} (${inc.sector || "unknown sector"}, ${inc.country || "unknown country"}, severity ${inc.severity || "?"}/5)`,
    `LOCKED DATA: ${JSON.stringify({ peers: locked.peers, blast_radius: locked.blast, guard_controls: locked.controls })}`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARD CONTROL QUERY (v2) — canonical mapping, fully server-side
// ═══════════════════════════════════════════════════════════════════════════
async function queryGuardControls(body: Record<string, any>) {
  const gUrl = Deno.env.get("GUARD_DB_URL");
  const gKey = Deno.env.get("GUARD_SERVICE_KEY");
  if (!gUrl || !gKey) return { error: "GUARD_DB_URL / GUARD_SERVICE_KEY secrets not set" };
  const g = createClient(gUrl, gKey);

  // Schema-tolerant: use the pinned table if provided, else probe likely
  // names. Once the real name is confirmed, set GUARD_CONTROLS_TABLE.
  const pinned = Deno.env.get("GUARD_CONTROLS_TABLE");
  const candidates = pinned
    ? [pinned]
    : ["controls", "guard_controls", "master_controls", "adaptive_controls", "controls_master", "control"];
  let rows: any[] | null = null;
  let tableUsed = "";
  for (const t of candidates) {
    const { data, error } = await g.from(t).select("*").limit(450);
    if (!error && Array.isArray(data) && data.length) { rows = data; tableUsed = t; break; }
  }
  if (!rows) return { error: "controls table not found — set GUARD_CONTROLS_TABLE" };

  // Compact rows for the prompt: short scalar fields only.
  const compact = rows.slice(0, 450).map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if ((typeof v === "string" && v.length <= 200) || typeof v === "number") o[k] = v;
    }
    return o;
  });

  const prompt = [
    "You are the control-mapping layer for Attacked.ai. Below are rows from the CANONICAL GUARD v7 controls table and one incident. Select the 5-8 controls most relevant to the incident — judge relevance from headline, sector and summary, preferring controls whose objective addresses the incident's failure mode.",
    "",
    "Respond with ONLY this JSON object, no preamble, no markdown fences:",
    '{"category": "the GUARD category these controls belong to", "controls": [{"id": "control id", "name": "control name", "objective": "parent objective if present", "sub_category": "sub-category if present"}], "note": "one line on selection, max 18 words"}',
    "Use the rows’ own field values — do not invent controls that are not in the rows.",
    "",
    `INCIDENT: ${body.headline || "—"} · category ${body.category_code || "?"} (${body.category_label || "?"}) · sector ${body.sector || "—"} · ${body.country || "—"} · severity ${body.severity || "?"}/5`,
    `SUMMARY: ${String(body.summary || "").slice(0, 600)}`,
    `CONTROL ROWS (table "${tableUsed}"): ${JSON.stringify(compact)}`,
  ].join("\n");

  const parsed = extractJson(await callFable(prompt, 1500));
  if (parsed && Array.isArray(parsed.controls) && parsed.controls.length) {
    return { ...parsed, _table: tableUsed };
  }
  return { error: "selection failed" };
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const url = new URL(req.url);
  const supa = db();

  // ── GET: index or gated sweep ─────────────────────────────────────────────
  if (req.method === "GET") {
    if (url.searchParams.get("list") === "1") {
      const { data, error } = await supa
        .from(TABLE)
        .select("date_key, incident_count, updated_at")
        .order("date_key", { ascending: false });
      if (error) return json({ error: "read failed" }, 500);
      return json({ sweeps: data });
    }

    const date = url.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ error: "date=YYYY-MM-DD required" }, 400);
    }
    const { data, error } = await supa
      .from(TABLE)
      .select("payload, teasers")
      .eq("date_key", date)
      .maybeSingle();
    if (error) return json({ error: "read failed" }, 500);
    if (!data) return json({ error: "no sweep for that date" }, 404);

    const isPartner = await keyMatches(req.headers.get("x-partner-key"), Deno.env.get("PARTNER_FEED_KEY"));

    if (isPartner) {
      return json({ ...data.payload, _tier: "partner" });
    }
    return json(redactSweep(data.payload, data.teasers));
  }

  // ── POST: every action needs the admin key ────────────────────────────────
  if (req.method === "POST") {
    if (!await keyMatches(req.headers.get("x-admin-key"), Deno.env.get("ADMIN_FEED_KEY"))) {
      return json({ error: "unauthorised" }, 401);
    }
    const action = url.searchParams.get("action");

    if (action === "ai" || action === "guard") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

      if (action === "ai") {
        const prompt = String(body?.prompt || "");
        if (!prompt || prompt.length > 12000) {
          return json({ error: "prompt missing or too long" }, 400);
        }
        const maxTokens = Math.min(1200, Math.max(64, Number(body?.max_tokens) || 800));
        const text = await callFable(prompt, maxTokens);
        if (!text) return json({ error: "generation failed — is ANTHROPIC_API_KEY set?" }, 502);
        return json({ text });
      }
      // action === "guard"
      const result = await queryGuardControls(body || {});
      return json(result, result && (result as any).error ? 502 : 200);
    }

    if (action === "upload") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const { date_key, payload } = body || {};
      if (!date_key || !/^\d{4}-\d{2}-\d{2}$/.test(date_key) || !payload?.results) {
        return json({ error: "body must be { date_key: YYYY-MM-DD, payload: <sweep> }" }, 400);
      }
      let count = 0;
      for (const cat of Object.values(payload.results) as any[]) {
        count += Array.isArray(cat?.incidents) ? cat.incidents.length : 0;
      }
      const { error } = await supa.from(TABLE).upsert({
        date_key,
        payload,
        incident_count: count,
        updated_at: new Date().toISOString(),
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, date_key, incident_count: count });
    }

    if (action === "teasers") {
      if (!Deno.env.get("ANTHROPIC_API_KEY")) {
        return json({ error: "ANTHROPIC_API_KEY secret not set" }, 400);
      }
      const date = url.searchParams.get("date");
      if (!date) return json({ error: "date required" }, 400);
      const { data, error } = await supa
        .from(TABLE)
        .select("payload, teasers")
        .eq("date_key", date)
        .maybeSingle();
      if (error || !data) return json({ error: error?.message || "not found" }, 404);

      const teasers: Record<string, any> = data.teasers || {};
      let generated = 0, skipped = 0, failed = 0;
      const MAX_PER_INVOCATION = 25; // edge function wall-clock budget

      outer:
      for (const cat of Object.values(data.payload.results || {}) as any[]) {
        for (const inc of (cat?.incidents || [])) {
          if (generated >= MAX_PER_INVOCATION) break outer;
          const h = incidentHash(inc);
          if (teasers[h]) { skipped++; continue; }
          const locked = collectLocked(inc);
          if (!locked.hasAny) { skipped++; continue; }
          const parsed = scrub(
            extractJson(await callFable(teaserPrompt(inc, locked), 600)),
            locked.forbidden,
          );
          if (parsed) { teasers[h] = parsed; generated++; }
          else failed++;
        }
      }
      const { error: werr } = await supa
        .from(TABLE)
        .update({ teasers, updated_at: new Date().toISOString() })
        .eq("date_key", date);
      if (werr) return json({ error: werr.message }, 500);
      return json({
        ok: true, date, generated, skipped, failed,
        complete: generated < MAX_PER_INVOCATION,
        note: generated >= MAX_PER_INVOCATION
          ? "invocation budget hit — call again to continue"
          : "all gated incidents covered",
      });
    }

    return json({ error: "unknown action" }, 400);
  }

  return json({ error: "method not allowed" }, 405);
});
