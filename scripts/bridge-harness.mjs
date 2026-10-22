// Run the REAL workos-auth bridge (index.ts) in Node against simulated
// Supabase (GoTrue admin + PostgREST rpc) and WorkOS APIs, and walk every route.
// No network: fetch is replaced. Works from any cwd (esbuild is resolved
// through the repo's package.json).
//   node scripts/bridge-harness.mjs [path-to-index.ts]
// Expected: every check "ok", "N passed, 0 failed". The "[workos-auth] QR code
// not drawn: ... 'npm:'" warning is normal in Node (no npm: specifier).
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const { transformSync } = createRequire("D:/attacked-dev/wt-cards/package.json")("esbuild");
const FILE = process.argv[2] || "D:/attacked-dev/wt-cards/supabase/functions/workos-auth/index.ts";

// ── simulated world ──
const SB = "https://ovenyjguhkgiceddzwna.supabase.co";
const ENV = { WORKOS_API_KEY: "test_key", SUPABASE_SERVICE_ROLE_KEY: "service_test", GMAIL_USER: "bot@example.com", GMAIL_APP_PASSWORD: "x",
  WORKOS_ALLOWED_ORIGINS: " https://attackedmap-test123-mohiawrai2609s-projects.vercel.app/ , not a url" };
const mail = [];
const sbUsers = new Map();       // id -> { id, email, email_confirmed_at, app_metadata, user_metadata }
const tokens = new Map();        // access token -> user id
const wosUsers = new Map();      // id -> { id, email, email_verified }
const factors = new Map();       // factor id -> { id, user_id, secret, created_at }
const challenges = new Map();    // challenge id -> factor id
const attempts = new Map();      // user id -> { n, start }
const calls = [];
let fail = {};                   // switches: { gotrue, gotrue500, challenge, verifyInvalid, adminPut, slowPut, resetPut, rpc, factors, relistAt, identities, put, put429, delete }
let nextId = 1;
const id = (p) => `${p}_${String(nextId++).padStart(4, "0")}`;

const b32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const b32d = (s) => { let bits = 0, v = 0; const o = []; for (const c of s) { v = (v << 5) | b32.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const totp = (secret, t = Date.now()) => { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 30000))); const h = crypto.createHmac("sha1", b32d(secret)).update(c).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0"); };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64u({ alg: "HS256" })}.${b64u(payload)}.sig`;
const res = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function addSbUser(email, extra = {}) { const u = { id: crypto.randomUUID(), email, email_confirmed_at: "2026-10-01T00:00:00Z", app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, ...extra }; sbUsers.set(u.id, u); return u; }
function session(user, amr) { const t = jwt({ sub: user.id, amr }); tokens.set(t, user.id); return t; }

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || "";
  calls.push(`${method} ${url.host}${url.pathname}`);
  if (url.origin === SB) {
    if (url.pathname === "/auth/v1/user") {
      if (fail.gotrue) throw new TypeError("network down");
      if (fail.gotrue500) return res(500, { msg: "boom" });
      const uid = tokens.get(auth.replace(/^Bearer /, ""));
      return uid ? res(200, sbUsers.get(uid)) : res(401, { msg: "bad jwt" });
    }
    if (auth !== `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`) return res(401, { msg: "not service role" });
    if (url.pathname === "/auth/v1/admin/users" && method === "POST") {
      if ([...sbUsers.values()].some((u) => u.email === body.email)) return res(422, { msg: "exists" });
      const u = addSbUser(body.email, { user_metadata: body.user_metadata }); return res(200, u);
    }
    if (url.pathname === "/auth/v1/admin/generate_link") {
      const u = [...sbUsers.values()].find((x) => x.email === body.email);
      world.links = (world.links || 0) + 1;
      return res(200, { ...u, hashed_token: "hash_" + u.id.slice(0, 8), verification_type: "magiclink", action_link: "x" });   // flat, like GoTrue
    }
    const m = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
    if (m && method === "PUT") {
      if (fail.adminPut) return res(500, {});
      if (fail.slowPut) return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason || new Error("aborted"))));
      const u = sbUsers.get(decodeURIComponent(m[1]));
      if (fail.resetPut && body.password) return res(500, {});
      for (const [k, v] of Object.entries(body.app_metadata || {})) { if (v === null) delete u.app_metadata[k]; else u.app_metadata[k] = v; }   // GoTrue merges per key
      for (const [k, v] of Object.entries(body.user_metadata || {})) { if (v === null) delete u.user_metadata[k]; else u.user_metadata[k] = v; }
      if (body.password) { u.password = body.password; world.pwResets = (world.pwResets || 0) + 1; }
      if (body.email_confirm) u.email_confirmed_at = new Date().toISOString();
      return res(200, u);
    }
    if (url.pathname === "/rest/v1/rpc/_mfa_attempt") {
      if (fail.rpc) return res(404, { code: "PGRST202" });
      const { p_user, p_ok } = body;
      if (p_ok) { attempts.delete(p_user); return res(200, 0); }
      const a = attempts.get(p_user);
      if (!a || a.start < Date.now() - 600000) { attempts.set(p_user, { n: 1, start: Date.now() }); return res(200, 1); }
      a.n++; return res(200, a.n);
    }
    return res(404, { msg: "no such sb route " + url.pathname });
  }
  if (url.host === "api.workos.com") {
    const p = url.pathname;
    if (p === "/user_management/authorize") return new Response(null, { status: 302, headers: { location: "https://progressive-camp-95-staging.authkit.app/..." } });
    if (p === "/user_management/authenticate") {
      if (world.authError) return res(world.authError.status || 403, world.authError.body);
      if (body.grant_type === "urn:workos:oauth:grant-type:magic-auth:code") {
        if (body.code !== "123456") return res(400, { code: "invalid_one_time_code" });
        let w = [...wosUsers.values()].find((x) => x.email === body.email);
        if (!w) { w = { id: id("user"), email: body.email, email_verified: true, first_name: null, last_name: null }; wosUsers.set(w.id, w); }
        return res(200, { user: w, authentication_method: "MagicAuth", access_token: jwt({ sid: "session_m" }) });
      }
      const w = wosUsers.get(world.signInAs);
      return res(200, { user: w, authentication_method: world.method || "Password", access_token: jwt({ sid: "session_1" }) });
    }
    if (p === "/user_management/sessions/revoke") { world.revoked = (world.revoked || 0) + 1; return res(200, {}); }
    if (auth !== `Bearer ${ENV.WORKOS_API_KEY}`) return res(401, {});
    if (p === "/user_management/magic_auth") { world.magic.push(body); return res(201, { id: id("magic_auth"), email: body.email, code: "123456" }); }
    let m;
    if ((m = p.match(/^\/user_management\/users\/([^/]+)\/auth_factors$/))) {
      const uid = decodeURIComponent(m[1]);
      if (method === "GET") {
        if (fail.factors) return res(500, { code: "server_error" });
        world.factorGets = (world.factorGets || 0) + 1;
        const list = [...factors.values()].filter((f) => f.user_id === uid).map(({ secret, ...f }) => f);
        if (fail.relistAt && world.factorGets >= fail.relistAt) list.push({ id: "auth_factor_other_tab", user_id: uid, type: "totp" });
        return res(200, { data: list });
      }
      const f = { id: id("auth_factor"), user_id: uid, type: "totp", secret: body.totp_secret, created_at: new Date().toISOString() };
      factors.set(f.id, f); world.enrolled.push(body);
      return res(201, { authentication_factor: { ...f, secret: undefined }, authentication_challenge: { id: id("auth_challenge") } });
    }
    if ((m = p.match(/^\/user_management\/users\/([^/]+)\/identities$/))) {
      if (fail.identities) return res(500, { code: "server_error" });
      world.identityGets = (world.identityGets || 0) + 1;
      const w = wosUsers.get(decodeURIComponent(m[1]));
      if (!w) return res(404, {});
      return world.identityWrap ? res(200, { data: w.identities || [] }) : res(200, w.identities || []);   // bare array per the reference; {data} variant for tolerance
    }
    if ((m = p.match(/^\/user_management\/users\/([^/]+)$/))) {
      const w = wosUsers.get(decodeURIComponent(m[1]));
      if (w && method === "PUT") {
        if ("password" in body) {   // a password set: record shape and length only, never the clear text
          world.passwordPuts.push({ id: w.id, keys: Object.keys(body), len: String(body.password || "").length });
          if (body.password === "weakweakweak") return res(422, { code: "password_strength_error" });
          if (fail.put) return res(500, {});
          if (fail.put429) return res(429, { code: "rate_limit" });
          const { password: _pw, ...rest } = body;
          Object.assign(w, rest);
          return res(200, w);
        }
        world.renamed.push({ id: w.id, ...body }); Object.assign(w, body);
      }
      return w ? res(200, w) : res(404, {});
    }
    if (p === "/user_management/users") { const e = url.searchParams.get("email"); return res(200, { data: [...wosUsers.values()].filter((w) => w.email === e) }); }
    if ((m = p.match(/^\/auth\/factors\/([^/]+)\/challenge$/))) {
      if (fail.challenge) return res(500, { code: "server_error" });
      if (!factors.has(decodeURIComponent(m[1]))) return res(404, {});
      const c = id("auth_challenge"); challenges.set(c, decodeURIComponent(m[1])); return res(201, { id: c });
    }
    if ((m = p.match(/^\/auth\/challenges\/([^/]+)\/verify$/))) {
      const fid = challenges.get(decodeURIComponent(m[1])), f = factors.get(fid);
      world.verifies.push({ factor: fid || null });
      if (fail.verifyInvalid) return res(200, { challenge: {}, valid: false });
      return res(200, { challenge: {}, valid: !!f && body.code === totp(f.secret) });
    }
    if ((m = p.match(/^\/auth\/factors\/([^/]+)$/)) && method === "DELETE") {
      if (fail.delete) return res(500, { code: "server_error" });
      factors.delete(decodeURIComponent(m[1])); return new Response(null, { status: 204 });
    }
    return res(404, { msg: "no such workos route " + p });
  }
  throw new Error("unexpected fetch " + url);
};
const world = { signInAs: null, method: "Password", enrolled: [], magic: [], renamed: [], passwordPuts: [], verifies: [], identityGets: 0, identityWrap: false };

// ── load the real bridge ──
let handler;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
let src = fs.readFileSync(FILE, "utf8").replace(/^import \{ SMTPClient \} from .*$/m,
  "class SMTPClient { constructor(o) {} async send(m) { if (globalThis.__smtpHang) return new Promise(() => {}); globalThis.__mail.push(m); } async close() {} }");
globalThis.__mail = mail;
const js = transformSync(src, { loader: "ts", format: "esm" }).code;
let loads = 0;
// Loads a fresh copy of the bridge (settings are read at load) and returns its handler.
async function loadBridge(extraEnv = {}) {
  const saved = { ...ENV };
  Object.assign(ENV, extraEnv);
  handler = null;
  await import("data:text/javascript;base64," + Buffer.from(js + `\n// load ${loads++}`).toString("base64"));
  for (const k of Object.keys(ENV)) if (!(k in saved)) delete ENV[k];
  Object.assign(ENV, saved);
  if (!handler) throw new Error("Deno.serve was not called");
  return handler;
}
await loadBridge();

const BASE = `${SB}/functions/v1/workos-auth`;
const SITE = "https://attackedmap.vercel.app";
const PREVIEW = "https://attackedmap-evil-mohiawrai2609s-projects.vercel.app";
const call = (path, { method = "GET", origin = SITE, token, body, cookie } = {}) => handler(new Request(BASE + path, {
  method, headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual",
}));
let fails = 0, passes = 0;
const check = (name, ok, extra = "") => { ok ? passes++ : fails++; console.log(ok ? "ok  " : "FAIL", name, ok ? "" : extra); };
const J = async (r) => { try { return await r.clone().json(); } catch { return null; } };

// ── 1. origins, CORS, providers ──
let r = await call("/security", { method: "OPTIONS" });
check("preflight from the live site: 204", r.status === 204);
check("preflight allows authorization + POST", /authorization/.test(r.headers.get("access-control-allow-headers") || "") && /POST/.test(r.headers.get("access-control-allow-methods") || ""));
r = await call("/security", { method: "OPTIONS", origin: PREVIEW });
check("SEC-1: look-alike Vercel preview origin refused (403)", r.status === 403, r.status);
r = await call("/security", { method: "OPTIONS", origin: "http://localhost:5173" });
check("localhost:5173 still allowed (owner tests there)", r.status === 204);
r = await call("/providers");
let j = await J(r);
check("/providers 200 + configured:true", r.status === 200 && j.configured === true && j.providers.includes("authkit"), JSON.stringify(j));
check("/providers CORS for the live site", r.headers.get("access-control-allow-origin") === SITE);
r = await call("/providers", { origin: PREVIEW });
check("/providers gives no CORS to a look-alike origin", !r.headers.get("access-control-allow-origin"));

// ── 2. start ──
r = await call(`/start?provider=authkit&screen_hint=sign-in&redirect=${encodeURIComponent(SITE + "/?dashboard#junk")}`, { origin: null });
const loc = r.headers.get("location") || "", setCookie = r.headers.get("set-cookie") || "";
check("start: 302 to WorkOS authorize", r.status === 302 && loc.startsWith("https://api.workos.com/user_management/authorize?") && /screen_hint=sign-in/.test(loc), loc);
check("start: round-trip cookie 30 min, HttpOnly, Secure", /Max-Age=1800/.test(setCookie) && /HttpOnly/.test(setCookie) && /Secure/.test(setCookie), setCookie);
const cookie = setCookie.split(";")[0];
const state = new URL(loc).searchParams.get("state");
const ck = JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[0], "base64url").toString());
check("start: target keeps the page, drops the planted #fragment", ck.t === SITE + "/?dashboard", ck.t);
r = await call(`/start?provider=authkit&redirect=${encodeURIComponent(PREVIEW + "/")}`, { origin: null });
const ck2 = JSON.parse(Buffer.from((r.headers.get("set-cookie") || "").split(";")[0].split("=")[1].split(".")[0], "base64url").toString());
check("SEC-1: start with a look-alike redirect falls back to the live site", ck2.t === SITE + "/?dashboard", ck2.t);
r = await call(`/start?provider=GoogleOAuth&redirect=${encodeURIComponent("http://localhost:5173/")}`, { origin: null });
check("sign-up page: direct Google start -> 302 to WorkOS with provider=GoogleOAuth", r.status === 302 && /provider=GoogleOAuth/.test(r.headers.get("location") || "") && !/screen_hint/.test(r.headers.get("location") || ""), r.headers.get("location"));
r = await call(`/start?provider=EvilOAuth&redirect=${encodeURIComponent("http://localhost:5173/")}`, { origin: null });
check("unknown provider -> back to that site with signin_error=unavailable", r.status === 302 && r.headers.get("location") === "http://localhost:5173/?home&signin_error=unavailable", r.headers.get("location"));

// ── 3. callback: new user, then existing user ──
const w = { id: "user_W1", email: "reader@example.com", email_verified: true, first_name: "Rea", last_name: "Der" };
wosUsers.set(w.id, w); world.signInAs = w.id; world.method = "Password";
const t0 = Date.now();
r = await call(`/callback?code=abc&state=${state}`, { origin: null, cookie });
const cb = r.headers.get("location") || "";
check("callback: 302 to the page with #wos_token", r.status === 302 && cb.startsWith(SITE + "/?dashboard#wos_token=hash_") && /wos_type=magiclink/.test(cb), cb);
check("callback: clears the round-trip cookie", /Max-Age=0/.test(r.headers.get("set-cookie") || ""));
const reader = [...sbUsers.values()].find((u) => u.email === w.email);
check("callback: account created with WorkOS names", reader && reader.user_metadata.signup_via === "workos" && reader.user_metadata.full_name === "Rea Der");
check("callback: sign-in stamped (method, WorkOS id, strong=false, time)", reader.app_metadata.auth_method === "Password" && reader.app_metadata.workos_user_id === "user_W1" && reader.app_metadata.strong_auth === false && Math.abs(Date.parse(reader.app_metadata.signed_in_at) - t0) < 5000, JSON.stringify(reader.app_metadata));
check("callback: existing app_metadata kept (provider/providers)", reader.app_metadata.provider === "email" && Array.isArray(reader.app_metadata.providers));
r = await call(`/callback?code=abc&state=${state}`, { origin: null });
check("callback without cookie -> signin_error=expired", (r.headers.get("location") || "").endsWith("signin_error=expired"));
r = await call(`/callback?code=abc&state=WRONG`, { origin: null, cookie });
check("callback with wrong state -> signin_error=workos", (r.headers.get("location") || "").endsWith("signin_error=workos"));
fail.adminPut = true;
r = await call(`/callback?code=abc&state=${state}`, { origin: null, cookie });
check("callback still signs in when the stamp fails", (r.headers.get("location") || "").includes("#wos_token="));
fail.adminPut = false;

// ── 4. security status + the recent-sign-in rule ──
const stampS = Date.parse(reader.app_metadata.signed_in_at) / 1000;
const fresh = session(reader, [{ method: "otp", timestamp: Math.round(stampS) + 3 }]);
r = await call("/security", { token: fresh }); j = await J(r);
check("status: off, recent, method Password", r.status === 200 && j.workos === true && j.totp.on === false && j.recent === true && j.method === "Password", JSON.stringify(j));
const mfaFresh = session(reader, [{ method: "totp", timestamp: Math.round(Date.now() / 1000) }, { method: "otp", timestamp: Math.round(stampS) - 3600 }]);
r = await call("/security", { token: mfaFresh }); j = await J(r);
check("SEC-2: fresh Supabase-MFA amr does NOT count as a recent sign-in", j && j.recent === false, JSON.stringify(j));
const pwFresh = session(reader, [{ method: "password", timestamp: Math.round(Date.now() / 1000) }]);
r = await call("/security", { token: pwFresh }); j = await J(r);
check("SEC-2: fresh Supabase password amr does NOT count", j && j.recent === false);
const oldSession = session(reader, [{ method: "otp", timestamp: Math.round(stampS) - 2 * 3600 }]);
r = await call("/security", { token: oldSession }); j = await J(r);
check("an older bridge session (before the latest stamp) is not recent", j && j.recent === false);
r = await call("/security/totp/start", { method: "POST", token: mfaFresh, body: {} }); j = await J(r);
check("SEC-2: change refused with code reauth (403)", r.status === 403 && j.code === "reauth", r.status);
r = await call("/security", { token: "junk.junk.junk" });
check("bad token -> 401", r.status === 401);
r = await call("/security", { method: "POST", token: fresh });
check("POST /security -> 405", r.status === 405);
fail.gotrue = true;
r = await call("/security", { token: fresh });
check("RT-4: auth server down -> 502 with CORS", r.status === 502 && r.headers.get("access-control-allow-origin") === SITE, r.status);
fail.gotrue = false;
const unconf = addSbUser("new@example.com", { email_confirmed_at: null });
r = await call("/security", { token: session(unconf, [{ method: "otp", timestamp: Math.round(Date.now() / 1000) }]) });
check("unconfirmed email -> 401", r.status === 401);

// ── 5. turn on ──
r = await call("/security/totp/start", { method: "POST", token: fresh, body: {} }); j = await J(r);
check("start: setup blob + 32-char secret + otpauth URI", r.status === 200 && typeof j.setup === "string" && /^[A-Z2-7]{32}$/.test(j.secret) && j.uri.startsWith("otpauth://totp/Attacked.ai:"), JSON.stringify(j).slice(0, 200));
const setup = j.setup, secret = j.secret;
for (let i = 1; i <= 5; i++) {
  r = await call("/security/totp/confirm", { method: "POST", token: fresh, body: { setup, code: "000000" } });
  if (i === 1) check("confirm: wrong code -> 400", r.status === 400);
}
r = await call("/security/totp/confirm", { method: "POST", token: fresh, body: { setup, code: totp(secret) } });
check("confirm: 6th try in 10 min -> 429 even with the right code", r.status === 429, r.status);
attempts.clear();
const other = addSbUser("other@example.com", { app_metadata: { workos_user_id: "user_W1", signed_in_at: reader.app_metadata.signed_in_at } });
wosUsers.set("user_W3", { id: "user_W3", email: "other@example.com", email_verified: true });
other.app_metadata.workos_user_id = "user_W3";
const enrolledBefore = world.enrolled.length;
r = await call("/security/totp/confirm", { method: "POST", token: session(other, [{ method: "otp", timestamp: Math.round(stampS) + 2 }]), body: { setup, code: totp(secret) } });
check("setup blob of one reader is useless to another reader (400, nothing enrolled)", r.status === 400 && world.enrolled.length === enrolledBefore, r.status);
r = await call("/security/totp/confirm", { method: "POST", token: fresh, body: { setup: setup.slice(0, -2) + "xx", code: totp(secret) } });
check("tampered setup blob -> 400", r.status === 400);
mail.length = 0;
r = await call("/security/totp/confirm", { method: "POST", token: fresh, body: { setup, code: totp(secret) } }); j = await J(r);
check("confirm: right code -> on", r.status === 200 && j.totp.on === true, r.status + " " + JSON.stringify(j));
check("WorkOS factor created with OUR secret (no half-made factor)", world.enrolled.length === 1 && world.enrolled[0].totp_secret === secret && world.enrolled[0].type === "totp");
check("app_metadata.mfa_factor_id + mfa_since recorded", !!reader.app_metadata.mfa_factor_id && !!reader.app_metadata.mfa_since);
check("RT-7: email sent with the fixed subject", mail.length === 1 && mail[0].subject === "Two-step verification turned on for your Attacked.ai account", mail[0] && mail[0].subject);
r = await call("/security", { token: fresh }); j = await J(r);
check("status now on", j.totp.on === true && !!j.totp.since);
r = await call("/security/totp/confirm", { method: "POST", token: fresh, body: { setup, code: totp(secret) } });
check("SEC-4: replaying the setup blob -> 409 already on", r.status === 409);
r = await call("/security/totp/start", { method: "POST", token: fresh, body: {} });
check("start while on -> 409", r.status === 409);

// ── 6. turn off ──
r = await call("/security/totp/remove", { method: "POST", token: fresh, body: { code: "123456" === totp(secret) ? "654321" : "123456" } });
check("remove: wrong code -> 400", r.status === 400);
fail.challenge = true;
r = await call("/security/totp/remove", { method: "POST", token: fresh, body: { code: totp(secret) } });
check("RT-3: WorkOS failure -> 502 (not 'wrong code')", r.status === 502, r.status);
fail.challenge = false;
mail.length = 0;
r = await call("/security/totp/remove", { method: "POST", token: fresh, body: { code: totp(secret) } }); j = await J(r);
check("remove: right code -> off", r.status === 200 && j.totp.on === false, r.status);
check("factors deleted at WorkOS", [...factors.values()].filter((f) => f.user_id === "user_W1").length === 0);
check("app_metadata cleared", !("mfa_factor_id" in reader.app_metadata) && !("mfa_since" in reader.app_metadata));
check("email sent: turned off", mail.length === 1 && /turned off/.test(mail[0].subject));

// ── 7. WorkOS account matching (WOS-5) ──
const moved = addSbUser("moved@example.com", { app_metadata: { workos_user_id: "user_W1", signed_in_at: new Date().toISOString() } });
const movedTok = session(moved, [{ method: "otp", timestamp: Math.round(Date.now() / 1000) }]);
r = await call("/security/totp/start", { method: "POST", token: movedTok, body: {} }); j = await J(r);
check("WOS-5: recorded WorkOS id with another email -> 409 no_workos (never guesses)", r.status === 409 && j.code === "no_workos", r.status + " " + JSON.stringify(j));
wosUsers.set("user_W2", { id: "user_W2", email: "nostamp@example.com", email_verified: true });
const nostamp = addSbUser("nostamp@example.com");
r = await call("/security", { token: session(nostamp, [{ method: "otp", timestamp: Math.round(Date.now() / 1000) }]) }); j = await J(r);
check("status may find a v4-era account by email (read-only)", r.status === 200 && j.workos === true && j.recent === false, JSON.stringify(j));
r = await call("/security/totp/start", { method: "POST", token: session(nostamp, [{ method: "otp", timestamp: Math.round(Date.now() / 1000) }]), body: {} }); j = await J(r);
check("change for a v4-era session -> reauth (sign in again once)", r.status === 403 && j.code === "reauth", r.status);
fail.rpc = true;
r = await call("/security/totp/start", { method: "POST", token: fresh, body: {} }); j = await J(r);
const s2 = j.setup, sec2 = j.secret;
r = await call("/security/totp/confirm", { method: "POST", token: fresh, body: { setup: s2, code: totp(sec2) } });
check("attempt counter missing (migration not applied) -> fails closed (502)", r.status === 502, r.status);
fail.rpc = false;


// ── 8. second-review additions ──
r = await call("/security", { token: session(reader, [{ method: "otp", timestamp: Math.round(stampS) + 15 * 60 }]) }); j = await J(r);
check("SEC-2 upper bound: otp session 15 min after the stamp is not recent", j && j.recent === false, JSON.stringify(j));
r = await call("/security/totp/start", { method: "POST", token: session(reader, [{ method: "otp", timestamp: Math.round(stampS) + 15 * 60 }]), body: {} });
check("... and cannot change two-step (403)", r.status === 403);
r = await call("/security", { token: session(reader, [{ method: "otp", timestamp: Math.round(stampS) - 30 }]) }); j = await J(r);
check("window lower bound: otp 30 s before the stamp is not recent", j && j.recent === false);
r = await call("/security", { token: session(reader, [{ method: "otp", timestamp: Math.round(stampS) + 100 }]) }); j = await J(r);
check("slow page: otp 100 s after the stamp is recent", j && j.recent === true);
r = await call("/security", { token: session(reader, [{ method: "magiclink", timestamp: Math.round(stampS) + 3 }]) }); j = await J(r);
check("amr 'magiclink' (PKCE link, not the bridge) does not count", j && j.recent === false);
r = await call("/security", { token: "junk.junk.junk" }); j = await J(r);
check("401 carries code reauth", r.status === 401 && j.code === "reauth");
fail.gotrue500 = true;
r = await call("/security", { token: fresh });
check("auth server 500 -> 502 (not 'sign in again')", r.status === 502, r.status);
fail.gotrue500 = false;
r = await call("/security/totp/remove", { method: "POST", token: fresh, body: { code: "123456" } }); j = await J(r);
check("remove while off -> 409 state_changed", r.status === 409 && j.code === "state_changed", r.status + " " + JSON.stringify(j));
r = await call("/security/totp/start", { method: "POST", token: fresh, body: {} }); j = await J(r);
const s3 = j.setup, sec3 = j.secret;
world.factorGets = 0; fail.relistAt = 2;   // 1st list in the request: none; re-list just before enrolling: another tab's factor
const enr = world.enrolled.length;
r = await call("/security/totp/confirm", { method: "POST", token: fresh, body: { setup: s3, code: totp(sec3) } }); j = await J(r);
check("SEC-4: factor appears between check and enroll -> 409 state_changed, nothing enrolled", r.status === 409 && j.code === "state_changed" && world.enrolled.length === enr, r.status + " " + JSON.stringify(j));
fail.relistAt = 0;
wosUsers.set("user_W4", { id: "user_W4", email: "gone@example.com", email_verified: true });
const gone = addSbUser("gone@example.com", { app_metadata: { workos_user_id: "user_GONE", signed_in_at: new Date().toISOString() } });
const goneTok = session(gone, [{ method: "otp", timestamp: Math.round(Date.now() / 1000) }]);
r = await call("/security/totp/start", { method: "POST", token: goneTok, body: {} }); j = await J(r);
check("WOS-5 strict: recorded WorkOS id gone (404) -> change refused (409 no_workos)", r.status === 409 && j.code === "no_workos", r.status);
r = await call("/security", { token: goneTok }); j = await J(r);
check("... status still finds the account by email", j && j.workos === true);
r = await call("/security", { token: movedTok }); j = await J(r);
check("status: recorded id now on another email -> workos:false", j && j.workos === false, JSON.stringify(j));
wosUsers.set("user_W5", { id: "user_W5", email: "unverified@example.com", email_verified: false });
const unv = addSbUser("unverified@example.com");
r = await call("/security", { token: session(unv, [{ method: "otp", timestamp: Math.round(Date.now() / 1000) }]) }); j = await J(r);
check("WorkOS email not verified -> workos:false", j && j.workos === false);
r = await call("/security", { method: "OPTIONS", origin: "https://attackedmap-test123-mohiawrai2609s-projects.vercel.app" });
check("WORKOS_ALLOWED_ORIGINS entry with a trailing slash still matches", r.status === 204, r.status);
// timeouts
fail.slowPut = true;
const st = await call(`/start?provider=authkit&redirect=${encodeURIComponent(SITE + "/")}`, { origin: null });
const ck3 = (st.headers.get("set-cookie") || "").split(";")[0], state3 = new URL(st.headers.get("location")).searchParams.get("state");
let t1 = Date.now();
r = await call(`/callback?code=abc&state=${state3}`, { origin: null, cookie: ck3 });
const took = Date.now() - t1;
check(`SIGNIN-2: stuck stamp is cut at ~2.5 s and sign-in still completes (${took} ms)`, (r.headers.get("location") || "").includes("#wos_token=") && took < 3500 && took >= 2000, took);
fail.slowPut = false;
world.method = "Impersonation";
const st4 = await call(`/start?provider=authkit&redirect=${encodeURIComponent(SITE + "/")}`, { origin: null });
await call(`/callback?code=abc&state=${new URL(st4.headers.get("location")).searchParams.get("state")}`, { origin: null, cookie: (st4.headers.get("set-cookie") || "").split(";")[0] });
check("impersonation sign-in is not stamped as a fresh sign-in", reader.app_metadata.auth_method === "Impersonation" && !("signed_in_at" in reader.app_metadata), JSON.stringify(reader.app_metadata));
world.method = "Password";
const st5 = await call(`/start?provider=authkit&redirect=${encodeURIComponent(SITE + "/")}`, { origin: null });
await call(`/callback?code=abc&state=${new URL(st5.headers.get("location")).searchParams.get("state")}`, { origin: null, cookie: (st5.headers.get("set-cookie") || "").split(";")[0] });
const stamp5 = Date.parse(reader.app_metadata.signed_in_at) / 1000;
const fresh5 = session(reader, [{ method: "otp", timestamp: Math.round(stamp5) + 2 }]);
r = await call("/security/totp/start", { method: "POST", token: fresh5, body: {} }); j = await J(r);
{ const t0b = Date.now(); const rr = await call("/security/totp/confirm", { method: "POST", token: fresh5, body: { setup: j.setup, code: "000000" } }); console.log("     (timing) wrong-code confirm took", Date.now() - t0b, "ms", rr.status); }
attempts.clear();
globalThis.__smtpHang = true;
t1 = Date.now();
r = await call("/security/totp/confirm", { method: "POST", token: fresh5, body: { setup: j.setup, code: totp(j.secret) } });
const took2 = Date.now() - t1;
check(`RT-5: hanging mail server holds the answer at most ~4 s (${took2} ms)`, r.status === 200 && took2 < 5000, r.status + " " + took2);
globalThis.__smtpHang = false;

// ── SIGNUP PAGE: email code + direct providers, guarded against skipping two-step ──
{
  const cookieJson = (h) => JSON.parse(Buffer.from((h || "").split(";")[0].split("=")[1].split(".")[0], "base64url").toString());
  const mailBefore = mail.length;
  r = await call("/email/start", { method: "POST", body: { email: " New.Person@Example.com " } }); j = await J(r);
  check("SU-1: /email/start -> 200 sent, WorkOS asked for a code for the lower-cased address", r.status === 200 && j.sent === true && world.magic.at(-1)?.email === "new.person@example.com", r.status + " " + JSON.stringify(world.magic.at(-1)));
  check("SU-2: the bridge sends no email of its own (WorkOS emails the code)", mail.length === mailBefore, mail.length - mailBefore);
  r = await call("/email/start", { method: "POST", body: { email: "not an email" } });
  check("SU-3: bad address -> 400", r.status === 400);
  r = await call("/email/start", { method: "POST", origin: PREVIEW, body: { email: "a@b.co" } });
  check("SU-4: look-alike origin -> 403", r.status === 403);
  r = await call("/email/start", { method: "OPTIONS" });
  check("SU-5: preflight from the live site -> 204", r.status === 204);
  r = await call("/email/verify", { method: "POST", body: { email: "new.person@example.com", code: "000000" } });
  check("SU-6: wrong code -> 400", r.status === 400);
  const revokedBefore = world.revoked || 0;
  r = await call("/email/verify", { method: "POST", body: { email: "new.person@example.com", code: "123456", first_name: " Nia\u0007 ", last_name: "Patel" } }); j = await J(r);
  const np = [...sbUsers.values()].find((u) => u.email === "new.person@example.com");
  check("SU-7: right code, new person -> one-time Supabase token", r.status === 200 && /^hash_/.test(j.token_hash) && j.type === "magiclink", r.status + " " + JSON.stringify(j));
  check("SU-8: account made with the typed name (control character dropped)", np && np.user_metadata.first_name === "Nia" && np.user_metadata.last_name === "Patel" && np.user_metadata.full_name === "Nia Patel", JSON.stringify(np && np.user_metadata));
  check("SU-9: the name is saved at WorkOS too", world.renamed.some((x) => x.first_name === "Nia" && x.last_name === "Patel"), JSON.stringify(world.renamed));
  check("SU-10: sign-in stamped MagicAuth, not strong", np && np.app_metadata.auth_method === "MagicAuth" && np.app_metadata.strong_auth === false, JSON.stringify(np && np.app_metadata));
  check("SU-11: WorkOS's own session ended", (world.revoked || 0) === revokedBefore + 1);
  // existing WorkOS names are kept
  wosUsers.set("user_N2", { id: "user_N2", email: "named@example.com", email_verified: true, first_name: "Real", last_name: "Name" });
  const renamedBefore = world.renamed.length;
  r = await call("/email/verify", { method: "POST", body: { email: "named@example.com", code: "123456", first_name: "Other", last_name: "Person" } });
  check("SU-12: a WorkOS account that has a name keeps it", r.status === 200 && world.renamed.length === renamedBefore && wosUsers.get("user_N2").first_name === "Real", r.status);
  // two-step on: the code alone never opens a session
  wosUsers.set("user_T1", { id: "user_T1", email: "twostep@example.com", email_verified: true });
  factors.set("auth_factor_T1", { id: "auth_factor_T1", user_id: "user_T1", type: "totp", secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" });
  const sbBefore = sbUsers.size;
  r = await call("/email/verify", { method: "POST", body: { email: "twostep@example.com", code: "123456" } }); j = await J(r);
  check("SU-13: account with two-step -> 409 use_hosted (reason two_step), no token", r.status === 409 && j.code === "use_hosted" && j.reason === "two_step" && !j.token_hash, r.status + " " + JSON.stringify(j));
  check("SU-14: ... and no Supabase account was made or signed in", sbUsers.size === sbBefore);
  world.authError = { status: 403, body: { code: "mfa_challenge", pending_authentication_token: "pat", user: { email: "twostep@example.com" } } };
  r = await call("/email/verify", { method: "POST", body: { email: "twostep@example.com", code: "123456" } }); j = await J(r);
  check("SU-15: WorkOS answers mfa_challenge -> 409 use_hosted (reason two_step)", r.status === 409 && j.code === "use_hosted" && j.reason === "two_step", r.status + " " + JSON.stringify(j));
  world.authError = { status: 403, body: { code: "mfa_enrollment", user: { email: "x@example.com" } } };
  r = await call("/email/verify", { method: "POST", body: { email: "x@example.com", code: "123456" } }); j = await J(r);
  check("SU-16: WorkOS answers mfa_enrollment (two-step Required) -> 409 use_hosted (reason hosted)", r.status === 409 && j.code === "use_hosted" && j.reason === "hosted", r.status + " " + JSON.stringify(j));
  world.authError = null;
  fail.factors = true;
  const sbBefore2 = sbUsers.size;
  r = await call("/email/verify", { method: "POST", body: { email: "blip@example.com", code: "123456" } }); j = await J(r);
  check("SU-17: factor check fails -> fails closed (409 use_hosted reason hosted, no account)", r.status === 409 && j.code === "use_hosted" && j.reason === "hosted" && sbUsers.size === sbBefore2, r.status + " " + JSON.stringify(j));
  fail.factors = false;
  r = await call("/email/verify", { method: "POST", origin: PREVIEW, body: { email: "new.person@example.com", code: "123456" } });
  check("SU-18: verify from a look-alike origin -> 403", r.status === 403);
  r = await call("/email/verify", { method: "POST", body: { email: "new.person@example.com", code: "12345" } });
  check("SU-19: a 5-digit code (lost leading zero) is padded and checked, not crashed", r.status === 400);

  // direct provider trips
  const d1 = await call(`/start?provider=GoogleOAuth&redirect=${encodeURIComponent(SITE + "/?dashboard&wos_n=abc")}`, { origin: null });
  const d1c = (d1.headers.get("set-cookie") || "").split(";")[0], d1s = new URL(d1.headers.get("location")).searchParams.get("state");
  check("SU-20: direct start cookie marks the trip direct (d:true) and keeps the page", cookieJson(d1.headers.get("set-cookie")).d === true && cookieJson(d1.headers.get("set-cookie")).t === SITE + "/?dashboard&wos_n=abc");
  wosUsers.set("user_G1", { id: "user_G1", email: "gina@example.com", email_verified: true, first_name: "Gina", last_name: "G" });
  world.signInAs = "user_G1"; world.method = "GoogleOAuth";
  r = await call(`/callback?code=abc&state=${d1s}`, { origin: null, cookie: d1c });
  check("SU-21: direct Google, no two-step -> signed in (#wos_token)", (r.headers.get("location") || "").startsWith(SITE + "/?dashboard&wos_n=abc#wos_token=hash_"), r.headers.get("location"));
  // direct trip for an account with two-step -> on to the hosted sign-in, same page
  const d2 = await call(`/start?provider=GoogleOAuth&redirect=${encodeURIComponent(SITE + "/?dashboard&wos_n=def")}`, { origin: null });
  world.signInAs = "user_T1";
  const sbBefore3 = sbUsers.size;
  r = await call(`/callback?code=abc&state=${new URL(d2.headers.get("location")).searchParams.get("state")}`, { origin: null, cookie: (d2.headers.get("set-cookie") || "").split(";")[0] });
  const hop = r.headers.get("location") || "", hopCookie = r.headers.get("set-cookie") || "";
  check("SU-22: direct trip + two-step -> 302 to the HOSTED sign-in with the address filled in", r.status === 302 && /provider=authkit/.test(hop) && /screen_hint=sign-in/.test(hop) && /login_hint=twostep%40example.com/.test(hop) && !/wos_token/.test(hop), hop);
  check("SU-23: ... with a fresh hosted trip cookie for the same page (not cleared)", !/Max-Age=0/.test(hopCookie) && cookieJson(hopCookie).d === false && cookieJson(hopCookie).t === SITE + "/?dashboard&wos_n=def", hopCookie);
  check("SU-24: ... and no Supabase session or account", sbUsers.size === sbBefore3);
  // finishing that hosted trip signs in (WorkOS asked for the code on its page)
  world.method = "Password";
  const gets = world.factorGets || 0;
  r = await call(`/callback?code=abc&state=${new URL(hop).searchParams.get("state")}`, { origin: null, cookie: hopCookie.split(";")[0] });
  check("SU-25: the hosted trip then signs in to the same page, no factor check", (r.headers.get("location") || "").startsWith(SITE + "/?dashboard&wos_n=def#wos_token="), r.headers.get("location"));
  check("SU-26: hosted trips are not factor-checked (two-step users can sign in)", (world.factorGets || 0) === gets);
  // WorkOS itself says mfa_challenge on a direct trip
  const d3 = await call(`/start?provider=MicrosoftOAuth&redirect=${encodeURIComponent(SITE + "/?subscribe&activate=subscriber")}`, { origin: null });
  world.authError = { status: 403, body: { code: "mfa_challenge", user: { email: "TwoStep@Example.com" } } };
  r = await call(`/callback?code=abc&state=${new URL(d3.headers.get("location")).searchParams.get("state")}`, { origin: null, cookie: (d3.headers.get("set-cookie") || "").split(";")[0] });
  check("SU-27: direct trip + WorkOS mfa_challenge -> hosted sign-in, hint lower-cased", /provider=authkit/.test(r.headers.get("location") || "") && /login_hint=twostep%40example.com/.test(r.headers.get("location") || "") && cookieJson(r.headers.get("set-cookie")).t === SITE + "/?subscribe&activate=subscriber", r.headers.get("location"));
  world.authError = { status: 400, body: { code: "invalid_grant" } };
  const d4 = await call(`/start?provider=GoogleOAuth&redirect=${encodeURIComponent(SITE + "/")}`, { origin: null });
  r = await call(`/callback?code=abc&state=${new URL(d4.headers.get("location")).searchParams.get("state")}`, { origin: null, cookie: (d4.headers.get("set-cookie") || "").split(";")[0] });
  check("SU-28: direct trip + other WorkOS error -> signin_error=workos (no hop)", (r.headers.get("location") || "").endsWith("signin_error=workos"), r.headers.get("location"));
  // a hosted trip that WorkOS answers with mfa_challenge must not loop back to the hosted page
  const d5 = await call(`/start?provider=authkit&redirect=${encodeURIComponent(SITE + "/")}`, { origin: null });
  world.authError = { status: 403, body: { code: "mfa_challenge", user: { email: "twostep@example.com" } } };
  r = await call(`/callback?code=abc&state=${new URL(d5.headers.get("location")).searchParams.get("state")}`, { origin: null, cookie: (d5.headers.get("set-cookie") || "").split(";")[0] });
  check("SU-29: hosted trip + mfa_challenge -> signin_error=workos (no loop)", (r.headers.get("location") || "").endsWith("signin_error=workos"), r.headers.get("location"));
  world.authError = null;
  // factor check fails on a direct trip -> hosted page (fails closed)
  world.signInAs = "user_G1"; fail.factors = true;
  const d6 = await call(`/start?provider=GoogleOAuth&redirect=${encodeURIComponent(SITE + "/")}`, { origin: null });
  r = await call(`/callback?code=abc&state=${new URL(d6.headers.get("location")).searchParams.get("state")}`, { origin: null, cookie: (d6.headers.get("set-cookie") || "").split(";")[0] });
  check("SU-30: direct trip, factor check down -> hosted sign-in (fails closed)", /provider=authkit/.test(r.headers.get("location") || "") && !/wos_token/.test(r.headers.get("location") || ""), r.headers.get("location"));
  fail.factors = false;
  // a cookie made before this change (no d) counts as direct: checked
  world.signInAs = "user_T1";
  const oldPayload = Buffer.from(JSON.stringify({ s: "oldstate", t: SITE + "/?dashboard", e: Date.now() + 60000 })).toString("base64url");
  const oldSig = crypto.createHmac("sha256", `workos-auth-state:${ENV.SUPABASE_SERVICE_ROLE_KEY}`).update(oldPayload).digest("base64url");
  r = await call(`/callback?code=abc&state=oldstate`, { origin: null, cookie: `wos_rt=${oldPayload}.${oldSig}` });
  check("SU-31: a trip cookie without the d mark is treated as direct (two-step user -> hosted)", /provider=authkit/.test(r.headers.get("location") || ""), r.headers.get("location"));
  world.signInAs = "user_W1";

  // an account somebody made with this address through Supabase's own sign-up and never confirmed
  const evil = addSbUser("victim@example.com", { email_confirmed_at: null, password: "attacker-pw", user_metadata: { industry: "Evil Corp", job_title: "Attacker", first_name: "Mal" } });
  const resetsBefore = world.pwResets || 0;
  r = await call("/email/verify", { method: "POST", body: { email: "victim@example.com", code: "123456", first_name: "Vic" } }); j = await J(r);
  check("SU-36: unconfirmed account made by someone else -> still signs the real owner in", r.status === 200 && /^hash_/.test(j.token_hash), r.status + " " + JSON.stringify(j));
  check("SU-37: ... but first its password is replaced with a random one", evil.password !== "attacker-pw" && evil.password.length >= 40 && (world.pwResets || 0) === resetsBefore + 1, evil.password);
  check("SU-38: ... the address confirmed, and the other person's details removed", !!evil.email_confirmed_at && !("industry" in evil.user_metadata) && !("job_title" in evil.user_metadata) && evil.user_metadata.first_name === "Vic", JSON.stringify(evil.user_metadata));
  const linksBefore = world.links || 0, resets2 = world.pwResets || 0;
  r = await call("/email/verify", { method: "POST", body: { email: "victim@example.com", code: "123456" } });
  check("SU-39: a confirmed existing account is signed in as it is (no reset, one link)", r.status === 200 && (world.pwResets || 0) === resets2 && (world.links || 0) === linksBefore + 1, `${world.pwResets - resets2} resets, ${world.links - linksBefore} links`);
  addSbUser("victim2@example.com", { email_confirmed_at: null, password: "attacker-pw" });
  fail.resetPut = true;
  r = await call("/email/verify", { method: "POST", body: { email: "victim2@example.com", code: "123456" } }); j = await J(r);
  check("SU-40: reset fails -> no token (fails closed, 502)", r.status === 502 && !j.token_hash, r.status + " " + JSON.stringify(j));
  fail.resetPut = false;
  // the hosted callback goes through the same code
  addSbUser("victim3@example.com", { email_confirmed_at: null, password: "attacker-pw" });
  wosUsers.set("user_V3", { id: "user_V3", email: "victim3@example.com", email_verified: true, first_name: "V", last_name: "Three" });
  world.signInAs = "user_V3"; world.method = "Password";
  const h3 = await call(`/start?provider=authkit&redirect=${encodeURIComponent(SITE + "/")}`, { origin: null });
  r = await call(`/callback?code=abc&state=${new URL(h3.headers.get("location")).searchParams.get("state")}`, { origin: null, cookie: (h3.headers.get("set-cookie") || "").split(";")[0] });
  const v3 = [...sbUsers.values()].find((u) => u.email === "victim3@example.com");
  check("SU-41: hosted sign-in into an unconfirmed account also resets it first", (r.headers.get("location") || "").includes("#wos_token=") && v3.password !== "attacker-pw" && !!v3.email_confirmed_at, r.headers.get("location"));
  world.signInAs = "user_W1";
  r = await call("/providers"); j = await J(r);
  check("SU-42: /providers says the sign-up routes are on", j && j.signup_form === true, JSON.stringify(j));

  // switched off
  const off = await loadBridge({ BRIDGE_SIGNUP_FORM: "off" });
  const callOff = (path, o = {}) => off(new Request(BASE + path, { method: o.method || "GET", headers: { origin: SITE, "content-type": "application/json" }, ...(o.body ? { body: JSON.stringify(o.body) } : {}), redirect: "manual" }));
  r = await callOff("/email/start", { method: "POST", body: { email: "a@b.co" } });
  check("SU-32: BRIDGE_SIGNUP_FORM=off -> email routes 404", r.status === 404);
  r = await callOff(`/start?provider=GoogleOAuth&redirect=${encodeURIComponent(SITE + "/")}`);
  check("SU-33: BRIDGE_SIGNUP_FORM=off -> direct start back with signin_error=unavailable", r.headers.get("location") === SITE + "/?home&signin_error=unavailable", r.headers.get("location"));
  r = await callOff(`/start?provider=authkit&redirect=${encodeURIComponent(SITE + "/")}`);
  check("SU-34: BRIDGE_SIGNUP_FORM=off -> hosted sign-in still works", r.status === 302 && /provider=authkit/.test(r.headers.get("location") || ""));
  r = await callOff("/providers"); j = await J(r);
  check("SU-43: BRIDGE_SIGNUP_FORM=off -> /providers says signup_form false (the page signs up on the hosted page)", j && j.signup_form === false, JSON.stringify(j));
  // our own code email
  const ours = await loadBridge({ BRIDGE_CODE_EMAIL: "ours" });
  const m0 = mail.length;
  r = await ours(new Request(BASE + "/email/start", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ email: "ours@example.com" }) }));
  check("SU-35: BRIDGE_CODE_EMAIL=ours -> our template is sent with WorkOS's code", r.status === 200 && mail.length === m0 + 1 && /123456/.test(mail.at(-1).content || ""), r.status + " " + (mail.length - m0));
}

// ── 9. Login and security page: status fields, linked accounts, password ──
{
  await loadBridge();   // back to the default settings after the SU-32/35 variants
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const hostedSignIn = async (wosId, method, page = SITE + "/?profile") => {
    world.signInAs = wosId; world.method = method;
    const s = await call(`/start?provider=authkit&redirect=${encodeURIComponent(page)}`, { origin: null });
    return call(`/callback?code=abc&state=${new URL(s.headers.get("location")).searchParams.get("state")}`, { origin: null, cookie: (s.headers.get("set-cookie") || "").split(";")[0] });
  };
  const freshFor = (u) => session(u, [{ method: "otp", timestamp: Math.round(Date.parse(u.app_metadata.signed_in_at) / 1000) + 3 }]);
  const factorsOf = (uid) => [...factors.values()].filter((f) => f.user_id === uid);

  // the default Google reader: identities [] is what Staging shows even for Google-linked accounts
  const p1w = { id: "user_P1", email: "reader@x.io", email_verified: true, first_name: "Rea", last_name: "Der", identities: [] };
  wosUsers.set(p1w.id, p1w);
  r = await hostedSignIn("user_P1", "GoogleOAuth");
  const p1 = [...sbUsers.values()].find((u) => u.email === "reader@x.io");
  check("ST-9a: first sign-in (Google) starts app_metadata.methods_used", (r.headers.get("location") || "").includes("#wos_token=") && !!p1 && same(p1.app_metadata.methods_used, ["GoogleOAuth"]), JSON.stringify(p1 && p1.app_metadata));
  await hostedSignIn("user_P1", "MagicAuth");
  check("ST-9: Google then Magic Auth sign-ins -> methods_used [GoogleOAuth, MagicAuth]", same(p1.app_metadata.methods_used, ["GoogleOAuth", "MagicAuth"]) && p1.app_metadata.auth_method === "MagicAuth", JSON.stringify(p1.app_metadata));
  await hostedSignIn("user_P1", "GoogleOAuth");
  check("ST-9b: a repeated method is listed once, order kept", same(p1.app_metadata.methods_used, ["GoogleOAuth", "MagicAuth"]) && p1.app_metadata.auth_method === "GoogleOAuth", JSON.stringify(p1.app_metadata.methods_used));
  await hostedSignIn("user_P1", "Impersonation");
  check("ST-9c: an impersonation sign-in is never added to methods_used", same(p1.app_metadata.methods_used, ["GoogleOAuth", "MagicAuth"]) && !("signed_in_at" in p1.app_metadata), JSON.stringify(p1.app_metadata));
  await hostedSignIn("user_P1", "GoogleOAuth");   // a real sign-in again: fresh stamp for the rest
  let tok = freshFor(p1);
  r = await call("/security?full=1", { token: tok }); j = await J(r);
  check("ST-5: signed_in_at is the stamp written at the callback", r.status === 200 && j.signed_in_at === p1.app_metadata.signed_in_at && Math.abs(Date.parse(j.signed_in_at) - Date.now()) < 5000, JSON.stringify(j));
  check("ST-6: password_set_at is null before any password is set", !!j && "password_set_at" in j && j.password_set_at === null, JSON.stringify(j));
  check("ST-10a: login.methods comes from methods_used", !!j && !!j.login && same(j.login.methods, ["GoogleOAuth", "MagicAuth"]), JSON.stringify(j && j.login));
  check("ST-1b: an empty identities list (as on Staging) is passed through as []", !!j && !!j.login && same(j.login.identities, []), JSON.stringify(j && j.login));
  p1w.identities = [{ idp_id: "x", type: "OAuth", provider: "GoogleOAuth" }];
  r = await call("/security?full=1", { token: tok }); j = await J(r);
  check("ST-1: ?full=1 lists the linked account with provider only (no idp_id)", r.status === 200 && same(j.login && j.login.identities, [{ provider: "GoogleOAuth" }]) && !("idp_id" in j.login.identities[0]), JSON.stringify(j && j.login));
  world.identityWrap = true;
  r = await call("/security?full=1", { token: tok }); j = await J(r);
  check("ST-3: a {data:[...]} wrapped identities list is read the same way", r.status === 200 && same(j.login && j.login.identities, [{ provider: "GoogleOAuth" }]), JSON.stringify(j && j.login));
  world.identityWrap = false;
  world.identityGets = 0;
  r = await call("/security", { token: tok }); j = await J(r);
  check("ST-2: plain GET /security (the nudge) has no login key and asks WorkOS for no identities", r.status === 200 && !("login" in j) && world.identityGets === 0 && j.workos === true, JSON.stringify(j) + " gets=" + world.identityGets);
  fail.identities = true;
  r = await call("/security?full=1", { token: tok }); j = await J(r);
  check("ST-4: identities lookup fails -> still 200, identities null, methods/totp/method/recent intact", r.status === 200 && !!j.login && j.login.identities === null && same(j.login.methods, ["GoogleOAuth", "MagicAuth"]) && j.totp.on === false && j.method === "GoogleOAuth" && j.recent === true, JSON.stringify(j));
  fail.identities = false;
  p1w.identities = [];
  wosUsers.set("user_V7", { id: "user_V7", email: "prev8@example.com", email_verified: true });
  const prev8 = addSbUser("prev8@example.com", { app_metadata: { provider: "email", providers: ["email"], workos_user_id: "user_V7", auth_method: "GoogleOAuth", strong_auth: false, signed_in_at: new Date().toISOString() } });
  r = await call("/security?full=1", { token: freshFor(prev8) }); j = await J(r);
  check("ST-10: a pre-v8 account with only auth_method -> login.methods [GoogleOAuth]", r.status === 200 && !!j.login && same(j.login.methods, ["GoogleOAuth"]) && same(j.login.identities, []), JSON.stringify(j && j.login));
  await hostedSignIn("user_V7", "MagicAuth");   // its first sign-in on v8: the list starts from the method already recorded
  check("ST-10b: a pre-v8 Google account's first v8 sign-in (email code) -> methods_used [GoogleOAuth, MagicAuth]", same(prev8.app_metadata.methods_used, ["GoogleOAuth", "MagicAuth"]) && prev8.app_metadata.auth_method === "MagicAuth", JSON.stringify(prev8.app_metadata));
  r = await call("/security?full=1", { token: session(nostamp, [{ method: "otp", timestamp: Math.round(Date.now() / 1000) }]) }); j = await J(r);
  check("ST-5b: a v4-era account with no stamp -> signed_in_at null, methods []", r.status === 200 && j.workos === true && j.signed_in_at === null && !!j.login && same(j.login.methods, []), JSON.stringify(j));
  r = await call("/security?full=1", { token: movedTok }); j = await J(r);
  check("ST-7: workos:false body has signed_in_at + password_set_at keys, no login, no since", r.status === 200 && j.workos === false && "signed_in_at" in j && "password_set_at" in j && !("login" in j) && !("since" in j.totp), JSON.stringify(j));
  r = await call("/security?full=1", { method: "POST", token: tok });
  check("ST-8a: POST /security?full=1 -> 405", r.status === 405, r.status);
  r = await call("/security?full=1"); j = await J(r);
  check("ST-8b: ?full=1 without a token -> 401 reauth", r.status === 401 && j.code === "reauth", r.status);
  r = await call("/security?full=1", { origin: PREVIEW, token: tok });
  check("ST-8c: ?full=1 from a look-alike origin -> 403", r.status === 403, r.status);

  // ── password: gate, validation, the WorkOS write, step-up ──
  // Everything the bridge prints and answers during these checks is captured
  // so PW-12 can prove no password ever leaves the request.
  const out = [], bodies = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { out.push(a.map(String).join(" ")); orig[k](...a); };
  const callP = async (path, o) => { const rr = await call(path, o); bodies.push(await rr.clone().text()); return rr; };
  const PW = { ok: "correct horse battery staple", ok2: "another long passphrase here", weak: "weakweakweak", short: "nine char", local: "readerreader1", long: "a".repeat(129) };
  const puts = () => world.passwordPuts.length;
  // PW-1 + RG-1: a bridge sign-in 25 minutes ago (amr matches the stamp, but the stamp is too old)
  const keptStamp = p1.app_metadata.signed_in_at;
  p1.app_metadata.signed_in_at = new Date(Date.now() - 25 * 60_000).toISOString();
  const stale = freshFor(p1);
  r = await callP("/security/password", { method: "POST", token: stale, body: { password: PW.ok } }); j = await J(r);
  check("PW-1: sign-in 25 min old -> 403 reauth with the password wording, no PUT", r.status === 403 && j.code === "reauth" && j.error === "For your safety, sign in again before changing your password." && puts() === 0, r.status + " " + JSON.stringify(j));
  r = await callP("/security/totp/start", { method: "POST", token: stale, body: {} }); j = await J(r);
  check("RG-1: the two-step routes keep their own reauth wording", r.status === 403 && j.code === "reauth" && j.error === "For your safety, sign in again before changing two-step verification.", JSON.stringify(j));
  p1.app_metadata.signed_in_at = keptStamp;
  tok = freshFor(p1);
  r = await callP("/security/password", { token: tok });
  check("PW-2: GET /security/password -> 405", r.status === 405, r.status);
  r = await callP("/security/password", { method: "POST", token: tok, body: {} }); j = await J(r);
  const w1 = r.status === 400 && j.code === "weak_password" && j.error === "Use at least 10 characters.";
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: 123 } }); j = await J(r);
  const w2 = r.status === 400 && j.code === "weak_password";
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.short } }); j = await J(r);
  check("PW-3: no password / not a string / 9 characters -> 400 weak_password, no PUT", w1 && w2 && r.status === 400 && j.code === "weak_password" && puts() === 0, r.status + " " + JSON.stringify(j));
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.long } }); j = await J(r);
  check("PW-4: 129 characters -> 400 weak_password (too long), no PUT", r.status === 400 && j.code === "weak_password" && /128 characters/.test(j.error) && puts() === 0, JSON.stringify(j));
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.local } }); j = await J(r);
  check("PW-5: the email's local part inside the password -> 400 weak_password, no PUT", r.status === 400 && j.code === "weak_password" && j.error === "Don't use your email address in your password." && puts() === 0, JSON.stringify(j));
  r = await callP("/security/password", { method: "POST", token: movedTok, body: { password: PW.ok } }); j = await J(r);
  const n1 = r.status === 409 && j.code === "no_workos";
  wosUsers.set("user_NW", { id: "user_NW", email: "nowos@example.com", email_verified: true });
  const nowos = addSbUser("nowos@example.com", { app_metadata: { provider: "email", providers: ["email"], signed_in_at: new Date().toISOString() } });
  r = await callP("/security/password", { method: "POST", token: freshFor(nowos), body: { password: PW.ok } }); j = await J(r);
  check("PW-6: recorded id on another address, or no recorded id although the email matches -> 409 no_workos, no PUT", n1 && r.status === 409 && j.code === "no_workos" && puts() === 0, r.status + " " + JSON.stringify(j));
  // WorkOS refuses the write
  let m0 = mail.length;
  fail.put = true;
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok } }); j = await J(r);
  check("PW-8: WorkOS PUT fails (500) -> 502 generic text, no stamp, no email", r.status === 502 && j.error === "Security settings are unavailable right now. Try again in a minute." && !("password_set_at" in p1.app_metadata) && mail.length === m0, r.status + " " + JSON.stringify(j));
  fail.put = false;
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.weak } }); j = await J(r);
  check("PW-9: a password WorkOS rejects (stub 422) -> 400 weak_password (not 502), no stamp, no email", r.status === 400 && j.code === "weak_password" && /too easy to guess/.test(j.error) && !("password_set_at" in p1.app_metadata) && mail.length === m0, r.status + " " + JSON.stringify(j));
  fail.put429 = true;
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok } }); j = await J(r);
  check("PW-10: WorkOS 429 on the PUT -> 429 'Too many changes in a short time'", r.status === 429 && j.error === "Too many changes in a short time. Wait a minute, then try again." && !("password_set_at" in p1.app_metadata), r.status + " " + JSON.stringify(j));
  fail.put429 = false;
  // the happy path, two-step off
  m0 = mail.length; let pBefore = puts(); const tHappy = Date.now();
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok } }); j = await J(r);
  check("PW-7: set a password (two-step off) -> 200 {password:{set:true}}", r.status === 200 && same(j, { password: { set: true } }), r.status + " " + JSON.stringify(j));
  check("PW-7: the WorkOS PUT body is exactly {password}", puts() === pBefore + 1 && same(world.passwordPuts.at(-1).keys, ["password"]) && world.passwordPuts.at(-1).len === PW.ok.length, JSON.stringify(world.passwordPuts.at(-1)));
  check("PW-7: app_metadata.password_set_at stamped (ISO, now)", typeof p1.app_metadata.password_set_at === "string" && Math.abs(Date.parse(p1.app_metadata.password_set_at) - tHappy) < 5000, String(p1.app_metadata.password_set_at));
  check("PW-7: the reader is emailed 'Your Attacked.ai password was changed'", mail.length === m0 + 1 && mail.at(-1).subject === "Your Attacked.ai password was changed" && /Login and security/.test(mail.at(-1).content || ""), mail.at(-1) && mail.at(-1).subject);
  r = await callP("/security", { token: tok }); j = await J(r);
  check("PW-7: GET /security now shows password_set_at", r.status === 200 && j.password_set_at === p1.app_metadata.password_set_at, JSON.stringify(j));
  // one change a minute per account: a second one straight away is refused before any WorkOS call or email
  m0 = mail.length; pBefore = puts();
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok2 } }); j = await J(r);
  check("PW-20: a second change within a minute -> 429 'Too many changes', no PUT, no email", r.status === 429 && j.error === "Too many changes in a short time. Wait a minute, then try again." && puts() === pBefore && mail.length === m0, r.status + " " + JSON.stringify(j));
  const cool = () => { p1.app_metadata.password_set_at = new Date(Date.now() - 61_000).toISOString(); };   // "a minute has passed"
  // the account note fails after a successful WorkOS write
  cool(); fail.adminPut = true; m0 = mail.length;
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok2 } }); j = await J(r);
  check("PW-11: account note fails after the WorkOS PUT -> still 200, email still sent", r.status === 200 && !!j.password && j.password.set === true && mail.length === m0 + 1, r.status + " " + JSON.stringify(j));
  fail.adminPut = false;
  // extra body fields never choose the account
  cool();
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok2, email: "attacker@example.com", user_id: "user_W1" } }); j = await J(r);
  check("PW-13: extra body fields are ignored; the PUT targets the session's WorkOS account", r.status === 200 && world.passwordPuts.at(-1).id === "user_P1" && same(world.passwordPuts.at(-1).keys, ["password"]), JSON.stringify(world.passwordPuts.at(-1)));
  // a hanging mail server
  cool(); globalThis.__smtpHang = true; let tt = Date.now();
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok } });
  const tookPw = Date.now() - tt; globalThis.__smtpHang = false;
  check(`PW-14: hanging mail server -> still 200 within ~4 s (${tookPw} ms)`, r.status === 200 && tookPw < 5000, r.status + " " + tookPw);
  // attempt counter missing, two-step off: no code is checked, so the route still works
  cool(); fail.rpc = true;
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok } });
  check("PW-19a: attempt counter missing + two-step off -> the password route still works (200)", r.status === 200, r.status);
  fail.rpc = false;

  // ── enrolment is verified at WorkOS too (SEC-9 / SEC-10) ──
  r = await callP("/security/totp/start", { method: "POST", token: tok, body: {} }); j = await J(r);
  const setupP = j.setup, secretP = j.secret;
  m0 = mail.length; fail.verifyInvalid = true; world.verifies = []; let enrBefore = world.enrolled.length;
  r = await callP("/security/totp/confirm", { method: "POST", token: tok, body: { setup: setupP, code: totp(secretP) } }); j = await J(r);
  check("SEC-10: WorkOS says the code is invalid on the new factor -> 400 'just expired', factor deleted, no stamp, no email", r.status === 400 && j.error === "That code has just expired. Type the next code the app shows and try again." && world.enrolled.length === enrBefore + 1 && factorsOf("user_P1").length === 0 && !("mfa_factor_id" in p1.app_metadata) && mail.length === m0 && world.verifies.length === 1, r.status + " " + JSON.stringify(j) + " factors=" + factorsOf("user_P1").length);
  check("SEC-10: a code right by the bridge's own check costs no attempt when WorkOS's clock refuses it", !attempts.has(p1.id), JSON.stringify(attempts.get(p1.id) || null));
  fail.verifyInvalid = false; attempts.clear();
  fail.challenge = true; enrBefore = world.enrolled.length;
  r = await callP("/security/totp/confirm", { method: "POST", token: tok, body: { setup: setupP, code: totp(secretP) } }); j = await J(r);
  check("SEC-10b: WorkOS challenge fails on the new factor -> 502 (never 'wrong code'), factor deleted, no stamp, no email", r.status === 502 && world.enrolled.length === enrBefore + 1 && factorsOf("user_P1").length === 0 && !("mfa_factor_id" in p1.app_metadata) && mail.length === m0, r.status + " factors=" + factorsOf("user_P1").length);
  fail.challenge = false; attempts.clear();
  // the compensating delete fails too: the factor is live at WorkOS, so the account must say so
  const tidyFactors = () => { for (const f of factorsOf("user_P1")) factors.delete(f.id); delete p1.app_metadata.mfa_factor_id; delete p1.app_metadata.mfa_since; attempts.clear(); };
  fail.verifyInvalid = true; fail.delete = true; m0 = mail.length; let warnAt = out.length;
  r = await callP("/security/totp/confirm", { method: "POST", token: tok, body: { setup: setupP, code: totp(secretP) } }); j = await J(r);
  let kept = factorsOf("user_P1");
  check("SEC-10c: code refused by WorkOS AND the delete fails -> 409 state_changed, factor kept and noted on the account, 'turned on' email, warning logged", r.status === 409 && j.code === "state_changed" && kept.length === 1 && p1.app_metadata.mfa_factor_id === kept[0].id && mail.length === m0 + 1 && /turned on/.test(mail.at(-1).subject) && out.slice(warnAt).some((l) => /unverified factor not deleted/.test(l) && l.includes(kept[0].id)), r.status + " " + JSON.stringify(j) + " factors=" + kept.length + " stamp=" + p1.app_metadata.mfa_factor_id);
  fail.verifyInvalid = false; fail.delete = false; tidyFactors();
  fail.challenge = true; fail.delete = true; m0 = mail.length; warnAt = out.length;
  r = await callP("/security/totp/confirm", { method: "POST", token: tok, body: { setup: setupP, code: totp(secretP) } }); j = await J(r);
  kept = factorsOf("user_P1");
  check("SEC-10d: challenge fails AND the delete fails -> 409 state_changed (not 502), factor kept and noted, email, warning logged", r.status === 409 && j.code === "state_changed" && kept.length === 1 && p1.app_metadata.mfa_factor_id === kept[0].id && mail.length === m0 + 1 && out.slice(warnAt).some((l) => /unverified factor not deleted/.test(l)), r.status + " " + JSON.stringify(j) + " factors=" + kept.length);
  fail.challenge = false; fail.delete = false; tidyFactors();
  m0 = mail.length; world.verifies = [];
  r = await callP("/security/totp/confirm", { method: "POST", token: tok, body: { setup: setupP, code: totp(secretP) } }); j = await J(r);
  check("SEC-9: confirm -> the new factor is verified at WorkOS once and stays", r.status === 200 && j.totp.on === true && world.verifies.length === 1 && world.verifies[0].factor === p1.app_metadata.mfa_factor_id && factorsOf("user_P1").length === 1 && factorsOf("user_P1")[0].id === p1.app_metadata.mfa_factor_id && mail.length === m0 + 1 && /turned on/.test(mail.at(-1).subject), r.status + " " + JSON.stringify(j) + " verifies=" + JSON.stringify(world.verifies));
  check("SEC-9: no attempt is left reserved after a verified enrolment", !attempts.has(p1.id));

  // ── step-up: two-step on, so a password change needs a live code ──
  const wrong = () => ("000000" === totp(secretP) ? "999999" : "000000");
  cool(); pBefore = puts();
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok } }); j = await J(r);
  check("PW-15: two-step on, no code -> 400 code_required, no PUT, no attempt used", r.status === 400 && j.code === "code_required" && j.error === "Two-step verification is on, so type the current code from your authenticator app too." && puts() === pBefore && !attempts.has(p1.id), r.status + " " + JSON.stringify(j));
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok, code: wrong() } }); j = await J(r);
  check("PW-16: wrong code -> 400 'didn't match', one attempt used, no PUT", r.status === 400 && j.error === "That code didn't match. Use the newest code in the app." && attempts.get(p1.id)?.n === 1 && puts() === pBefore, r.status + " " + JSON.stringify(j) + " n=" + (attempts.get(p1.id) || {}).n);
  for (let i = 0; i < 4; i++) await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok, code: wrong() } });
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok, code: totp(secretP) } }); j = await J(r);
  check("PW-16: 5 wrong codes, then the right one -> 429, no PUT", r.status === 429 && j.error === "Too many wrong codes. Wait 10 minutes, then try again." && puts() === pBefore, r.status + " " + JSON.stringify(j));
  attempts.clear(); cool();
  const stampBefore = p1.app_metadata.password_set_at; await new Promise((res2) => setTimeout(res2, 5));
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok2, code: totp(secretP) } }); j = await J(r);
  check("PW-17: right code -> 200, PUT made, attempts cleared, password_set_at re-stamped", r.status === 200 && puts() === pBefore + 1 && !attempts.has(p1.id) && Date.parse(p1.app_metadata.password_set_at) > Date.parse(stampBefore), r.status + " " + JSON.stringify(j) + " " + stampBefore + " -> " + p1.app_metadata.password_set_at);
  cool(); fail.challenge = true; pBefore = puts();
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok, code: totp(secretP) } }); j = await J(r);
  check("PW-18: WorkOS challenge fails + right code -> 502 (never 'wrong code'), no PUT", r.status === 502 && puts() === pBefore && !/didn't match/.test(j.error || ""), r.status + " " + JSON.stringify(j));
  fail.challenge = false; attempts.clear();
  cool(); fail.rpc = true;
  r = await callP("/security/password", { method: "POST", token: tok, body: { password: PW.ok, code: totp(secretP) } }); j = await J(r);
  check("PW-19: attempt counter missing + two-step on -> 502 fails closed, no PUT", r.status === 502 && puts() === pBefore, r.status + " " + JSON.stringify(j));
  fail.rpc = false;

  for (const k of Object.keys(orig)) console[k] = orig[k];
  const leaked = Object.values(PW).filter((p) => out.some((l) => l.includes(p)) || bodies.some((b) => b.includes(p)));
  check("PW-12: no password ever appears in the bridge's console output or any response body", leaked.length === 0, leaked.length + " leaked");
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
