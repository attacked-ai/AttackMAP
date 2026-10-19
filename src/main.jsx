import React, { useState } from "react";
import ReactDOM from "react-dom/client";
// Brand system first: fonts and tokens, then the shared navigation that every
// page renders. Page-level stylesheets (dashboard, map) read the same tokens.
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/site-nav.css";
import "./responsive.css";
import GlobalAttackMap from "./GlobalAttackMap.jsx";
import { AuthProvider, useAuth } from "./auth/AuthProvider.jsx";
import { LandingPage } from "./auth/LandingPage.jsx";
import { SubscribePage } from "./auth/SubscribePage.jsx";
import { UnsubscribePage } from "./auth/UnsubscribePage.jsx";
import { AttackHub } from "./auth/AttackHub.jsx";
import { SubscriptionsPage } from "./auth/SubscriptionsPage.jsx";
import { LegalPage } from "./auth/LegalPage.jsx";
import { ProfilePage } from "./auth/ProfilePage.jsx";
import { AdminDashboard } from "./admin/AdminDashboard.jsx";
import { Dashboard } from "./dashboard/Dashboard.jsx";
import { CompleteProfile } from "./auth/CompleteProfile.jsx";
import { SecurityNudge } from "./auth/SecurityNudge.jsx";
import { supabase } from "./lib/supabaseClient";
import { WORKOS } from "./lib/workos";

// ─────────────────────────────────────────────────────────────────────────
// AppShell — decides what the visitor sees based on auth state.
//   • loading              → small spinner (avoids landing-page flash)
//   • anonymous + no preview override → LandingPage (editorial front page)
//   • signed-in OR preview → the full map (gating happens inside per tier)
//
// The preview override (?preview=public|free|partner|admin) bypasses the
// wall so QA can land directly on the gated/unlocked map without a real
// signup. Useful for demos and screenshots.
// ─────────────────────────────────────────────────────────────────────────
// Tiny shared loading placeholder so the admin tier-check + main loader
// don't drift visually.
function LoadingScreen() {
  return (
    <div style={{
      minHeight: "100vh", background: "#080808", color: "#A8A8A8",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "Inter, sans-serif", fontSize: 11, letterSpacing: "0.12em",
      textTransform: "uppercase", fontWeight: 600,
    }}>
      ◇ Loading…
    </div>
  );
}

function AppShell() {
  const { user, loading, tier } = useAuth();

  // Detect ?preview= in URL — same heuristic the AuthProvider uses.
  const hasPreviewOverride = (() => {
    if (typeof window === "undefined") return false;
    try {
      const p = new URLSearchParams(window.location.search).get("preview");
      return p === "public" || p === "free" || p === "subscriber" || p === "partner" || p === "admin";
    } catch { return false; }
  })();


  // Detect ?unsubscribe=<token> in URL — handle BEFORE auth resolution so
  // anyone clicking from email lands on the unsubscribe page without being
  // blocked by the auth wall.
  const unsubscribeToken = (() => {
    if (typeof window === "undefined") return null;
    try {
      return new URLSearchParams(window.location.search).get("unsubscribe");
    } catch { return null; }
  })();
  if (unsubscribeToken) {
    return <UnsubscribePage token={unsubscribeToken} />;
  }

  // ?home — the editorial landing page, forced regardless of auth. Without
  // this, a signed-in visitor lands on the map at "/" and has no way back to
  // the front page (since "/" only shows LandingPage to anonymous users).
  // The map's logo links here so signed-in users can return home.
  const showHome = (() => {
    if (typeof window === "undefined") return false;
    try {
      return new URLSearchParams(window.location.search).has("home");
    } catch { return false; }
  })();
  if (showHome) {
    return <LandingPage />;
  }

  // ?legal=<key> — footer pages (privacy / terms / cookies / accessibility /
  // scam / faq). Public, no auth.
  const legalKey = (() => {
    if (typeof window === "undefined") return null;
    try { return new URLSearchParams(window.location.search).get("legal"); } catch { return null; }
  })();
  if (legalKey) {
    return <LegalPage pageKey={legalKey} />;
  }

  // ?pricing — public marketing page. Accessible without auth.
  // ?subscribe — the subscription page, a full page for everyone. Public: it
  // reads signed out, and sign-in is part of its flow (Subscribe → Create an
  // account → back here with ?activate=subscriber).
  const showSubscribe = (() => {
    if (typeof window === "undefined") return false;
    try { return new URLSearchParams(window.location.search).has("subscribe"); } catch { return false; }
  })();
  if (showSubscribe) {
    return <SubscribePage />;
  }

  const showPricing = (() => {
    if (typeof window === "undefined") return false;
    try {
      const p = new URLSearchParams(window.location.search);
      return p.has("pricing");
    } catch { return false; }
  })();
  // ?pricing lands on the subscription page: one place for every plan and product.
  if (showPricing) {
    return <SubscribePage />;
  }

  // ?hub — the Attacked Hub editorial feed. Public marketing surface like
  // pricing: readable without auth, depth gated behind sign-up inside.
  const showHub = (() => {
    if (typeof window === "undefined") return false;
    try {
      return new URLSearchParams(window.location.search).has("hub");
    } catch { return false; }
  })();
  if (showHub) {
    return <AttackHub />;
  }

  // ?subscriptions — the "Manage subscription" preference centre. Requires a
  // signed-in user; the page itself bounces anonymous visitors to the landing.
  const showSubscriptions = (() => {
    if (typeof window === "undefined") return false;
    try { return new URLSearchParams(window.location.search).has("subscriptions"); } catch { return false; }
  })();
  if (showSubscriptions) {
    // Configure Alerts was removed from the dashboard (2026-09-29), so a
    // signed-in visitor lands on the dashboard itself rather than a view that
    // no longer exists. Anonymous visitors still get the public page below.
    if (user || hasPreviewOverride) return <Dashboard />;
    return <SubscriptionsPage />;
  }

  // ?profile — the signed-in user's account profile (from the nav account menu).
  // Replaces the old onboarding wizard. The page itself bounces anonymous users.
  const showProfile = (() => {
    if (typeof window === "undefined") return false;
    try { return new URLSearchParams(window.location.search).has("profile"); } catch { return false; }
  })();
  if (showProfile) {
    return <ProfilePage />;
  }

  // ?admin — admin dashboard. Tier-gated: only tier='admin' may enter.
  // Anyone else who tries hits a polite "not authorised" message instead
  // of seeing the page chrome. This is UI-layer gating only; the actual
  // RPCs check _is_admin() server-side as a second line of defence.
  const showAdmin = (() => {
    if (typeof window === "undefined") return false;
    try {
      const p = new URLSearchParams(window.location.search);
      return p.has("admin");
    } catch { return false; }
  })();
  if (showAdmin) {
    if (loading) return <LoadingScreen />;
    if (!user) return <LandingPage />;
    if (tier !== "admin") {
      return (
        <div style={{
          minHeight: "100vh", background: "#080808", color: "#A8A8A8",
          display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column",
          fontFamily: "Inter, sans-serif", padding: 32, textAlign: "center",
        }}>
          <div style={{ fontSize: 48, marginBottom: 18 }}>🔒</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#FFF", marginBottom: 8 }}>Admin only</div>
          <div style={{ fontSize: 13, marginBottom: 20, maxWidth: 380 }}>
            This page is restricted to the internal team. Your current tier is <b>{tier || "free"}</b>.
          </div>
          <a href="/?map" style={{
            padding: "10px 20px", background: "#FCBD00", color: "#1A1A1A",
            textDecoration: "none", borderRadius: 4, fontSize: 12,
            fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase",
          }}>← Back to map</a>
        </div>
      );
    }
    return <AdminDashboard />;
  }

  if (loading) {
    return <LoadingScreen />;
  }

  if (!user && !hasPreviewOverride) {
    return <LandingPage />;
  }

  // The onboarding wizard has been removed entirely. Signed-in users land on the
  // editorial landing page (account state in the nav) and manage their identity
  // via "Profile" (?profile) and "Manage subscription" (?subscriptions).

  // Signed-in users land on the editorial landing page by default — sign-in
  // no longer dumps them straight into the map. The map opens explicitly:
  //   • ?map         → the live map (the landing "Attack Map" button + CTAs)
  //   • ?preview=…   → demo/QA override, lands on the map directly
  const showMap = (() => {
    if (typeof window === "undefined") return false;
    try { return new URLSearchParams(window.location.search).has("map"); } catch { return false; }
  })();
  if (showMap) {
    return <GlobalAttackMap />;
  }

  // ?dashboard — the signed-in home, personalised to profiles.industry. It is
  // also the default for a signed-in visitor at "/" (the landing page stays
  // one click away via ?home). With ?preview=… and no ?map it renders too, so
  // QA can walk it without an account.
  const showDashboard = (() => {
    if (typeof window === "undefined") return false;
    try { return new URLSearchParams(window.location.search).has("dashboard"); } catch { return false; }
  })();
  if (showDashboard || user || hasPreviewOverride) {
    return <Dashboard />;
  }

  return <LandingPage />;
}

// WorkOS sign-in only: a reader who came in through Google / Microsoft /
// GitHub / LinkedIn straight from "Sign in" never saw the sign-up form, so the
// same questions are asked once (CompleteProfile.jsx) until the profile has an
// industry. Legal pages and unsubscribe links stay readable without it.
function ProfileStep() {
  const { user, profile, loading, saveProfileBasics, signOut } = useAuth();
  const show = WORKOS && !loading && !!user && !!profile && !profile.industry && (() => {
    try { const q = new URLSearchParams(window.location.search); return !q.has("legal") && !q.has("unsubscribe"); }
    catch { return true; }
  })();
  if (!show) return null;
  const meta = user.user_metadata || {};
  async function save(fields, consent) {
    try { await supabase.auth.updateUser({ data: { marketing_opt_in: !!consent } }); }
    catch (e) { console.warn("[Profile] opt-in not saved:", e?.message || e); }
    // onboarded_at NULL -> set sends the welcome email (trg_welcome_on_onboarded).
    const r = await saveProfileBasics({ ...fields, ...(profile.onboarded_at ? {} : { onboarded_at: new Date().toISOString() }) });
    if (r?.error) return { error: r.error };
    if (!r?.profile?.industry) return { error: "Could not save. Try again." };
    return { ok: true };
  }
  return (
    <CompleteProfile email={user.email} profile={profile}
      nameHint={{ first_name: meta.first_name, last_name: meta.last_name, full_name: meta.full_name || meta.name }}
      onSave={save} onSignOut={async () => { await signOut(); window.location.href = "/"; }} />
  );
}

// ?signin_error=<reason>: a WorkOS sign-in trip that could not finish lands on
// /?home with it. Say why, once.
const SIGNIN_ERRORS = {
  cancelled: "Sign-in was cancelled. You can try again any time.",
  expired: "That sign-in took too long to finish. Please start again.",
  unverified: "We couldn't confirm that email address. Please try another sign-in option.",
  suspended: "This account is suspended. Email hello@attacked.ai if you think that's a mistake.",
  unavailable: "Sign-in isn't available right now. Please try again in a few minutes.",
};
function SigninNotice() {
  const [reason, setReason] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("signin_error"); } catch { return null; }
  });
  if (!reason) return null;
  function dismiss() {
    setReason(null);
    try {
      const search = window.location.search.replace(/([?&])signin_error=[^&]*&?/, "$1").replace(/[?&]$/, "");
      window.history.replaceState(null, "", window.location.pathname + search + window.location.hash);
    } catch { /* noop */ }
  }
  return (
    <div role="alert" style={{
      position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 10000,
      width: "min(560px, calc(100% - 32px))", boxSizing: "border-box", display: "flex", alignItems: "center", gap: 8,
      padding: "6px 4px 6px 16px", background: "#0E1116", color: "#FFFFFF", borderLeft: "3px solid #FCBD00",
      borderRadius: 4, boxShadow: "0 12px 40px rgba(0,0,0,.35)", fontFamily: "Inter, sans-serif", fontSize: 13.5, lineHeight: 1.5,
    }}>
      <span style={{ flex: 1, minWidth: 0, padding: "6px 0" }}>{SIGNIN_ERRORS[reason] || "Sign-in didn't finish. Please try again."}</span>
      <button type="button" onClick={dismiss} aria-label="Dismiss" style={{
        flex: "none", width: 44, height: 44, background: "none", border: 0, color: "#A6A8AD", fontSize: 18, cursor: "pointer",
      }}>×</button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <AppShell />
      <ProfileStep />
      <SigninNotice />
      <SecurityNudge />
    </AuthProvider>
  </React.StrictMode>
);
