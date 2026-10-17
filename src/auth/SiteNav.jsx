// ─────────────────────────────────────────────────────────────────────────
// SiteNav — the shared site-wide top navigation (Attacked.ai branding).
//
// One component dropped into every page — landing, Attacked Hub, pricing,
// legal, profile, subscriptions and the signed-in dashboard — so the navbar is
// identical everywhere. It is fully self-contained:
//   • manages its own sign-in modal (AuthModal)
//   • "Attack Map"  — signed-in → /?map, anonymous → sign-in wall
//   • "Attacked Hub" / "Pricing" — real in-app routes
//   • signed-in → My dashboard + account menu
//   • anonymous → "Sign in" (modal) + "Subscribe" (→ /?subscribe)
//
// Pass `active` ("map" | "hub" | "pricing") to highlight the current page.
//
// STYLING (2026-09-29): every rule lives in src/styles/site-nav.css and reads
// the brand tokens, replacing ~120 lines of inline styles that had the gold,
// the greys and the spacing hard-coded in this file. Restyling the navbar
// across the whole product is now a stylesheet change, not a JSX change — and
// the mobile panel comes from the same place as the desktop bar.
// ─────────────────────────────────────────────────────────────────────────
import React, { useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { AuthModal } from "./AuthModal";

export function SiteNav({ active }) {
  const { user, tier, profile, signOut } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [authIntent, setAuthIntent] = useState(null);
  const [authScreen, setAuthScreen] = useState("sign-up"); // WorkOS page: "Sign in" opens sign-in
  const [menuOpen, setMenuOpen] = useState(false); // account dropdown (signed-in)
  const [navOpen, setNavOpen] = useState(false);   // mobile hamburger panel

  // "Attack Map": signed-in users open the live map at ?map (the bare "/"
  // keeps them on the landing page); anonymous visitors hit the sign-in wall.
  function enterMap() {
    if (user) window.location.href = "/?map";
    else { setAuthScreen("sign-up"); setAuthOpen(true); }
  }

  // Hidden admin shortcut — three clicks on the wordmark inside 600ms opens
  // /?admin. The tier gate in main.jsx still blocks non-admins; this only
  // saves an admin from typing the URL. Carried over from the Logo component,
  // which the navbar no longer renders.
  const clicks = useRef([]);
  function brandClick() {
    const now = Date.now();
    clicks.current = [...clicks.current, now].filter((t) => now - t < 600);
    if (clicks.current.length >= 3) {
      clicks.current = [];
      if (typeof window !== "undefined") window.location.href = "/?admin";
    }
  }

  const linkCls = (key) => `nav-link${active === key ? " is-active" : ""}`;

  return (
    <>
      {/* `acct-open` lifts the bar while the account menu is open, so the menu
          clears the Attack Map's floating panels (see site-nav.css). */}
      <header role="banner" className={`site-nav${menuOpen ? " acct-open" : ""}`}>
        {/* ?home, not "/": for a signed-in reader "/" opens the dashboard,
            and the logo is the way back to the landing page. */}
        <a href="/?home" aria-label="Attacked.ai home" className="site-brand" onClick={brandClick}>
          <img src="/attacked-ai-logo.svg" alt="" className="shield" />
          <span className="wordmark">Attacked<span className="ai">.ai</span><sup>™</sup></span>
        </a>

        {/* Hamburger — phones only (CSS-toggled); opens the link panel. */}
        <button
          className="site-nav-burger"
          aria-label="Menu" aria-expanded={navOpen}
          onClick={() => setNavOpen((v) => !v)}
        >
          <span style={{ fontSize: 18, lineHeight: 1 }}>{navOpen ? "✕" : "☰"}</span>
        </button>

        <nav aria-label="Primary" className={`site-nav-links${navOpen ? " open" : ""}`}>
          <button type="button" className={linkCls("map")} onClick={enterMap}>Attack Map</button>
          {active === "hub"
            ? <span className={linkCls("hub")} aria-current="page">Attacked Hub</span>
            : <a className={linkCls("hub")} href="/?hub">Attacked Hub</a>}
          {active === "pricing"
            ? <span className={linkCls("pricing")} aria-current="page">Pricing</span>
            : <a className={linkCls("pricing")} href="/?pricing">Pricing</a>}

          {user ? (
            <>
              {/* The signed-in home. The landing page stays reachable via the
                  logo and ?home, but the dashboard is one click from anywhere. */}
              <a className="nav-gold" href="/?dashboard">My dashboard</a>

              <div className="site-acct">
                <button
                  className="acct-trigger"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="Account menu" aria-expanded={menuOpen}
                >
                  <span className="acct-avatar">
                    {profile?.avatar_url
                      ? <img src={profile.avatar_url} alt="" />
                      : (user.email || "?").charAt(0).toUpperCase()}
                  </span>
                  <span className="acct-caret">{menuOpen ? "▲" : "▼"}</span>
                </button>

                {menuOpen && (
                  <>
                    {/* click-away backdrop */}
                    <div className="acct-backdrop" onClick={() => setMenuOpen(false)} />
                    <div className="acct-menu">
                      <div className="acct-head">
                        <div className="acct-eyebrow">Signed in</div>
                        <div className="acct-email">{user.email}</div>
                      </div>
                      <a href="/?dashboard" className="is-primary">My dashboard</a>
                      <a href="/?profile">Profile</a>
                      <a href="/?subscribe">Subscription</a>
                      <button onClick={() => { setMenuOpen(false); enterMap(); }}>Open the live map</button>
                      <a href="/?hub">The Attacked Hub</a>
                      {tier === "admin" && <a href="/?admin" className="is-admin">★ Admin dashboard</a>}
                      <div className="acct-rule" />
                      <button
                        className="is-danger"
                        onClick={async () => { await signOut(); window.location.href = "/"; }}
                      >Sign out</button>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <button type="button" className="nav-ghost" onClick={() => { setAuthIntent(null); setAuthScreen("sign-in"); setAuthOpen(true); }}>Sign in</button>
              <a className="nav-gold" href="/?subscribe">Subscribe</a>
            </>
          )}
        </nav>
      </header>

      <AuthModal open={authOpen} intent={authIntent} screen={authScreen} onClose={() => setAuthOpen(false)} />
    </>
  );
}
