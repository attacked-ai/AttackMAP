// workos-auth — WorkOS sign-in for the Supabase-backed site (the Vercel build
// and localhost).
//
// WorkOS proves who someone is: a 6-digit code it emails, or Google /
// Microsoft / GitHub / LinkedIn through WorkOS. This function then signs
// the person in to Supabase the same way the localhost testing sign-in does
// (scripts/dev-direct-signin.mjs on main): create the account if the address is
// new (email confirmed), mint a one-time magic-link token with the admin API, and
// hand it to the page, which exchanges it with supabase.auth.verifyOtp. Sessions,
// profiles, tiers and row-level security are unchanged.
//
//   POST /workos-auth/email/start   {email}          WorkOS makes a code and emails it
//   POST /workos-auth/email/verify  {email, code, first_name?, last_name?}
//                                                     -> { token_hash, type }
//   GET  /workos-auth/providers                       -> { providers: [those switched on in WorkOS] }
//   GET  /workos-auth/start?provider=authkit&screen_hint=sign-up&redirect=<page URL>
//                                                     -> the WorkOS-hosted sign-in page
//   GET  /workos-auth/start?provider=GoogleOAuth&redirect=<page URL>   -> the provider
//   GET  /workos-auth/callback                        -> <page URL>#wos_token=…
//   GET  /workos-auth/security                        -> the signed-in reader's two-step status
//   GET  /workos-auth/security?full=1                 -> status + linked accounts (the Login and security page)
//   POST /workos-auth/security/totp/start             -> QR code + key for an authenticator app
//   POST /workos-auth/security/totp/confirm  {setup, code}   -> two-step on
//   POST /workos-auth/security/totp/remove   {code}          -> two-step off
//   POST /workos-auth/security/password      {password, code?} -> set or change the WorkOS password
//   GET  /workos-auth/security/devices                -> { devices: [ { id, current, os, browser, last_active, signed_in } ] }
//                                                        every browser and phone signed in to this account (one per Supabase session)
//   POST /workos-auth/security/devices/signout {id}   -> { ended: true }: that one other device is signed out
//   (security routes: Authorization: Bearer <the reader's Supabase access token>;
//    changes need a sign-in in the last 20 minutes, except the devices routes: see devices();
//    the two devices routes answer 429 after 60 calls a minute from one reader)
//
// The email-code routes and direct provider starts (?provider=GoogleOAuth …)
// serve the site's own sign-up page (/?signup: every question on one page;
// sign-in stays on the WorkOS-hosted page). They skip the hosted page, where
// WorkOS asks for the two-step code, so they never open a session for an
// account that has a second step: WorkOS's own mfa_* answers, or any factor
// on the account, send the reader to the hosted sign-in instead (409 code
// "use_hosted" for the email code, a second trip to the hosted page for a
// provider). BRIDGE_SIGNUP_FORM=off switches them off.
//
// Secrets (Edge Functions -> Secrets): WORKOS_API_KEY. WORKOS_CLIENT_ID defaults
// to the Staging client. GMAIL_USER / GMAIL_APP_PASSWORD / SENDER_NAME are the
// ones welcome-email already uses. SUPABASE_SERVICE_ROLE_KEY is built in.
// WorkOS emails the sign-up code itself while its Magic Auth email is on
// (WorkOS dashboard -> Emails). BRIDGE_CODE_EMAIL=ours sends our template
// instead: only with WorkOS's email switched off, or the reader gets two.
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SITE = "https://attackedmap.vercel.app";
// The sign-up page's routes (see the header): on unless switched off.
const SIGNUP_FORM = (Deno.env.get("BRIDGE_SIGNUP_FORM") ?? "").trim().toLowerCase() !== "off";
const OWN_CODE_EMAIL = (Deno.env.get("BRIDGE_CODE_EMAIL") ?? "").trim().toLowerCase() === "ours";
// WorkOS answers that only its hosted page can finish (a two-step code, setting
// one up, an email check, an organisation or SSO choice).
const HOSTED_ONLY = new Set(["mfa_challenge", "mfa_enrollment", "email_verification_required",
  "organization_selection_required", "sso_required", "organization_authentication_methods_required"]);

// Pages allowed to use this function: the live site and the local dev servers,
// exact origins only. No patterns: the callback hands the one-time sign-in token
// to this page, and a pattern such as Vercel preview hosts can be claimed by
// someone else's Vercel project. A preview that needs sign-in goes into
// WORKOS_ALLOWED_ORIGINS (comma-separated exact origins).
const ORIGINS = new Set([
  DEFAULT_SITE, "http://localhost:5173", "http://localhost:5180",
  ...(Deno.env.get("WORKOS_ALLOWED_ORIGINS") ?? "").split(",").map((s) => { try { return new URL(s.trim()).origin; } catch { return ""; } })
    .filter((o) => o && o !== "null"),
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
  constructor(message: string, public status = 502, public code = "", public body: Record<string, any> = {}) { super(message); }
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
  if (!r.ok) throw new WorkOSError(`WorkOS ${path} -> ${r.status}`, r.status, String(j.code || j.error || ""), j);
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
  await mk.body?.cancel().catch(() => {});
  if (!mk.ok && mk.status !== 422) throw new Error(`could not create the account (${mk.status})`);
  let link = await magicLink(email);
  // An account that already existed but whose address nobody ever confirmed
  // (Supabase's own sign-up, with a password, by anyone who typed this
  // address): WorkOS has just proved the address, so the account starts
  // clean. Without this the token would confirm it with the other person's
  // password and details still on it.
  const existing = link.user || link;
  if (mk.status === 422 && !existing.email_confirmed_at && !existing.confirmed_at) {
    await startClean(existing, meta);
    link = await magicLink(email);
  }
  const token_hash = link.hashed_token || link.properties?.hashed_token;
  if (!token_hash) throw new Error("auth returned no token");
  // Before the page exchanges the token, so the new session already carries it.
  if (signIn) await stampSignIn(link.user || link, signIn);
  return { token_hash, type: link.verification_type || link.properties?.verification_type || "magiclink" };
}

async function magicLink(email: string): Promise<Record<string, any>> {
  const gen = await fetch(`${SB_URL}/auth/v1/admin/generate_link`, {
    method: "POST", headers: ADMIN, body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!gen.ok) { await gen.body?.cancel().catch(() => {}); throw new Error(`could not start the session (${gen.status})`); }
  return await gen.json();
}

// A random password nobody knows (it replaces the unconfirmed one; the
// fixed tail meets any character-class rule), the address confirmed, and
// user metadata reduced to what WorkOS says (the auth server merges
// user_metadata per key; null removes one).
async function startClean(user: Record<string, any>, meta: Record<string, unknown>): Promise<void> {
  if (!user?.id) throw new Error("auth returned no account to reset");
  const clear = Object.fromEntries(Object.keys(user.user_metadata || {}).filter((k) => !(k in meta)).map((k) => [k, null]));
  const r = await fetch(`${SB_URL}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
    method: "PUT", headers: ADMIN, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ password: `${random(36)}aA1!`, email_confirm: true, user_metadata: { ...clear, ...meta } }),
  });
  await r.body?.cancel().catch(() => {});
  if (!r.ok) throw new Error(`could not reset the unconfirmed account (${r.status})`);
  console.warn("[workos-auth] an unconfirmed account was reset before its first verified sign-in:", user.id);
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
// The Login and security page (GET /security?full=1) also lists the reader's
// linked accounts: WorkOS's identities list, read-only (WorkOS has no unlink),
// plus the methods seen at sign-in (app_metadata.methods_used). A password is
// set or changed with PUT /user_management/users/{id} behind the same
// recent-sign-in gate, plus the authenticator code when two-step is on, and
// at most once a minute per account.
const TOTP_ISSUER = "Attacked.ai";
const RECENT_SIGN_IN_S = 20 * 60;          // changing two-step needs a sign-in this recent
const BRIDGE_HANDOFF_S = 3 * 60;           // bridge stamp -> the page's token exchange
const SETUP_TTL_MS = 20 * 60_000;          // a scanned secret must be confirmed within this
const PASSWORD_CHANGE_GAP_MS = 60_000;     // one password change per account per minute

async function workosCall(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, any>> {
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
// The sign-up page's routes skip the hosted page's two-step code: an account
// with any factor signs in on the hosted page only. "unknown" (the check
// failed, or an unreadable id) is treated like "two_step": fails closed.
async function secondStep(workosUserId: string): Promise<"none" | "two_step" | "unknown"> {
  if (!/^user_[A-Za-z0-9]+$/.test(workosUserId)) return "unknown";
  try { return (await listFactors(workosUserId)).length > 0 ? "two_step" : "none"; }
  catch (e) { console.warn("[workos-auth] factor check failed, sending to the hosted page:", (e as Error).message); return "unknown"; }
}
// Only the keys given change (the auth server merges app_metadata; null removes a key).
async function setAppMeta(userId: string, changes: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
  const r = await fetch(`${SB_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "PUT", headers: ADMIN, body: JSON.stringify({ app_metadata: changes }), signal: AbortSignal.timeout(timeoutMs),
  });
  await r.body?.cancel().catch(() => {});
  if (!r.ok) throw new Error(`could not update the account (${r.status})`);
}
// Never blocks a sign-in: a failure only leaves the old marks in place.
// methods_used accumulates every method this reader has signed in with (the
// Login card's linked-account rows: WorkOS's own identities list is empty for
// readers who linked Google to an email-code account). Last 10, in the order
// first seen; an impersonation sign-in is never added. An account stamped
// before this list existed starts it from the auth_method already recorded,
// so the method it used last (say Google) is not forgotten at this sign-in.
async function stampSignIn(user: Record<string, any>, s: { workosUserId: string; method: string }): Promise<void> {
  try {
    if (!user?.id) return;
    const am = user.app_metadata || {};
    const prior: unknown[] = Array.isArray(am.methods_used) ? am.methods_used
      : (typeof am.auth_method === "string" && am.auth_method !== "Impersonation" ? [am.auth_method] : []);
    const seen: string[] = prior.filter((m: unknown): m is string => typeof m === "string" && !!m);
    const methods_used = s.method && s.method !== "Impersonation" ? [...new Set([...seen, s.method])].slice(-10) : null;
    await setAppMeta(user.id, {
      workos_user_id: s.workosUserId || null, auth_method: s.method || null,
      strong_auth: s.method === "Passkey", signed_in_at: s.method === "Impersonation" ? null : new Date().toISOString(),
      ...(methods_used ? { methods_used } : {}),
    }, 2500);
  } catch (e) { console.warn("[workos-auth] sign-in not stamped:", (e as Error).message); }
}

// The reader behind a request: the auth server checks the access token.
// signedInAt is when this session was opened by the bridge's hand-over, or 0:
// an amr "otp" entry (the page's verifyOtp) from a few seconds after the
// bridge stamped app_metadata.signed_in_at. amr keeps that time through token
// refreshes. Supabase's own MFA ("totp") and password sign-ins never count.
// GoTrue labels every POST /verify session "otp", so a direct Supabase
// email-code or recovery session opened inside this short window would count
// too: closing those direct routes is docs/MFA-PASSKEYS.md §3.
// sessionId is the token's session_id claim (the auth.sessions row this token
// belongs to), lower-cased, or null for a token without one.
async function readerFrom(req: Request): Promise<{ user: Record<string, any>; signedInAt: number; sessionId: string | null } | null> {
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: `Bearer ${m[1]}` }, signal: AbortSignal.timeout(5000) });
  if (r.status === 401 || r.status === 403) { await r.body?.cancel().catch(() => {}); return null; }
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`auth server answered ${r.status}`); }
  const user = await r.json().catch(() => null);
  if (!user || !user.id || !EMAIL.test(String(user.email || "")) || !user.email_confirmed_at) return null;
  let claims: Record<string, any> = {};
  try { const c = JSON.parse(new TextDecoder().decode(fromB64url(m[2]))); if (c && typeof c === "object") claims = c; }
  catch { /* unreadable: not recent, no session id */ }
  const sessionId = typeof claims.session_id === "string" && UUID.test(claims.session_id) ? claims.session_id.toLowerCase() : null;
  let signedInAt = 0;
  const stamp = Date.parse(String(user.app_metadata?.signed_in_at || "")) / 1000;
  if (Number.isFinite(stamp)) {
    for (const a of Array.isArray(claims.amr) ? claims.amr : []) {
      const t = Number(a?.timestamp) || 0;
      if (a?.method === "otp" && t - stamp >= -15 && t - stamp <= BRIDGE_HANDOFF_S) signedInAt = Math.max(signedInAt, t);
    }
  }
  return { user, signedInAt, sessionId };
}
// The WorkOS account for a reader: the id the bridge recorded at sign-in, if
// its (verified) email still matches. Changes (strict) use only that id; the
// read-only status may also find the account by the confirmed email.
async function workosUserFor(user: Record<string, any>, strict = false): Promise<Record<string, any> | null> {
  const email = String(user.email).toLowerCase();
  const same = (u: Record<string, any> | null) => !!u && String(u.email || "").toLowerCase() === email && u.email_verified === true;
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
    await r.body?.cancel().catch(() => {});
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
// Best effort: tells the reader their two-step setting changed (true / false)
// or their password was set or changed ("password"). Waits at most 4 s for the
// mail server; the send carries on in the background after that.
async function tellReaderSoon(email: string, what: boolean | "password"): Promise<void> {
  const p = tellReader(email, what);
  try { (globalThis as any).EdgeRuntime?.waitUntil?.(p); } catch { /* not on the edge runtime */ }
  await Promise.race([p, new Promise((r) => setTimeout(r, 4000))]);
}
async function tellReader(email: string, what: boolean | "password"): Promise<void> {
  let msg: { subject: string; text: string; html: string };
  if (what === "password") {
    msg = {
      subject: "Your Attacked.ai password was changed",
      text: "Your Attacked.ai password was set or changed just now.\n\nIf this was you, there is nothing to do. If it wasn't, sign in, go to Profile > Login and security, sign out everywhere else and set a new password, and contact the Attacked.ai team.",
      html: "<p>Your Attacked.ai password was set or changed just now.</p><p>If this was you, there is nothing to do. If it wasn't, sign in, go to <strong>Profile &rarr; Login and security</strong>, sign out everywhere else and set a new password, and contact the Attacked.ai team.</p>",
    };
  } else {
    const state = what ? "turned on" : "turned off";
    msg = {
      subject: `Two-step verification ${state} for your Attacked.ai account`,
      text: `Two-step verification was ${state} for your Attacked.ai account just now.\n\nIf this was you, there is nothing to do. If it wasn't, sign in and check Profile > Login and security, and contact the Attacked.ai team.`,
      html: `<p>Two-step verification was <strong>${state}</strong> for your Attacked.ai account just now.</p><p>If this was you, there is nothing to do. If it wasn't, sign in and check <strong>Profile &rarr; Login and security</strong>, and contact the Attacked.ai team.</p>`,
    };
  }
  try { await sendMail(email, msg); }
  catch (e) { console.warn("[workos-auth] change email not sent:", (e as Error).message); }
}

// ── Signed-in devices ───────────────────────────────────────────────────────
// What a session's user agent says, in the two words the page shows ("Mac ·
// Safari"). Deliberately small; the order of the tests is what matters:
//   os: iPhone and iPad before Mac (both say "like Mac OS X"); Android and
//       Chrome OS before Linux (both say Linux / X11). An iPad that asks for
//       desktop pages (iPadOS) says Macintosh and is accepted as a Mac.
//   browser: Edge (Edg/, EdgA/ on Android, EdgiOS/ on iPhone), Opera (OPR/),
//       Samsung Internet, Chrome on iPhone (CriOS/) and Firefox on iPhone
//       (FxiOS/) all say Chrome and/or Safari too, so they come first; Chrome
//       says Safari, so it comes before Safari.
// Nothing from the user agent is passed through: the answer is one of these
// fixed words, so a crafted user agent can never put text on the page.
function deviceOf(ua: string): { os: string; browser: string } {
  const s = String(ua || "").slice(0, 1000);
  const has = (re: RegExp) => re.test(s);
  const os = has(/iPhone|iPod/) ? "iPhone"
    : has(/iPad/) ? "iPad"
    : has(/Android/) ? "Android"
    : has(/CrOS/) ? "Chrome OS"
    : has(/Windows/) ? "Windows"
    : has(/Macintosh|Mac OS X/) ? "Mac"
    : has(/Linux|X11/) ? "Linux"
    : "Unknown device";
  const browser = has(/Edg(e|A|iOS)?\//) ? "Edge"
    : has(/OPR\/|Opera/) ? "Opera"
    : has(/SamsungBrowser\//) ? "Samsung Internet"
    : has(/CriOS\//) ? "Chrome"
    : has(/FxiOS\//) ? "Firefox"
    : has(/Firefox\//) ? "Firefox"
    : has(/Chrome\/|Chromium\//) ? "Chrome"
    : has(/Safari\//) ? "Safari"
    : "Browser";
  return { os, browser };
}
const isoOf = (v: unknown): string | null => { const t = Date.parse(String(v ?? "")); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
// One PostgREST call to a service-role-only SQL function (public._…): the
// decoded JSON answer, or a thrown Error (the caller answers 502).
async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: ADMIN, body: JSON.stringify(args), signal: AbortSignal.timeout(5000) });
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`${fn} answered ${r.status}`); }
  return await r.json();
}
// GET /security/devices and POST /security/devices/signout {id}: the reader's
// own Supabase sessions (auth.sessions, through the two service-role SQL
// functions in supabase/migrations/20261022_sessions.sql). The page shows
// "Mac · Safari", "This device", the two times, and a Sign out button on every
// other device.
//
// Unlike the other changes on this page these two routes have no
// recent-sign-in gate and make no WorkOS call. Why that is safe:
//  - the list carries only the device type, the browser and two times (never
//    the user agent, the address, or anything typed), and only the reader's
//    own sessions: the user id for both SQL calls is the checked token's;
//  - ending one of the reader's OWN other sessions is the same power the page
//    already has with "Sign out everywhere else" (supabase.auth.signOut scope
//    "others", no bridge, no gate), and it can only shorten what a stolen
//    token could do; the one session it cannot end is the current one (409
//    "current": that is Sign out at the top of the page), so a stolen token
//    cannot use it to lock its owner out of the device they are using.
// Which session is "this device" comes from the token's session_id claim,
// never from the page. 502, in plain words, when the SQL function is missing
// (migration not applied) or fails.
//
// A brake on request loops (security() applies it before calling here): at
// most DEVICES_PER_MIN calls a minute per reader, counted in this isolate (a
// new isolate starts from zero, so it is a brake, not a quota), 429 in plain
// words above it. The other /security routes have their own limits (the
// wrong-code counter, the one-a-minute password gap); these two had none, and
// a signout loop with random ids would run a DELETE per request. Keyed by the
// checked reader, not the address: readers behind one shared address (an
// office) must not throttle one another. One page visit makes one or two calls.
const DEVICES_PER_MIN = 60;
const devHits = new Map<string, { n: number; until: number }>();
function devicesThrottled(userId: string): boolean {
  const now = Date.now();
  if (devHits.size > 5000) for (const [k, v] of devHits) if (v.until <= now) devHits.delete(k);
  const h = devHits.get(userId);
  if (!h || h.until <= now) { devHits.set(userId, { n: 1, until: now + 60_000 }); return false; }
  h.n++;
  return h.n > DEVICES_PER_MIN;
}
async function devices(req: Request, path: string, origin: string | null, user: Record<string, any>, sessionId: string | null): Promise<Response> {
  const now = new Date().toISOString();
  try {
    if (path === "/security/devices") {
      const rows = await rpc("_sessions_for", { p_user: user.id });
      const list = (Array.isArray(rows) ? rows : [])
        .filter((row) => row && typeof row.id === "string" && UUID.test(row.id))
        .map((row) => {
          const current = !!sessionId && row.id.toLowerCase() === sessionId;
          const signed_in = isoOf(row.created_at) ?? now;
          // this very request is activity: the current device is active now
          return { id: row.id.toLowerCase(), current, ...deviceOf(String(row.user_agent ?? "")), last_active: current ? now : (isoOf(row.last_active) ?? signed_in), signed_in };
        })
        .sort((a, b) => Date.parse(b.last_active) - Date.parse(a.last_active));
      // The reader's own device is always shown. Belt and braces: the auth
      // server checks the token's session_id row on every call and refuses the
      // token (403 session_not_found -> 401 reauth above) once that row is gone,
      // so this branch is not reached on the live project; an auth server that
      // does not check the row would still list this device, from this request.
      if (sessionId && !list.some((d) => d.current)) {
        list.unshift({ id: sessionId, current: true, ...deviceOf(req.headers.get("user-agent") ?? ""), last_active: now, signed_in: now });
      }
      return json({ devices: list }, 200, origin);
    }
    const body = await readJson(req);
    const id = typeof body.id === "string" && UUID.test(body.id) ? body.id.toLowerCase() : null;
    if (!id) return json({ error: "That device could not be found.", code: "not_found" }, 400, origin);
    if (id === sessionId) return json({ error: "To sign out this device, use Sign out at the top of the page.", code: "current" }, 409, origin);
    const ended = Number(await rpc("_end_session", { p_user: user.id, p_session: id }));
    // Both ids are uuids (no secret, no address, nothing typed), logged so
    // "who ended which session, when" can be read back from the function logs.
    if (!(ended > 0)) {
      console.log("[workos-auth] session not ended (not this reader's):", user.id, id);
      return json({ error: "That device could not be found.", code: "not_found" }, 400, origin);
    }
    console.log("[workos-auth] session ended:", user.id, id);
    return json({ ended: true }, 200, origin);
  } catch (e) {
    console.error("[workos-auth] devices:", (e as Error).message);
    return json({ error: path === "/security/devices" ? "We couldn't list your devices just now. Try again in a minute."
                                                       : "That device couldn't be signed out just now. Try again in a minute." }, 502, origin);
  }
}

async function security(req: Request, path: string, origin: string | null): Promise<Response> {
  let r: Awaited<ReturnType<typeof readerFrom>>;
  try { r = await readerFrom(req); }
  catch (e) {
    console.error("[workos-auth] security: reader check failed:", (e as Error).message);
    return json({ error: "Security settings are unavailable right now. Try again in a minute." }, 502, origin);
  }
  if (!r) return json({ error: "Your session has ended. Sign in again to see your security settings.", code: "reauth" }, 401, origin);
  const { user } = r;
  // The signed-in devices: no WorkOS account needed and no recent-sign-in gate (why: see devices()).
  if (path === "/security/devices" || path === "/security/devices/signout") {
    if (devicesThrottled(user.id)) return json({ error: "Too many requests. Wait a minute, then try again.", code: "slow_down" }, 429, origin);
    return devices(req, path, origin, user, r.sessionId);
  }
  const email = String(user.email).toLowerCase();
  const am: Record<string, any> = user.app_metadata || {};
  const recent = Date.now() / 1000 - r.signedInAt < RECENT_SIGN_IN_S;
  const view = { method: am.auth_method || null, strong: am.strong_auth === true, recent,
                 signed_in_at: am.signed_in_at || null, password_set_at: am.password_set_at || null };
  // Changes need a recent sign-in through the bridge; checked first, before any WorkOS call.
  if (path !== "/security" && !recent) return json({
    error: path === "/security/password" ? "For your safety, sign in again before changing your password."
                                          : "For your safety, sign in again before changing two-step verification.",
    code: "reauth" }, 403, origin);
  try {
    const wu = await workosUserFor(user, path !== "/security");
    if (!wu) {
      if (path === "/security") return json({ workos: false, totp: { on: false }, ...view }, 200, origin);
      return json({ error: "Sign out, then sign in again with the Attacked.ai sign-in page first. Then try again.", code: "no_workos" }, 409, origin);
    }
    const factors = await listFactors(wu.id);
    const factor = factors.find((f) => f.id === am.mfa_factor_id) || factors[0] || null;
    if (path === "/security") {
      const since = factor ? (factor.id === am.mfa_factor_id && am.mfa_since) || factor.created_at || null : null;
      // ?full=1 (the Login and security page; the site-wide nudge never asks):
      // the methods this reader has signed in with, and WorkOS's identities
      // list, read-only and best effort (null when it cannot be read: a thrown
      // error here would turn the whole status into a 502). idp_id is dropped.
      let login: { identities: { provider: string }[] | null; methods: string[] } | undefined;
      if (new URL(req.url).searchParams.get("full") === "1") {
        const methods: string[] = (Array.isArray(am.methods_used) ? am.methods_used : (am.auth_method ? [am.auth_method] : []))
          .filter((m: unknown) => typeof m === "string" && /^[A-Za-z]+$/.test(m));
        let identities: { provider: string }[] | null;
        try {
          const j = await workosCall("GET", `/user_management/users/${encodeURIComponent(wu.id)}/identities`, undefined, 4000);
          const list: any[] = Array.isArray(j) ? j : (Array.isArray((j as any).data) ? (j as any).data : []);   // bare array per the reference; {data} tolerated
          identities = list.map((i) => ({ provider: String(i?.provider || "") })).filter((i) => /^[A-Za-z]+$/.test(i.provider));
        } catch (e) { console.warn("[workos-auth] identities not listed:", (e as Error).message); identities = null; }
        login = { identities, methods };
      }
      return json({ workos: true, totp: { on: !!factor, since }, ...view, ...(login ? { login } : {}) }, 200, origin);
    }
    const body = await readJson(req);

    if (path === "/security/totp/start") {
      if (factor) return json({ error: "Two-step verification is already on.", code: "state_changed" }, 409, origin);
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
      if (factor) return json({ error: "Two-step verification is already on.", code: "state_changed" }, 409, origin);
      const code = sixDigits(body.code), secret = await openSetup(String(body.setup || ""), user.id);
      if (!secret) return json({ error: "That set-up has expired. Start again and scan the new code." }, 400, origin);
      if (!code) return json({ error: "Enter the 6-digit code from your authenticator app." }, 400, origin);
      if (!(await reserveAttempt(user.id))) return json({ error: "Too many wrong codes. Wait 10 minutes, then try again." }, 429, origin);
      if (!(await totpMatches(secret, code))) return json({ error: "That code didn't match. Use the newest code in the app, and check your phone's clock is set automatically." }, 400, origin);
      if ((await listFactors(wu.id)).length) return json({ error: "Two-step verification is already on.", code: "state_changed" }, 409, origin);   // a second tab got there first
      const made = await workosCall("POST", `/user_management/users/${encodeURIComponent(wu.id)}/auth_factors`, { type: "totp", totp_issuer: TOTP_ISSUER, totp_user: email, totp_secret: secret });
      const f = made.authentication_factor || {};
      if (!f.id) throw new Error("WorkOS returned no factor");
      // Verify the new factor at WorkOS too (challenge + verify, same code), so
      // WorkOS holds it as a verified factor exactly as a hosted-page enrolment
      // would. Any failure deletes it again: never a half-made factor, and no
      // extra attempt is used (the one above covers this code). If that delete
      // fails as well, the factor is live at WorkOS whatever we say: note it on
      // the account, tell the reader, and answer "already on" so the page shows
      // the truth (the reader can turn it off with the same app entry).
      const dropFactor = async (why: string): Promise<boolean> => {
        try { await workosCall("DELETE", `/auth/factors/${encodeURIComponent(String(f.id))}`); return true; }
        catch (e2) { console.warn("[workos-auth] unverified factor not deleted:", String(f.id), why, (e2 as Error).message); return false; }
      };
      const keepFactor = async (): Promise<Response> => {
        try { await setAppMeta(user.id, { mfa_factor_id: f.id, mfa_since: new Date().toISOString() }); }
        catch (e2) { console.warn("[workos-auth] factor left at WorkOS, not noted on the account:", (e2 as Error).message); }
        await tellReaderSoon(email, true);
        return json({ error: "Two-step verification is already on.", code: "state_changed" }, 409, origin);
      };
      let verified = false;
      try { verified = await verifyWithWorkos(String(f.id), code); }
      catch (e) { if (await dropFactor("challenge failed")) throw e; return keepFactor(); }
      if (!verified) {
        // The code was right by our own check (the secret is ours), so this is
        // WorkOS's clock window, not a guess: it costs no attempt.
        await clearAttempts(user.id);
        if (!(await dropFactor("code not accepted"))) return keepFactor();
        return json({ error: "That code has just expired. Type the next code the app shows and try again." }, 400, origin);
      }
      await clearAttempts(user.id);
      try { await setAppMeta(user.id, { mfa_factor_id: f.id, mfa_since: new Date().toISOString() }); }
      catch (e) { console.warn("[workos-auth] factor saved at WorkOS, not noted on the account:", (e as Error).message); }
      await tellReaderSoon(email, true);
      return json({ totp: { on: true } }, 200, origin);
    }
    if (path === "/security/totp/remove") {
      if (!factor) return json({ error: "Two-step verification is not on.", code: "state_changed" }, 409, origin);
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
    // Set or change the WorkOS password. The address is always the session's
    // verified email (nothing in the body chooses the account). Cheap local
    // checks first; when two-step is on, a live authenticator code is checked
    // through the shared attempt counter (step-up); then the one WorkOS write.
    // WorkOS has no current-password check: the recent-sign-in gate above and
    // the step-up are the substitute, and the reader is emailed about it.
    // One change a minute per account (password_set_at is service-role only):
    // every change is a WorkOS write and an email from the shared sender, so
    // a signed-in script must not be able to run either dry for everyone.
    // The password is never logged or echoed.
    if (path === "/security/password") {
      const pw = body.password;
      if (typeof pw !== "string" || pw.length < 10) return json({ error: "Use at least 10 characters.", code: "weak_password" }, 400, origin);
      if (pw.length > 128) return json({ error: "That password is too long (128 characters at most).", code: "weak_password" }, 400, origin);
      const low = pw.toLowerCase(), local = email.split("@")[0];
      if (low.includes(email) || (local.length >= 4 && low.includes(local))) return json({ error: "Don't use your email address in your password.", code: "weak_password" }, 400, origin);
      const lastSet = Date.parse(String(am.password_set_at || ""));
      if (Number.isFinite(lastSet) && Date.now() - lastSet < PASSWORD_CHANGE_GAP_MS) return json({ error: "Too many changes in a short time. Wait a minute, then try again." }, 429, origin);
      if (factor) {
        const code = sixDigits(body.code);
        if (!code) return json({ error: "Two-step verification is on, so type the current code from your authenticator app too.", code: "code_required" }, 400, origin);
        if (!(await reserveAttempt(user.id))) return json({ error: "Too many wrong codes. Wait 10 minutes, then try again." }, 429, origin);
        if (!(await verifyWithWorkos(factor.id, code))) return json({ error: "That code didn't match. Use the newest code in the app." }, 400, origin);
        await clearAttempts(user.id);
      }
      try { await workosCall("PUT", `/user_management/users/${encodeURIComponent(wu.id)}`, { password: pw }); }
      catch (e) {
        const s = (e as WorkOSError).status;
        if (s === 400 || s === 422) return json({ error: "That password is too easy to guess. Try a longer phrase that isn't a common word, your name or your email.", code: "weak_password" }, 400, origin);
        if (s === 429) return json({ error: "Too many changes in a short time. Wait a minute, then try again." }, 429, origin);
        throw e;   // the catch below: 502
      }
      try { await setAppMeta(user.id, { password_set_at: new Date().toISOString() }); }
      catch (e) { console.warn("[workos-auth] password set at WorkOS, not noted on the account:", (e as Error).message); }
      await tellReaderSoon(email, "password");
      console.log("[workos-auth] password set");
      return json({ password: { set: true } }, 200, origin);
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
  // WorkOS has emailed the code (its Magic Auth email), unless we send ours.
  if (OWN_CODE_EMAIL) {
    try {
      await sendMail(email, codeEmail(String(magic.code || "")));
    } catch (e) {
      console.error("[workos-auth] code email failed:", (e as Error).message);
      return json({ error: "We could not send the code email. Try again in a minute." }, 502, origin);
    }
  }
  return json({ sent: true, length: 6, expires_in: 600 }, 200, origin);
}

// A name typed on the sign-up page: no control characters, at most 100 characters.
const cleanName = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
// reason: "two_step" (the account has a second step) or "hosted" (WorkOS
// needs its own page for something else, or the check could not be made).
const useHosted = (reason: "two_step" | "hosted", origin: string | null) =>
  json({ error: "Please finish on the secure sign-in page.", code: "use_hosted", reason }, 409, origin);

async function emailVerify(req: Request, origin: string | null): Promise<Response> {
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const first = cleanName(body.first_name), last = cleanName(body.last_name);
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
    if (HOSTED_ONLY.has(err.code)) return useHosted(err.code === "mfa_challenge" ? "two_step" : "hosted", origin);
    return json({ error: "That code didn't match or has expired. Use the code from the newest email, or ask for a new one." }, 400, origin);
  }
  const u = auth.user || {};
  await endWorkosSession(auth.access_token);
  if (String(u.email || "").toLowerCase() !== email || u.email_verified !== true) {
    return json({ error: "We couldn't confirm that email address." }, 400, origin);
  }
  const step = await secondStep(String(u.id || ""));
  if (step !== "none") return useHosted(step === "two_step" ? "two_step" : "hosted", origin);
  // The name typed on the page, for a WorkOS account that has none yet (so
  // WorkOS's emails and dashboard show it too). Best effort.
  const named = { ...u, first_name: u.first_name || first, last_name: u.last_name || last };
  if ((first || last) && !u.first_name && !u.last_name) {
    try {
      await workosCall("PUT", `/user_management/users/${encodeURIComponent(String(u.id))}`, { ...(first ? { first_name: first } : {}), ...(last ? { last_name: last } : {}) }, 4000);
    } catch (e) { console.warn("[workos-auth] name not saved at WorkOS:", (e as Error).message); }
  }
  try {
    return json(await supabaseToken(email, metaOf(named), { workosUserId: String(u.id || ""), method: String(auth.authentication_method || "MagicAuth") }), 200, origin);
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
  // this before sending anyone off to WorkOS). signup_form: the sign-up page's
  // routes are on (an older bridge says nothing: the page then signs up on
  // the hosted page instead).
  const configured = !!(Deno.env.get("WORKOS_API_KEY") ?? "").trim();
  return new Response(JSON.stringify({ providers: list, configured, signup_form: SIGNUP_FORM }), {
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
  return trip(provider, target, url.searchParams.get("screen_hint"), url.searchParams.get("login_hint"));
}

// Off to WorkOS. The signed cookie remembers the page to come back to, the
// state, and whether the trip skips the hosted page (d: a direct provider).
async function trip(provider: string, target: string, screen: string | null, hint: string | null): Promise<Response> {
  const state = random();
  const payload = b64url(enc.encode(JSON.stringify({ s: state, t: target, e: Date.now() + 30 * 60_000, d: provider !== "authkit" })));
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: CALLBACK, response_type: "code", provider, state });
  if (hint && EMAIL.test(hint) && hint.length <= 254) q.set("login_hint", hint);
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
  let target = `${DEFAULT_SITE}/?dashboard`, state = "", direct = true;
  const raw = cookieOf(req);
  if (raw) {
    const [payload, sig] = raw.split(".");
    if (payload && sig && await safeEqual(sig, await hmac(payload))) {
      try {
        const c = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
        if (typeof c.t === "string" && typeof c.s === "string" && c.e > Date.now() && allowed(new URL(c.t).origin)) { target = c.t; state = c.s; direct = c.d !== false; }
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
  // A direct trip (the sign-up page's Google / Microsoft) that WorkOS or the
  // account says needs the hosted page: straight on to the hosted sign-in,
  // same page to come back to. Its new cookie replaces this trip's.
  const hosted = (hint: unknown) => trip("authkit", target, "sign-in", typeof hint === "string" ? hint.trim().toLowerCase() : null);
  try {
    auth = await authenticate({ grant_type: "authorization_code", code, ...(clientIp(req) ? { ip_address: clientIp(req) } : {}), user_agent: (req.headers.get("user-agent") ?? "").slice(0, 400) });
  } catch (e) {
    const err = e as WorkOSError;
    console.warn("[workos-auth] provider sign-in refused:", err.message, err.code);
    if (direct && HOSTED_ONLY.has(err.code)) return hosted(err.body?.user?.email ?? err.body?.email);
    return done(back(site, err.code === "not_configured" ? "unavailable" : "workos"));
  }
  const u = auth.user || {};
  await endWorkosSession(auth.access_token);
  const email = String(u.email || "").trim().toLowerCase();
  if (!EMAIL.test(email) || u.email_verified !== true) return done(back(site, "unverified"));
  if (direct && await secondStep(String(u.id || "")) !== "none") return hosted(email);
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
    if (!SIGNUP_FORM && url.searchParams.get("provider") !== "authkit") {
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
    // GET only for the two reads (the status and the devices list), POST for every change.
    const read = path === "/security" || path === "/security/devices";
    if (read ? req.method !== "GET" : req.method !== "POST") return json({ error: "method not allowed" }, 405, origin);
    return security(req, path, origin);
  }

  if ((path === "/email/start" || path === "/email/verify") && !SIGNUP_FORM) return json({ error: "not found" }, 404, allowed(origin) ? origin : null);
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
