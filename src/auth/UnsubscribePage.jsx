// ─────────────────────────────────────────────────────────────────────────
// UnsubscribePage — handles ?unsubscribe=<token> URL param.
//
// Triggered when a user clicks the unsubscribe link in any digest email.
// Calls the unsubscribe_by_token RPC (SECURITY DEFINER) which:
//   • Validates the token
//   • Flips profiles.email_subscribed to false
//   • Returns the email so we can confirm to the user
//
// No login required — token IS the auth. CAN-SPAM compliant: one-click,
// no password, no surprise.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { SiteNav } from "./SiteNav";
import { SiteFooter } from "./SiteFooter";

const BRAND = {
  gold:     "#FCBD00",
  obsidian: "#1A1A1A",
  deep:     "#080808",
  card:     "#242424",
  white:    "#FFFFFF",
  t2:       "#A8A8A8",
  tmuted:   "#585858",
  border:   "#333",
  green:    "#34C759",
  red:      "#FF6B6B",
};

function FontLoader() {
  useEffect(() => {
    if (document.getElementById("attacked-fonts")) return;
    const link = document.createElement("link");
    link.id = "attacked-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
  }, []);
  return null;
}

// What the reader sees when the call fails. Only the RPC's own message
// (RAISE ... P0001, "Invalid unsubscribe link.") is written for readers; a
// malformed token falls back to the card's "invalid or expired" line; anything
// else (the service down or restricted, a network error) is technical text,
// which goes to the console instead.
const SERVICE_DOWN = "We could not reach our servers just now, so nothing has changed yet. Please try the link again in a few minutes.";
function friendlyError(error) {
  if (error && error.code === "P0001" && error.message) return error.message;
  if (error && error.code === "22P02") return null;
  return SERVICE_DOWN;
}

export function UnsubscribePage({ token }) {
  const [state, setState] = useState({ status: "loading", email: null, error: null, already: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc("unsubscribe_by_token", { p_token: token });
        if (cancelled) return;
        if (error) {
          console.error("[unsubscribe] unsubscribe_by_token failed:", error);
          setState({ status: "error", error: friendlyError(error), email: null, already: false });
          return;
        }
        const row = Array.isArray(data) ? data[0] : data;
        setState({
          status: "ok",
          email: row?.email || null,
          already: !!row?.already_unsubscribed,
          error: null,
        });
      } catch (e) {
        console.error("[unsubscribe] request failed:", e);
        if (!cancelled) {
          setState({ status: "error", error: SERVICE_DOWN, email: null, already: false });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div style={{
      minHeight: "100vh",
      background: `radial-gradient(ellipse at center top, rgba(252,189,0,0.06), transparent 70%), ${BRAND.deep}`,
      color: BRAND.white,
      fontFamily: "Inter, sans-serif",
      display: "flex", flexDirection: "column",
      WebkitFontSmoothing: "antialiased",
    }}>
      <FontLoader />

      <SiteNav />

      <main style={{
        flex: 1,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "32px clamp(16px, 20vw - 40px, 32px)",
      }}>
        <div style={{
          width: "min(520px, 100%)",
          background: BRAND.card,
          border: `1px solid ${BRAND.border}`,
          borderRadius: 8,
          padding: "36px clamp(20px, 20vw - 40px, 32px)",
          textAlign: "center",
        }}>
          {state.status === "loading" && (
            <>
              <div style={{
                fontFamily: "Inter, sans-serif", fontSize: 10,
                color: BRAND.gold, letterSpacing: "0.14em", textTransform: "uppercase",
                marginBottom: 8,
              }}>◇ Processing…</div>
              <h1 style={{
                fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: "clamp(24px, 20vw - 40px, 32px)",
                color: BRAND.white, lineHeight: 1.15, margin: "8px 0",
              }}>One moment.</h1>
              <p style={{ fontSize: 13.5, color: BRAND.t2, lineHeight: 1.55 }}>
                Removing your email from the daily digest list…
              </p>
            </>
          )}

          {state.status === "ok" && (
            <>
              <div style={{
                display: "inline-flex", width: 52, height: 52, borderRadius: 50,
                background: "rgba(52,199,89,0.10)", border: `1px solid ${BRAND.green}55`,
                alignItems: "center", justifyContent: "center", marginBottom: 16,
                fontSize: 24, color: BRAND.green,
              }}>✓</div>
              <h1 style={{
                fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: "clamp(24px, 20vw - 40px, 32px)",
                color: BRAND.white, lineHeight: 1.15, margin: "0 0 14px",
              }}>
                {state.already ? "Already unsubscribed." : "You're unsubscribed."}
              </h1>
              <p style={{ fontSize: 14, color: BRAND.t2, lineHeight: 1.55, margin: "0 0 8px", overflowWrap: "anywhere" }}>
                {state.email && <>We won't send the daily digest to <b style={{ color: BRAND.white }}>{state.email}</b> any more.</>}
              </p>
              <p style={{ fontSize: 12.5, color: BRAND.tmuted, lineHeight: 1.55, marginTop: 18 }}>
                Your account stays active. You can re-enable the digest from your account settings
                whenever you want.
              </p>
              <div style={{ marginTop: 28, paddingTop: 18, borderTop: `1px solid ${BRAND.border}` }}>
                <a href="/" style={{
                  display: "inline-block", padding: "10px 22px",
                  background: "transparent", color: BRAND.gold,
                  border: `1px solid ${BRAND.gold}`, borderRadius: 4,
                  fontFamily: "Inter, sans-serif", fontSize: 11,
                  letterSpacing: "0.10em", textTransform: "uppercase",
                  textDecoration: "none", fontWeight: 600,
                }}>Back to Attacked.ai</a>
              </div>
            </>
          )}

          {state.status === "error" && (
            <>
              <div style={{
                display: "inline-flex", width: 52, height: 52, borderRadius: 50,
                background: "rgba(255,107,107,0.10)", border: `1px solid ${BRAND.red}55`,
                alignItems: "center", justifyContent: "center", marginBottom: 16,
                fontSize: 24, color: BRAND.red,
              }}>!</div>
              <h1 style={{
                fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 28,
                color: BRAND.white, lineHeight: 1.15, margin: "0 0 14px",
              }}>That link didn't work.</h1>
              <p style={{ fontSize: 13.5, color: BRAND.t2, lineHeight: 1.55, overflowWrap: "anywhere" }}>
                {state.error || "The unsubscribe token is invalid or expired."}
              </p>
              <p style={{ fontSize: 12, color: BRAND.tmuted, lineHeight: 1.55, marginTop: 18 }}>
                Sign in to your account and update preferences directly, or reply to any
                digest email to be removed manually.
              </p>
              <div style={{ marginTop: 28, paddingTop: 18, borderTop: `1px solid ${BRAND.border}` }}>
                <a href="/" style={{
                  display: "inline-block", padding: "10px 22px",
                  background: BRAND.gold, color: BRAND.obsidian,
                  border: "none", borderRadius: 4,
                  fontFamily: "Inter, sans-serif", fontSize: 11,
                  letterSpacing: "0.10em", textTransform: "uppercase",
                  textDecoration: "none", fontWeight: 600,
                }}>Back to Attacked.ai</a>
              </div>
            </>
          )}
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
