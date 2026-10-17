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
//
// Secrets (Edge Functions -> Secrets): WORKOS_API_KEY. WORKOS_CLIENT_ID defaults
// to the Staging client. GMAIL_USER / GMAIL_APP_PASSWORD / SENDER_NAME are the
// ones welcome-email already uses. SUPABASE_SERVICE_ROLE_KEY is built in.
//
// Deployed with verify_jwt = false: browsers call it directly. Every route checks
// the page's origin against ORIGINS (no open redirects, no other site can use it),
// and a provider round trip is bound to the browser that started it by a signed,
// HttpOnly cookie.
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

// Pages allowed to use this function: the live site, its Vercel previews, and
// the local dev servers. WORKOS_ALLOWED_ORIGINS adds more (comma-separated).
const ORIGINS = new Set([
  DEFAULT_SITE, "http://localhost:5173", "http://localhost:5180",
  ...(Deno.env.get("WORKOS_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);
const PREVIEW = /^https:\/\/attackedmap-[a-z0-9-]+-mohiawrai2609s-projects\.vercel\.app$/;
const allowed = (origin: string | null) => !!origin && (ORIGINS.has(origin) || PREVIEW.test(origin));

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type",
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
async function supabaseToken(email: string, meta: Record<string, unknown>): Promise<{ token_hash: string; type: string }> {
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
  return { token_hash, type: link.verification_type || link.properties?.verification_type || "magiclink" };
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
    return json(await supabaseToken(email, metaOf(u)), 200, origin);
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
  const payload = b64url(enc.encode(JSON.stringify({ s: state, t: target, e: Date.now() + 10 * 60_000 })));
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: CALLBACK, response_type: "code", provider, state });
  const hint = url.searchParams.get("login_hint");
  if (hint && EMAIL.test(hint)) q.set("login_hint", hint);
  const screen = url.searchParams.get("screen_hint");
  if (provider === "authkit" && (screen === "sign-up" || screen === "sign-in")) q.set("screen_hint", screen);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${WORKOS}/user_management/authorize?${q}`,
      "Set-Cookie": `${COOKIE}=${payload}.${await hmac(payload)}; Path=${COOKIE_PATH}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
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
    const t = await supabaseToken(email, metaOf(u));
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
  if (req.method === "GET" && path === "/start") return providerStart(url);
  if (req.method === "GET" && path === "/callback") return providerCallback(req, url);

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
