// _shared/mail.ts — how every function sends an email.
//
//   RESEND_API_KEY set    → Resend (https://resend.com): one HTTPS call per
//                           message, From = env MAIL_FROM, an address on the
//                           domain verified in Resend, e.g.
//                           "Attacked.ai <brief@attacked.ai>". The Google Cloud setup.
//   RESEND_API_KEY unset  → Gmail SMTP through denomailer (GMAIL_USER +
//                           GMAIL_APP_PASSWORD), as the functions always sent, so
//                           a redeploy to Supabase works with its current secrets.
//
// sendMail never throws. It returns { ok, provider, id?, error?, skipped? }, so a
// bulk sender logs one failure and carries on with the next reader.
//
// Resend is retried on 429 and 5xx (and on a dropped connection), 3 attempts in
// all, honouring Retry-After. Pass idempotencyKey (see idemKey) so a retry that
// crosses a message Resend had in fact accepted is not delivered twice.
//
// Gmail opens one SMTP connection per message. That costs a login per reader in
// a bulk send, which is fine for a fallback; the connection is never shared
// between requests, so concurrent calls cannot close each other's.

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

export type Mail = {
  to: string;
  subject: string;
  html: string;
  text?: string;                     // omitted: Resend derives the text part from the HTML
  headers?: Record<string, string>;  // e.g. List-Unsubscribe
  idempotencyKey?: string;           // Resend only (24-hour window)
  gmailFrom?: string;                // Gmail fallback only; Resend always sends as MAIL_FROM
};
export type MailResult = { ok: boolean; provider: "resend" | "gmail-smtp"; id?: string; error?: string; skipped?: boolean };

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_ATTEMPTS = 3;
const RESEND_TIMEOUT_MS = 15_000;
const GMAIL_TEXT = "This email is best viewed in an HTML-capable client.";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mailProvider(): "resend" | "gmail-smtp" {
  return env("RESEND_API_KEY") ? "resend" : "gmail-smtp";
}

// Why nothing can be sent right now, or null when a provider is configured.
// Lets a caller fail fast before it renders a whole run of emails.
export function mailSetupError(): string | null {
  if (env("RESEND_API_KEY")) return env("MAIL_FROM") ? null : "MAIL_FROM is not set (needed with RESEND_API_KEY)";
  return env("GMAIL_USER") && env("GMAIL_APP_PASSWORD") ? null : "no mail provider: set RESEND_API_KEY + MAIL_FROM (or GMAIL_USER + GMAIL_APP_PASSWORD)";
}

// A stable Idempotency-Key for one message: the same parts give the same key, so
// a retried call or a re-run of the same job cannot deliver the same email twice
// inside Resend's 24-hour window. Include the subject and HTML in the parts: a
// changed email then gets a new key instead of Resend's 409 for a reused one.
// Hashed, so no address appears in it.
export async function idemKey(label: string, ...parts: unknown[]): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.map((p) => String(p ?? "")).join("\u0000")));
  return `${label}/${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function sendMail(m: Mail): Promise<MailResult> {
  const key = env("RESEND_API_KEY");
  return key ? await viaResend(m, key) : await viaGmail(m);
}

async function viaResend(m: Mail, key: string): Promise<MailResult> {
  const from = env("MAIL_FROM");
  if (!from) return { ok: false, skipped: true, provider: "resend", error: "MAIL_FROM is not set" };
  const payload: Record<string, unknown> = { from, to: [m.to], subject: m.subject, html: m.html };
  if (m.text) payload.text = m.text;
  if (m.headers && Object.keys(m.headers).length) payload.headers = m.headers;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (m.idempotencyKey) headers["Idempotency-Key"] = m.idempotencyKey;

  let error = "";
  for (let attempt = 1; attempt <= RESEND_ATTEMPTS; attempt++) {
    let waitMs = 1000 * 3 ** (attempt - 1);   // 1 s, then 3 s
    try {
      const r = await fetch(RESEND_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(RESEND_TIMEOUT_MS) });
      const body = await r.text();
      if (r.ok) {
        let id = "";
        try { id = String(JSON.parse(body)?.id ?? ""); } catch { /* keep "" */ }
        return { ok: true, provider: "resend", id };
      }
      error = `resend ${r.status}: ${body.slice(0, 300)}`;
      // Only rate limiting and server errors can get better on a retry.
      if (r.status !== 429 && r.status < 500) break;
      const after = Number(r.headers.get("retry-after"));
      if (Number.isFinite(after) && after > 0) waitMs = Math.min(after * 1000, 10_000);
    } catch (e) {
      error = `resend unreachable: ${(e as Error)?.message || String(e)}`;
    }
    if (attempt < RESEND_ATTEMPTS) await sleep(waitMs);
  }
  return { ok: false, provider: "resend", error };
}

async function viaGmail(m: Mail): Promise<MailResult> {
  const user = env("GMAIL_USER"), pass = env("GMAIL_APP_PASSWORD");
  if (!user || !pass) return { ok: false, skipped: true, provider: "gmail-smtp", error: "Gmail creds missing (GMAIL_USER / GMAIL_APP_PASSWORD)" };
  const msg = {
    from: m.gmailFrom || `${env("SENDER_NAME") || "Attacked.ai"} <${user}>`,
    to: m.to,
    subject: m.subject,
    content: m.text || GMAIL_TEXT,
    html: m.html,
    ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
  };
  let client: SMTPClient | null = null;
  try {
    client = new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: user, password: pass } } });
    await client.send(msg);
    return { ok: true, provider: "gmail-smtp", id: "gmail-smtp" };
  } catch (e) {
    return { ok: false, provider: "gmail-smtp", error: (e as Error)?.message || String(e) };
  } finally {
    try { await client?.close(); } catch { /* noop */ }
  }
}
