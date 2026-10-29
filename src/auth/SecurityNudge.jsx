// ─────────────────────────────────────────────────────────────────────────
// SecurityNudge — "Set up two-step verification for your account", the full
// screen MongoDB shows right after signing in (owner, 2026-10-27; it used to
// be a small corner card a few seconds after the page opened).
//
// Two-step verification stays optional (WorkOS: MFA "Optional"), so this is
// a question, not a gate: "Set up now" goes to Profile › Login and security,
// "Remind me later" closes it and the reader is on their dashboard. It comes
// back at the next sign-in, until two-step is on.
//
// It stays away:
//   • when two-step is on, or the last sign-in used a passkey or single sign-on
//   • on the profile, admin, map, checkout, legal and unsubscribe pages, the
//     sign-up page, previews, and while a sign-in notice is on screen
//   • when the sign-in bridge can't answer (no point sending readers to a
//     Security panel that can't load)
// Once per sign-in: the handled sign-in (user.last_sign_in_at) is kept in
// localStorage, so reloads and new tabs of the same sign-in don't ask again.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { WORKOS, securityApi } from "../lib/workos";

const KEY = "atk.securityPrompt";          // localStorage: { [userId]: last_sign_in_at already handled }
const QUIET_PARAMS = ["profile", "admin", "map", "legal", "unsubscribe", "subscribe", "pricing", "activate", "signin", "signin_error", "signup", "preview"];

const read = (key) => { try { return JSON.parse(window.localStorage.getItem(key) || "null"); } catch { return null; } };
const write = (key, v) => { try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode: asks again next load */ } };
// The sign-in this session belongs to. The same sign-in arrives with
// nanosecond precision from /verify and microseconds after a token refresh
// ("…05.062487829Z" vs "…05.062487Z"), so it is compared as milliseconds.
// "-" when neither stamp exists: one shared key, so "Remind me later" still sticks.
const signInId = (user) => {
  const t = Date.parse(user?.last_sign_in_at || user?.app_metadata?.signed_in_at || "");
  return Number.isFinite(t) ? String(t) : "-";
};

// May the screen be considered on this page load? (The bridge is asked after.)
export function nudgeAllowed({ user, search, handled }) {
  if (!user) return false;
  const am = user.app_metadata || {};
  if (am.mfa_factor_id || am.auth_method === "Passkey" || am.auth_method === "SSO") return false;
  let q;
  try { q = new URLSearchParams(search || ""); } catch { return false; }
  if (QUIET_PARAMS.some((p) => q.has(p))) return false;
  if (handled != null && handled === signInId(user)) return false;   // this sign-in was already asked
  return true;
}
// What the bridge said → still worth asking?
export const needsNudge = (s) => !!s && s.workos !== false && !s.totp?.on && s.method !== "Passkey" && s.method !== "SSO";

export function SecurityNudge() {
  const { user, loading } = useAuth();
  return <SecurityNudgeFor user={user} loading={loading} />;
}

// The screen's logic for a given reader (review/security-nudge-preview.html drives it directly).
export function SecurityNudgeFor({ user, loading }) {
  const [show, setShow] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    if (!WORKOS || loading || asked.current || !user) return;
    const ok = nudgeAllowed({ user, search: window.location.search, handled: (read(KEY) || {})[user.id] });
    if (!ok) return;
    asked.current = true;
    securityApi("").then((s) => { if (needsNudge(s)) setShow(true); }).catch(() => { /* bridge unavailable: stay quiet */ });
  }, [loading, user]);

  // The page underneath doesn't scroll while the screen is up.
  useEffect(() => {
    if (!show) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [show]);

  if (!show || !user) return null;
  const handle = () => { const all = read(KEY) || {}; all[user.id] = signInId(user); write(KEY, all); };
  return (
    <SecurityPromptScreen email={user.email}
      onSetup={() => { handle(); window.location.href = "/?profile#security"; }}
      onLater={() => {
        handle(); setShow(false);
        setTimeout(focusPage, 0);
      }} />
  );
}

// Back on the page after "Remind me later" / Esc: focus its main heading (the
// dashboard's first), or failing that the first link, never <body>. Each
// selector is tried in turn: one comma list would return the first match in
// page order, and that is always the navbar logo link.
const FOCUS_AFTER = [".dash h1", "main h1", "main h2", "h1", "a[href]"];
function focusPage() {
  for (const sel of FOCUS_AFTER) {
    const el = [...document.querySelectorAll(sel)].find((n) => !n.closest(".sec-prompt") && n.getClientRects().length);
    if (!el) continue;
    if (!el.hasAttribute("tabindex") && !/^(A|BUTTON)$/.test(el.tagName)) {
      // A heading only takes focus with tabindex -1 (script yes, Tab no). It is a
      // place to land, not a control, so no focus ring; both are undone on blur.
      const outline = el.style.outline;
      el.setAttribute("tabindex", "-1");
      el.style.outline = "none";
      const done = () => {
        if (document.activeElement === el) return;   // the window lost focus, not the heading
        el.removeEventListener("blur", done);
        el.removeAttribute("tabindex"); el.style.outline = outline;
      };
      el.addEventListener("blur", done);
    }
    el.focus({ preventScroll: true });
    return;
  }
}

const C = {
  paper: "#FFFFFF", paper2: "#FAFAFA", ink: "#101010", ink2: "#52525B", ink3: "#6A6A6A", line: "#E7E7E9", line2: "#CFCDC4",
  gold: "#FCBD00", goldDeep: "#8A6D00", warnBg: "#FFF7DD", deep: "#080808", obsidian: "#1A1A1A",
};
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const PATHS = {
  shield: <><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></>,
  fingerprint: <><path d="M5 10.5a7 7 0 0 1 14 0" /><path d="M7.5 12a4.5 4.5 0 0 1 9 0c0 3-.6 5.6-1.6 8" /><path d="M12 12v1.5c0 2.8-.6 5.2-1.7 7.5" /><path d="M9.6 15.5c-.2 1.8-.7 3.4-1.4 4.9" /></>,
  okta: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.5" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18h2" /></>,
};
const Glyph = ({ name, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>
);
const METHODS = [
  ["fingerprint", "Passkey", "Fingerprint, face or security key"],
  ["okta", "Okta Verify", "6-digit code in the Okta Verify app"],
  ["phone", "Authenticator app", "Google, Microsoft, 1Password and others"],
];

export function SecurityPromptScreen({ email, onSetup, onLater }) {
  const setupRef = useRef(null);
  const boxRef = useRef(null);
  useEffect(() => { try { setupRef.current?.focus({ preventScroll: true }); } catch { /* noop */ } }, []);
  // A modal screen: Tab and Shift+Tab stay on its two buttons, Esc = "Remind me later".
  // Listened for on the document, so it still works after a click on the
  // screen's text has moved focus off the buttons.
  const laterRef = useRef(onLater);
  laterRef.current = onLater;
  useEffect(() => {
    const h = (e) => onKeyDown(e);
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); laterRef.current(); return; }
    if (e.key !== "Tab") return;
    const f = [...(boxRef.current?.querySelectorAll("button, a[href]") || [])];
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  };
  return (
    <div ref={boxRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="sec-prompt-h" className="sec-prompt" style={{
      position: "fixed", inset: 0, zIndex: 9000, background: C.paper, color: C.ink,
      fontFamily: "Inter, sans-serif", WebkitFontSmoothing: "antialiased", overflowY: "auto",
    }}>
      <style>{`
        .sec-prompt-side{flex:0 0 38%;max-width:520px;display:flex;flex-direction:column;justify-content:space-between;position:sticky;top:0;align-self:flex-start;height:100vh;height:100dvh;box-sizing:border-box}
        @media (max-width:820px){.sec-prompt-side{display:none}}
        .sec-prompt a:focus-visible,.sec-prompt button:focus-visible{outline:2px solid ${C.gold};outline-offset:2px}
      `}</style>
      {/* The row is at least the screen's height and grows with its content, so a
          short screen scrolls. (Held to the screen's height, the question's top was
          cut off, out of scroll's reach.) */}
      <div style={{ display: "flex", minHeight: "100%" }}>
        {/* Brand side — dark, like the WorkOS sign-in panel. Its display and its
            one-screen sticky height are set in the <style> above (not inline), so
            phones can hide it and it stays whole while a short screen scrolls. */}
        <aside className="sec-prompt-side" aria-hidden="true" style={{
          overflow: "hidden", background: C.deep, color: "#fff",
          backgroundImage: `radial-gradient(circle at 30% 78%, rgba(252,189,0,.22), transparent 46%), radial-gradient(circle at 85% 12%, rgba(252,189,0,.10), transparent 40%)`,
          padding: "40px 44px",
        }}>
          <img src="/attacked-ai-logo.svg" alt="" width="40" height="40" />
          <div style={{ position: "absolute", right: -90, top: "50%", transform: "translateY(-50%)", width: 380, height: 380, borderRadius: "50%", border: "1px solid rgba(252,189,0,.18)" }} />
          <div style={{ position: "absolute", right: -30, top: "50%", transform: "translateY(-50%)", width: 260, height: 260, borderRadius: "50%", border: "1px solid rgba(252,189,0,.26)" }} />
          <div style={{ position: "absolute", right: 40, top: "50%", transform: "translateY(-50%)", width: 120, height: 120, borderRadius: "50%", background: "rgba(252,189,0,.12)", color: C.gold, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Glyph name="shield" size={52} />
          </div>
          <div style={{ position: "relative" }}>
            <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: ".16em", textTransform: "uppercase", color: C.gold, marginBottom: 12 }}>Attacked.ai · Account security</div>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.15, letterSpacing: "-.02em", maxWidth: 340 }}>Your intelligence, protected.</div>
            <p style={{ margin: "12px 0 0", fontSize: 14, lineHeight: 1.6, color: "#B8BBC2", maxWidth: 340 }}>A second check at sign-in keeps your briefings, reports and account yours, even if a password leaks.</p>
          </div>
        </aside>

        {/* Question side */}
        <main style={{ flex: "1 1 auto", display: "flex", justifyContent: "center", padding: "48px 24px" }}>
          {/* Centred by auto margins, not align-items: they shrink to 0 when the
              content is taller than the space, so it starts at the top instead. */}
          <div style={{ width: "min(520px, 100%)", margin: "auto 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 36 }}>
              <img src="/attacked-ai-logo-ink.png" alt="" style={{ height: 30, width: "auto", display: "block" }} />
              <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.01em" }}>Attacked<span style={{ color: C.goldDeep }}>.ai</span></span>
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: C.goldDeep, fontFamily: MONO, fontSize: 10.5, fontWeight: 600, letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 12 }}>
              <Glyph name="shield" size={14} /> Recommended · optional
            </div>
            <h1 id="sec-prompt-h" style={{ margin: 0, fontSize: "clamp(24px, 3.2vw, 30px)", fontWeight: 800, lineHeight: 1.2, letterSpacing: "-.02em" }}>
              Set up two-step verification for your account
            </h1>
            <p style={{ margin: "12px 0 0", fontSize: 15, lineHeight: 1.6, color: C.ink2 }}>
              We recommend adding a second check when you sign in, so a stolen password alone can't open your account. It takes about two minutes, and you can switch it off any time in your profile.
            </p>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "26px 0 30px" }}>
              <button ref={setupRef} type="button" onClick={onSetup} style={{
                minHeight: 44, padding: "0 22px", background: C.gold, color: C.obsidian, border: 0, borderRadius: 4, cursor: "pointer",
                fontFamily: "inherit", fontSize: 12.5, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase",
              }}>Set up now</button>
              <button type="button" onClick={onLater} style={{
                minHeight: 44, padding: "0 20px", background: C.paper, color: C.ink, border: `1px solid ${C.line2}`, borderRadius: 4, cursor: "pointer",
                fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase",
              }}>Remind me later</button>
            </div>

            <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", background: C.paper2, borderBottom: `1px solid ${C.line}`, fontSize: 12.5, fontWeight: 700 }}>Ways to verify it's you</div>
              {METHODS.map(([ic, name, text], k) => (
                <div key={name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: k ? `1px solid ${C.line}` : 0 }}>
                  <span style={{ width: 30, height: 30, flex: "0 0 auto", borderRadius: "50%", background: C.paper2, border: `1px solid ${C.line}`, color: C.ink2, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Glyph name={ic} /></span>
                  <span style={{ minWidth: 0, flex: "1 1 auto" }}>
                    <strong style={{ display: "block", fontSize: 13.5 }}>{name}</strong>
                    <span style={{ display: "block", fontSize: 12.5, color: C.ink3 }}>{text}</span>
                  </span>
                  <span style={{ flex: "0 0 auto", fontSize: 10, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 999, background: C.warnBg, color: C.goldDeep }}>Recommended</span>
                </div>
              ))}
            </div>

            {email && <p style={{ margin: "22px 0 0", fontSize: 12.5, color: C.ink3 }}>Signed in as <b style={{ color: C.ink }}>{email}</b></p>}
          </div>
        </main>
      </div>
    </div>
  );
}
