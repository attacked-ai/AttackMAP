// workos.js — WorkOS sign-in for the Supabase site, through the workos-auth
// Edge Function (supabase/functions/workos-auth).
//
// Switched on per build with VITE_AUTH_PROVIDER=workos. Off (the default), the
// site signs in exactly as before (Supabase codes and Supabase OAuth).
//
//   emailStart(email)            WorkOS makes a 6-digit code and emails it
//   emailVerify(email, code, names)  -> { token_hash, type } for supabase.auth.verifyOtp
//   bridgeInfo()                 { providers, configured, signup_form } from the bridge (or null)
//   startHosted(screen, back, cancel, hint, answers)  full-page trip to the WorkOS-hosted page
//   startProvider(id, back, answers)  full-page trip: Google / Microsoft / GitHub / LinkedIn
//   takeReturn()                 the token a trip brought back (#wos_token=…) and its nonce
//   takePending(n) / clearPending()  sign-up answers kept for one trip

// Trimmed: a value saved with a trailing newline (e.g. piped in from
// PowerShell's echo) must still count.
export const WORKOS = String(import.meta.env.VITE_AUTH_PROVIDER || "").trim().toLowerCase() === "workos";

const BRIDGE = `${String(import.meta.env.VITE_SUPABASE_URL || "").replace(/\/$/, "")}/functions/v1/workos-auth`;

// The modal's provider ids (kept from the Supabase days) -> WorkOS providers.
export const WORKOS_PROVIDER = {
  google: "GoogleOAuth",
  azure: "MicrosoftOAuth",
  github: "GitHubOAuth",
  linkedin_oidc: "LinkedInOAuth",
};

async function post(path, body) {
  let r;
  try {
    r = await fetch(`${BRIDGE}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Sign-in can't be reached right now. Check your connection and try again.");
  }
  let j = {};
  try { j = await r.json(); } catch { /* empty body */ }
  if (!r.ok) { const e = new Error(j.error || `Sign-in failed (${r.status}).`); e.status = r.status; e.code = j.code || null; e.reason = j.reason || null; throw e; }
  return j;
}

// The sign-up page (SignUpPage.jsx). emailVerify may carry the typed name, for
// a new account. A 409 with code "use_hosted" means the account must sign in
// on the WorkOS-hosted page (reason "two_step": it has two-step verification;
// "hosted": WorkOS needs its own page for something else).
export const emailStart = (email) => post("/email/start", { email });
export const emailVerify = (email, code, names = {}) => post("/email/verify", { email, code, ...names });

// What the bridge offers: providers WorkOS has switched on (e.g. ["authkit",
// "GoogleOAuth"]), configured (its WorkOS key is set) and signup_form (the
// sign-up page's own routes are on; an older bridge does not say). null when
// the bridge can't be asked.
export async function bridgeInfo() {
  try {
    const r = await fetch(`${BRIDGE}/providers`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const j = r.ok ? await r.json() : null;
    return j && Array.isArray(j.providers) ? j : null;
  } catch { return null; }
}

// The WorkOS-hosted sign-in page (AuthKit, branded in the WorkOS dashboard):
// email code or Google / Microsoft / GitHub, all on WorkOS's page. The reader
// comes back the same way as from startProvider. Checks first that the bridge
// answers, so an outage is a message in our window, not a raw error page.
// `cancel` (an AbortSignal): the reader closed our window while we checked.
// `hint`: an address to fill in on WorkOS's page. `answers`: the sign-up
// page's answers, saved once the reader is back (this trip only).
export async function startHosted(screen, back, cancel, hint, answers = null) {
  // Ready = the bridge answers within 8 s, WorkOS has the hosted page on, and
  // the bridge holds its WorkOS key (without it the trip would fail at the end).
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  cancel?.addEventListener("abort", () => ctl.abort());
  let j = null;
  try {
    const r = await fetch(`${BRIDGE}/providers`, { cache: "no-store", signal: ctl.signal });
    if (r.ok) j = await r.json();
  } catch { /* unreachable, too slow or cancelled */ } finally { clearTimeout(timer); }
  if (cancel?.aborted) return;
  if (!j || !Array.isArray(j.providers) || !j.providers.includes("authkit")) {
    throw new Error("Sign-in is unavailable right now. Please try again in a few minutes.");
  }
  if (j.configured === false) throw new Error("Sign-in is not switched on yet. Please try again later.");
  const q = new URLSearchParams({
    provider: "authkit",
    screen_hint: screen === "sign-in" ? "sign-in" : "sign-up",
    redirect: tripBack(back, answers),
  });
  if (hint) q.set("login_hint", String(hint).trim().toLowerCase());
  window.location.href = `${BRIDGE}/start?${q}`;
}

export function startProvider(id, back, answers = null) {
  const provider = WORKOS_PROVIDER[id];
  if (!provider) throw new Error("That sign-in option is not switched on.");
  const q = new URLSearchParams({ provider, redirect: tripBack(back, answers) });
  window.location.href = `${BRIDGE}/start?${q}`;
}

// Each trip belongs to the tab that started it: a random nonce rides in the
// return address (kept by the bridge in its signed cookie) and in this tab's
// sessionStorage. takeReturn() accepts a token only when the two match.
// Without this, anyone could send a link carrying their own #wos_token and
// sign the reader in to the sender's account (login CSRF). Sign-up answers
// given for the trip carry the same nonce, so they are only ever saved onto
// the account this trip signs in; a trip without answers drops any left over.
const TRIP = "attacked.wosTrip";
const SECTION = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;   // a section to land on (wos_h): a plain element id, nothing else
function tripBack(back, answers = null) {
  const n = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  try { sessionStorage.setItem(TRIP, JSON.stringify({ n, at: Date.now() })); } catch { /* storage blocked: the return is refused */ }
  try {
    if (answers) sessionStorage.setItem(PENDING, JSON.stringify({ fields: answers, n, at: Date.now() }));
    else sessionStorage.removeItem(PENDING);
  } catch { /* storage blocked: the answers are asked again */ }
  // The bridge drops any fragment from the return address (its callback adds
  // its own), so a section to land on, as in /?profile#security, rides along
  // as wos_h and takeReturn() puts it back as the hash.
  const [base, frag = ""] = String(back || `${window.location.origin}/?dashboard`).split("#");
  const section = SECTION.test(frag) ? `&wos_h=${frag}` : "";
  return `${base}${base.includes("?") ? "&" : "?"}wos_n=${n}${section}`;
}

// A trip lands on the page with ?…&wos_n=… and #wos_token=…&wos_type=…. Take
// both off the address straight away (not left in history or copied in a
// link) and hand the token back once, only if this tab started the trip.
export function takeReturn() {
  if (typeof window === "undefined") return null;
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const tokens = h.getAll("wos_token");
  const qs = new URLSearchParams(window.location.search);
  const n = qs.get("wos_n"), section = qs.get("wos_h") || "";
  if (!tokens.length && !n) return null;
  const type = h.get("wos_type") || "magiclink";
  h.delete("wos_token"); h.delete("wos_type");
  const search = window.location.search.replace(/([?&])wos_n=[^&]*&?/, "$1").replace(/([?&])wos_h=[^&]*&?/, "$1").replace(/[?&]$/, "");
  const rest = h.toString() || (SECTION.test(section) ? section : "");   // the section the trip was to land on
  window.history.replaceState(null, "", window.location.pathname + search + (rest ? `#${rest}` : ""));
  let trip = null;
  try { trip = JSON.parse(sessionStorage.getItem(TRIP) || "null"); sessionStorage.removeItem(TRIP); } catch { /* storage blocked */ }
  if (tokens.length !== 1 || !n || !trip || trip.n !== n || Date.now() - trip.at > 30 * 60_000) {
    if (tokens.length) console.warn("[Auth] sign-in return ignored: it was not started in this tab");
    return null;
  }
  return { token_hash: tokens[0], type, n };
}

// The sign-up page's answers, kept for one trip (this tab only, 30 minutes),
// so someone who filled the page and then chose Google, or was sent on to the
// hosted sign-in, does not have to answer again. Saved by tripBack; taken back
// only by the return of that same trip (its nonce).
const PENDING = "attacked.pendingSignup";
export function takePending(n) {
  try {
    const raw = sessionStorage.getItem(PENDING);
    sessionStorage.removeItem(PENDING);
    const p = raw ? JSON.parse(raw) : null;
    return p && p.fields && n && p.n === n && Date.now() - p.at < 30 * 60_000 ? p.fields : null;
  } catch { return null; }
}
export function clearPending() {
  try { sessionStorage.removeItem(PENDING); } catch { /* storage blocked */ }
}

// Account security — "Login and security" on the Profile page — as the
// signed-in reader, through the bridge's /security routes. The reader's
// Supabase access token proves who is asking; WorkOS keeps the factor and asks
// for its code on the sign-in page. Paths (GET when body is null, else POST):
//   ""                 status, the light form the reminder card uses
//   "?full=1"          status plus login.identities and login.methods, for the
//                      Linked accounts row (one extra WorkOS call; page only)
//   "/totp/start" {}, "/totp/confirm" {setup, code}, "/totp/remove" {code}
//   "/password" {password, code?}   set or change the WorkOS password; code
//                      only when two-step is on (bridge v8 and later)
// Errors carry the bridge's code ("reauth": sign in again first; "no_workos";
// "state_changed"; "weak_password"; "code_required").
export async function securityApi(path = "", body = null) {
  const { supabase } = await import("./supabaseClient");
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("Sign in again to change your security settings.");
  let r;
  try {
    r = await fetch(`${BRIDGE}/security${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
  } catch {
    throw new Error("Security settings can't be reached right now. Check your connection and try again.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "Security settings are unavailable right now. Try again in a minute."), { code: j.code || null });
  return j;
}
