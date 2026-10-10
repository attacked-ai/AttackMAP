// incident-deliver — the internal sweep brief: mails (and WhatsApps) the latest
// sweep once to every active report_recipients row; delivery_log dedupes.
// Triggered every 30 min (pg_cron auto-incident-report on Supabase; Cloud
// Scheduler through the API on Google Cloud: deploy/gcp/functions/README.md).
//
// 2026-09-30, portable to Cloud Run:
//   • callers must be internal (x-internal-token or the service-role key; see
//     _shared/auth.ts). The response lists recipient addresses.
//   • mail goes through _shared/mail.ts: Resend when RESEND_API_KEY is set, else
//     Gmail SMTP as before (GMAIL_USER must now be set; the address fallback that
//     was hardcoded here is gone).
//   • every model- or DB-written string in the email HTML is escaped (esc).
//   • listens on env PORT when set (Cloud Run), else Deno's default 8000.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { idemKey, sendMail } from "../_shared/mail.ts";
import { requireInternal } from "../_shared/auth.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// From on the Gmail fallback only (Resend always sends as MAIL_FROM).
const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM");
const GMAIL_FROM = EMAIL_FROM && EMAIL_FROM.includes("<") ? EMAIL_FROM : `Attacked.ai Intel <${GMAIL_USER}>`;
// The dashboard moved from the Netlify site (not reachable from the owner's Netlify account) to its own
// Vercel project on 2026-09-17. A DASHBOARD_URL secret still naming the Netlify host is treated as stale,
// so the email can never point back at the frozen build.
const DASHBOARD_URL = (() => {
  const fromEnv = (Deno.env.get("DASHBOARD_URL") ?? "").trim();
  return fromEnv && !fromEnv.includes("sensational-ganache-31f0d0") ? fromEnv : "https://attacked-daily-brief.vercel.app";
})();
const TW_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
const TW_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
const TW_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM");

const h = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };
function dashLink(sid: number) {
  if (!DASHBOARD_URL) return "";
  return `${DASHBOARD_URL}${DASHBOARD_URL.includes("?") ? "&" : "?"}sweep_id=${sid}`;
}

async function rpc(fn: string, body: Record<string, unknown>) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${await r.text()}`);
  return await r.json();
}
async function sel(path: string) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: h });
  if (!r.ok) throw new Error(`sel ${r.status}: ${await r.text()}`);
  return await r.json();
}
async function logDelivery(row: Record<string, unknown>) {
  await fetch(`${URL_}/rest/v1/delivery_log`, { method: "POST", headers: { ...h, Prefer: "return=minimal" }, body: JSON.stringify(row) });
}

const SEVNAME = (s: number) => (s === 5 ? "CRITICAL" : s === 4 ? "HIGH" : s === 3 ? "MED" : s === 2 ? "LOW" : "MIN");
const SEVCOL = (s: number) => (s === 5 ? "#FF6B6B" : s === 4 ? "#FF8C5A" : s === 3 ? "#FCBD00" : s === 2 ? "#34C759" : "#8E8E93");
const arrow = (n: number) => (n > 0 ? `▲ ${n}` : n < 0 ? `▼ ${Math.abs(n)}` : "flat");

// Model-written text (headlines, summaries, entities, update notes) can carry & < > and quotes, so every string
// from the report is escaped before it goes into HTML — the escapeHtml helper of this file.
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (iso: unknown) => {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : String(iso ?? "");
};

// Summaries are paragraphs separated by blank lines. When a published incident later changes, the pipeline appends a
// dated "UPDATE <date>: ..." paragraph (apply_incident_update); those are highlighted so the change is easy to spot.
function summaryHtml(s: unknown) {
  return String(s ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = p.match(/^UPDATE (\d{1,2} [A-Z][a-z]{2} \d{4}): /);
    return m ? `<b style="color:#FCBD00">UPDATE ${esc(m[1])}:</b> ${esc(p.slice(m[0].length))}` : esc(p);
  }).join("<br><br>");
}

// The 13 GUARD risk categories. secondary_mappings.category is a 3-letter code in ~96% of rows but free text in the
// rest ("Operations", "GEOPOLITICAL"); the subcategory_code prefix comes from the framework, so it wins — same rule
// as the dashboard.
const CAT_LABEL: Record<string, string> = {
  OPS: "Operational", GEO: "Geopolitical", STR: "Strategic", CYB: "Cyber Security", PPL: "People & Human Capital",
  REP: "Reputational", ENV: "Environmental", TEC: "Technology", DAT: "Data & Privacy", PHY: "Physical Security",
  TPR: "Third-Party Risk", REG: "Regulatory", FIN: "Financial",
};
const secCode = (s: any) => {
  const fromCode = String(s?.subcategory_code ?? "").split("-")[0].toUpperCase();
  if (CAT_LABEL[fromCode]) return fromCode;
  const raw = String(s?.category ?? "").trim().toUpperCase();
  return CAT_LABEL[raw] ? raw : (fromCode || raw);
};
const secParent = (s: any) => CAT_LABEL[secCode(s)] ?? (String(s?.category ?? "").trim() || "Other");

// Classification tags for one incident, as a small labelled fact box: category, subcategory, and the secondary
// categories grouped under their parent category. Written for readers: full names, no framework codes, no monospace —
// codes and tiny tracked labels made the first version read like a code listing (owner feedback, 2026-09-18).
function tagsHtml(m: any) {
  const groups = new Map<string, string[]>();
  for (const s of Array.isArray(m.secondary) ? m.secondary : []) {
    const name = String(s?.subcategory_name ?? "").trim();
    if (!name) continue;
    const parent = secParent(s);
    groups.set(parent, [...(groups.get(parent) ?? []), name]);
  }
  const row = (label: string, value: string) =>
    `<tr><td style="padding:3px 16px 3px 0;color:#8C8C8C;font-size:11.5px;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:3px 0;font-size:12.5px;line-height:1.55;color:#C8C8C8">${value}</td></tr>`;
  const rows = [
    m.category ? row("Category", `<span style="color:#FCBD00;font-weight:600">${esc(m.category)}</span>`) : "",
    m.subcategory ? row("Subcategory", `<span style="color:#fff">${esc(m.subcategory)}</span>`) : "",
    groups.size ? row("Secondary categories", [...groups].map(([p, subs]) => `<span style="color:#fff">${esc(p)}:</span> ${subs.map((x) => esc(x)).join(", ")}`).join("<br>")) : "",
  ].join("");
  return rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 8px;background:#222;border:1px solid #333;border-radius:6px"><tr><td style="padding:8px 12px"><table role="presentation" cellpadding="0" cellspacing="0">${rows}</table></td></tr></table>` : "";
}

const DEV_LABEL: Record<string, string> = {
  root_cause: "Root cause", leadership_change: "Leadership change", regulatory_action: "Regulator action",
  legal_action: "Legal action", financial_impact: "Financial impact", casualties: "Casualties",
  scale_change: "Scale change", recovery: "Recovery", attribution: "Attribution", other: "Development",
};

// New developments about incidents from earlier briefs (report.updates, from sweep.incident_updates). A confirmed one
// has already changed the original incident; an unconfirmed one was only logged, and is labelled as such.
function updatesHtml(rep: any) {
  const list = rep.updates ?? [];
  if (!list.length) return "";
  const rows = list.map((u: any) => {
    const now = u.severity_after ?? u.severity_before;
    const raised = u.confirmed && Number.isInteger(u.severity_before) && now > u.severity_before;
    const sev = Number.isInteger(now) ? `&nbsp;<span style="font-family:monospace;font-size:11px;color:${SEVCOL(now)}">${raised ? `S${u.severity_before} → ` : ""}S${now} ${SEVNAME(now)}</span>` : "";
    const src = (u.sources ?? []).find((s: any) => /^https?:\/\//.test(String(s?.url ?? "")));
    const first = esc(dashLink(u.first_sweep_id));
    const firstTxt = `first reported ${esc(dayLabel(u.first_sweep_date))}`;
    return `
    <tr><td style="padding:10px 0;border-bottom:1px solid #333">
      <span style="font-family:monospace;font-size:10px;color:#FCBD00;border:1px solid #FCBD0055;padding:1px 6px;border-radius:3px">${esc(DEV_LABEL[u.development_type] ?? "Development")}</span>${sev}${u.confirmed ? "" : `&nbsp;<span style="font-family:monospace;font-size:10px;color:#A8A8A8">UNCONFIRMED</span>`}<br>
      <b style="color:#fff">${esc(u.headline)}</b>
      <div style="color:#A8A8A8;font-size:13px;margin-top:4px;line-height:1.55">${esc(u.what_changed)}</div>
      <span style="color:#777;font-size:11px;font-family:monospace">${esc(dayLabel(u.update_date))} · ${esc(u.entity)} · ${first ? `<a href="${first}" style="color:#A8A8A8">${firstTxt}</a>` : firstTxt}${src ? ` · <a href="${esc(src.url)}" style="color:#FCBD00;text-decoration:none">${esc(src.publisher || "source")}</a>` : ""}</span>
    </td></tr>`;
  }).join("");
  return `<h3 style="font-family:Georgia,serif;color:#fff;font-size:18px;border-bottom:1px solid #FCBD00;padding-bottom:6px;margin-top:24px">Updates to Earlier Incidents — ${list.length}</h3><table style="width:100%;border-collapse:collapse">${rows}</table>`;
}

function emailHtml(rep: any, exec: boolean) {
  const t = rep.totals, d = rep.delta;
  const url = esc(dashLink(rep.sweep_id));
  const day = esc(rep.sweep_date);
  const btn = url ? `<div style="margin:18px 0"><a href="${url}" style="display:inline-block;background:#FCBD00;color:#1A1A1A;font-weight:600;font-size:13px;text-decoration:none;padding:11px 22px;border-radius:6px">→ View Live Dashboard (${day})</a></div>` : "";
  const majors = (rep.major_incidents ?? []).map((m: any) => `
    <tr><td style="padding:10px 0;border-bottom:1px solid #333">
      <span style="font-family:monospace;font-size:11px;color:${SEVCOL(m.severity)}">S${esc(m.severity)} ${SEVNAME(m.severity)}</span>
      &nbsp;<b style="color:#fff">${esc(m.headline)}</b><br>
      <span style="color:#A8A8A8;font-size:12px">${esc(m.category)} · ${esc(m.entity)}${m.country ? " · " + esc(m.country) : ""}${m.threat_actor ? " · ⚔ " + esc(m.threat_actor) : ""}</span>
    </td></tr>`).join("");
  const cats = exec ? "" : (rep.categories ?? []).map((c: any) =>
    `<tr><td style="color:#A8A8A8;padding:3px 0">${esc(c.label)}</td><td style="font-family:monospace;text-align:right;color:#fff">${esc(c.incidents)}${c.major ? ` (${esc(c.major)}⚑)` : ""}</td></tr>`).join("");
  const fullLog = exec ? "" : (rep.incidents ?? []).map((m: any) => `
    <tr><td style="padding:12px 0;border-bottom:1px solid #2a2a2a">
      <span style="font-family:monospace;font-size:10px;color:${SEVCOL(m.severity)};border:1px solid ${SEVCOL(m.severity)}55;padding:1px 6px;border-radius:3px">S${esc(m.severity)} ${SEVNAME(m.severity)}</span>
      &nbsp;<b style="color:#fff;font-size:14px">${esc(m.headline)}</b><br>
      <span style="color:#8C8C8C;font-size:12px">${esc(m.entity)}${m.country ? " · " + esc(m.country) : ""}${m.sector ? " · " + esc(m.sector) : ""}</span>
      ${tagsHtml(m)}
      ${m.summary ? `<div style="color:#A8A8A8;font-size:13px;margin-top:5px;line-height:1.55">${summaryHtml(m.summary)}</div>` : ""}
    </td></tr>`).join("");
  return `<div style="background:#1A1A1A;color:#fff;font-family:Inter,Arial,sans-serif;padding:28px;max-width:680px;margin:0 auto">
    <div style="font-weight:600;font-size:16px">Attacked<span style="color:#FCBD00">.ai</span> <span style="color:#585858;font-size:11px;text-transform:uppercase;letter-spacing:1px">Incident Intelligence</span></div>
    <div style="font-family:monospace;color:#FCBD00;font-size:11px;letter-spacing:1px;margin-top:18px">SWEEP #${esc(rep.sweep_id)} · ${day}${Number.isFinite(rep.lookback_hours) ? ` · LAST ${rep.lookback_hours}H` : ""}</div>
    <h1 style="font-family:Georgia,serif;font-size:30px;margin:6px 0 14px">${exec ? "Executive Brief" : "Daily Incident Brief"}</h1>
    <div style="border-left:2px solid #FCBD00;padding-left:14px;color:#A8A8A8;font-size:14px">${esc(rep.exec_line)}</div>
    ${btn}
    <table style="width:100%;margin:22px 0;border-collapse:collapse;text-align:center"><tr>
      <td><div style="font-family:monospace;font-size:26px;color:#FCBD00">${t.total}</div><div style="font-size:10px;color:#585858;text-transform:uppercase">Incidents</div><div style="font-size:10px;font-family:monospace;color:#A8A8A8">${arrow(d.total_change)}</div></td>
      <td><div style="font-family:monospace;font-size:26px;color:#FF8C5A">${t.major}</div><div style="font-size:10px;color:#585858;text-transform:uppercase">Major</div><div style="font-size:10px;font-family:monospace;color:#A8A8A8">${arrow(d.major_change)}</div></td>
      <td><div style="font-family:monospace;font-size:26px;color:#FF6B6B">${t.critical}</div><div style="font-size:10px;color:#585858;text-transform:uppercase">Critical</div></td>
      <td><div style="font-family:monospace;font-size:26px;color:#fff">${t.avg_severity}</div><div style="font-size:10px;color:#585858;text-transform:uppercase">Avg sev</div></td>
    </tr></table>
    <h3 style="font-family:Georgia,serif;color:#fff;font-size:18px;border-bottom:1px solid #FCBD00;padding-bottom:6px">Major Incidents</h3>
    <table style="width:100%;border-collapse:collapse">${majors || '<tr><td style="color:#585858;padding:10px 0">None at severity 4–5.</td></tr>'}</table>
    ${updatesHtml(rep)}
    ${exec ? "" : `<h3 style="font-family:Georgia,serif;color:#fff;font-size:18px;border-bottom:1px solid #FCBD00;padding-bottom:6px;margin-top:24px">By Category</h3><table style="width:100%;border-collapse:collapse;font-size:13px">${cats}</table>`}
    ${exec ? "" : `<h3 style="font-family:Georgia,serif;color:#fff;font-size:18px;border-bottom:1px solid #FCBD00;padding-bottom:6px;margin-top:24px">All Incidents — ${rep.incidents?.length ?? 0} total</h3><table style="width:100%;border-collapse:collapse">${fullLog}</table>`}
    <p style="color:#585858;font-size:11px;margin-top:26px">${url ? `<a href="${url}" style="color:#FCBD00;text-decoration:none">Open full dashboard →</a> · ` : ""}Attacked.ai — Confidential Intelligence · sweep #${esc(rep.sweep_id)}</p>
  </div>`;
}

function waText(rep: any) {
  const t = rep.totals;
  const top = (rep.major_incidents ?? []).slice(0, 3).map((m: any) => `• S${m.severity} ${m.headline}`).join("\n");
  const ups = (rep.updates ?? []).slice(0, 2).map((u: any) => `• ${u.confirmed ? "" : "(unconfirmed) "}${u.headline}`).join("\n");
  const url = dashLink(rep.sweep_id);
  const link = url ? `\n\nDashboard: ${url}` : "";
  return `*Attacked.ai — Daily Brief* (${rep.sweep_date})\n${t.total} incidents · ${t.major} major · ${t.critical} critical (${arrow(rep.delta.total_change)} vs prior)\n\n${top || "No major incidents."}${ups ? `\n\nUpdates to earlier incidents:\n${ups}` : ""}${link}`;
}

// delivery_log keeps the provider's message id: Resend's id, or "gmail-smtp" as before.
async function sendEmail(to: string, subject: string, html: string, idempotencyKey: string) {
  const res = await sendMail({ to, subject, html, idempotencyKey, gmailFrom: GMAIL_FROM });
  if (res.ok) return { status: "sent", provider_id: res.id || res.provider };
  return { status: res.skipped ? "skipped" : "failed", error: res.error };
}

async function sendWhatsApp(to: string, body: string) {
  if (!TW_SID || !TW_TOKEN || !TW_FROM) return { status: "skipped", error: "Twilio secrets not set" };
  const to_ = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const form = new URLSearchParams({ To: to_, From: TW_FROM, Body: body });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`, {
    method: "POST", headers: { Authorization: "Basic " + btoa(`${TW_SID}:${TW_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body_ = await r.json().catch(() => ({}));
  return r.ok ? { status: "sent", provider_id: body_.sid } : { status: "failed", error: JSON.stringify(body_) };
}

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (req) => {
  const denied = await requireInternal(req);
  if (denied) return denied;
  try {
    const input = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const sweep_id = input.sweep_id ?? null;
    const force = input.force === true;
    const rep = await rpc("fn_sweep_report", { p_sweep_id: sweep_id });
    const sid = rep.sweep_id;

    if (!rep || !rep.totals || (rep.totals.total ?? 0) === 0) {
      return new Response(JSON.stringify({ sweep_id: sid, skipped: "no incidents loaded yet — will retry next check" }), { headers: { "Content-Type": "application/json" } });
    }

    const recipients = await sel(`report_recipients?active=eq.true&select=*`);
    const already = force ? [] : await sel(`delivery_log?sweep_id=eq.${sid}&status=eq.sent&select=channel,recipient`);
    const sentKey = new Set(already.map((a: any) => `${a.channel}|${a.recipient}`));

    const results: any[] = [];
    for (const rcpt of recipients) {
      if (sentKey.has(`${rcpt.channel}|${rcpt.address}`)) { results.push({ to: rcpt.address, status: "already_sent" }); continue; }
      const exec = rcpt.role === "exec";
      const kind = exec ? "daily_exec" : "daily_full";
      let res;
      if (rcpt.channel === "email") {
        const upd = rep.totals.updates ?? 0;
        const subj = `${exec ? "Exec Brief" : "Incident Brief"} — ${rep.totals.total} incidents, ${rep.totals.major} major${upd ? `, ${upd} update${upd === 1 ? "" : "s"}` : ""} (${rep.sweep_date})`;
        const html = emailHtml(rep, exec);
        // Same sweep, recipient and email ⇒ same key, so a retry cannot mail twice; force (a deliberate
        // re-send) gets a fresh one.
        const key = await idemKey("incident-deliver", sid, rcpt.channel, rcpt.address, subj, html, force ? Date.now() : "");
        res = await sendEmail(rcpt.address, subj, html, key);
      } else {
        res = await sendWhatsApp(rcpt.address, waText(rep));
      }
      await logDelivery({ sweep_id: sid, kind, channel: rcpt.channel, recipient: rcpt.address, status: res.status, provider_id: res.provider_id ?? null, error: res.error ?? null, payload: { role: rcpt.role } });
      results.push({ to: rcpt.address, channel: rcpt.channel, ...res });
    }
    return new Response(JSON.stringify({ sweep_id: sid, sent: results }, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
