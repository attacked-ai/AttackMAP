// reportGate.js — the server-side check in front of the full reports.
//
// /reports-full/<ref>.html is the whole briefing; /reports/<ref>.html is the
// free preview (scripts/build-report-previews.mjs). A full file is served only
// to a request that carries the reader's Supabase access token
// (Authorization: Bearer …) and whose profile is a subscriber — decided by
// the database itself (rpc is_subscriber, which reads auth.uid() from the
// verified token), so nothing here trusts the browser's idea of the tier.
//
// Used by middleware.js on Vercel and by the Vite dev server (vite.config.js),
// so localhost behaves exactly like the live site. No Node-only or
// browser-only APIs.

export const FULL_PREFIX = "/reports-full/";
export const PREVIEW_PREFIX = "/reports/";
const REPORT_FILE = /^ATK-[A-Za-z0-9-]+\.html$/;

// The path a static file server would end up at: percent-decoding applied
// until stable, backslashes and repeated slashes folded, dot segments
// resolved. Checking this form (not the raw one) means /reports%2Dfull/…,
// /x/../reports-full/… and friends are gated like the plain path.
export function canonicalPath(raw) {
  let p = String(raw || "/").split(/[?#]/)[0];
  for (let i = 0; i < 4; i++) {
    let d; try { d = decodeURIComponent(p); } catch { break; }
    if (d === p) break;
    p = d;
  }
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  try { p = decodeURIComponent(new URL(p, "http://gate.invalid").pathname); } catch { /* keep p */ }
  return p;
}

// What to do with a request:
//   { action: "pass" }                 not the gated folder — carry on
//   { action: "404" }                  gated folder, but not a report file
//   { action: "serve", file, exact }   subscriber — serve /reports-full/<file>
//   { action: "deny", file }           a token that is not a subscriber's
//   { action: "preview", file }        no token — send to /reports/<file>
export async function decide(rawPath, authHeader, opts) {
  const p = canonicalPath(rawPath);
  if (!p.toLowerCase().startsWith(FULL_PREFIX)) return { action: "pass" };
  const file = p.slice(FULL_PREFIX.length);
  if (!REPORT_FILE.test(file)) return { action: "404" };
  const token = bearerToken(authHeader);
  if (!token) return { action: "preview", file };
  if (await isSubscriberToken(token, opts)) return { action: "serve", file, exact: String(rawPath || "").split(/[?#]/)[0] === FULL_PREFIX + file };
  return { action: "deny", file };
}

export function bearerToken(header) {
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*$/.exec(String(header || ""));
  return m ? m[1] : null;
}

function claims(token) {
  try {
    const b = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b + "=".repeat((4 - (b.length % 4)) % 4)));
  } catch { return null; }
}

// token signature → { ok, until }. Short-lived and bounded: a tier change
// (subscribe / cancel) shows up within a minute.
const cache = new Map();
const TTL_MS = 60_000, MAX_ENTRIES = 500;

export async function isSubscriberToken(token, { supabaseUrl, anonKey, fetchImpl = fetch } = {}) {
  const base = String(supabaseUrl || "").replace(/\/$/, "");
  if (!base || !anonKey) return false;                       // misconfigured: fail closed
  // Cheap shape checks first, so junk tokens never reach the database.
  const c = claims(token);
  const now = Date.now();
  if (!c || c.role !== "authenticated" || !c.sub || !(c.exp * 1000 > now) || c.iss !== `${base}/auth/v1`) return false;
  const key = token.slice(token.lastIndexOf(".") + 1);
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.ok;
  let ok = false;
  try {
    // PostgREST verifies the token's signature and expiry itself; a bad one
    // is a 401 here, never a true.
    const r = await fetchImpl(`${base}/rest/v1/rpc/is_subscriber`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(4000),
    });
    ok = r.ok && (await r.json()) === true;
  } catch { ok = false; }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { ok, until: Math.min(now + TTL_MS, c.exp * 1000) });
  return ok;
}
