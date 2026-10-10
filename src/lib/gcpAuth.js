// gcpAuth.js — sign-in on the Google Cloud backend (VITE_BACKEND=gcp).
//
// The session is an HttpOnly cookie (__session) set by the API: page scripts
// never see it, so an injected script cannot steal a sign-in. What the page
// holds is a short-lived access token (1 hour, in memory only) that the data
// API (our PostgREST at /rest/v1) checks; it is fetched from
// POST /api/auth/token with the cookie and renewed a minute before it lapses.
// The sign-in itself ends SESSION_DAYS (30) after it began, on the server.
//
//   getSession()           { user, session, access_token } | null
//   getAccessToken()       for supabase-js's accessToken option
//   onChange(cb)           called with the session (or null) when it changes
//   emailStart / emailVerify / googleStart / logout / devDirect

const API = "/api";
const HDR = { "Content-Type": "application/json", "X-Requested-With": "attacked" };

let current = null;          // { user, session, access_token, expires_at(ms) }
let inflight = null;
let renewTimer = null;
const listeners = new Set();       // who is signed in changed
const tokenListeners = new Set();  // any new token (sign-in, sign-out, hourly renewal)

function set(next) {
  const changed = (current?.user?.id || null) !== (next?.user?.id || null);
  const tokenChanged = (current?.access_token || null) !== (next?.access_token || null);
  current = next;
  if (changed) for (const cb of listeners) { try { cb(current); } catch { /* listener errors stay local */ } }
  if (tokenChanged) for (const cb of tokenListeners) { try { cb(current ? current.access_token : null); } catch { /* local */ } }
  // Keep the token fresh while the page is open, so code that cached it
  // (the map's raw fetches) never sends an expired one.
  clearTimeout(renewTimer);
  if (current && typeof window !== "undefined") {
    renewTimer = setTimeout(() => { refresh(); }, Math.max(5_000, current.expires_at - Date.now() - 60_000));
  }
}

async function post(path, body) {
  const r = await fetch(`${API}${path}`, { method: "POST", credentials: "same-origin", headers: HDR, body: JSON.stringify(body || {}) });
  let j = null;
  try { j = await r.json(); } catch { /* empty body */ }
  if (!r.ok) { const e = new Error((j && j.detail) || `Request failed (${r.status})`); e.status = r.status; throw e; }
  return j;
}

function adopt(j) {
  if (!j || !j.access_token) return null;
  const s = { user: j.user, session: j.session, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 0) * 1000 };
  set(s);
  return s;
}

// A fresh token (and with it the current session), or null when signed out.
async function refresh() {
  if (!inflight) {
    inflight = post("/auth/token")
      .then(adopt)
      .catch((e) => { if (e.status === 401) set(null); return e.status === 401 ? null : current; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export async function getSession() {
  if (current && current.expires_at - Date.now() > 60_000) return current;
  return refresh();
}

export async function getAccessToken() {
  const s = await getSession();
  return s ? s.access_token : null;           // null -> supabase-js sends the public anon key
}

export function onChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function onToken(cb) {
  tokenListeners.add(cb);
  return () => tokenListeners.delete(cb);
}

// Email code: start sends it, verify signs in (the API sets the cookie).
export const emailStart = (email, meta = null) => post("/auth/email/start", { email, meta });
export async function emailVerify(email, code) { return adopt(await post("/auth/email/verify", { email, code })); }

// Google: a full-page trip to Google and back; the API sets the cookie.
export function googleStart(redirect = "/?dashboard") {
  window.location.href = `${API}/auth/google/start?redirect=${encodeURIComponent(redirect)}`;
}

export async function logout(all = false) {
  try { await post("/auth/logout", { all }); } finally { set(null); }
}

// Local testing only (the API refuses it unless ENV=local, DEV_DIRECT_SIGNIN=true).
export async function devDirect(email, meta = null) { return adopt(await post("/auth/dev/direct", { email, meta })); }

// Profile picture -> Cloud Storage through the API; returns { url } or { error }.
export async function uploadAvatar(file) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`${API}/me/avatar`, { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "attacked" }, body: fd });
  let j = null;
  try { j = await r.json(); } catch { /* empty */ }
  return r.ok ? { url: j && j.url } : { error: (j && j.detail) || `Upload failed (${r.status})` };
}

// Admin uploads (report heroes, incident pictures) -> Cloud Storage.
export async function uploadMedia(kind, ref, file) {
  const fd = new FormData();
  fd.append("file", file); fd.append("kind", kind); fd.append("ref", ref);
  const r = await fetch(`${API}/admin/media`, { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "attacked" }, body: fd });
  let j = null;
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error((j && j.detail) || `Upload failed (${r.status})`);
  return j.url;
}
