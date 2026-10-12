// SubscribePage — THE subscription page (?subscribe, and ?pricing lands here
// too). Every "Subscribe" button in the product ends up on this page or on
// (the dashboard links here too — it is a full page, not a view inside the shell).
//
// Two groups, in the order a reader meets them:
//   1. Attack Map — Free vs Subscriber. Subscriber is the self-service switch
//      (set_own_subscription): press it and the tier flips, no application.
//   2. Organisation intelligence · Premium — the products behind the map, from
//      the approved free-dashboard design (Impact Assessments, Watchlists,
//      Pathways & simulation). "Industry intelligence first.
//      Organisation intelligence when you need it."
//   (Sector Reports / Vendor Promotion / Media Licence were dropped from this
//    page on 2026-09-21 at the owner's request.)
//
// Sign-in is part of the flow, not a wall in front of it: the page reads
// without an account; pressing Subscribe while signed out opens Create an
// account with intent=subscribe, and the reader comes back here with
// ?activate=subscriber, which finishes the switch automatically.
//
// Prices are the same placeholders PricingPage carried; change them here.

import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { AuthModal } from "./AuthModal";
import { SiteNav } from "./SiteNav";
import { SiteFooter } from "./SiteFooter";
import { BRAND } from "../brand.js";

const CONTACT_EMAIL = "hello@attacked.ai";
const mailto = (subject) => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;

const MAP_PLANS = [
  {
    id: "free", name: "Free", price: "₹0", period: "forever",
    pitch: "Every incident in your industry, classified.",
    includes: [
      "Every incident in your industry, geolocated and classified against GUARD",
      "Severity, rationale and the daily edition in the Attack Hub",
      "The live Attack Map with category and severity filters",
      "The count of blast-radius entities, GUARD controls and peers per incident",
      "Daily intelligence email for your industry",
    ],
  },
  {
    id: "subscriber", name: "Subscriber", price: "₹14,999", period: "per month",
    note: "Placeholder price · per organisation · 3 seats included",
    pitch: "From what happened to who it reaches.",
    includes: [
      "Everything on Free, plus:",
      "Named blast radius — the companies each incident reaches, with the exposure channel",
      "Adaptive GUARD controls — objectives, master controls, recommended actions",
      "Peer watchlist and historical analogues on every incident",
      "Vendor Defence Ratings and capability claims",
      "The full daily brief: summary, rationale and blast radius, not headlines only",
      "Full reports open end to end — no locked sections",
    ],
  },
];

const PREMIUM = [
  { key: "impact", name: "Impact Assessments", lead: "Organisation-specific impact assessment.", body: "Translate an incident into plausible exposure, stakeholders and materiality for your organisation — not just your sector.", subject: "Impact Assessments — enquiry" },
  { key: "watch", name: "Watchlists", lead: "Blast radius & dependencies for the entities you watch.", body: "Priority sweeps on your suppliers, assets, critical services and connected exposures, with the exposure channel named.", subject: "Watchlists — enquiry" },
  { key: "path", name: "Pathways & simulation", lead: "How an incident could evolve, and how your teams would respond.", body: "Plausible pathways from a sector signal to your organisation, run as a simulation with your stakeholders in the room.", subject: "Pathways & simulation — enquiry" },
];

const FONT = "Inter, system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SERIF = FONT; // brand: Inter everywhere, headings included
const S = {
  section: { maxWidth: 1180, margin: "0 auto", padding: "34px 24px" },
  eyebrow: { fontFamily: MONO, fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: BRAND.goldDeep, fontWeight: 700 },
  h2: { fontFamily: SERIF, fontSize: "clamp(26px, 7.6vw, 34px)", lineHeight: 1.08, fontWeight: 500, margin: "6px 0 8px", letterSpacing: "-0.01em", color: BRAND.ink },
  lede: { fontFamily: FONT, fontSize: 14.5, lineHeight: 1.6, color: BRAND.inkSoft, maxWidth: 720, margin: 0 },
  grid: (min) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, gap: 14, marginTop: 22 }),
  card: { background: "#fff", border: `1px solid ${BRAND.line}`, borderRadius: 14, padding: "22px 22px 20px", display: "flex", flexDirection: "column", minWidth: 0, fontFamily: FONT },
  name: { fontFamily: FONT, fontSize: 17, fontWeight: 800, letterSpacing: "-0.01em", color: BRAND.ink, margin: 0 },
  price: { fontFamily: SERIF, fontSize: 34, lineHeight: 1, fontWeight: 600, color: BRAND.ink, marginTop: 10 },
  // inline-block + nowrap: "per month" never splits; if it does not fit beside
  // the price it moves under it as one piece.
  period: { fontFamily: MONO, fontSize: 10, color: BRAND.muted, marginLeft: 8, letterSpacing: ".06em", whiteSpace: "nowrap", display: "inline-block" },
  note: { fontFamily: MONO, fontSize: 9.5, color: BRAND.muted, marginTop: 6 },
  pitch: { fontSize: 13, color: BRAND.inkSoft, margin: "10px 0 0", lineHeight: 1.5 },
  list: { listStyle: "none", padding: 0, margin: "16px 0 18px", display: "grid", gap: 8, flex: 1, alignContent: "start" },
  li: { display: "flex", gap: 9, fontSize: 12.5, lineHeight: 1.45, color: BRAND.ink },
  tick: { color: BRAND.goldDeep, fontWeight: 800, flex: "none" },
  tag: { fontFamily: MONO, fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", background: BRAND.goldTint, color: BRAND.goldDeep, border: `1px solid ${BRAND.borderGold}`, borderRadius: 6, padding: "4px 7px", fontWeight: 700 },
  primary: { background: BRAND.gold, color: BRAND.obsidian, border: 0, borderRadius: 8, padding: "12px 18px", fontWeight: 800, fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", cursor: "pointer", fontFamily: FONT, textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8 },
  secondary: { background: "transparent", color: BRAND.ink, border: `1px solid ${BRAND.lineDark}`, borderRadius: 8, padding: "11px 16px", fontWeight: 700, fontSize: 12, letterSpacing: ".06em", textTransform: "uppercase", cursor: "pointer", fontFamily: FONT, textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8 },
  current: { fontFamily: MONO, fontSize: 11, color: "#1E7A3D", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 8 },
};

function useFonts() {
  useEffect(() => {
    if (document.getElementById("attacked-subscribe-fonts")) return;
    const link = document.createElement("link"); link.id = "attacked-subscribe-fonts"; link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap";
    document.head.appendChild(link);
  }, []);
}

const activateParam = () => { try { return new URLSearchParams(window.location.search).get("activate"); } catch { return null; } };
const stripParam = (k) => { try { const u = new URL(window.location.href); if (u.searchParams.has(k)) { u.searchParams.delete(k); window.history.replaceState(null, "", u.pathname + (u.search || "")); } } catch { /* noop */ } };

// The plans, without page chrome.
export function SubscriptionPlans({ embedded = false, onSignIn, onDashboard }) {
  const { user, tier, subscriber, setSubscribed } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const autoRan = useRef(false);

  async function subscribe() {
    if (!user) { onSignIn?.(); return; }
    setBusy(true); setMsg(null);
    try {
      const t = await setSubscribed(true);
      setMsg(t === "enterprise" || t === "admin" ? { ok: true, text: "You are now a subscriber. Every incident in your industry is open end to end." } : { ok: false, text: `Tier is now ${t}.` });
    } catch (e) { setMsg({ ok: false, text: e?.message || "Could not subscribe." }); }
    finally { setBusy(false); }
  }
  async function switchOff() {
    setBusy(true); setMsg(null);
    try { const t = await setSubscribed(false); setMsg({ ok: true, text: t === "free" ? "Subscription switched off. You are on Free." : `Tier is ${t}.` }); }
    catch (e) { setMsg({ ok: false, text: e?.message || "Could not switch off." }); }
    finally { setBusy(false); }
  }
  // Back from Create an account with intent=subscribe: finish the switch.
  useEffect(() => {
    if (activateParam() !== "subscriber" || autoRan.current) return;
    if (!user) return;
    autoRan.current = true; stripParam("activate");
    if (!subscriber) subscribe();
  }, [user, subscriber]); // eslint-disable-line react-hooks/exhaustive-deps

  const dashboardHref = "/?dashboard";
  const DashboardCta = ({ style }) => onDashboard
    ? <button style={{ ...S.secondary, ...style }} onClick={onDashboard}>Open my dashboard →</button>
    : <a style={{ ...S.secondary, ...style }} href={dashboardHref}>Open my dashboard →</a>;

  return (
    <div style={{ fontFamily: FONT }}>
      {/* Small-screen overrides for this page (layout only, 2026-10-07). Fine
          print goes to 12px on phones and on every touch screen (tablets too);
          mouse laptops and desktops keep the design sizes. The third
          Premium card spans the row while the Premium grid has exactly two
          columns, so it does not sit alone (container query on the dark box's
          content width: 2 x 280 + 14 = 574 up to 3 x 280 + 2 x 14 = 868).
          Phones (portrait, and landscape touch screens under 500px tall): the
          eyebrows, the Recommended / Pro tags and "per month" go from 9-10px
          to 11px; the plan name row may wrap so the larger tag never runs
          past the card edge (it drops under the name on a 280px screen). */}
      <style>{`
        @media (max-width: 768px), (pointer: coarse) {
          .sub-fine { font-size: 12px !important; line-height: 1.45 !important; }
        }
        @media (max-width: 600px), (pointer: coarse) and (max-height: 500px) {
          .sub-eyebrow, .sub-tag, .sub-period { font-size: 11px !important; }
          .sub-head { flex-wrap: wrap; row-gap: 6px !important; }
        }
        /* Under 300px "per month" cannot sit beside ₹14,999: the period goes
           under the price in both cards, without the 8px indent. */
        @media (max-width: 300px) {
          .sub-period { display: block !important; margin: 6px 0 0 !important; }
        }
        @container (min-width: 574px) and (max-width: 867.98px) {
          .sub-premium > article:nth-child(3) { grid-column: 1 / -1; }
        }
      `}</style>
      {/* 1 · Attack Map */}
      <section style={{ ...S.section, paddingTop: embedded ? 4 : 34 }}>
        <div className="sub-eyebrow" style={S.eyebrow}>Attack Map · industry intelligence</div>
        <h2 style={S.h2}>Free shows what happened. Subscriber shows who it reaches.</h2>
        <p style={S.lede}>Both run on the same corpus, classified through GUARD and geolocated on the live map. Subscriber switches on now and switches off any time; nothing to apply for.</p>
        {msg && <p style={{ margin: "16px 0 0", fontSize: 13, fontWeight: 600, color: msg.ok ? "#1E7A3D" : "#B21F31" }}>{msg.text}</p>}
        <div style={S.grid(300)}>
          {MAP_PLANS.map((p) => {
            const isSub = p.id === "subscriber";
            const current = isSub ? subscriber : (!!user && !subscriber);
            return (
              <article key={p.id} style={{ ...S.card, ...(isSub ? { borderColor: BRAND.gold, boxShadow: "0 18px 44px rgba(252,189,0,.14)", background: "#FFFDF5" } : {}) }}>
                <div className="sub-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <h3 style={S.name}>{p.name}</h3>
                  {isSub ? <span className="sub-tag" style={S.tag}>Recommended</span> : current ? <span className="sub-tag" style={S.tag}>Your plan</span> : null}
                </div>
                <div style={S.price}>{p.price}<span className="sub-period" style={S.period}>{p.period}</span></div>
                {p.note && <div className="sub-fine" style={S.note}>{p.note}</div>}
                <p style={S.pitch}>{p.pitch}</p>
                <ul style={S.list}>{p.includes.map((f) => <li key={f} style={S.li}><span style={S.tick}>✓</span><span>{f}</span></li>)}</ul>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                  {isSub ? (
                    subscriber ? (
                      <>
                        <span style={S.current}>✓ {tier === "admin" ? "Admin · full access" : "You're a subscriber"}</span>
                        <DashboardCta />
                        {tier !== "admin" && <button style={{ ...S.secondary, borderColor: BRAND.line, color: BRAND.muted }} disabled={busy} onClick={switchOff}>{busy ? "Switching…" : "Switch off"}</button>}
                      </>
                    ) : (
                      <>
                        <button style={S.primary} disabled={busy} onClick={subscribe}>{busy ? "Subscribing…" : user ? "Subscribe →" : "Subscribe · create an account →"}</button>
                        <span className="sub-fine" style={{ fontSize: 11.5, color: BRAND.muted }}>{user ? "Switches on now. Switch off any time." : "Takes a minute. Then it switches on."}</span>
                      </>
                    )
                  ) : (
                    user ? (subscriber ? <span style={S.current}>✓ Included in Subscriber</span> : <><span style={S.current}>✓ You're on Free</span><DashboardCta /></>)
                         : <button style={S.secondary} onClick={() => onSignIn?.("free")}>Create a free account →</button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* 2 · Organisation intelligence */}
      <section style={{ ...S.section, paddingTop: 10, paddingBottom: embedded ? 20 : 56 }}>
        <div style={{ background: BRAND.obsidian, color: "#fff", borderRadius: 16, padding: "28px clamp(16px, 10vw - 13px, 26px) 26px", position: "relative", overflow: "hidden", containerType: "inline-size" }}>
          <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 85% 20%, rgba(252,189,0,.16), transparent 30%)", pointerEvents: "none" }} />
          <div className="sub-eyebrow" style={{ ...S.eyebrow, color: BRAND.gold }}>♛ Organisation intelligence · Premium</div>
          <h2 style={{ ...S.h2, color: "#fff", textWrap: "balance" }}>Industry intelligence first. Organisation intelligence when you need it.</h2>
          <p style={{ ...S.lede, color: "rgba(255,255,255,.72)" }}>Free and Subscriber keep you informed at sector level. Premium adds your organisation: its suppliers, dependencies, materiality and controls — what an incident could mean for you, not just for your industry.</p>
          <div className="sub-premium" style={S.grid(280)}>
            {PREMIUM.map((p) => (
              <article key={p.key} style={{ ...S.card, background: "rgba(255,255,255,.04)", borderColor: "rgba(255,255,255,.12)", color: "#fff" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                  <h3 style={{ ...S.name, color: "#fff", fontSize: 15 }}>{p.name}</h3>
                  <span className="sub-tag" style={{ ...S.tag, background: "rgba(252,189,0,.14)", borderColor: "rgba(252,189,0,.4)", color: BRAND.gold }}>Pro</span>
                </div>
                <p style={{ ...S.pitch, color: "#fff", fontWeight: 600, marginTop: 12 }}>{p.lead}</p>
                <p style={{ ...S.pitch, color: "rgba(255,255,255,.66)", marginTop: 6, flex: 1 }}>{p.body}</p>
                <a style={{ ...S.secondary, color: "#fff", borderColor: "rgba(255,255,255,.28)", marginTop: 16 }} href={mailto(p.subject)}>Talk to us →</a>
              </article>
            ))}
          </div>
          <div className="sub-fine" style={{ marginTop: 18, fontFamily: MONO, fontSize: 10.5, color: "rgba(255,255,255,.55)", letterSpacing: ".04em" }}>Available to Subscriber organisations · scoped and priced per organisation · a sample assessment on request.</div>
        </div>
      </section>

    </div>
  );
}

export function SubscribePage() {
  useFonts();
  const { user, subscriber } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [authIntent, setAuthIntent] = useState("subscribe");
  return (
    <div style={{ background: BRAND.paper, minHeight: "100vh", color: BRAND.ink }}>
      {/* The nav item that leads here is "Pricing" (?pricing routes to this
          page), so that is the one to mark as current — "subscribe" matched no
          nav item and left the bar with nothing highlighted. */}
      <SiteNav active="pricing" />
      <header style={{ background: BRAND.obsidian, color: "#fff", padding: "54px 24px 46px", borderBottom: `1px solid ${BRAND.border}` }}>
        <div style={{ maxWidth: 1132, margin: "0 auto" }}>
          <div className="sub-eyebrow" style={{ ...S.eyebrow, color: BRAND.gold }}>Subscribe · Attacked.ai</div>
          <h1 style={{ fontFamily: SERIF, fontSize: "clamp(36px, 11vw, 52px)", lineHeight: 1.02, fontWeight: 500, margin: "10px 0 14px", letterSpacing: "-0.015em", maxWidth: 820 }}>One corpus. Three ways in.</h1>
          <p style={{ ...S.lede, color: "rgba(255,255,255,.72)", fontSize: 16 }}>The Attack Map for your industry, the organisation-level intelligence behind it, and the reports, listings and licences that stand on their own.</p>
          {user && <div style={{ marginTop: 18, fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,.6)" }}>Signed in as {user.email} · {subscriber ? "Subscriber" : "Free"}</div>}
        </div>
      </header>
      <SubscriptionPlans onSignIn={(kind) => { setAuthIntent(kind === "free" ? null : "subscribe"); setAuthOpen(true); }} />
      <SiteFooter />
      <AuthModal open={authOpen} intent={authIntent} onClose={() => setAuthOpen(false)} />
    </div>
  );
}
