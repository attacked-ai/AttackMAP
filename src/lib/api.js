// api.js — the FastAPI layer (api/), as seen from the browser.
//
// Off by default: with no VITE_API_URL the app keeps reading PostgREST
// directly, exactly as before, so the API can be rolled out on its own
// schedule. With it set, the calls that must not be decided in the browser
// go through the API with the reader's Supabase session token:
//   • the subscriber layer of an incident   (data.js → loadIncidentDetail)
//   • switching the subscription             (AuthProvider → setSubscribed)
//   • the baked reports, locked server-side  (ReportFrame → reportHtml)
// Every helper returns null when the API is off or the reader has no session,
// and callers fall back to the old path.
//
// GCP backend (VITE_BACKEND=gcp): the API is always on, at /api on this same
// origin, and the reader is identified by the HttpOnly session cookie, so no
// token is attached and anonymous readers use it too (reports arrive locked
// by the server, never unlocked by the browser).

import { GCP } from "./backend";
import { readerToken } from "./authClient";

export const API_URL = GCP ? "/api" : String(import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
export const apiEnabled = () => !!API_URL;

const sessionToken = readerToken;

async function call(path, { method = "GET", body, auth = true, text = false } = {}) {
  if (!API_URL) return null;
  const headers = { Accept: text ? "text/html" : "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (GCP) {
    headers["X-Requested-With"] = "attacked";  // the API's CSRF check; the cookie carries the session
  } else if (auth) {
    const t = await sessionToken();
    if (!t) return null;                       // no session → caller uses the old path
    headers.Authorization = `Bearer ${t}`;
  }
  const r = await fetch(`${API_URL}${path}`, { method, headers, ...(GCP ? { credentials: "same-origin" } : {}), body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!r.ok) {
    let msg = `API ${r.status}`;
    try { const j = await r.json(); msg = j.detail || msg; } catch { /* not json */ }
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return text ? r.text() : r.json();
}

export const apiFetch = (path, opts) => call(path, opts);

// The subscriber layer, in the shape data.js already returns.
export async function subscriberLayer(id) {
  const j = await call(`/incidents/${id}/subscriber-layer`);
  if (!j) return null;
  return { blast: j.blast_radius || [], controls: j.adaptive_controls || [], peers: j.peer_watchlist || [], analogues: j.historical_analogues || [], sources: j.sources || [] };
}

// Flip the tier; resolves to the new tier string or null when the API is off.
export async function setSubscription(on) {
  const j = await call("/subscription", { method: "POST", body: { on } });
  return j ? j.tier : null;
}

// A baked report's HTML with the lock already applied by the server. Loaded
// with the token (an <iframe src> cannot carry one) and shown via srcdoc, which
// keeps the frame same-origin so the page can still reach into it.
export async function reportHtml(ref) {
  return call(`/reports/${encodeURIComponent(ref)}`, { text: true, auth: true });
}

// Ask the API to email a sign-in code. Unlike Supabase's own email, this is
// ALWAYS a code — for a new address (the sign-up form rides along as meta)
// and for a returning one. Returns null when the API is off so the caller
// falls back to Supabase's signInWithOtp. No session needed.
export async function sendCode(email, meta = null, create = true) {
  return call("/auth/send-code", { method: "POST", body: { email, meta, create }, auth: false });
}
