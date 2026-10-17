// workos.js — WorkOS sign-in for the Supabase site, through the workos-auth
// Edge Function (supabase/functions/workos-auth).
//
// Switched on per build with VITE_AUTH_PROVIDER=workos. Off (the default), the
// site signs in exactly as before (Supabase codes and Supabase OAuth).
//
//   emailStart(email)            WorkOS makes a 6-digit code; the function emails it
//   emailVerify(email, code)     -> { token_hash, type } for supabase.auth.verifyOtp
//   startHosted(screen, back)    full-page trip to the WorkOS-hosted sign-in page
//   startProvider(id, back)      full-page trip: Google / Microsoft / GitHub / LinkedIn
//   takeReturn()                 the token a provider trip brought back (#wos_token=…)
//   savePending / takePending    sign-up form details kept across a provider trip

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
  if (!r.ok) { const e = new Error(j.error || `Sign-in failed (${r.status}).`); e.status = r.status; throw e; }
  return j;
}

export const emailStart = (email) => post("/email/start", { email });
export const emailVerify = (email, code) => post("/email/verify", { email, code });

// The WorkOS-hosted sign-in page (AuthKit, branded in the WorkOS dashboard):
// email code or Google / Microsoft / GitHub, all on WorkOS's page. The reader
// comes back the same way as from startProvider. Checks first that the bridge
// answers, so an outage is a message in our window, not a raw error page.
// `cancel` (an AbortSignal): the reader closed our window while we checked.
export async function startHosted(screen, back, cancel) {
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
    redirect: tripBack(back),
  });
  window.location.href = `${BRIDGE}/start?${q}`;
}

export function startProvider(id, back) {
  const provider = WORKOS_PROVIDER[id];
  if (!provider) throw new Error("That sign-in option is not switched on.");
  const q = new URLSearchParams({ provider, redirect: tripBack(back) });
  window.location.href = `${BRIDGE}/start?${q}`;
}

// Each trip belongs to the tab that started it: a random nonce rides in the
// return address (kept by the bridge in its signed cookie) and in this tab's
// sessionStorage. takeReturn() accepts a token only when the two match.
// Without this, anyone could send a link carrying their own #wos_token and
// sign the reader in to the sender's account (login CSRF).
const TRIP = "attacked.wosTrip";
function tripBack(back) {
  const n = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  try { sessionStorage.setItem(TRIP, JSON.stringify({ n, at: Date.now() })); } catch { /* storage blocked: the return is refused */ }
  const base = String(back || `${window.location.origin}/?dashboard`).split("#")[0];
  return `${base}${base.includes("?") ? "&" : "?"}wos_n=${n}`;
}

// A trip lands on the page with ?…&wos_n=… and #wos_token=…&wos_type=…. Take
// both off the address straight away (not left in history or copied in a
// link) and hand the token back once, only if this tab started the trip.
export function takeReturn() {
  if (typeof window === "undefined") return null;
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const tokens = h.getAll("wos_token");
  const n = new URLSearchParams(window.location.search).get("wos_n");
  if (!tokens.length && !n) return null;
  const type = h.get("wos_type") || "magiclink";
  h.delete("wos_token"); h.delete("wos_type");
  const search = window.location.search.replace(/([?&])wos_n=[^&]*&?/, "$1").replace(/[?&]$/, "");
  const rest = h.toString();
  window.history.replaceState(null, "", window.location.pathname + search + (rest ? `#${rest}` : ""));
  let trip = null;
  try { trip = JSON.parse(sessionStorage.getItem(TRIP) || "null"); sessionStorage.removeItem(TRIP); } catch { /* storage blocked */ }
  if (tokens.length !== 1 || !n || !trip || trip.n !== n || Date.now() - trip.at > 30 * 60_000) {
    if (tokens.length) console.warn("[Auth] sign-in return ignored: it was not started in this tab");
    return null;
  }
  return { token_hash: tokens[0], type };
}

// The sign-up form's answers, kept for the length of a provider trip (this tab
// only, 30 minutes), so someone who filled the form and then chose Google does
// not have to answer again.
const PENDING = "attacked.pendingSignup";
export function savePending(fields) {
  try { sessionStorage.setItem(PENDING, JSON.stringify({ fields, at: Date.now() })); } catch { /* storage blocked */ }
}
export function takePending() {
  try {
    const raw = sessionStorage.getItem(PENDING);
    sessionStorage.removeItem(PENDING);
    const p = raw ? JSON.parse(raw) : null;
    return p && p.fields && Date.now() - p.at < 30 * 60_000 ? p.fields : null;
  } catch { return null; }
}

// Account security — two-step verification (an authenticator-app code) — as
// the signed-in reader, through the bridge's /security routes. The reader's
// Supabase access token proves who is asking; WorkOS keeps the factor and asks
// for its code on the sign-in page. Paths: "" (status), "/totp/start",
// "/totp/confirm" {setup, code}, "/totp/remove" {code}. Errors carry the
// bridge's code ("reauth": sign in again first; "no_workos").
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
