// incident-images — Supabase Edge Function
//
// Gives every incident ONE stored picture, so the map, the dashboard, the Hub,
// the landing page and the emails all read `incidents.image_url` instead of
// each inventing a picture in the browser at render time (2026-09-23).
//
// For each incident without an image:
//   1. build an editorial prompt from the record — headline, entity, industry,
//      GUARD category (→ a scene), location, first sentence of the summary
//   2. generate a 16:9 picture (pollinations.ai, seeded by the incident id so
//      a re-run gives the same picture)
//   3. crop the generator's watermark strip off the bottom, re-encode as JPEG
//   4. upload incidents/<id>.jpg: Supabase Storage bucket incident-media
//      (public), or on Google Cloud the Cloud Storage bucket GCS_BUCKET_MEDIA
//   5. write image_url / image_source / image_credit / image_prompt /
//      image_updated_at on the row (service role, through the public view)
//
// Columns come from migration 20260923_incident_images.sql (applied). An admin
// can still override a picture with admin_set_incident_media (image_source
// 'manual'); this function never touches rows that already have a picture.
//
// CALLS
//   POST {}                         → next 12 incidents without a picture
//   POST { "limit": 20 }            → up to 20 (hard cap MAX_LIMIT)
//   POST { "mod": 4, "rem": 1 }     → only ids with id % 4 = 1 — lets the
//                                     backfill run several workers in parallel
//                                     without two of them doing the same row
//   POST { "dryRun": true }         → prompts only, nothing generated/written
// Meant to run every 10 minutes (pg_cron, commented out in the migration; Cloud
// Scheduler on Google Cloud) so a new sweep is illustrated within the hour.
// Bounded by TIME_BUDGET_MS per call. Callers must be internal: x-internal-token
// or the service-role key (_shared/auth.ts).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (both present on Supabase).
// Google Cloud: GCS_BUCKET_MEDIA (+ optional PUBLIC_MEDIA_BASE), see upload().
// Listens on env PORT when set (Cloud Run), else Deno's default 8000.

import { Image } from "https://deno.land/x/imagescript@1.2.15/mod.ts";
import { requireInternal } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://ovenyjguhkgiceddzwna.supabase.co";
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const BUCKET = "incident-media";
const FOLDER = "incidents";
const GENERATOR = "https://image.pollinations.ai/prompt/";
// The free generator renders a SQUARE and stretches it to any other aspect (a
// circle asked for at 16:9 comes back as an ellipse), so we ask for a square
// (answered 768×768 anonymously) and cut the 3:2 picture out of its middle.
// That crop also removes the watermark, which sits in the bottom strip.
const GEN_WIDTH = 1024, GEN_HEIGHT = 1024;
const OUT_ASPECT = 3 / 2;
const JPEG_QUALITY = 86;
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 8;
const CONCURRENCY = 1;                      // the generator 429s parallel requests
const TIME_BUDGET_MS = 110_000;             // edge functions stop at ~150 s
const GEN_TIMEOUT_MS = 70_000;
const CREDIT = "Illustration generated from the incident record";

// A scene per GUARD category, so the picture shows the KIND of event and not
// a generic skyline. Kept concrete and photographable.
const CATEGORY_SCENE: Record<string, string> = {
  CYB: "a darkened security operations centre, rows of monitors showing network maps and red alert dashboards, blue and amber light",
  DAT: "a data centre corridor of server racks and storage arrays, cold blue light, a technician's silhouette at the far end",
  TEC: "a control room with engineers at consoles, large wall screens showing system status, shallow depth of field",
  GEO: "an aerial view of the facility and the terrain around it, security barriers and vehicles at the perimeter",
  PHY: "the industrial site from ground level, emergency vehicles and cordon tape, smoke in the distance, overcast sky",
  OPS: "the plant floor or logistics yard mid-operation, heavy machinery, workers in high-visibility gear seen from behind",
  TPR: "a supplier's loading dock with stacked shipping containers and pallets, a clipboard of documents in the foreground",
  REG: "the stone facade of a government regulatory building, press microphones and cameras waiting at the entrance",
  FIN: "a financial district skyline at dusk with trading screens reflected in the glass of a tower lobby",
  STR: "an executive boardroom with a long table, a wall screen of strategy charts and a city view",
  REP: "a crowd of press photographers and television cameras outside a corporate headquarters entrance",
  PPL: "the entrance of an office or plant with workers gathering, banners and hard hats, early morning light",
  ENV: "the landscape around the site with a visible plume or spill and environmental response crews at a distance",
};

function firstSentence(s: unknown): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/^(.{40,260}?[.!?])(\s|$)/);
  return (m ? m[1] : t.slice(0, 220)).trim();
}

export function buildPrompt(i: any): string {
  const scene = CATEGORY_SCENE[i.primary_category] || "the site of the incident seen from outside, documentary framing";
  const place = [i.location_name, i.country].filter(Boolean).join(", ");
  const ctx = firstSentence(i.summary);
  return [
    `Editorial news photograph. ${String(i.headline || "").trim().replace(/\.$/, "")}.`,
    i.entity ? `Subject: ${i.entity}${i.industry ? ` (${i.industry})` : ""}.` : (i.industry ? `Industry: ${i.industry}.` : ""),
    place ? `Location: ${place}.` : "",
    ctx ? `Context: ${ctx}` : "",
    `Scene: ${scene}.`,
    "Photorealistic press photography, natural light, 35mm lens, cinematic composition, high detail, muted colour grade.",
    "No text, no captions, no watermark, no logos, no readable signage, no recognisable faces.",
  ].filter(Boolean).join(" ");
}

function generatorUrl(prompt: string, seed: number): string {
  return `${GENERATOR}${encodeURIComponent(prompt)}?width=${GEN_WIDTH}&height=${GEN_HEIGHT}&model=flux&nologo=true&seed=${seed}`;
}

const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function pg(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, "Content-Type": "application/json", ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`PostgREST ${r.status}: ${await r.text()}`);
  return r;
}

async function pending(limit: number, mod: number, rem: number): Promise<any[]> {
  const fetchN = mod > 1 ? limit * mod * 2 : limit;
  const r = await pg(`incidents?select=id,headline,summary,entity,industry,primary_category,location_name,country&image_url=is.null&headline=not.is.null&order=incident_day.desc.nullslast,id.desc&limit=${fetchN}`);
  const rows: any[] = await r.json();
  return (mod > 1 ? rows.filter((x) => Number(x.id) % mod === rem) : rows).slice(0, limit);
}

async function remainingCount(): Promise<number | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/incidents?select=id&image_url=is.null&headline=not.is.null`, { method: "HEAD", headers: { ...H, Prefer: "count=exact" } });
    const cr = r.headers.get("content-range") || "";
    const n = Number(cr.split("/")[1]);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// The generator rate-limits anonymous callers (429 on concurrent requests), so
// images are made one at a time (CONCURRENCY = 1) with a pause between them,
// and a 429 waits and retries rather than failing the incident.
const GEN_GAP_MS = 2500, GEN_RETRIES = 3, GEN_BACKOFF_MS = 9000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function generate(prompt: string, seed: number): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), GEN_TIMEOUT_MS);
    try {
      const r = await fetch(generatorUrl(prompt, seed), { signal: ctl.signal, headers: { Accept: "image/jpeg,image/*" } });
      if (r.status === 429 || r.status >= 500) {
        if (attempt >= GEN_RETRIES) throw new Error(`generator ${r.status} after ${attempt + 1} tries`);
        await sleep(GEN_BACKOFF_MS * (attempt + 1)); continue;
      }
      if (!r.ok) throw new Error(`generator ${r.status}`);
      const ct = r.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) throw new Error(`generator returned ${ct || "no content-type"}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length < 5000) throw new Error(`generator returned ${bytes.length} bytes`);
      await sleep(GEN_GAP_MS);
      return bytes;
    } finally { clearTimeout(t); }
  }
}

// Centre-crop to OUT_ASPECT (never keeping the bottom 8 %, where the watermark
// is), re-encode. Falls back to the original bytes if the decoder cannot read
// the file (a picture with a small mark beats no picture).
async function cropAndEncode(bytes: Uint8Array): Promise<{ jpeg: Uint8Array; width: number; height: number; cropped: boolean }> {
  try {
    const img = await Image.decode(bytes);
    const W = img.width, H = img.height;
    let w = W, h = Math.round(W / OUT_ASPECT);
    if (h > H * 0.92) { h = Math.round(H * 0.92); w = Math.round(h * OUT_ASPECT); }
    const x = Math.round((W - w) / 2);
    const y = Math.max(0, Math.min(Math.round((H - h) / 2), H - h - Math.round(H * 0.08)));
    const out = img.crop(x, y, w, h);
    const jpeg = await out.encodeJPEG(JPEG_QUALITY);
    return { jpeg, width: out.width, height: out.height, cropped: true };
  } catch (err) {
    console.warn("[incident-images] crop failed, storing original:", (err as Error)?.message);
    return { jpeg: bytes, width: 0, height: 0, cropped: false };
  }
}

// Google Cloud: with GCS_BUCKET_MEDIA set the picture goes to Cloud Storage
// instead (JSON API media upload), as the Cloud Run service account: its token
// comes from the metadata server. The account needs roles/storage.objectUser on
// the bucket (a redone picture overwrites <id>.jpg, which objectCreator cannot).
// The bucket is publicly readable, so the stored URL is
// <PUBLIC_MEDIA_BASE>/<bucket>/<path> (default https://storage.googleapis.com),
// the same shape the API's uploads and the data service's old-link redirect use.
const GCS_BUCKET = (Deno.env.get("GCS_BUCKET_MEDIA") ?? "").trim();
const MEDIA_BASE = (Deno.env.get("PUBLIC_MEDIA_BASE") ?? "").trim().replace(/\/+$/, "") || "https://storage.googleapis.com";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
let gcsToken: { value: string; until: number } | null = null;

async function metadataToken(): Promise<string> {
  if (gcsToken && gcsToken.until > Date.now() + 60_000) return gcsToken.value;
  const r = await fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error(`metadata token ${r.status}`);
  const j = await r.json();
  gcsToken = { value: String(j.access_token), until: Date.now() + (Number(j.expires_in) || 300) * 1000 };
  return gcsToken.value;
}

async function uploadGcs(path: string, jpeg: Uint8Array): Promise<string> {
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(GCS_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await metadataToken()}`, "Content-Type": "image/jpeg" },
    body: jpeg,
  });
  if (!r.ok) throw new Error(`gcs ${r.status}: ${(await r.text()).slice(0, 300)}`);
  // ?v= as on Supabase: a redone picture keeps its name, so the query busts caches.
  return `${MEDIA_BASE}/${GCS_BUCKET}/${path}?v=${Date.now()}`;
}

async function upload(id: number, jpeg: Uint8Array): Promise<string> {
  const path = `${FOLDER}/${id}.jpg`;
  if (GCS_BUCKET) return await uploadGcs(path, jpeg);
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...H, "Content-Type": "image/jpeg", "x-upsert": "true", "Cache-Control": "public, max-age=31536000" },
    body: jpeg,
  });
  if (!r.ok) throw new Error(`storage ${r.status}: ${await r.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}?v=${Date.now()}`;
}

async function record(id: number, url: string, prompt: string) {
  await pg(`incidents?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ image_url: url, image_source: "generated", image_credit: CREDIT, image_prompt: prompt, image_updated_at: new Date().toISOString() }),
  });
}

async function illustrate(i: any) {
  const id = Number(i.id);
  const prompt = buildPrompt(i);
  const raw = await generate(prompt, id);
  const { jpeg, width, height, cropped } = await cropAndEncode(raw);
  const url = await upload(id, jpeg);
  await record(id, url, prompt);
  return { id, url, bytes: jpeg.length, width, height, cropped };
}

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (req) => {
  const denied = await requireInternal(req);
  if (denied) return denied;
  if (!SERVICE_KEY) return new Response(JSON.stringify({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY missing" }), { status: 500, headers: { "Content-Type": "application/json" } });
  let body: any = {};
  try { if (req.method === "POST") body = await req.json().catch(() => ({})); } catch { /* noop */ }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(body?.limit) || DEFAULT_LIMIT));
  const mod = Math.max(1, Math.min(16, Number(body?.mod) || 1));
  const rem = Math.max(0, Math.min(mod - 1, Number(body?.rem) || 0));
  const dryRun = body?.dryRun === true;
  const started = Date.now();

  let rows: any[];
  try { rows = await pending(limit, mod, rem); }
  catch (err) { return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } }); }

  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, dryRun: true, candidates: rows.map((i) => ({ id: i.id, headline: i.headline, prompt: buildPrompt(i), url: generatorUrl(buildPrompt(i), Number(i.id)) })) }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  const done: any[] = [], failed: any[] = [];
  for (let k = 0; k < rows.length; k += CONCURRENCY) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const chunk = rows.slice(k, k + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(illustrate));
    results.forEach((res, j) => {
      if (res.status === "fulfilled") done.push(res.value);
      else failed.push({ id: chunk[j].id, error: String(res.reason?.message || res.reason) });
    });
  }
  const remaining = await remainingCount();
  return new Response(JSON.stringify({ ok: true, processed: done.length, failed: failed.length, remaining, ms: Date.now() - started, done, errors: failed }), { headers: { "Content-Type": "application/json" } });
});
