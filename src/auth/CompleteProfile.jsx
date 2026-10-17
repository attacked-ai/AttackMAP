// ─────────────────────────────────────────────────────────────────────────
// CompleteProfile — the sign-up form's questions, asked once after a first
// sign-in that skipped the form (Google / Microsoft / GitHub / LinkedIn through
// WorkOS, straight from "Sign in").
//
//   name, job title, company, industry, email opt-in — the same fields and the
//   same strings as AuthModal's "Create an account" form (src/lib/taxonomy.js).
//   Industry decides what the dashboard and the daily brief lead with, so the
//   step stays until it is answered; "Sign out" is the only way past it.
//
// main.jsx shows it, when WorkOS sign-in is on, to a signed-in reader whose
// profile has no industry. It is presentational: main.jsx passes the reader and
// does the saving (onSave → saveProfileBasics, which stamps onboarded_at the
// first time and so sends the welcome email, as the sign-up form does).
// ─────────────────────────────────────────────────────────────────────────
import React, { useState } from "react";
import { SECTORS, ROLES } from "../lib/taxonomy";

// Light / paper palette, as AuthModal.
const C = {
  paper: "#FFFFFF", paper2: "#F5F2E9", ink: "#0E1116", ink2: "#383838", ink3: "#7A7E86",
  line: "#E7E5DE", line2: "#CFCDC4", gold: "#FCBD00", goldDeep: "#8A6D00", err: "#B21F31",
};

const Field = ({ children }) => <div style={{ marginBottom: 10 }}>{children}</div>;

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return [parts[0] || "", parts.slice(1).join(" ")];
}

export function CompleteProfile({ email, profile, nameHint, onSave, onSignOut }) {
  const [hintFirst, hintLast] = nameHint?.first_name
    ? [nameHint.first_name, nameHint.last_name || ""]
    : splitName(profile?.full_name || nameHint?.full_name);
  const [firstName, setFirstName] = useState(hintFirst);
  const [lastName, setLastName] = useState(hintLast);
  const [jobTitle, setJobTitle] = useState(ROLES.includes(profile?.role) ? profile.role : "");
  const [company, setCompany] = useState(profile?.company || "");
  const [industry, setIndustry] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!industry) { setError("Please choose your industry — it decides what your dashboard and daily brief lead with."); return; }
    setBusy(true);
    try {
      const r = await onSave({
        full_name: `${firstName.trim()} ${lastName.trim()}`.trim() || null,
        role: jobTitle || null,
        company: company.trim() || null,
        industry,
      }, consent);
      if (r && r.error) { setError(r.error); setBusy(false); }
      // On success the profile has an industry and main.jsx stops showing this.
    } catch (err) {
      setError(err?.message || "Could not save. Try again.");
      setBusy(false);
    }
  }

  const label = { display: "block", fontFamily: "Inter, sans-serif", fontSize: 11.5, color: C.ink, fontWeight: 600, marginBottom: 4 };
  const sub = { fontSize: 11, color: C.ink3, fontWeight: 400, marginLeft: 6 };
  const field = {
    width: "100%", padding: "9px 12px", background: C.paper, color: C.ink,
    border: `1px solid ${C.line2}`, borderRadius: 4, boxSizing: "border-box",
    fontFamily: "Inter, sans-serif", fontSize: 13.5, outline: "none",
  };
  const sel = { ...field, appearance: "none", cursor: "pointer" };
  const opt = { color: C.ink, background: C.paper };
  const onFocus = (e) => (e.target.style.borderColor = C.gold);
  const onBlur = (e) => (e.target.style.borderColor = C.line2);

  return (
    <div className="am-overlay" style={{
      position: "fixed", inset: 0, zIndex: 9999, background: "rgba(14,17,22,0.55)",
      backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-start",
      justifyContent: "center", padding: "3vh 18px", overflowY: "auto", overscrollBehavior: "contain",
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="cp-title" style={{
        width: "min(500px, 100%)", background: C.paper,
        border: `1px solid ${C.line}`, borderRadius: 6,
        padding: "20px 24px 22px", boxShadow: "0 24px 70px rgba(16,16,16,0.28)",
      }}>
        <div style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: C.goldDeep, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>
          Attacked.ai™ · Intelligence Inbox
        </div>
        <h2 id="cp-title" style={{ fontFamily: "Inter, sans-serif", fontWeight: 800, fontSize: 22, color: C.ink, lineHeight: 1.2, marginTop: 8, letterSpacing: "-0.015em" }}>
          One last step
        </h2>
        <p style={{ marginTop: 6, marginBottom: 14, fontSize: 12.5, color: C.ink3, fontFamily: "Inter, sans-serif", lineHeight: 1.5 }}>
          Tell us who you are and what you work on. Your industry decides what your dashboard and daily brief lead with.
        </p>

        <form onSubmit={submit}>
          {/* Wraps only on the narrowest phones (<~285px), as in AuthModal. */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0 10px" }}>
            <div style={{ flex: "1 1 96px", minWidth: 0 }}><Field>
              <label htmlFor="cp-first" style={label}>First name</label>
              <input id="cp-first" type="text" required autoFocus={!hintFirst} placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} style={field} onFocus={onFocus} onBlur={onBlur} autoComplete="given-name" />
            </Field></div>
            <div style={{ flex: "1 1 96px", minWidth: 0 }}><Field>
              <label htmlFor="cp-last" style={label}>Last name</label>
              <input id="cp-last" type="text" placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} style={field} onFocus={onFocus} onBlur={onBlur} autoComplete="family-name" />
            </Field></div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "0 10px" }}>
            <div style={{ flex: "1 1 145px", minWidth: 0 }}><Field>
              <label htmlFor="cp-role" style={label}>Job title</label>
              <select id="cp-role" required value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} style={{ ...sel, color: jobTitle ? C.ink : C.ink3 }} onFocus={onFocus} onBlur={onBlur}>
                <option value="" disabled style={opt}>Select</option>
                {ROLES.map((j) => <option key={j} value={j} style={opt}>{j}</option>)}
              </select>
            </Field></div>
            <div style={{ flex: "1 1 145px", minWidth: 0 }}><Field>
              <label htmlFor="cp-company" style={label}>Company</label>
              <input id="cp-company" type="text" required placeholder="Your organisation" value={company} onChange={(e) => setCompany(e.target.value)} style={field} onFocus={onFocus} onBlur={onBlur} autoComplete="organization" />
            </Field></div>
          </div>

          <Field>
            <label htmlFor="cp-industry" style={label}>Industry <span className="am-fine" style={sub}>drives your dashboard and daily brief</span></label>
            <select id="cp-industry" required value={industry} onChange={(e) => { setIndustry(e.target.value); error && setError(null); }} style={{ ...sel, color: industry ? C.ink : C.ink3 }} onFocus={onFocus} onBlur={onBlur}>
              <option value="" disabled style={opt}>Select your industry</option>
              {SECTORS.map(([sector, list]) => (
                <optgroup key={sector} label={sector}>
                  {list.map((i) => <option key={i} value={i} style={opt}>{i}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>

          <label style={{ display: "flex", gap: 9, alignItems: "flex-start", margin: "2px 0 12px", cursor: "pointer" }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 2, accentColor: C.gold }} />
            <span className="am-fine" style={{ fontSize: 11, color: C.ink2, lineHeight: 1.45, fontFamily: "Inter, sans-serif" }}>
              Occasional emails about Attacked.ai, including account notifications. Unsubscribe any time.
            </span>
          </label>

          {error && <div role="alert" style={{ marginBottom: 12, fontSize: 12, color: C.err }}>{error}</div>}
          <button type="submit" disabled={busy} style={{
            width: "100%", padding: "12px 16px",
            background: busy ? "rgba(252,189,0,0.55)" : C.gold, color: "#1A1A1A",
            border: "none", borderRadius: 4, fontFamily: "Inter, sans-serif", fontSize: 13.5,
            fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
            cursor: busy ? "not-allowed" : "pointer",
          }}>{busy ? "Saving…" : "Save and continue →"}</button>
        </form>

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}`, fontSize: 12, color: C.ink3, fontFamily: "Inter, sans-serif", lineHeight: 1.5 }}>
          Signed in as <b style={{ color: C.ink, overflowWrap: "anywhere" }}>{email}</b>. Not you?{" "}
          {/* 28px-tall tap target in the old 16px line, as AuthModal's links. */}
          <button type="button" onClick={onSignOut} style={{ background: "none", border: "none", color: C.goldDeep, cursor: "pointer", fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 600, padding: "6px 0", margin: "-6px 0", textDecoration: "underline" }}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
