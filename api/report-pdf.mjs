// api/report-pdf.mjs — the licensed PDF of a briefing, stamped for the reader
// who asks for it. A Vercel Node function; the Vite dev server mounts the same
// handler at /api/report-pdf (vite.config.js), so localhost behaves alike.
//
//   POST /api/report-pdf   Authorization: Bearer <Supabase access token>
//                          { "ref": "ATK-2026-0908-NATS" }
//   200  application/pdf, Content-Disposition attachment, X-Licence-Id
//   401  no token · 403 not a subscriber · 404 no print edition for that ref
//
// Who may download is decided exactly as for /reports-full/ (src/lib/reportGate.js:
// the database's is_subscriber() on the verified token). The licence is the
// reader's own profile (full name, job title, company, account email), read
// here with their token: nothing typed, nothing to forge. The account id goes
// into the licence id, so a copy is always traceable to the login. Masters: reports-pdf/<ref>.pdf +
// <ref>.stamp.json, made by the print build (see api/_lib/reportPdf.mjs).
import { bearerToken, isSubscriberToken, tokenClaims } from "../src/lib/reportGate.js";
import { latin, stampReportPdf } from "./_lib/reportPdf.mjs";

const OPTS = {
  supabaseUrl: process.env.VITE_SUPABASE_URL || "https://ovenyjguhkgiceddzwna.supabase.co",
  anonKey: process.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_23l5g7MVvgkKuUIctG-e9w_cWYnAtM5",
};

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("cache-control", "private, no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) { res.end(Buffer.from(body)); return; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

// Vercel parses a JSON body into req.body; the Vite dev server hands over the raw stream.
// The reader's profile row, through the public.profiles view with their own token
// (the same read the app makes); null when the view or the row is missing.
async function readProfile(token, sub) {
  try {
    const r = await fetch(`${OPTS.supabaseUrl.replace(/\/$/, "")}/rest/v1/profiles?id=eq.${encodeURIComponent(sub)}&select=full_name,role,company,email,industry,tier`, {
      headers: { apikey: OPTS.anonKey, Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch { return null; }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > 16384) throw new Error("body_too_large"); }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (req.method !== "POST") return send(res, 405, { error: "post_only" });
  const token = bearerToken(req.headers.authorization);
  if (!token) return send(res, 401, { error: "sign_in" });
  if (!(await isSubscriberToken(token, OPTS))) return send(res, 403, { error: "subscribers_only" });
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: "bad_body" }); }
  const c = tokenClaims(token) || {};
  const ref = String(body.ref || "");
  const prof = (await readProfile(token, c.sub || "")) || {};
  const name = prof.full_name || (c.user_metadata && c.user_metadata.full_name) || c.email || "";
  const role = [prof.role, prof.company].filter(Boolean).join(" \u00b7 ") || "Subscriber";
  try {
    const out = await stampReportPdf({ ref, name, role, email: prof.email || c.email || "", userId: c.sub || "" });
    return send(res, 200, out.bytes, {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${ref}.pdf"`,
      "content-length": String(out.bytes.length),
      "x-licence-id": latin(out.licenceId, 80),
      "x-robots-tag": "noindex",
    });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    return send(res, status, { error: status === 500 ? "stamp_failed" : e.message });
  }
}
