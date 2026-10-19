// workos-auth — WorkOS sign-in for the Supabase-backed site (the Vercel build
// and localhost).
//
// WorkOS proves who someone is: a 6-digit code it generates (we email it), or
// Google / Microsoft / GitHub / LinkedIn through WorkOS. This function then signs
// the person in to Supabase the same way the localhost testing sign-in does
// (scripts/dev-direct-signin.mjs on main): create the account if the address is
// new (email confirmed), mint a one-time magic-link token with the admin API, and
// hand it to the page, which exchanges it with supabase.auth.verifyOtp. Sessions,
// profiles, tiers and row-level security are unchanged.
//
//   POST /workos-auth/email/start   {email}          WorkOS makes a code; we email it
//   POST /workos-auth/email/verify  {email, code}    -> { token_hash, type }
//   GET  /workos-auth/providers                       -> { providers: [those switched on in WorkOS] }
//   GET  /workos-auth/start?provider=authkit&screen_hint=sign-up&redirect=<page URL>
//                                                     -> the WorkOS-hosted sign-in page
//   GET  /workos-auth/start?provider=GoogleOAuth&redirect=<page URL>   -> the provider
//   GET  /workos-auth/callback                        -> <page URL>#wos_token=…
//   GET  /workos-auth/security                        -> the signed-in reader's two-step status
//   POST /workos-auth/security/totp/start             -> QR code + key for an authenticator app
//   POST /workos-auth/security/totp/confirm  {setup, code}   -> two-step on
//   POST /workos-auth/security/totp/remove   {code}          -> two-step off
//   (security routes: Authorization: Bearer <the reader's Supabase access token>;
//    changes need a sign-in in the last 20 minutes)
//
// The email-code routes and direct provider starts (?provider=GoogleOAuth …)
// skip the WorkOS-hosted page, where WorkOS asks for the two-step code, and
// the site no longer uses them: they answer only when BRIDGE_DIRECT_ROUTES=on.
//
// Secrets (Edge Functions -> Secrets): WORKOS_API_KEY. WORKOS_CLIENT_ID defaults
// to the Staging client. GMAIL_USER / GMAIL_APP_PASSWORD / SENDER_NAME are the
// ones welcome-email already uses. SUPABASE_SERVICE_ROLE_KEY is built in.
//
// DEPLOY WITH verify_jwt = false (dashboard: "Verify JWT" OFF; MCP deploy:
// verify_jwt: false). Browsers call /providers, /start and /callback with no
// Supabase token, so with the check on the gateway refuses every sign-in.
// Every route checks the page's origin against ORIGINS (exact origins only: no
// open redirects, no other site can use it), and a provider round trip is bound
// to the browser that started it by a signed, HttpOnly cookie.
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const WORKOS = "https://api.workos.com";
const CLIENT_ID = (Deno.env.get("WORKOS_CLIENT_ID") ?? "client_01M4APWJ40K0B75B3ZYZJ6B0DW").trim();
const SB_URL = (Deno.env.get("SUPABASE_URL") ?? "https://ovenyjguhkgiceddzwna.supabase.co").replace(/\/$/, "");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Must match a redirect URI registered in WorkOS exactly.
const CALLBACK = (Deno.env.get("WORKOS_REDIRECT_URI") ?? "https://ovenyjguhkgiceddzwna.supabase.co/functions/v1/workos-auth/callback").trim();
const COOKIE = "wos_rt";
const COOKIE_PATH = "/functions/v1/workos-auth";
// "authkit" = the WorkOS-hosted sign-in page (email code or a provider, all on WorkOS).
const PROVIDERS = new Set(["authkit", "GoogleOAuth", "MicrosoftOAuth", "GitHubOAuth", "LinkedInOAuth"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_SITE = "https://attackedmap.vercel.app";
// Email-code routes and direct provider starts (see the header): off unless asked for.
const DIRECT_ROUTES = (Deno.env.get("BRIDGE_DIRECT_ROUTES") ?? "").trim().toLowerCase() === "on";

// Pages allowed to use this function: the live site and the local dev servers,
// exact origins only. No patterns: the callback hands the one-time sign-in token
// to this page, and a pattern such as Vercel preview hosts can be claimed by
// someone else's Vercel project. A preview that needs sign-in goes into
// WORKOS_ALLOWED_ORIGINS (comma-separated exact origins).
const ORIGINS = new Set([
  DEFAULT_SITE, "http://localhost:5173", "http://localhost:5180",
  ...(Deno.env.get("WORKOS_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);
const allowed = (origin: string | null) => !!origin && ORIGINS.has(origin);

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0));
const random = (n = 24) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(`workos-auth-state:${SERVICE}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

function cors(origin: string | null): Record<string, string> {
  return allowed(origin) ? {
    "Access-Control-Allow-Origin": origin!, "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
  } : {};
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function clientIp(req: Request): string | undefined {
  const xff = req.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() || undefined : undefined;
}

// ── WorkOS ──────────────────────────────────────────────────────────────────
class WorkOSError extends Error {
  constructor(message: string, public status = 502, public code = "") { super(message); }
}

function apiKey(): string {
  const k = (Deno.env.get("WORKOS_API_KEY") ?? "").trim();
  if (!k) throw new WorkOSError("WORKOS_API_KEY is not set", 503, "not_configured");
  return k;
}

async function workos(path: string, body: Record<string, unknown>, bearer = false): Promise<Record<string, any>> {
  const r = await fetch(`${WORKOS}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${apiKey()}` } : {}) },
    body: JSON.stringify(body),
  });
  let j: Record<string, any> = {};
  try { j = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new WorkOSError(`WorkOS ${path} -> ${r.status}`, r.status, String(j.code || j.error || ""));
  return j;
}

const authenticate = (body: Record<string, unknown>) =>
  workos("/user_management/authenticate", { client_id: CLIENT_ID, client_secret: apiKey(), ...body });

// Ours is the session that matters: end the one WorkOS opened (best effort).
async function endWorkosSession(accessToken: unknown): Promise<void> {
  try {
    const part = String(accessToken || "").split(".")[1];
    if (!part) return;
    const sid = JSON.parse(new TextDecoder().decode(fromB64url(part))).sid;
    if (typeof sid === "string" && sid) await workos("/user_management/sessions/revoke", { session_id: sid }, true);
  } catch (e) { console.warn("[workos-auth] WorkOS session not ended:", (e as Error).message); }
}

// ── Supabase (admin API, service role) ──────────────────────────────────────
const ADMIN = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

// The signed-in person as a Supabase account: created if new (email confirmed),
// then a one-time token the page exchanges for a session (verifyOtp).
async function supabaseToken(email: string, meta: Record<string, unknown>, signIn?: { workosUserId: string; method: string }): Promise<{ token_hash: string; type: string }> {
  const mk = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: "POST", headers: ADMIN, body: JSON.stringify({ email, email_confirm: true, user_metadata: meta }),
  });
  if (!mk.ok && mk.status !== 422) throw new Error(`could not create the account (${mk.status})`);
  const gen = await fetch(`${SB_URL}/auth/v1/admin/generate_link`, {
    method: "POST", headers: ADMIN, body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!gen.ok) throw new Error(`could not start the session (${gen.status})`);
  const link = await gen.json();
  const token_hash = link.hashed_token || link.properties?.hashed_token;
  if (!token_hash) throw new Error("auth returned no token");
  // Before the page exchanges the token, so the new session already carries it.
  if (signIn) await stampSignIn(link.user || link, signIn);
  return { token_hash, type: link.verification_type || link.properties?.verification_type || "magiclink" };
}

// ── Account security: two-step verification and sign-in strength ────────────
// WorkOS keeps the authenticator-app factor and asks for its code on the hosted
// sign-in page. Turning it on never leaves a half-made factor at WorkOS: the
// bridge makes the secret, the reader scans it and types one code, the bridge
// checks that code itself (RFC 6238) and only then registers the factor with
// WorkOS (totp_secret). Changing the setting needs a recent sign-in, every code
// check reserves an attempt in the database first (public._mfa_attempt: 5 per
// 10 minutes, atomic), and the reader is emailed about the change.
// Each sign-in records app_metadata.auth_method (Passkey, Password, MagicAuth,
// GoogleOAuth, …) and strong_auth — true only for a passkey, the one method
// WorkOS documents as covering both steps. app_metadata is service-role only.
const TOTP_ISSUER = "Attacked.ai";
const RECENT_SIGN_IN_S = 20 * 60;          // changing two-step needs a sign-in this recent
const BRIDGE_HANDOFF_S = 10 * 60;          // bridge stamp -> the page's token exchange
const SETUP_TTL_MS = 20 * 60_000;          // a scanned secret must be confirmed within this

async function workosCall(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, any>> {
  const r = await fetch(`${WORKOS}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let j: Record<string, any> = {};
  try { j = await r.json(); } catch { /* empty body (DELETE) */ }
  if (!r.ok) throw new WorkOSError(`WorkOS ${method} ${path.split("?")[0]} -> ${r.status}`, r.status, String(j.code || j.error || ""));
  return j;
}
const listFactors = async (workosUserId: string): Promise<Record<string, any>[]> => {
  const j = await workosCall("GET", `/user_management/users/${encodeURIComponent(workosUserId)}/auth_factors?limit=20`);
  return Array.isArray(j.data) ? j.data : [];
};
// Only the keys given change (the auth server merges app_metadata; null removes a key).
async function setAppMeta(userId: string, changes: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
  const r = await fetch(`${SB_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "PUT", headers: ADMIN, body: JSON.stringify({ app_metadata: changes }), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`could not update the account (${r.status})`);
}
// Never blocks a sign-in: a failure only leaves the old marks in place.
async function stampSignIn(user: Record<string, any>, s: { workosUserId: string; method: string }): Promise<void> {
  try {
    if (!user?.id) return;
    await setAppMeta(user.id, {
      workos_user_id: s.workosUserId || null, auth_method: s.method || null,
      strong_auth: s.method === "Passkey", signed_in_at: new Date().toISOString(),
    }, 2500);
  } catch (e) { console.warn("[workos-auth] sign-in not stamped:", (e as Error).message); }
}

// The reader behind a request: the auth server checks the access token.
// signedInAt is when THIS session was opened through the bridge, or 0. It
// counts only the token exchange the bridge handed over (amr "otp"/"magiclink",
// a few seconds after the bridge stamped app_metadata.signed_in_at), never
// other fresh authentications (Supabase's own MFA, password or email-code
// sign-ins), which skip WorkOS. amr keeps its time through token refreshes.
async function readerFrom(req: Request): Promise<{ user: Record<string, any>; signedInAt: number } | null> {
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: `Bearer ${m[1]}` }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  if (!user || !user.id || !EMAIL.test(String(user.email || "")) || !user.email_confirmed_at) return null;
  let signedInAt = 0;
  const stamp = Date.parse(String(user.app_metadata?.signed_in_at || "")) / 1000;
  if (Number.isFinite(stamp)) {
    try {
      const claims = JSON.parse(new TextDecoder().decode(fromB64url(m[2])));
      for (const a of Array.isArray(claims.amr) ? claims.amr : []) {
        const t = Number(a?.timestamp) || 0;
        if ((a?.method === "otp" || a?.method === "magiclink") && t - stamp >= -60 && t - stamp <= BRIDGE_HANDOFF_S) signedInAt = Math.max(signedInAt, t);
      }
    } catch { /* unreadable: not recent */ }
  }
  return { user, signedInAt };
}
// The WorkOS account for a reader: the id the bridge recorded at sign-in, if
// its (verified) email still matches. Changes (strict) use only that id; the
// read-only status may also find the account by the confirmed email.
async function workosUserFor(user: Record<string, any>, strict = false): Promise<Record<string, any> | null> {
  const email = String(user.email).toLowerCase();
  const same = (u: Record<string, any> | null) => !!u && String(u.email || "").toLowerCase() === email && u.email_verified !== false;
  const known = user.app_metadata?.workos_user_id;
  if (typeof known === "string" && /^user_[A-Za-z0-9]+$/.test(known)) {
    let u: Record<string, any> | null = null;
    try { u = await workosCall("GET", `/user_management/users/${encodeURIComponent(known)}`); }
    catch (e) { if ((e as WorkOSError).status !== 404) throw e; }
    if (same(u)) return u;
    if (strict || u) return null;   // recorded account now belongs to another address: never guess
  }
  if (strict) return null;
  const j = await workosCall("GET", `/user_management/users?email=${encodeURIComponent(email)}&limit=1`);
  const u = Array.isArray(j.data) ? j.data[0] : null;
  return same(u) ? u : null;
}

// ── TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 s) ──
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) { value = ((value << 8) | b) & 0xffff; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function b32decode(s: string): Uint8Array {
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) throw new Error("bad base32");
    value = ((value << 5) | i) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
async function totpAt(key: CryptoKey, counter: number): Promise<string> {
  const msg = new DataView(new ArrayBuffer(8));
  msg.setUint32(0, Math.floor(counter / 2 ** 32)); msg.setUint32(4, counter >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg.buffer));
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}
async function totpMatches(secretB32: string, code: string, now = Date.now()): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", b32decode(secretB32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const t = Math.floor(now / 30_000);
  let ok = false;
  for (const d of [-1, 0, 1]) if (await safeEqual(await totpAt(key, t + d), code)) ok = true;   // one step of clock drift
  return ok;
}
const otpauthUri = (secretB32: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(email)}?secret=${secretB32}&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA1&digits=6&period=30`;
// The scanned-but-unconfirmed secret travels with the page, signed and bound to the reader.
async function sealSetup(userId: string, secretB32: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ u: userId, s: secretB32, e: Date.now() + SETUP_TTL_MS })));
  return `${payload}.${await hmac(`totp-setup:${payload}`)}`;
}
async function openSetup(sealed: string, userId: string): Promise<string | null> {
  const [payload, sig] = String(sealed || "").split(".");
  if (!payload || !sig || !(await safeEqual(sig, await hmac(`totp-setup:${payload}`)))) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return c.u === userId && c.e > Date.now() && typeof c.s === "string" && /^[A-Z2-7]{32}$/.test(c.s) ? c.s : null;
  } catch { return null; }
}

const sixDigits = (v: unknown) => { const c = String(v ?? "").replace(/\D/g, ""); return c.length === 6 ? c : null; };
// Reserve one code check before making it (atomic, so parallel requests count too).
async function reserveAttempt(userId: string): Promise<boolean> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/_mfa_attempt`, {
    method: "POST", headers: ADMIN, body: JSON.stringify({ p_user: userId, p_ok: false }), signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`attempt counter unavailable (${r.status})`);
  return Number(await r.json()) <= 5;
}
async function clearAttempts(userId: string): Promise<void> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/_mfa_attempt`, { method: "POST", headers: ADMIN, body: JSON.stringify({ p_user: userId, p_ok: true }), signal: AbortSignal.timeout(5000) });
    if (!r.ok) console.warn("[workos-auth] attempt counter not cleared:", r.status);
  } catch (e) { console.warn("[workos-auth] attempt counter not cleared:", (e as Error).message); }   // expires on its own in 10 minutes
}
// true / false = WorkOS says the code is right / wrong. A WorkOS failure
// throws, so the reader sees "try again in a minute", not "wrong code".
async function verifyWithWorkos(factorId: string, code: string): Promise<boolean> {
  const ch = await workosCall("POST", `/auth/factors/${encodeURIComponent(factorId)}/challenge`, {});
  if (!ch.id) throw new WorkOSError("WorkOS returned no challenge");
  const v = await workosCall("POST", `/auth/challenges/${encodeURIComponent(String(ch.id))}/verify`, { code });
  return v.valid === true;
}
// Best effort: tells the reader their two-step setting changed. Waits at most
// 4 s for the mail server; the send carries on in the background after that.
async function tellReaderSoon(email: string, on: boolean): Promise<void> {
  const p = tellReader(email, on);
  try { (globalThis as any).EdgeRuntime?.waitUntil?.(p); } catch { /* not on the edge runtime */ }
  await Promise.race([p, new Promise((r) => setTimeout(r, 4000))]);
}
async function tellReader(email: string, on: boolean): Promise<void> {
  const what = on ? "turned on" : "turned off";
  try {
    await sendMail(email, {
      subject: `Two-step verification ${what} for your Attacked.ai account`,
      text: `Two-step verification was ${what} for your Attacked.ai account just now.\n\nIf this was you, there is nothing to do. If it wasn't, sign in and check Profile > Security, and contact the Attacked.ai team.`,
      html: `<p>Two-step verification was <strong>${what}</strong> for your Attacked.ai account just now.</p><p>If this was you, there is nothing to do. If it wasn't, sign in and check <strong>Profile &rarr; Security</strong>, and contact the Attacked.ai team.</p>`,
    });
  } catch (e) { console.warn("[workos-auth] change email not sent:", (e as Error).message); }
}

async function security(req: Request, path: string, origin: string | null): Promise<Response> {
  let r: Awaited<ReturnType<typeof readerFrom>>;
  try { r = await readerFrom(req); }
  catch (e) {
    console.error("[workos-auth] security: reader check failed:", (e as Error).message);
    return json({ error: "Security settings are unavailable right now. Try again in a minute." }, 502, origin);
  }
  if (!r) return json({ error: "Sign in again to change your security settings." }, 401, origin);
  const { user } = r;
  const email = String(user.email).toLowerCase();
  const am: Record<string, any> = user.app_metadata || {};
  const recent = Date.now() / 1000 - r.signedInAt < RECENT_SIGN_IN_S;
  const view = { method: am.auth_method || null, strong: am.strong_auth === true, recent };
  // Changes need a recent sign-in through the bridge; checked first, before any WorkOS call.
  if (path !== "/security" && !recent) return json({ error: "For your safety, sign in again before changing two-step verification.", code: "reauth" }, 403, origin);
  try {
    const wu = await workosUserFor(user, path !== "/security");
    if (!wu) {
      if (path === "/security") return json({ workos: false, totp: { on: false }, ...view }, 200, origin);
      return json({ error: "Sign out, then sign in again with the Attacked.ai sign-in page first. Then turn this on.", code: "no_workos" }, 409, origin);
    }
    const factors = await listFactors(wu.id);
    const factor = factors.find((f) => f.id === am.mfa_factor_id) || factors[0] || null;
    if (path === "/security") {
      const since = factor ? (factor.id === am.mfa_factor_id && am.mfa_since) || factor.created_at || null : null;
      return json({ workos: true, totp: { on: !!factor, since }, ...view }, 200, origin);
    }
    const body = await readJson(req);

    if (path === "/security/totp/start") {
      if (factor) return json({ error: "Two-step verification is already on." }, 409, origin);
      const secret = b32encode(crypto.getRandomValues(new Uint8Array(20)));
      const uri = otpauthUri(secret, email);
      let qr: string | null = null;
      try {
        // loaded here, not at start-up: the QR drawing can never stop sign-in
        const QRCode = (await import("npm:qrcode@1.5.4")).default;
        qr = `data:image/svg+xml;base64,${btoa(await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 1 }))}`;
      }
      catch (e) { console.warn("[workos-auth] QR code not drawn:", (e as Error).message); }
      return json({ setup: await sealSetup(user.id, secret), secret, uri, qr }, 200, origin);
    }
    if (path === "/security/totp/confirm") {
      if (factor) return json({ error: "Two-step verification is already on." }, 409, origin);
      const code = sixDigits(body.code), secret = await openSetup(String(body.setup || ""), user.id);
      if (!secret) return json({ error: "That set-up has expired. Start again and scan the new code." }, 400, origin);
      if (!code) return json({ error: "Enter the 6-digit code from your authenticator app." }, 400, origin);
      if (!(await reserveAttempt(user.id))) return json({ error: "Too many wrong codes. Wait 10 minutes, then try again." }, 429, origin);
      if (!(await totpMatches(secret, code))) return json({ error: "That code didn't match. Use the newest code in the app, and check your phone's clock is set automatically." }, 400, origin);
      if ((await listFactors(wu.id)).length) return json({ error: "Two-step verification is already on." }, 409, origin);   // a second tab got there first
      const made = await workosCall("POST", `/user_management/users/${encodeURIComponent(wu.id)}/auth_factors`, { type: "totp", totp_issuer: TOTP_ISSUER, totp_user: email, totp_secret: secret });
      const f = made.authentication_factor || {};
      if (!f.id) throw new Error("WorkOS returned no factor");
      await clearAttempts(user.id);
      try { await setAppMeta(user.id, { mfa_factor_id: f.id, mfa_since: new Date().toISOString() }); }
      catch (e) { console.warn("[workos-auth] factor saved at WorkOS, not noted on the account:", (e as Error).message); }
      await tellReaderSoon(email, true);
      return json({ totp: { on: true } }, 200, origin);
    }
    if (path === "/security/totp/remove") {
      if (!factor) return json({ error: "Two-step verification is not on." }, 409, origin);
      const code = sixDigits(body.code);
      if (!code) return json({ error: "Enter the current 6-digit code from your authenticator app." }, 400, origin);
      if (!(await reserveAttempt(user.id))) return json({ error: "Too many wrong codes. Wait 10 minutes, then try again." }, 429, origin);
      if (!(await verifyWithWorkos(factor.id, code))) return json({ error: "That code didn't match. Use the newest code in the app." }, 400, origin);
      for (const f of factors) await workosCall("DELETE", `/auth/factors/${encodeURIComponent(f.id)}`);
      await clearAttempts(user.id);
      try { await setAppMeta(user.id, { mfa_factor_id: null, mfa_since: null }); } catch { /* status reads WorkOS */ }
      await tellReaderSoon(email, false);
      return json({ totp: { on: false } }, 200, origin);
    }
    return json({ error: "not found" }, 404, origin);
  } catch (e) {
    const err = e as WorkOSError;
    console.error("[workos-auth] security:", err.message, err.code || "");
    if (err.code === "not_configured") return json({ error: "Security settings are not switched on yet." }, 503, origin);
    return json({ error: "Security settings are unavailable right now. Try again in a minute." }, 502, origin);
  }
}

// What WorkOS knows about the person, as Supabase user metadata (new accounts only).
function metaOf(u: Record<string, any>): Record<string, unknown> {
  const first = typeof u.first_name === "string" ? u.first_name.trim() : "";
  const last = typeof u.last_name === "string" ? u.last_name.trim() : "";
  const out: Record<string, unknown> = { signup_via: "workos", workos_user_id: u.id };
  if (first) out.first_name = first;
  if (last) out.last_name = last;
  if (first || last) out.full_name = `${first} ${last}`.trim();
  if (typeof u.profile_picture_url === "string" && u.profile_picture_url) out.avatar_url = u.profile_picture_url;
  return out;
}

// ── the code email ──────────────────────────────────────────────────────────
function codeEmail(code: string): { subject: string; html: string; text: string } {
  const digits = code.replace(/\D/g, "").slice(0, 10);
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Attacked.ai sign-in code</title></head>
<body style="margin:0;padding:32px 16px;background:#F5F2E9;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0E1116;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #E7E5DE;border-radius:8px;overflow:hidden;">
<tr><td style="padding:20px 28px;background:#0E1116;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle;padding-right:12px;"><img src="https://attackedmap.vercel.app/attacked-ai-logo.png" alt="Attacked.ai" width="34" height="34" style="display:block;border:0;"></td>
<td style="vertical-align:middle;"><div style="font-size:19px;font-weight:700;color:#FFFFFF;letter-spacing:-0.01em;line-height:1;">Attacked<span style="color:#FCBD00;">.ai</span></div>
<div style="font-size:10px;color:#A6A8AD;letter-spacing:0.14em;text-transform:uppercase;margin-top:5px;font-weight:600;">Secure sign-in</div></td>
</tr></table></td></tr>
<tr><td style="height:4px;background:#FCBD00;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:28px;">
<div style="font-size:10px;color:#765900;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:10px;">One-time code &middot; expires in 10 minutes</div>
<h1 style="font-size:26px;font-weight:800;color:#0E1116;margin:0 0 12px;line-height:1.2;letter-spacing:-0.015em;">Your sign-in code</h1>
<p style="font-size:14px;color:#3A3D43;line-height:1.6;margin:0 0 22px;">Type this code into the Attacked.ai window where you asked for it. No password needed; it works once.</p>
<div style="text-align:center;margin:24px 0;"><div style="display:inline-block;background:#0E1116;border-radius:6px;padding:16px 28px;">
<span style="font-family:'JetBrains Mono','Courier New',monospace;font-size:36px;font-weight:700;letter-spacing:0.32em;color:#FCBD00;padding-left:0.32em;">${digits}</span></div></div>
<p style="font-size:12px;color:#6B7078;line-height:1.55;margin:22px 0 0;">Didn't ask for this? Someone may have typed your address by mistake. You can ignore this email.</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #E7E5DE;font-size:10px;color:#6B7078;letter-spacing:0.10em;text-transform:uppercase;text-align:center;font-weight:600;">Attacked.ai &middot; GUARD framework</td></tr>
</table></body></html>`;
  const text = `Your Attacked.ai sign-in code: ${digits}\n\nType it into the Attacked.ai window where you asked for it. It expires in 10 minutes and works once.\n\nDidn't ask for this? You can ignore this email.`;
  return { subject: "Your Attacked.ai sign-in code", html, text };
}

async function sendMail(to: string, msg: { subject: string; html: string; text: string }): Promise<void> {
  const user = Deno.env.get("GMAIL_USER") ?? "", pass = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
  if (!user || !pass) throw new Error("mail is not configured (GMAIL_USER / GMAIL_APP_PASSWORD)");
  const client = new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: user, password: pass } } });
  try {
    await client.send({ from: `${Deno.env.get("SENDER_NAME") ?? "Attacked.ai"} <${user}>`, to, subject: msg.subject, content: msg.text, html: msg.html });
  } finally {
    try { await client.close(); } catch { /* already closed */ }
  }
}

// ── routes ──────────────────────────────────────────────────────────────────
async function readJson(req: Request): Promise<Record<string, any>> {
  try { const j = await req.json(); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}

async function emailStart(req: Request, origin: string | null): Promise<Response> {
  const email = String((await readJson(req)).email || "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return json({ error: "That does not look like an email address." }, 400, origin);
  let magic: Record<string, any>;
  try {
    magic = await workos("/user_management/magic_auth", { email, ...(clientIp(req) ? { ip_address: clientIp(req) } : {}) }, true);
  } catch (e) {
    const err = e as WorkOSError;
    console.error("[workos-auth] magic_auth failed:", err.message, err.code);
    if (err.status === 429) return json({ error: "Too many codes asked for. Wait a minute, then try again." }, 429, origin);
    if (err.code === "not_configured") return json({ error: "Sign-in is not switched on yet." }, 503, origin);
    return json({ error: "We could not create a code right now. Try again in a minute." }, 502, origin);
  }
  try {
    await sendMail(email, codeEmail(String(magic.code || "")));
  } catch (e) {
    console.error("[workos-auth] code email failed:", (e as Error).message);
    return json({ error: "We could not send the code email. Try again in a minute." }, 502, origin);
  }
  return json({ sent: true, length: 6, expires_in: 600 }, 200, origin);
}

async function emailVerify(req: Request, origin: string | null): Promise<Response> {
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  let code = String(body.code || "").replace(/\D/g, "");
  if (code.length > 0 && code.length < 6) code = code.padStart(6, "0");   // a lost leading zero
  if (!EMAIL.test(email) || code.length !== 6) return json({ error: "That code didn't match. Use the code from the newest email." }, 400, origin);
  let auth: Record<string, any>;
  try {
    auth = await authenticate({
      grant_type: "urn:workos:oauth:grant-type:magic-auth:code", code, email,
      ...(clientIp(req) ? { ip_address: clientIp(req) } : {}), user_agent: (req.headers.get("user-agent") ?? "").slice(0, 400),
    });
  } catch (e) {
    const err = e as WorkOSError;
    console.warn("[workos-auth] code refused:", err.message, err.code);
    if (err.code === "not_configured") return json({ error: "Sign-in is not switched on yet." }, 503, origin);
    return json({ error: "That code didn't match or has expired. Use the code from the newest email, or ask for a new one." }, 400, origin);
  }
  const u = auth.user || {};
  await endWorkosSession(auth.access_token);
  if (String(u.email || "").toLowerCase() !== email || u.email_verified !== true) {
    return json({ error: "We couldn't confirm that email address." }, 400, origin);
  }
  try {
    return json(await supabaseToken(email, metaOf(u), { workosUserId: String(u.id || ""), method: String(auth.authentication_method || "MagicAuth") }), 200, origin);
  } catch (e) {
    console.error("[workos-auth] supabase sign-in failed:", (e as Error).message);
    return json({ error: "Signed in with WorkOS, but your account could not be opened. Try again." }, 502, origin);
  }
}

function back(site: string, reason: string): Response {
  return new Response(null, { status: 302, headers: { Location: `${site}/?home&signin_error=${reason}`, "Cache-Control": "no-store" } });
}

function cookieOf(req: Request): string | null {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

const clearCookie = `${COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// Is this provider switched on in WorkOS? WorkOS answers a provider that is not
// set up (LinkedIn needs our own LinkedIn app) with a bare "Not Found" page, so
// ask it first: a redirect onward means ready. Remembered for five minutes, so a
// provider switched on in the WorkOS dashboard shows up without a deploy.
const ready = new Map<string, { ok: boolean; at: number }>();
async function providerReady(provider: string): Promise<boolean> {
  const hit = ready.get(provider);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
  let ok = true;   // WorkOS unreachable: don't hide anything over a blip
  try {
    const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: CALLBACK, response_type: "code", provider, state: "probe" });
    const r = await fetch(`${WORKOS}/user_management/authorize?${q}`, { redirect: "manual" });
    await r.body?.cancel();
    ok = r.status >= 300 && r.status < 400;
    ready.set(provider, { ok, at: Date.now() });
  } catch (e) { console.warn("[workos-auth] provider check failed:", (e as Error).message); }
  return ok;
}

async function providersList(origin: string | null): Promise<Response> {
  const list = (await Promise.all([...PROVIDERS].map(async (p) => (await providerReady(p)) ? p : null))).filter(Boolean);
  // configured: the WorkOS key is set, so a trip can finish (the page checks
  // this before sending anyone off to WorkOS).
  const configured = !!(Deno.env.get("WORKOS_API_KEY") ?? "").trim();
  return new Response(JSON.stringify({ providers: list, configured }), {
    status: 200, headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "private, max-age=60" },
  });
}

async function providerStart(url: URL): Promise<Response> {
  const provider = url.searchParams.get("provider") ?? "";
  const redirect = url.searchParams.get("redirect") ?? "";
  let site = DEFAULT_SITE, target = `${DEFAULT_SITE}/?dashboard`;
  // No fragment from the link: the callback appends #wos_token=…, and a
  // fragment planted in a crafted link must not ride ahead of it.
  try { const r = new URL(redirect); r.hash = ""; if (allowed(r.origin)) { site = r.origin; target = r.toString(); } } catch { /* default */ }
  if (!PROVIDERS.has(provider) || !(await providerReady(provider))) return back(site, "unavailable");
  const state = random();
  const payload = b64url(enc.encode(JSON.stringify({ s: state, t: target, e: Date.now() + 30 * 60_000 })));
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: CALLBACK, response_type: "code", provider, state });
  const hint = url.searchParams.get("login_hint");
  if (hint && EMAIL.test(hint)) q.set("login_hint", hint);
  const screen = url.searchParams.get("screen_hint");
  if (provider === "authkit" && (screen === "sign-up" || screen === "sign-in")) q.set("screen_hint", screen);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${WORKOS}/user_management/authorize?${q}`,
      "Set-Cookie": `${COOKIE}=${payload}.${await hmac(payload)}; Path=${COOKIE_PATH}; Max-Age=1800; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

async function providerCallback(req: Request, url: URL): Promise<Response> {
  // Which page started this, from the signed cookie (never from the query string).
  let target = `${DEFAULT_SITE}/?dashboard`, state = "";
  const raw = cookieOf(req);
  if (raw) {
    const [payload, sig] = raw.split(".");
    if (payload && sig && await safeEqual(sig, await hmac(payload))) {
      try {
        const c = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
        if (typeof c.t === "string" && typeof c.s === "string" && c.e > Date.now() && allowed(new URL(c.t).origin)) { target = c.t; state = c.s; }
      } catch { /* bad cookie: treated as missing */ }
    }
  }
  const site = new URL(target).origin;
  const done = (r: Response) => { r.headers.append("Set-Cookie", clearCookie); return r; };
  const error = url.searchParams.get("error");
  if (error) return done(back(site, error === "access_denied" ? "cancelled" : "workos"));
  const code = url.searchParams.get("code") ?? "";
  const sent = url.searchParams.get("state") ?? "";
  if (!state) return done(back(site, "expired"));
  if (!code || !sent || !(await safeEqual(sent, state))) return done(back(site, "workos"));
  let auth: Record<string, any>;
  try {
    auth = await authenticate({ grant_type: "authorization_code", code, ...(clientIp(req) ? { ip_address: clientIp(req) } : {}), user_agent: (req.headers.get("user-agent") ?? "").slice(0, 400) });
  } catch (e) {
    console.warn("[workos-auth] provider sign-in refused:", (e as Error).message, (e as WorkOSError).code);
    return done(back(site, (e as WorkOSError).code === "not_configured" ? "unavailable" : "workos"));
  }
  const u = auth.user || {};
  await endWorkosSession(auth.access_token);
  const email = String(u.email || "").trim().toLowerCase();
  if (!EMAIL.test(email) || u.email_verified !== true) return done(back(site, "unverified"));
  try {
    const t = await supabaseToken(email, metaOf(u), { workosUserId: String(u.id || ""), method: String(auth.authentication_method || "") });
    const sep = target.includes("#") ? "&" : "#";
    return done(new Response(null, {
      status: 302,
      headers: { Location: `${target}${sep}wos_token=${encodeURIComponent(t.token_hash)}&wos_type=${encodeURIComponent(t.type)}`, "Cache-Control": "no-store" },
    }));
  } catch (e) {
    console.error("[workos-auth] supabase sign-in failed:", (e as Error).message);
    return done(back(site, "workos"));
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/workos-auth/, "") || "/";
  const origin = req.headers.get("origin");

  if (req.method === "GET" && path === "/providers") return providersList(allowed(origin) ? origin : null);
  if (req.method === "GET" && path === "/start") {
    if (!DIRECT_ROUTES && url.searchParams.get("provider") !== "authkit") {
      let site = DEFAULT_SITE;
      try { const o = new URL(url.searchParams.get("redirect") ?? "").origin; if (allowed(o)) site = o; } catch { /* default */ }
      return back(site, "unavailable");
    }
    return providerStart(url);
  }
  if (req.method === "GET" && path === "/callback") return providerCallback(req, url);

  if (path === "/security" || path.startsWith("/security/")) {
    if (!allowed(origin)) return json({ error: "origin not allowed" }, 403, null);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (path === "/security" ? req.method !== "GET" : req.method !== "POST") return json({ error: "method not allowed" }, 405, origin);
    return security(req, path, origin);
  }

  if ((path === "/email/start" || path === "/email/verify") && !DIRECT_ROUTES) return json({ error: "not found" }, 404, allowed(origin) ? origin : null);
  if (path === "/email/start" || path === "/email/verify") {
    if (!allowed(origin)) return json({ error: "origin not allowed" }, 403, null);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);
    if (!String(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
      return json({ error: "JSON only" }, 415, origin);
    }
    return path === "/email/start" ? emailStart(req, origin) : emailVerify(req, origin);
  }
  return json({ error: "not found" }, 404, origin);
});
