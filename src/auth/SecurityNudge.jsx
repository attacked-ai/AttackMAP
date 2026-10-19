// ─────────────────────────────────────────────────────────────────────────
// SecurityNudge — a polite reminder to turn on two-step verification.
//
// Two-step verification is optional (WorkOS: MFA "Optional"), so nobody is
// stopped at sign-in by the authenticator screen. Instead a signed-in reader
// without it sees this small card once per visit, a few seconds after the page
// opens: "Set it up" goes to Profile → Security, "Remind me later" hides it
// for 7, then 14, then 30 days. It never blocks anything.
//
// It stays away:
//   • when two-step is on, or the last sign-in used a passkey or single sign-on
//   • on the profile, admin, map, checkout, legal and unsubscribe pages, and
//     while the profile step or a sign-in notice is on screen
//   • when the sign-in bridge can't answer (no point sending readers to a
//     Security panel that can't load)
// The bridge is asked at most once per visit.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { WORKOS, securityApi } from "../lib/workos";

const KEY = "atk.securityNudge";          // localStorage: { [userId]: { count, until } }
const SEEN = "atk.securityNudge.seen";    // sessionStorage: the user already handled this visit
const SNOOZE_DAYS = [7, 14, 30];
const DELAY_MS = 3500;
const QUIET_PARAMS = ["profile", "admin", "map", "legal", "unsubscribe", "subscribe", "pricing", "activate", "signin", "signin_error", "preview"];

const read = (store, key) => { try { return JSON.parse(window[store].getItem(key) || "null"); } catch { return null; } };
const write = (store, key, v) => { try { window[store].setItem(key, JSON.stringify(v)); } catch { /* private mode: asks again next visit */ } };

// May the card be considered on this page load? (The bridge is asked after.)
export function nudgeAllowed({ user, profile, search, snooze, seenId, now }) {
  if (!user || !profile || !profile.industry) return false;        // signed out, or still on the profile step
  const am = user.app_metadata || {};
  if (am.mfa_factor_id || am.auth_method === "Passkey" || am.auth_method === "SSO") return false;
  let q;
  try { q = new URLSearchParams(search || ""); } catch { return false; }
  if (QUIET_PARAMS.some((p) => q.has(p))) return false;
  if (seenId === user.id) return false;                              // once per visit
  if (snooze && Number(snooze.until) > now) return false;
  return true;
}
// "Remind me later" number `count` (1, 2, 3…) → when to ask again.
export const snoozeUntil = (count, now) => now + SNOOZE_DAYS[Math.min(Math.max(count, 1), SNOOZE_DAYS.length) - 1] * 86_400_000;
// What the bridge said → still worth asking?
export const needsNudge = (s) => !!s && s.workos !== false && !s.totp?.on && s.method !== "Passkey" && s.method !== "SSO";

export function SecurityNudge() {
  const { user, profile, loading } = useAuth();
  return <SecurityNudgeFor user={user} profile={profile} loading={loading} />;
}

// The card's logic for a given reader (review/security-preview.html drives it directly).
export function SecurityNudgeFor({ user, profile, loading }) {
  const [show, setShow] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => { clearTimeout(timer.current); timer.current = null; }, []);
  useEffect(() => {
    if (!WORKOS || loading || timer.current) return;
    const snoozes = read("localStorage", KEY) || {};
    const ok = nudgeAllowed({
      user, profile, search: window.location.search,
      snooze: user ? snoozes[user.id] : null, seenId: read("sessionStorage", SEEN), now: Date.now(),
    });
    if (!ok) return;
    const id = user.id;
    timer.current = setTimeout(async () => {
      write("sessionStorage", SEEN, id);
      try { if (needsNudge(await securityApi(""))) setShow(true); }
      catch { /* bridge unavailable: stay quiet */ }
    }, DELAY_MS);
  }, [loading, user, profile]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e) => { if (e.key === "Escape") setShow(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  if (!show || !user) return null;
  function later() {
    const snoozes = read("localStorage", KEY) || {};
    const count = (Number(snoozes[user.id]?.count) || 0) + 1;
    snoozes[user.id] = { count, until: snoozeUntil(count, Date.now()) };
    write("localStorage", KEY, snoozes);
    setShow(false);
  }
  return <NudgeCard onLater={later} onClose={() => setShow(false)} />;
}

const C = { card: "#0E1116", line: "#2A2E36", ink: "#FFFFFF", ink2: "#C4C7CE", gold: "#FCBD00", obsidian: "#1A1A1A" };
const reduceMotion = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

export function NudgeCard({ onLater, onClose, setupHref = "/?profile#security" }) {
  const [entered, setEntered] = useState(reduceMotion);
  useEffect(() => { const r = requestAnimationFrame(() => setEntered(true)); return () => cancelAnimationFrame(r); }, []);
  return (
    <section role="region" aria-labelledby="sec-nudge-h" aria-live="polite" style={{
      position: "fixed", right: 16, bottom: 16, zIndex: 120,
      width: "min(384px, calc(100% - 32px))", boxSizing: "border-box",
      padding: "18px 20px 18px 20px", background: C.card, color: C.ink,
      border: `1px solid ${C.line}`, borderTop: `3px solid ${C.gold}`, borderRadius: 8,
      boxShadow: "0 18px 50px rgba(0,0,0,.38)", fontFamily: "Inter, sans-serif",
      opacity: entered ? 1 : 0, transform: entered ? "none" : "translateY(12px)",
      transition: "opacity .25s ease, transform .25s ease",
    }}>
      <button type="button" onClick={onClose} aria-label="Close" style={{
        position: "absolute", top: 2, right: 2, width: 44, height: 44, background: "none", border: 0,
        color: "#8E929B", fontSize: 20, lineHeight: 1, cursor: "pointer",
      }}>×</button>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, color: C.gold, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" />
        </svg>
        Recommended · optional
      </div>
      <h2 id="sec-nudge-h" style={{ margin: "0 32px 6px 0", fontSize: 16, fontWeight: 700, lineHeight: 1.3, letterSpacing: "-0.01em", color: C.ink }}>
        Add two-step verification
      </h2>
      <p style={{ margin: "0 0 14px", fontSize: 13.5, lineHeight: 1.55, color: C.ink2 }}>
        Keep your account safe even if your password leaks: confirm each sign-in with a 6-digit code from an authenticator app, or with your fingerprint or face using a passkey. It takes about a minute.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a href={setupHref} style={{
          display: "inline-flex", alignItems: "center", minHeight: 40, padding: "0 16px", background: C.gold, color: C.obsidian,
          borderRadius: 4, textDecoration: "none", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
        }}>Set it up</a>
        <button type="button" onClick={onLater} style={{
          minHeight: 40, padding: "0 14px", background: "transparent", color: C.ink, border: `1px solid ${C.line}`,
          borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
        }}>Remind me later</button>
      </div>
    </section>
  );
}
