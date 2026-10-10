import React, { useState, useEffect, useMemo, useRef } from "react";
import * as d3 from "d3";
import { useAuth } from "./auth/AuthProvider.jsx";
import { AuthModal } from "./auth/AuthModal.jsx";
import { PartnerFeedbackModal } from "./auth/PartnerFeedbackModal.jsx";
import { SubscribeModal } from "./auth/SubscribeModal.jsx";
import { isSubscriber } from "./lib/taxonomy";
import { readerToken as fetchReaderToken, onReaderToken } from "./lib/authClient";
import { incidentImage } from "./lib/images";
import { Logo } from "./auth/Logo.jsx";
import { SiteNav } from "./auth/SiteNav.jsx";
import Globe3D from "./Globe3D.jsx";
import "./map-responsive.css";
// World atlas + topojson are BUNDLED (not loaded from a CDN at runtime) so the
// continents always render — a blocked/slow CDN used to leave the map empty.
import { feature as topoFeature } from "topojson-client";
import worldCountries110m from "world-atlas/countries-110m.json";
import { BRAND, SEVERITY } from "./brand.js";

// ── Daily Brief — turn a day's incidents into a fast, news-bulletin script.
//    Structure mirrors a TV headlines roundup: cold-open → headline stack →
//    ranked lead stories (with anchor transitions) → "also today" quick-hits →
//    sign-off. Returns ordered segments; a segment carrying `id` is a lead
//    story the map flies to + highlights as it's read. Data-driven, so it works
//    for every day and every future daily sweep — no per-incident authoring.
const BRIEF_CAT = {
  CYB: "cyber", DAT: "data-breach", TEC: "technology", INF: "infrastructure",
  OPS: "operational", GEO: "geopolitical", PHY: "physical-security", ENV: "environmental",
  FIN: "financial", REG: "regulatory", REP: "reputational", STR: "strategic", SUP: "supply-chain",
};

// The specific place an incident happened, for the on-map focus label.
// location_name is ordered most-specific-first ("Strait of Hormuz, Persian
// Gulf"; "Naval Support Activity Bahrain, Juffair, Manama, Bahrain"), so the
// leading segment is the place a reader recognises. country is only a fallback:
// it is coarse (a point event is not a whole nation) and inconsistently coded
// across the dataset — both "US" and "United States" occur.
function placeLabelFor(inc) {
  if (!inc) return "";
  const first = String(inc.location_name || "").split(",")[0].trim();
  if (first) return first;
  return String(inc.entity || inc.country || "").trim();
}
function buildDailyBrief(incidents, niceDate) {
  const inc = (incidents || []).filter(Boolean);
  if (!inc.length) return [{ text: `This is your daily attack brief for ${niceDate}. No incidents on the board today — all quiet across the map.` }];
  const list = [...inc].sort((a, b) => (b.severity || 0) - (a.severity || 0));
  const N = list.length;
  const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/[\s,;:.\-]+\S*$/, "") + "…" : s; };
  const phrase = (i) => {
    const h = clip(i.headline, 96);
    if (h) return h;
    const cat = BRIEF_CAT[i._cat] || "an"; const ent = i.entity || i.primary_entity || "a major organisation";
    return `a ${cat} incident at ${ent}`;
  };
  const city = (i) => { const c = String(i.location_name || "").split(",")[0].trim(); return c || i.country || "an undisclosed location"; };
  const med = (i) => clip(i.headline, 66) || phrase(i);   // MEDIUM heading — punchy + fast to read
  const segs = [];
  segs.push({ text: `This is your daily attack brief for ${niceDate}. ${N} incident${N === 1 ? "" : "s"} across the globe — here's the rundown.` });
  // ONE line per incident, and EVERY line syncs the map + card to that incident,
  // so what you hear is always what you see. Top 3 get an anchor lead-in; the
  // rest are rapid-fire (medium headings, faster rate) so all are covered fast.
  const openers = ["We begin in", "Turning to", "Meanwhile, in"];
  list.forEach((i, idx) => {
    const text = idx < 3 ? `${openers[idx]} ${city(i)}: ${med(i)}.` : `In ${city(i)}: ${med(i)}.`;
    segs.push({ id: i._id, text, fast: idx >= 3 });
  });
  const sectors = new Set(list.map(i => i._cat).filter(Boolean)).size;
  segs.push({ text: `${N} event${N === 1 ? "" : "s"}${sectors ? `, across ${sectors} sector${sectors === 1 ? "" : "s"}` : ""}. That's your brief.` });
  return segs;
}

// Globally-mounted partner modal. Any GateBlock click anywhere in the map
// opens the same modal via this window-level event. Keeps the modal a
// single source of truth and avoids prop-drilling through 7 components.
const SUBSCRIBE_MODAL_EVENT = "attackmap:open-subscribe-modal";
export function openSubscribeModal() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SUBSCRIBE_MODAL_EVENT));
  }
}
// Design Partner is retired (2026-09-21). Old name kept as an alias so any
// external caller keeps working.
export const openPartnerModal = openSubscribeModal;

// useIsMobile — true when the viewport is phone-sized (<=768px). Drives the
// map's mobile shell (compact top bar + bottom sheets + swipe-card incident
// detail) instead of the desktop floating-corner-panel layout. Re-evaluates on
// resize so rotating the device or resizing a desktop window switches cleanly.
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= breakpoint : false
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

// ─────────────────────────────────────────────────────────────────────────────
// AccountChip — tier badge + sign-in/sign-out action in the top-right header.
// Renders one of:
//   • "Sign in"           — anonymous
//   • "📧 FREE  ·  email"  — signed in, free tier
//   • "🤝 PARTNER · email" — signed in, design-partner tier
//   • "✦ ADMIN · email"    — signed in, internal team
// Click opens the AuthModal (when anonymous) or a tiny menu (when signed in).
// ─────────────────────────────────────────────────────────────────────────────
function AccountChip({ onOpenAuth }) {
  const { user, tier, loading, signOut, profile, setEmailSubscribed } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [prefBusy, setPrefBusy] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Optimistic local mirror of profile.email_subscribed so the toggle feels
  // instant — falls back to true if profile hasn't loaded yet.
  const subscribed = profile ? !!profile.email_subscribed : true;

  if (loading) return null;

  const colorFor = (t) =>
    t === "enterprise" ? "#FCBD00" :
    t === "admin"   ? "#9D7BEC" :
    t === "free"    ? "#4FC3D7" :
                      "#A8A8A8";
  const labelFor = (t) =>
    t === "enterprise" ? "◆ SUBSCRIBER" :
    t === "admin"   ? "✦ ADMIN" :
    t === "free"    ? "📧 FREE" :
                      "🌐 PUBLIC";

  if (!user) {
    return (
      <button onClick={onOpenAuth}
        style={{
          padding: "6px 14px",
          background: "#FCBD00", color: "#1A1A1A",
          fontFamily: "Inter, sans-serif", fontSize: 11, letterSpacing: "0.12em",
          border: "1px solid #FCBD00", borderRadius: 0,
          cursor: "pointer", textTransform: "uppercase", fontWeight: 700,
        }}>
        Sign in
      </button>
    );
  }

  const color = colorFor(tier);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setMenuOpen(o => !o)}
        title={user.email}
        style={{
          padding: "6px 12px",
          background: "transparent", color,
          fontFamily: "Inter, sans-serif", fontSize: 11, letterSpacing: "0.08em",
          border: `1px solid ${color}55`, borderRadius: 0,
          cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
          textTransform: "uppercase", fontWeight: 600,
        }}>
        <span style={{ fontWeight: 700 }}>{labelFor(tier)}</span>
        <span style={{ color: "#A8A8A8", fontSize: 10.5, letterSpacing: "0.02em", textTransform: "none", fontWeight: 500 }}>
          {user.email?.length > 22 ? user.email.slice(0, 20) + "…" : user.email}
        </span>
      </button>
      {menuOpen && (
        <>
          <div onClick={() => setMenuOpen(false)}
               style={{ position: "fixed", inset: 0, zIndex: 99 }} />
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 100,
            background: "#242424", border: "1px solid #333", borderRadius: 0,
            minWidth: 200, padding: 6, boxShadow: "0 12px 28px rgba(0,0,0,0.5)",
          }}>
            <div style={{
              padding: "8px 10px", fontFamily: "Inter, sans-serif",
              fontSize: 9, color: "#585858", letterSpacing: "0.12em", textTransform: "uppercase",
            }}>
              Signed in as
            </div>
            <div style={{ padding: "2px 10px 4px", fontSize: 12, color: "#FFF", wordBreak: "break-all" }}>
              {user.email}
            </div>
            {/* Show company / role for partners + admins so they see what
                we have on file (came from their application). */}
            {isSubscriber(tier) && (profile?.company || profile?.role) && (
              <div style={{ padding: "0 10px 10px", fontSize: 11, color: "#A8A8A8", lineHeight: 1.45 }}>
                {profile.role}{profile.company ? ` · ${profile.company}` : ""}
                {profile.approved_at && (
                  <div style={{
                    fontFamily: "Inter, sans-serif", fontSize: 9,
                    color: "#585858", letterSpacing: "0.08em", marginTop: 2,
                  }}>
                    Subscriber since {new Date(profile.approved_at).toUTCString().slice(5, 16)}
                  </div>
                )}
              </div>
            )}
            {tier === "free" && (
              <>
                <div style={{
                  padding: "10px 10px", margin: "0 0 4px", background: "rgba(252,189,0,0.08)",
                  borderRadius: 0, fontSize: 11, color: "#FCBD00", lineHeight: 1.45,
                                  }}>
                  You're on the free tier. <b>Subscribe</b> to unlock named blast radius, GUARD controls and the peer watchlist.
                </div>
                <button onClick={() => { setMenuOpen(false); openSubscribeModal(); }}
                  style={{
                    width: "100%", padding: "8px 10px", marginBottom: 4,
                    background: "#FCBD00", color: "#1A1A1A",
                    border: "1px solid #FCBD00", borderRadius: 0,
                    fontFamily: "Inter, sans-serif", fontSize: 10,
                    letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
                    fontWeight: 600,
                  }}>
                  Subscribe →
                </button>
              </>
            )}

            {/* Pricing — always visible. Anyone can browse the upgrade path. */}
            <a href="/?pricing"
              style={{
                display: "block", width: "100%", padding: "8px 10px", marginBottom: 4, marginTop: 4,
                background: "transparent", color: "#A8A8A8",
                border: "1px solid #333", borderRadius: 0,
                fontFamily: "Inter, sans-serif", fontSize: 10,
                letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
                textAlign: "center", textDecoration: "none", boxSizing: "border-box",
              }}>
              📊 View pricing
            </a>

            {/* Admin Panel — direct entry for admin tier. Replaces the
                hidden triple-click trick for admins who use the dropdown. */}
            {tier === "admin" && (
              <a
                href="/?admin"
                onClick={() => setMenuOpen(false)}
                style={{
                  display: "block", width: "100%", padding: "9px 10px",
                  marginBottom: 4, marginTop: 4,
                  background: "rgba(252,189,0,0.07)",
                  color: "#FCBD00",
                  border: "1px solid rgba(252,189,0,0.35)", borderRadius: 0,
                  fontFamily: "Inter, sans-serif", fontSize: 11,
                  letterSpacing: "0.08em", textTransform: "uppercase",
                  fontWeight: 700, textAlign: "center", textDecoration: "none",
                  boxSizing: "border-box",
                }}>
                Admin Console →
              </a>
            )}

            {/* Share feedback — visible to ALL signed-in tiers (free,
                partner, admin, etc.). Free users' product feedback is
                just as valuable — the 6Q form's tier_at_submission column
                tags every response so admin can filter by tier in the
                Feedback tab later. setTimeout defers the modal mount so
                React commits the dropdown close first. */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                setTimeout(() => setFeedbackOpen(true), 0);
              }}
              style={{
                width: "100%", padding: "10px 10px", marginBottom: 4, marginTop: 4,
                background: "#FCBD00", color: "#1A1A1A",
                border: "1px solid #FCBD00", borderRadius: 0,
                fontFamily: "Inter, sans-serif", fontSize: 11.5,
                letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer",
                fontWeight: 700,
              }}>
              💬 Share feedback
            </button>

            {/* Email preferences — daily digest subscribe/unsubscribe.
                Visible for any signed-in user; updates flow through the
                AuthProvider's setEmailSubscribed (RLS allows self-update). */}
            <div style={{
              marginTop: 8, padding: "10px 10px",
              background: "rgba(255,255,255,0.02)", border: "1px solid #2a2a2a",
              borderRadius: 0,
            }}>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: "Inter, sans-serif", fontSize: 9,
                    color: "#585858", letterSpacing: "0.12em", textTransform: "uppercase",
                    marginBottom: 4,
                  }}>
                    Daily digest
                  </div>
                  <div style={{ fontSize: 11.5, color: "#FFF", lineHeight: 1.35 }}>
                    {subscribed
                      ? "Subscribed — 08:00 UTC daily"
                      : "Unsubscribed"}
                  </div>
                </div>
                {/* Toggle switch */}
                <button
                  disabled={prefBusy}
                  onClick={async () => {
                    setPrefBusy(true);
                    await setEmailSubscribed(!subscribed);
                    setPrefBusy(false);
                  }}
                  aria-label={subscribed ? "Unsubscribe from daily digest" : "Subscribe to daily digest"}
                  title={subscribed ? "Click to unsubscribe" : "Click to subscribe"}
                  style={{
                    flexShrink: 0,
                    width: 36, height: 20,
                    borderRadius: 0,
                    background: subscribed ? "#34C759" : "#333",
                    border: "none",
                    cursor: prefBusy ? "wait" : "pointer",
                    position: "relative",
                    transition: "background 180ms ease",
                    opacity: prefBusy ? 0.6 : 1,
                  }}>
                  <span style={{
                    position: "absolute",
                    top: 2,
                    left: subscribed ? 18 : 2,
                    width: 16, height: 16,
                    borderRadius: 0,
                    background: "#FFF",
                    transition: "left 180ms ease",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                  }}/>
                </button>
              </div>
            </div>

            {/* Manage subscription — the full preference centre (industries,
                risk lens, cadence). The quick toggle above is on/off only. */}
            <a href="/?subscriptions"
              onClick={() => setMenuOpen(false)}
              style={{
                display: "block", width: "100%", padding: "9px 10px", marginTop: 4,
                background: "rgba(252,189,0,0.06)", color: "#FCBD00",
                border: "1px solid rgba(252,189,0,0.3)", borderRadius: 0,
                fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700,
                letterSpacing: "0.08em", textTransform: "uppercase",
                textAlign: "center", textDecoration: "none", boxSizing: "border-box",
              }}>
              ⚙ Manage subscription →
            </a>

            {/* View pricing — public link, always visible. Opens dedicated page. */}
            <a href="/?pricing"
              onClick={() => setMenuOpen(false)}
              style={{
                display: "block", width: "100%", padding: "8px 10px",
                background: "transparent", color: "#A8A8A8",
                border: "1px solid #333", borderRadius: 0,
                fontFamily: "Inter, sans-serif", fontSize: 10,
                letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
                marginTop: 4, textDecoration: "none", textAlign: "center",
                boxSizing: "border-box",
              }}>
              View pricing →
            </a>
            <button onClick={async () => { setMenuOpen(false); await signOut(); }}
              style={{
                width: "100%", padding: "8px 10px",
                background: "transparent", color: "#A8A8A8",
                border: "1px solid #333", borderRadius: 0,
                fontFamily: "Inter, sans-serif", fontSize: 10,
                letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
                marginTop: 4,
              }}>
              Sign out
            </button>
          </div>
        </>
      )}
      <PartnerFeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  );
}

// ============================================================================
// ATTACKED.AI GLOBAL ATTACK MAP v4
// ----------------------------------------------------------------------------
// Single-file React component. Upload a GUARD daily-sweep JSON file → renders
// incidents on a world map. Two RENDERING SURFACES, one data model:
//
//   FLAT view  → d3.geoNaturalEarth1 + SVG  (zoom-pan, country/city labels)
//   GLOBE view → d3.geoOrthographic + SVG   (interactive drag-rotate, zoom)
//
// Both views use the same SVG pipeline — no Cesium, no WebGL, no Web Workers.
// Brand-coherent, single-file, no external runtime dependencies beyond d3 and
// the world-atlas TopoJSON (loaded from CDN, same as flat view). Works in any
// modern browser including sandboxed iframes (e.g. the Claude artifact preview).
//
// The toggle is in the top-right. All filters, sidebar, KPI overlay, detail
// panel, audit drawer, and search work IDENTICALLY across both views. Only
// the projection swaps — state stays in the parent. Lat/lng plotting is exact
// in both modes; no clustering on either side; spiderfy applies the same way
// to exact-coordinate collisions.
//
// GLOBE view specifics:
//   - d3.geoOrthographic projection with clipAngle(90) for back-of-globe culling
//   - Drag to rotate (longitude + latitude); scroll-wheel to zoom in/out
//   - Country outlines, ocean fill, and graticule grid in obsidian brand colours
//   - Pin click rotates globe to centre the incident
//   - Blast-radius arcs become great-circle geodesic paths
//
// v3 features preserved:
//   - d3-zoom pan/zoom on flat view (1× to 20×, hold-to-zoom buttons)
//   - Exact lat/lng plotting, spiderfy for coordinate collisions
//   - Counter-scaling at all zoom levels
//   - Country + city labels with zoom-fade
//   - Search across headline/entity/country/summary/sector/cat/vendors
//
// v2 features preserved:
//   - KPI overlay, sidebar incident list, audit drawer, severity/confidence
//     filter pills, distinct blast-radius glyphs, run-window timestamp.
//
// Data contract:
//   sweep.results[CAT].incidents[] — each incident has:
//     headline, summary, event_date, severity (1-5), confidence, country,
//     latitude, longitude, entity, sector, sources[], vendors[],
//     peer_watchlist[], historical_analogues[], blast_radius{ internal[],
//     supply_chain[], competitive_peer[], regulatory[], customer_counterparty[],
//     financial_market[] }, _enriched, _verified (optional v14.21+),
//     _verification_* (optional)
//   sweep.newsroom — reporter map keyed by reporter id
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// BRAND TOKENS (Attacked.ai — gold #FCBD00, NEVER Replaceable.ai crimson)
// ─────────────────────────────────────────────────────────────────────────────

// 5-tier risk scale (Attacked.ai standard, NOT the 3-tier RPI scale)

// 13 GUARD categories — short labels + colours
const CATEGORIES = {
  CYB: { label: "Cyber",        color: "#FCBD00" },
  DAT: { label: "Data",         color: "#FFD166" },
  TEC: { label: "Technology",   color: "#FFE99A" },
  GEO: { label: "Geopolitical", color: "#FF8C5A" },
  PHY: { label: "Physical",     color: "#FF6B35" },
  OPS: { label: "Operations",   color: "#34C759" },
  TPR: { label: "Third Party",  color: "#7BD693" },
  REG: { label: "Regulatory",   color: "#D4A000" },
  FIN: { label: "Financial",    color: "#B89A00" },
  STR: { label: "Strategic",    color: "#9D7BEC" },
  REP: { label: "Reputation",   color: "#BFA2F0" },
  PPL: { label: "People",       color: "#4FC3D7" },
  ENV: { label: "Environment",  color: "#7DDAEA" },
};

// Reporter desks (matches v14.21 newsroom assignment)
const DEFAULT_REPORTERS = {
  cyber_bob:        { name: "Cyber Bob",        desk: "Digital Defence",        cats: ["CYB","DAT","TEC"], color: "#FCBD00" },
  commander_vance:  { name: "Commander Vance",  desk: "Geopolitical & Physical",cats: ["GEO","PHY"],       color: "#FF8C5A" },
  saskia_martin:    { name: "Saskia Martin",    desk: "Operations & Supply",    cats: ["OPS","TPR"],       color: "#34C759" },
  jack_whistler:    { name: "Jack Whistler",    desk: "Regulatory & Financial", cats: ["REG","FIN"],       color: "#D4A000" },
  lulu_kim:         { name: "Lulu Kim",         desk: "Strategic & Reputation", cats: ["STR","REP"],       color: "#9D7BEC" },
  priya_banerjee:   { name: "Priya Banerjee",   desk: "People & Environment",   cats: ["PPL","ENV"],       color: "#4FC3D7" },
};

// ─────────────────────────────────────────────────────────────────────────────
// WORLD CITIES — curated set of major cities for labelling at higher zoom.
// Compact list (~140 entries) covering G20 capitals + top metros worldwide.
// Used to anchor city labels at zoom ≥ 3.5×. Each: [name, lat, lng].
// Population-weighted: we want capitals + finance/tech hubs to show up first.
// ─────────────────────────────────────────────────────────────────────────────
const WORLD_CITIES = [
  // North America
  ["New York", 40.7128, -74.0060], ["Los Angeles", 34.0522, -118.2437],
  ["Chicago", 41.8781, -87.6298], ["Washington", 38.9072, -77.0369],
  ["San Francisco", 37.7749, -122.4194], ["Boston", 42.3601, -71.0589],
  ["Seattle", 47.6062, -122.3321], ["Miami", 25.7617, -80.1918],
  ["Houston", 29.7604, -95.3698], ["Atlanta", 33.7490, -84.3880],
  ["Dallas", 32.7767, -96.7970], ["Detroit", 42.3314, -83.0458],
  ["Toronto", 43.6532, -79.3832], ["Vancouver", 49.2827, -123.1207],
  ["Montreal", 45.5017, -73.5673], ["Mexico City", 19.4326, -99.1332],
  ["Salt Lake City", 40.7608, -111.8910], ["San Jose", 37.3382, -121.8863],
  // South America
  ["São Paulo", -23.5505, -46.6333], ["Rio de Janeiro", -22.9068, -43.1729],
  ["Buenos Aires", -34.6037, -58.3816], ["Lima", -12.0464, -77.0428],
  ["Bogotá", 4.7110, -74.0721], ["Santiago", -33.4489, -70.6693],
  ["Caracas", 10.4806, -66.9036], ["Brasília", -15.8267, -47.9218],
  // Europe
  ["London", 51.5074, -0.1278], ["Paris", 48.8566, 2.3522],
  ["Berlin", 52.5200, 13.4050], ["Madrid", 40.4168, -3.7038],
  ["Rome", 41.9028, 12.4964], ["Amsterdam", 52.3676, 4.9041],
  ["Brussels", 50.8503, 4.3517], ["Vienna", 48.2082, 16.3738],
  ["Stockholm", 59.3293, 18.0686], ["Oslo", 59.9139, 10.7522],
  ["Copenhagen", 55.6761, 12.5683], ["Helsinki", 60.1699, 24.9384],
  ["Dublin", 53.3498, -6.2603], ["Lisbon", 38.7223, -9.1393],
  ["Warsaw", 52.2297, 21.0122], ["Prague", 50.0755, 14.4378],
  ["Athens", 37.9838, 23.7275], ["Zurich", 47.3769, 8.5417],
  ["Frankfurt", 50.1109, 8.6821], ["Milan", 45.4642, 9.1900],
  ["Barcelona", 41.3851, 2.1734], ["Moscow", 55.7558, 37.6173],
  ["Saint Petersburg", 59.9311, 30.3609], ["Kyiv", 50.4501, 30.5234],
  ["Istanbul", 41.0082, 28.9784], ["Ankara", 39.9334, 32.8597],
  ["Budapest", 47.4979, 19.0402], ["Bucharest", 44.4268, 26.1025],
  // Middle East
  ["Dubai", 25.2048, 55.2708], ["Riyadh", 24.7136, 46.6753],
  ["Tehran", 35.6892, 51.3890], ["Tel Aviv", 32.0853, 34.7818],
  ["Jerusalem", 31.7683, 35.2137], ["Doha", 25.2854, 51.5310],
  ["Abu Dhabi", 24.4539, 54.3773], ["Kuwait City", 29.3759, 47.9774],
  ["Baghdad", 33.3152, 44.3661], ["Beirut", 33.8938, 35.5018],
  ["Amman", 31.9454, 35.9284], ["Cairo", 30.0444, 31.2357],
  // Africa
  ["Lagos", 6.5244, 3.3792], ["Nairobi", -1.2921, 36.8219],
  ["Johannesburg", -26.2041, 28.0473], ["Cape Town", -33.9249, 18.4241],
  ["Addis Ababa", 9.0320, 38.7423], ["Accra", 5.6037, -0.1870],
  ["Casablanca", 33.5731, -7.5898], ["Dakar", 14.7167, -17.4677],
  ["Algiers", 36.7538, 3.0588], ["Tunis", 36.8065, 10.1815],
  ["Khartoum", 15.5007, 32.5599], ["Kinshasa", -4.4419, 15.2663],
  ["Luanda", -8.8390, 13.2894], ["Dar es Salaam", -6.7924, 39.2083],
  // Asia
  ["Tokyo", 35.6762, 139.6503], ["Osaka", 34.6937, 135.5023],
  ["Seoul", 37.5665, 126.9780], ["Beijing", 39.9042, 116.4074],
  ["Shanghai", 31.2304, 121.4737], ["Hong Kong", 22.3193, 114.1694],
  ["Shenzhen", 22.5431, 114.0579], ["Guangzhou", 23.1291, 113.2644],
  ["Taipei", 25.0330, 121.5654], ["Manila", 14.5995, 120.9842],
  ["Jakarta", -6.2088, 106.8456], ["Singapore", 1.3521, 103.8198],
  ["Kuala Lumpur", 3.1390, 101.6869], ["Bangkok", 13.7563, 100.5018],
  ["Hanoi", 21.0285, 105.8542], ["Ho Chi Minh City", 10.8231, 106.6297],
  ["Mumbai", 19.0760, 72.8777], ["Delhi", 28.7041, 77.1025],
  ["Bangalore", 12.9716, 77.5946], ["Kolkata", 22.5726, 88.3639],
  ["Chennai", 13.0827, 80.2707], ["Hyderabad", 17.3850, 78.4867],
  ["Pune", 18.5204, 73.8567], ["Karachi", 24.8607, 67.0011],
  ["Lahore", 31.5204, 74.3587], ["Islamabad", 33.6844, 73.0479],
  ["Dhaka", 23.8103, 90.4125], ["Colombo", 6.9271, 79.8612],
  ["Kabul", 34.5553, 69.2075], ["Tashkent", 41.2995, 69.2401],
  ["Almaty", 43.2220, 76.8512], ["Ulaanbaatar", 47.8864, 106.9057],
  // Oceania
  ["Sydney", -33.8688, 151.2093], ["Melbourne", -37.8136, 144.9631],
  ["Brisbane", -27.4698, 153.0251], ["Perth", -31.9505, 115.8605],
  ["Auckland", -36.8485, 174.7633], ["Wellington", -41.2865, 174.7762],
];

// Blast-radius channel styling (subtle, doesn't compete with category colour)
// `kind: primary` = directly named/affected entity (filled marker, solid arc)
// `kind: indirect` = read-across / sectoral inference (dashed-ring marker, dashed arc)
const BLAST_CHANNELS = {
  internal:              { label: "Internal",      color: "#FCBD00", dash: "0",      width: 1.2, opacity: 0.55, kind: "primary",  icon: "◉" },
  supply_chain:          { label: "Supply Chain",  color: "#FF8C5A", dash: "0",      width: 1.0, opacity: 0.50, kind: "primary",  icon: "⟿" },
  customer_counterparty: { label: "Customer",      color: "#4FC3D7", dash: "0",      width: 0.9, opacity: 0.45, kind: "primary",  icon: "◊" },
  competitive_peer:      { label: "Peer",          color: "#9D7BEC", dash: "4,3",    width: 0.9, opacity: 0.45, kind: "indirect", icon: "≈" },
  regulatory:            { label: "Regulator",     color: "#A8A8A8", dash: "2,3",    width: 0.9, opacity: 0.45, kind: "indirect", icon: "§" },
  financial_market:      { label: "Capital",       color: "#7BD693", dash: "6,3",    width: 0.9, opacity: 0.40, kind: "indirect", icon: "$" },
};

// Blast-radius rich-field lookup tables. The new schema (May 2026+) attaches
// per-entity impact_score, transmission_mechanism, impact_horizon, recommended
// action text, and a product hook with CTA. These tables convert the snake_case
// machine codes into human-readable labels for the detail panel card.
const IMPACT_HORIZONS = {
  immediate: { label: "Immediate", hint: "0–72h" },
  short:     { label: "Short",     hint: "1–4 wks" },
  medium:    { label: "Medium",    hint: "1–6 mo" },
  long:      { label: "Long",      hint: "6+ mo" },
};

// Each mechanism includes a plain-English description that explains how
// the risk actually transmits from the source incident to the affected
// entity. Without this, the user sees a code chip like "SHARED VENDOR"
// and has no idea what it means in practice. The description appears
// directly under the mechanism chip in the cascade card.
const TRANSMISSION_MECHANISMS = {
  shared_technology:        { label: "Shared technology",        desc: "Same underlying tech stack — if one is compromised, others are exposed via the same vector." },
  shared_geography:         { label: "Shared geography",         desc: "Located in the same region — same regulatory, political, or physical disruption window." },
  shared_vendor:            { label: "Shared vendor",            desc: "Common third-party supplier — a single vendor failure affects all dependent parties." },
  shared_workforce_market:  { label: "Shared workforce market",  desc: "Compete for the same talent pool — wage shocks or attrition spread across all participants." },
  supply_chain_link:        { label: "Supply chain link",        desc: "Direct supply-chain dependency — upstream disruption cascades into operational impact." },
  customer_overlap:         { label: "Customer overlap",         desc: "Serve substantially the same customers — demand-side shocks transmit across the cluster." },
  capability_substitution:  { label: "Capability substitution",  desc: "Competing capability — failure here drives customers to the alternative provider." },
  sentiment_contagion:      { label: "Sentiment contagion",      desc: "Investor or market sentiment spillover — perception of risk in one drags the cluster." },
  regulatory_spillover:     { label: "Regulatory spillover",     desc: "Regulatory response triggered here applies to peers — enforcement extends across category." },
};

// Product hooks — each blast entity may carry a CTA referencing an Attacked.ai
// product. The icon + label render as a small chip; clicking it would (in
// production) deep-link into the relevant product flow.
const PRODUCT_HOOKS = {
  wargaming_sim:         { label: "Wargaming.ai",        icon: "⚡", color: "#FCBD00" },
  apple_supply:          { label: "Supply Wargame",      icon: "◈", color: "#FF8C5A" },
  greyteaming:           { label: "Grey Teaming",        icon: "◇", color: "#9D7BEC" },
  fdri_watchlist:        { label: "FDRI Watchlist",      icon: "▲", color: "#A8A8A8" },
  attacked_brief:        { label: "Attacked Brief",      icon: "✦", color: "#4FC3D7" },
  replaceable_workforce: { label: "Replaceable.ai",      icon: "⊕", color: "#7BD693" },
};

// Reporter desks — icon + brand colour per reporter. Surfaces as a chip in the
// detail panel header so the user knows which editorial desk owns the incident.
const REPORTER_BADGES = {
  "Cyber Bob":          { desk: "Digital Defence",          color: "#FCBD00", icon: "⌬" },
  "Commander Vance":    { desk: "Geopolitical & Physical",  color: "#FF8C5A", icon: "▼" },
  "Saskia Martin":      { desk: "Operations & Supply Chain",color: "#34C759", icon: "◐" },
  "Jack Whistler":      { desk: "Regulatory & Financial",   color: "#D4A000", icon: "§" },
  "Lulu Kim":           { desk: "Strategic & Reputation",   color: "#9D7BEC", icon: "✦" },
  "Priya Banerjee":     { desk: "People & Environment",     color: "#4FC3D7", icon: "❋" },
};

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP ARCHIVE — persistent day-wise storage of uploaded sweep JSONs.
// ----------------------------------------------------------------------------
// In the Claude artifact runtime, persists via window.storage (cross-session,
// per-user). When this file is deployed to attackmap.ai with a real backend,
// replace the four functions below with fetch() calls to your API. Schema and
// key shape stay the same so the UI doesn't need to change.
//
// Storage keys:
//   sweep:YYYY-MM-DD      → full sweep JSON for that calendar date
//   sweep_index           → JSON array of { date, generatedAt, incidentCount,
//                            fileName, sevCounts } sorted by date descending
//
// The index is the read-fast list the date picker renders from. Without it
// rendering the picker would require fetching every sweep. Index stays in
// sync via writeSweep() and deleteSweep() helpers below.
// ─────────────────────────────────────────────────────────────────────────────

// Storage substrate state — populated by verifyStorage() at app boot.
// Until verifyStorage() resolves, we don't know which substrate is live.
const _storageState = {
  substrate: "unknown",  // "persistent" | "session" | "unknown"
  canaryError: null,     // last error captured during boot verification
  verifiedAt: null,      // timestamp of the last successful canary round-trip
};

// In-memory fallback — only used if window.storage is unavailable OR the
// canary round-trip fails. State persists for the page session only.
const _memoryStore = new Map();
const _memoryFallback = {
  async get(key) {
    if (!_memoryStore.has(key)) throw new Error("Key not found");
    return { key, value: _memoryStore.get(key), shared: false };
  },
  async set(key, value) {
    _memoryStore.set(key, value);
    return { key, value, shared: false };
  },
  async delete(key) {
    const had = _memoryStore.has(key);
    _memoryStore.delete(key);
    return { key, deleted: had, shared: false };
  },
  async list(prefix) {
    const keys = [];
    for (const k of _memoryStore.keys()) {
      if (!prefix || k.startsWith(prefix)) keys.push(k);
    }
    return { keys, prefix, shared: false };
  },
};

// _store() returns the active substrate. If verifyStorage() has flagged
// window.storage as unusable, we route to the memory fallback so callers
// don't need to branch on substrate state.
function _store() {
  if (_storageState.substrate === "persistent"
      && typeof window !== "undefined"
      && window.storage
      && typeof window.storage.get === "function") {
    return window.storage;
  }
  return _memoryFallback;
}

// True if persistent storage is live and verified. Used for the UI banner.
function isPersistent() {
  return _storageState.substrate === "persistent";
}

// Run a real write-read-delete round-trip on a canary key. This is the only
// reliable test of whether window.storage is actually functional in this
// runtime — the existence check `typeof window.storage.get === "function"`
// can pass while writes silently fail (sandbox quirks, missing permissions,
// disabled-by-policy, etc.). Called once at app boot.
async function verifyStorage() {
  const CANARY_KEY = "__attackmap_canary__";
  const canaryValue = JSON.stringify({ t: Date.now() });
  if (typeof window === "undefined"
      || !window.storage
      || typeof window.storage.get !== "function") {
    _storageState.substrate = "session";
    _storageState.canaryError = "window.storage API unavailable";
    return false;
  }
  try {
    await window.storage.set(CANARY_KEY, canaryValue);
    const res = await window.storage.get(CANARY_KEY);
    const got = res && res.value;
    if (got !== canaryValue) {
      throw new Error(`canary mismatch (wrote ${canaryValue.length}b, read ${got ? String(got).length : 0}b)`);
    }
    // Cleanup — don't litter the user's storage with canary records
    try { await window.storage.delete(CANARY_KEY); } catch { /* non-fatal */ }
    _storageState.substrate = "persistent";
    _storageState.canaryError = null;
    _storageState.verifiedAt = Date.now();
    return true;
  } catch (e) {
    _storageState.substrate = "session";
    _storageState.canaryError = e?.message || String(e);
    return false;
  }
}

// ── Serialised write queue. Without this, concurrent uploads (or rapid
//    user actions) can race on the index: write A reads idx=[], pushes A,
//    writes [A]; write B reads idx=[] (before A's write lands), pushes B,
//    writes [B] — losing A. The queue forces writes to complete in order.
let _writeChain = Promise.resolve();
function _queueWrite(fn) {
  const next = _writeChain.then(fn, fn);
  // Swallow chain errors so one failure doesn't poison subsequent writes
  _writeChain = next.then(() => undefined, () => undefined);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP ARCHIVE — high-level helpers used by the UI. All public functions
// route through the substrate selected by verifyStorage(), and all writes
// serialise through _queueWrite() to prevent races.
// ─────────────────────────────────────────────────────────────────────────────

// Derive a YYYY-MM-DD key from a sweep object. Tries the sweep's own
// generated_at timestamp first; falls back to today if absent.
function dateKeyFromSweep(sweep) {
  const raw = sweep && (sweep.generated_at || sweep.generatedAt);
  if (typeof raw === "string" && raw.length >= 10) {
    return raw.slice(0, 10);
  }
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function indexEntryFor(sweep, dateKey, fileName) {
  const sevCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let count = 0;
  const results = (sweep && sweep.results) || {};
  for (const cat of Object.values(results)) {
    const incs = (cat && cat.incidents) || [];
    for (const inc of incs) {
      count++;
      const s = inc.severity;
      if (s >= 1 && s <= 5) sevCounts[s]++;
    }
  }
  return {
    date: dateKey,
    generatedAt: (sweep && sweep.generated_at) || new Date().toISOString(),
    incidentCount: count,
    fileName: fileName || null,
    sevCounts,
  };
}

// Low-level: read the stored index (does NOT discover orphans).
async function _readStoredIndex() {
  try {
    const res = await _store().get("sweep_index");
    if (!res || !res.value) return [];
    const parsed = typeof res.value === "string" ? JSON.parse(res.value) : res.value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Low-level: write the index back, sorted desc by date.
async function _writeStoredIndex(entries) {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1));
  try {
    await _store().set("sweep_index", JSON.stringify(sorted));
    return sorted;
  } catch (e) {
    console.error("Sweep index write failed:", e);
    throw e;
  }
}

// Public: read the index, with a self-healing pass that discovers any
// `sweep:YYYY-MM-DD` keys not represented in the index and rebuilds their
// metadata from the stored sweep. This recovers from:
//   - a corrupted/missing sweep_index
//   - a race where a sweep was written but the index update failed
//   - manual storage inspection
async function readIndex() {
  const stored = await _readStoredIndex();
  let allKeys = [];
  try {
    const res = await _store().list("sweep:");
    allKeys = Array.isArray(res?.keys) ? res.keys : [];
  } catch (e) {
    // list() failed — just return the stored index as-is
    return stored;
  }
  const indexDates = new Set(stored.map(e => e.date));
  const orphanKeys = allKeys.filter(k => k.startsWith("sweep:") && !indexDates.has(k.slice(6)));
  if (orphanKeys.length === 0) return stored;

  // Reconstruct entries for orphan sweeps
  const recovered = [...stored];
  for (const key of orphanKeys) {
    const dateKey = key.slice(6);
    try {
      const r = await _store().get(key);
      if (!r || !r.value) continue;
      const sweepJson = typeof r.value === "string" ? JSON.parse(r.value) : r.value;
      const meta = indexEntryFor(sweepJson, dateKey, sweepJson?._recoveredFileName || null);
      recovered.push(meta);
    } catch (e) {
      console.warn(`Could not recover orphan sweep ${key}:`, e);
    }
  }
  // Persist the healed index so next read is fast
  try {
    return await _writeStoredIndex(recovered);
  } catch {
    return recovered.sort((a, b) => (a.date < b.date ? 1 : -1));
  }
}

// Public: persist a sweep. Serialised via the write queue to avoid index
// races when multiple uploads land in quick succession.
async function writeSweep(sweep, fileName) {
  const dateKey = dateKeyFromSweep(sweep);
  const meta = indexEntryFor(sweep, dateKey, fileName);
  return _queueWrite(async () => {
    // Write the sweep blob first
    try {
      await _store().set(`sweep:${dateKey}`, JSON.stringify(sweep));
    } catch (e) {
      throw new Error(`Could not save sweep for ${dateKey}: ${e?.message || e}`);
    }
    // Read-modify-write the index (now safe because we're queued)
    const idx = await _readStoredIndex();
    const filtered = idx.filter(x => x.date !== dateKey);
    filtered.push(meta);
    const updated = await _writeStoredIndex(filtered);
    return { dateKey, index: updated, meta };
  });
}

async function readSweep(dateKey) {
  try {
    const res = await _store().get(`sweep:${dateKey}`);
    if (!res || !res.value) return null;
    return typeof res.value === "string" ? JSON.parse(res.value) : res.value;
  } catch (e) {
    console.warn(`Sweep read failed for ${dateKey}:`, e);
    return null;
  }
}

async function deleteSweep(dateKey) {
  return _queueWrite(async () => {
    try {
      await _store().delete(`sweep:${dateKey}`);
    } catch (e) {
      console.warn(`Sweep delete failed for ${dateKey}:`, e);
    }
    const idx = await _readStoredIndex();
    return _writeStoredIndex(idx.filter(x => x.date !== dateKey));
  });
}

// Diagnostics — used by the Archive panel's status banner. Reads the
// substrate state plus a live count of stored sweep keys.
async function storageDiagnostics() {
  let liveKeys = [];
  try {
    const res = await _store().list("sweep:");
    liveKeys = Array.isArray(res?.keys) ? res.keys : [];
  } catch (e) {
    // ignore
  }
  return {
    substrate: _storageState.substrate,
    canaryError: _storageState.canaryError,
    verifiedAt: _storageState.verifiedAt,
    storedSweepCount: liveKeys.length,
    storedSweepKeys: liveKeys,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FONT LOADER
// ─────────────────────────────────────────────────────────────────────────────
function FontLoader() {
  useEffect(() => {
    if (document.getElementById("attacked-fonts")) return;
    const link = document.createElement("link");
    link.id = "attacked-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";
    document.head.appendChild(link);
  }, []);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// WORLD MAP DATA — BUNDLED countries GeoJSON (no runtime CDN; always renders).
// Computed once at module load from the bundled world-atlas TopoJSON.
// ─────────────────────────────────────────────────────────────────────────────
const WORLD_FEATURES = (() => {
  try {
    return topoFeature(worldCountries110m, worldCountries110m.objects.countries);
  } catch (e) {
    console.warn("[Map] world atlas parse failed:", e?.message);
    return null;
  }
})();

function useWorldGeo() {
  // The data is bundled, so it's available synchronously on first render.
  return { world: WORLD_FEATURES, err: WORLD_FEATURES ? null : "world atlas unavailable" };
}

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP JSON PARSER — flattens results{} into a list of enriched incidents
// ─────────────────────────────────────────────────────────────────────────────
function parseSweep(sweep) {
  if (!sweep || typeof sweep !== "object") return { incidents: [], meta: {} };
  const incidents = [];
  const results = sweep.results || {};
  for (const [catCode, payload] of Object.entries(results)) {
    const incs = payload?.incidents || [];
    incs.forEach((inc, idx) => {
      if (typeof inc.latitude !== "number" || typeof inc.longitude !== "number") return;
      // _id must be unique across ALL incidents fed to the map, not just
      // within one category. For a single-day sweep `${catCode}-${idx}` is
      // sufficient. For a MERGED multi-day sweep (Week/Month/All views),
      // incidents from different source dates can collide on catCode+idx,
      // which would break pin selection and the cascade. mergeSweeps()
      // stamps each merged incident with `_sourceDate`; when present we
      // prefix the id with it so it is globally unique. Single-day sweeps
      // have no _sourceDate and keep the original id shape (no regression).
      const id = inc._sourceDate
        ? `${inc._sourceDate}-${catCode}-${idx}`
        : `${catCode}-${idx}`;
      incidents.push({
        ...inc,
        _cat: catCode,
        _idx: idx,
        _id: id,
      });
    });
  }
  // Severity scale guard. The app's SEVERITY scale is 1-5, but some sweep
  // sources score incidents 1-10. If ANY value exceeds 5 we treat the whole
  // sweep as 1-10 and fold it into 1-5 with ceil(sev/2) — which reproduces the
  // normalized `incidents` table exactly (e.g. a sweep-5 → 3). Without this,
  // 6-10 incidents fell off the 1-5 scale: mis-coloured dots AND dropped from
  // the fleet list. Sweeps already on the 1-5 scale are left untouched.
  const maxSev = incidents.reduce((m, i) => Math.max(m, Number(i.severity) || 0), 0);
  if (maxSev > 5) {
    for (const i of incidents) {
      const s = Number(i.severity) || 2;
      i.severity = Math.max(1, Math.min(5, Math.ceil(s / 2)));
    }
  }
  const meta = {
    generated_at: sweep.generated_at,
    lookback_hours: sweep.lookback_hours,
    model: sweep.model,
    schema_version: sweep.schema_version,
    total_incidents: incidents.length,
    newsroom: sweep.newsroom || DEFAULT_REPORTERS,
  };
  return { incidents, meta };
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGED FORMAT NORMALIZER — converts vendor_intel_merged_CLEANED shape
// (results keyed by incident-slug, each entry wrapping {incident, vendor_intelligence,
// blast_radius, sources, ...}) into the standard sweep shape parseSweep expects
// (results keyed by category code, each containing incidents[]). The rich
// vendor_intelligence object is attached to each incident as inc.vendor_intelligence,
// blast_radius/sources/headline are flattened in, and contextual_vendors becomes
// the standard vendors[] chip list.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeMergedSweep(merged) {
  if (!merged || typeof merged !== "object") return merged;
  const entries = merged.results && typeof merged.results === "object" ? merged.results : {};
  // Detect merged shape: values have an `incident` sub-object (vs. regular
  // sweep where values have an `incidents` array). Fall through unchanged if
  // already in standard shape.
  const sample = Object.values(entries)[0];
  if (!sample || Array.isArray(sample.incidents) || !sample.incident) return merged;

  const results = {};
  for (const [, entry] of Object.entries(entries)) {
    const inner = entry.incident || {};
    const pc = inner.primary_classification || {};
    const cat = pc.category || "OPS";
    if (!results[cat]) results[cat] = { incidents: [] };
    // Flatten control_hierarchy into the field names the existing renderer
    // expects. Merged file keys (co_id/mc_id/ac_id) map to a single `id`.
    const ch = entry.control_hierarchy && typeof entry.control_hierarchy === "object" ? entry.control_hierarchy : {};
    const mapObj = src => Array.isArray(src) ? src.map(x => x && typeof x === "object"
      ? { ...x, id: x.id || x.co_id || x.mc_id || x.ac_id }
      : x).filter(Boolean) : [];
    const adaptive_objectives = mapObj(ch.control_objectives).length > 0 ? mapObj(ch.control_objectives)
      : (Array.isArray(inner.adaptive_objectives) ? inner.adaptive_objectives : []);
    const adaptive_master_controls = mapObj(ch.master_controls).length > 0 ? mapObj(ch.master_controls)
      : (Array.isArray(inner.adaptive_master_controls) ? inner.adaptive_master_controls : []);
    const adaptive_controls = mapObj(ch.adaptive_controls).length > 0 ? mapObj(ch.adaptive_controls)
      : (Array.isArray(inner.adaptive_controls) ? inner.adaptive_controls : []);
    const merged_incident = {
      ...inner,
      headline: entry.headline || inner.headline || "",
      primary_category: cat,
      primary_subcategory_code: pc.subcategory_code || inner.primary_subcategory_code,
      primary_subcategory_name: pc.subcategory_name || inner.primary_subcategory_name,
      vendors: Array.isArray(inner.contextual_vendors) ? inner.contextual_vendors
              : (Array.isArray(inner.vendors) ? inner.vendors : []),
      vendor_intelligence: entry.vendor_intelligence || null,
      blast_radius: inner.blast_radius || entry.blast_radius || {},
      sources: inner.sources || entry.sources || [],
      adaptive_objectives,
      adaptive_master_controls,
      adaptive_controls,
      _enriched: true,
    };
    results[cat].incidents.push(merged_incident);
  }
  return {
    generated_at: merged.generated_at,
    schema_version: merged.merge_version || "merged-normalized",
    newsroom: merged.newsroom || null,
    results,
    _sourceFile: merged.source_sweep || null,
  };
}

// Load all sweeps baked into /public/sweeps/ on app boot. The index.json
// lists each entry as { date, file, format }; format is "sweep" (regular)
// or "merged" (vendor-intel merged shape, run through normalizeMergedSweep).
// Each loaded sweep is pushed into the archive via writeSweep() so the
// existing date-picker UI lists them. Silently skips on fetch failure so
// a missing index.json doesn't break local file-drop usage.
async function loadBakedSweeps() {
  if (typeof window === "undefined" || typeof fetch !== "function") return [];
  const base = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL) || "/";
  const indexUrl = `${base}sweeps/index.json`;
  let manifest;
  try {
    const res = await fetch(indexUrl, { cache: "no-cache" });
    if (!res.ok) return [];
    manifest = await res.json();
  } catch {
    return [];
  }
  const list = Array.isArray(manifest?.sweeps) ? manifest.sweeps : [];
  const loaded = [];
  for (const entry of list) {
    if (!entry || !entry.file) continue;
    try {
      const res = await fetch(`${base}sweeps/${entry.file}`, { cache: "force-cache" });
      if (!res.ok) continue;
      const raw = await res.json();
      const sweep = entry.format === "merged" ? normalizeMergedSweep(raw) : raw;
      // Stamp the date if the JSON doesn't carry generated_at (so writeSweep keys it right)
      if (!sweep.generated_at && entry.date) sweep.generated_at = `${entry.date}T00:00:00.000Z`;
      await writeSweep(sweep, entry.file);
      loaded.push(entry.date);
    } catch (e) {
      console.warn(`Baked sweep ${entry.file} skipped:`, e?.message || e);
    }
  }
  return loaded;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE READER — fetches sweeps from the live backend so the map always
// reflects whatever the analyst has pushed (no redeploy needed).
//
// Two source tables, both carry the FULL sweep in `raw_json` jsonb:
//   • public.sweeps     — regular daily GUARD sweeps
//   • public.vi_sweeps  — merged vendor-intelligence format (rich vendor cards)
//
// Dedupe rules:
//   • One sweep per calendar date wins.
//   • vi_sweeps beats sweeps on the same date (richer vendor data).
//   • Within a table, newest generated_at wins.
//
// Env vars (Vite-style):
//   VITE_SUPABASE_URL       — https://<project>.supabase.co
//   VITE_SUPABASE_ANON_KEY  — publishable / anon key
//
// Silent fallback: if env / fetch fails, we just keep whatever baked-in data
// was already loaded. Console warns either way.
// PostgREST in Supabase enforces a server-side max_rows cap (default 1000)
// that overrides client `&limit=N`. Tables like blast_radius (3000+ rows) get
// silently truncated. To bypass this we paginate via the `Range` header,
// fetching 1000 rows at a time until the server returns fewer than asked.
// Hard safety cap at 20 pages (20 000 rows) per table.
// The signed-in reader's access token. PostgREST then applies THEIR row policies:
// after Phase 2 (migration 20260922_subscriber_layer_lock.sql) the subscriber
// layer is subscriber-only, and a subscriber on the map still gets the rows.
// Signed out, the anon key is used as before. Set from the map component.
let _readerToken = null;
export function setReaderToken(t) { _readerToken = t || null; }

async function _fetchSupabaseTable(url, key, table, query = "") {
  const PAGE = 1000;
  const sep = query ? "&" : "";
  const base = `${url.replace(/\/$/, "")}/rest/v1/${table}?${query}${sep}`;
  const all = [];
  for (let page = 0; page < 20; page++) {
    const from = page * PAGE;
    const to = from + PAGE - 1;
    try {
      const res = await fetch(base, {
        cache: "no-store",
        headers: {
          apikey: key,
          Authorization: `Bearer ${_readerToken || key}`,
          Range: `${from}-${to}`,
          "Range-Unit": "items",
        },
      });
      if (!res.ok && res.status !== 206) {
        console.warn(`Supabase ${table} fetch failed: ${res.status} ${res.statusText}`);
        return all;
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < PAGE) break;
    } catch (e) {
      console.warn(`Supabase ${table} fetch error:`, e?.message || e);
      break;
    }
  }
  return all;
}

// Reshape a flat incidents row + its embedded child arrays into the nested
// shape that parseSweep expects. The DB stores blast_radius as flat rows
// keyed by `bucket`; we group those into the {internal:[], supply_chain:[], …}
// object the renderer reads. Adaptive control tables store objective_id /
// control_id; we alias those to plain `id` for the renderer.
function _reshapeIncident(row) {
  const inc = { ...row };

  // blast_radius rows → grouped object
  const brByBucket = {};
  for (const br of row.blast_radius || []) {
    const b = br.exposure_group || "internal";
    if (!brByBucket[b]) brByBucket[b] = [];
    brByBucket[b].push(br);
  }
  inc.blast_radius = brByBucket;

  // adaptive_objectives — surface the SEMANTIC code (e.g. "CO-DAT-001")
  // not the auto-increment DB primary key. objective_id wins; id is a
  // last-ditch fallback only when no semantic code exists.
  inc.adaptive_objectives = (row.adaptive_objectives || []).map(o => ({
    ...o, id: o.objective_id || o.id,
  }));
  // adaptive_master_controls — surface control_id (e.g. "CO-MC-001") as id
  inc.adaptive_master_controls = (row.adaptive_master_controls || []).map(c => ({
    ...c, id: c.control_id || c.id,
  }));
  // adaptive_controls — PREFER the real adapted controls (AC-*) from the
  // adaptive_controls table: incident-specific, executable, with real semantic
  // ids + rationale + provenance back to the parent master control.
  // The legacy incidents.adaptive_controls_codes fallback went with the column
  // on 2026-08-03. It held a mix of MC-* codes and raw sentences — zero AC-*
  // codes — and synthesising ids from it is what put master-control ids on the
  // Adaptive Controls card. The adaptive_controls table is now the only source,
  // with provenance preserved via parent_mc_id.
  inc.adaptive_controls = (row.adaptive_controls_rows || []).map(c => ({
    id: c.control_id || c.id,
    statement: c.statement,
    rationale: c.rationale,
    parent_mc_id: c.parent_mc_id,
    layer: c.layer,
    control_kind: c.kind,   // 'direct' | 'indirect' — from the parent MC's framework capability
  }));

  // vendors, sources, peer_watchlist, historical_analogues, best_practices,
  // secondary_mappings are already shaped correctly by the embed.
  return inc;
}

// Same idea for vi_incidents but with the vendor-intelligence extras built
// from vi_vendors (grouped by vendor_group) and vi_*_controls tables.
function _reshapeViIncident(row) {
  const inc = { ...row };

  // vi_blast_radius rows → grouped object
  const brByBucket = {};
  for (const br of row.vi_blast_radius || []) {
    const b = br.exposure_group || "internal";
    if (!brByBucket[b]) brByBucket[b] = [];
    brByBucket[b].push(br);
  }
  inc.blast_radius = brByBucket;

  // Adaptive control hierarchy from vi_* tables
  inc.adaptive_objectives = (row.vi_control_objectives || []).map(o => ({
    id: o.co_id, statement: o.statement,
  }));
  inc.adaptive_master_controls = (row.vi_master_controls || []).map(c => ({
    id: c.mc_id, statement: c.statement, vendors_covering: c.vendors_covering,
  }));
  inc.adaptive_controls = (row.vi_adaptive_controls || []).map(a => ({
    id: a.ac_id, statement: a.statement, rationale: a.rationale, parent_mc_id: a.parent_mc_id,
  }));

  // Simple lists from embeds
  inc.sources = row.vi_sources || [];
  inc.peer_watchlist = row.vi_peer_watchlist || [];
  inc.historical_analogues = row.vi_historical_analogues || [];
  inc.best_practices = row.vi_best_practices || [];
  inc.secondary_mappings = row.vi_secondary_mappings || [];
  inc.vendors = row.vi_contextual_vendors || [];

  // vendor_intelligence — group vi_vendors by vendor_group
  const vendorsBy = { risk_coverage_vendors: [], incident_handler_vendors: [] };
  for (const v of row.vi_vendors || []) {
    const g = v.vendor_group;
    if (g === "risk_coverage") vendorsBy.risk_coverage_vendors.push(v);
    else if (g === "incident_handler") vendorsBy.incident_handler_vendors.push(v);
  }
  // vi_editorial_picks + vi_sponsored_slots store the company name in
  // `vendor_name` (not `name`). The render layer (VendorRichCard) only
  // looks at `name`, which produced "Unnamed vendor" cards in the public
  // teaser. Alias the field here so every consumer sees a uniform shape.
  const aliasName = (rows) => (rows || []).map(r => ({
    ...r,
    name: r.name || r.vendor_name || null,
  }));
  inc.vendor_intelligence = {
    ...vendorsBy,
    sponsored_slots: aliasName(row.vi_sponsored_slots),
    editorial_picks: aliasName(row.vi_editorial_picks),
    dropped_vendors: row.vi_dropped_vendors || [],
  };

  // Pull headline up from the row (vi_incidents has it on the parent row)
  inc.headline = row.headline || inc.headline || "";
  inc._enriched = true;
  return inc;
}

async function loadFromSupabase() {
  if (typeof window === "undefined" || typeof fetch !== "function") return [];
  const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.info("Supabase env not configured — using baked-in data only.");
    return [];
  }

  // Split into parallel light queries — one per table — instead of a single
  // mega-embed (which was 16 MB / 20 s on the wire). Each query selects only
  // the columns the renderer actually uses; debug/internal columns like
  // pass3_response_head, velocity_*, etc. are excluded. Children are stitched
  // onto their parent incident client-side via incident_id lookup maps.
  const q = "limit=10000";
  const incidentCols = [
    "id", "headline", "summary", "entity", "sector", "industry",
    "location_name", "country",
    "latitude", "longitude", "event_date", "disclosure_date", "incident_day",
    "primary_category", "primary_subcategory_code", "primary_subcategory_name",
    "image_url", // the stored picture (incident-images function), 2026-09-23
    // PostgREST rejects the WHOLE select when any single column is unknown, so
    // a single stale name here takes down the only query that loads live
    // incidents, and every visitor silently falls back to the sweep files
    // baked into public/sweeps/ (which stop at 2026-05-28). That is exactly
    // how the "map isn't populating day by day" outage happened, via
    // `confidence` being named after it was dropped from the view. It has
    // since been restored to public.incidents from the sweep.incidents base
    // table. Never add a column here without first confirming it exists.
    "severity", "severity_rationale", "confidence",
  ].join(",");
  const viIncidentCols = [
    "id", "vi_sweep_id",
    "headline", "summary", "entity", "sector", "industry",
    "location_name", "country",
    "latitude", "longitude", "event_date", "disclosure_date",
    "primary_category", "primary_subcategory_code", "primary_subcategory_name",
    "severity", "severity_rationale", "confidence", 
    "category", ].join(",");
  // ────────────────────────────────────────────────────────────────────
  // Initial load fetches ONLY what the map itself draws: the incident pins
  // and the newsroom. Measured 2026-08-01, the old version pulled 28 relations
  // and ~17-26 MB per page load, which is what exhausted the Supabase egress
  // allowance (5 GB ≈ 300 visits/month).
  //
  // Two problems were fixed here:
  //   1. Eighteen of those fetches — every vi_* relation and
  //      adaptive_master_controls — no longer exist in the database. They
  //      returned errors on every load and were silently swallowed by
  //      _fetchSupabaseTable, so they cost round-trips and delivered nothing.
  //   2. The per-incident child tables were pulled in full for all 1,099
  //      incidents, but are only ever read by the detail panel for the ONE
  //      incident a visitor opens. They are now lazily fetched on selection
  //      (see the child-hydration effect near the selectedIncident memo),
  //      exactly as blast_radius already was.
  // ────────────────────────────────────────────────────────────────────
  const [regularRows, reporterRows] = await Promise.all([
    _fetchSupabaseTable(url, key, "incidents",
      `select=${incidentCols}&incident_day=not.is.null&latitude=not.is.null&longitude=not.is.null&order=incident_day.desc&${q}`),
    _fetchSupabaseTable(url, key, "reporters", "select=slug,name,desk,cats,color&limit=200"),
  ]);
  // vi_* incidents were dropped from the database on 2026-07-28; keep the
  // downstream code paths alive with an empty set rather than 13 dead fetches.
  const viRows = [];

  // vi_sweeps was dropped with the rest of the vi_* layer on 2026-07-28.
  const viSweepDayById = new Map();

  // Every incident starts with empty child arrays. They are filled in one
  // incident at a time by the child-hydration effect when a visitor opens
  // that incident — see CHILD_RELATIONS further down. Keeping the keys
  // present (rather than undefined) means every downstream `Array.isArray`
  // and `?.length` check behaves exactly as it did before.
  for (const row of regularRows) {
    row.blast_radius = [];
    row.vendors = [];
    row.sources = [];
    row.adaptive_objectives = [];
    row.adaptive_master_controls = [];
    row.adaptive_controls_rows = [];
    row.peer_watchlist = [];
    row.historical_analogues = [];
    row.best_practices = [];
    row.secondary_mappings = [];
    row._childrenLoaded = false;
  }

  // Build the newsroom map (slug → record) the renderer expects.
  let newsroom = null;
  if (reporterRows.length > 0) {
    newsroom = {};
    for (const r of reporterRows) {
      if (r && r.slug) newsroom[r.slug] = {
        name: r.name, desk: r.desk, cats: r.cats || [], color: r.color,
      };
    }
  }

  // Reshape and group regular incidents by `incident_day`.
  const byDay = new Map();
  for (const row of regularRows) {
    const lat = typeof row.latitude === "string" ? parseFloat(row.latitude) : row.latitude;
    const lng = typeof row.longitude === "string" ? parseFloat(row.longitude) : row.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const day = (row.incident_day || row.event_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const inc = _reshapeIncident({ ...row, latitude: lat, longitude: lng });
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(inc);
  }

  // vi_incidents bucket under their parent vi_sweep's generated date — all
  // 10 incidents from a single merged sweep land on the same calendar day
  // (e.g. 2026-05-23), not scattered across each incident's event_date.
  // Fallback to event_date if the parent sweep is somehow missing.
  for (const row of viRows) {
    const lat = typeof row.latitude === "string" ? parseFloat(row.latitude) : row.latitude;
    const lng = typeof row.longitude === "string" ? parseFloat(row.longitude) : row.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const sweepDay = viSweepDayById.get(row.vi_sweep_id);
    const day = sweepDay || (row.event_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const inc = _reshapeViIncident({ ...row, latitude: lat, longitude: lng });
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(inc);
  }

  // Build a synthetic sweep per day and write to the archive. We ALSO keep the
  // built sweeps in memory and return them, so the boot can render the newest
  // day directly even if the storage round-trip (writeSweep/readSweep) fails —
  // guaranteeing the map opens populated instead of the empty upload screen.
  const loaded = [];
  const sweepsByDay = new Map();
  for (const [day, incidents] of byDay) {
    const results = {};
    for (const inc of incidents) {
      const cat = inc.primary_category || "OPS";
      if (!results[cat]) results[cat] = { incidents: [] };
      results[cat].incidents.push(inc);
    }
    const sweep = {
      generated_at: `${day}T00:00:00.000Z`,
      schema_version: "daily-aggregated",
      newsroom: newsroom || undefined,
      results,
    };
    sweepsByDay.set(day, sweep);
    try {
      await writeSweep(sweep, `daily_${day}.json`);
      loaded.push(day);
    } catch (e) {
      console.warn(`Day ${day} skipped:`, e?.message || e);
    }
  }
  return { loaded, sweepsByDay };
}

// ─────────────────────────────────────────────────────────────────────────────
// FAST FIRST PAINT — a light, incidents-only fetch so the map renders the newest
// day's dots in ~1–2s, instead of blocking on the full multi-table enrichment
// (blast_radius, vendors, controls, …) which can take 30s+. Returns the newest
// day's synthetic sweep, or null. The full loadFromSupabase still runs after to
// enrich detail panels + populate the archive.
// ─────────────────────────────────────────────────────────────────────────────
// Deep-link first paint: ONE day, straight from the DB. ?date= names the day;
// a bare ?incident=<id> resolves it with a one-row lookup first. A single day
// is a few hundred rows at most, so the linked incident is on screen in about
// a second while the full light load (every day, ~10k rows) runs behind it.
async function loadOneDayFast(day, incidentId) {
  if (typeof window === "undefined" || typeof fetch !== "function") return null;
  const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
  const url = env.VITE_SUPABASE_URL, key = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  let d = day;
  if (!d && incidentId != null) {
    const rows = await _fetchSupabaseTable(url, key, "incidents", `select=incident_day&id=eq.${encodeURIComponent(String(incidentId))}&limit=1`);
    d = rows[0] && rows[0].incident_day ? String(rows[0].incident_day).slice(0, 10) : null;
  }
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const cols = "id,headline,summary,entity,sector,industry,location_name,country,latitude,longitude,event_date,disclosure_date,incident_day,primary_category,primary_subcategory_code,primary_subcategory_name,severity,severity_rationale,confidence,image_url";
  const [reg, reporters] = await Promise.all([
    _fetchSupabaseTable(url, key, "incidents", `select=${cols}&incident_day=eq.${d}&latitude=not.is.null&longitude=not.is.null&limit=2000`),
    _fetchSupabaseTable(url, key, "reporters", "select=slug,name,desk,cats,color&limit=200"),
  ]);
  let newsroom = null;
  if (reporters.length) { newsroom = {}; for (const r of reporters) if (r && r.slug) newsroom[r.slug] = { name: r.name, desk: r.desk, cats: r.cats || [], color: r.color }; }
  const results = {};
  for (const row of reg) {
    const lat = typeof row.latitude === "string" ? parseFloat(row.latitude) : row.latitude;
    const lng = typeof row.longitude === "string" ? parseFloat(row.longitude) : row.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const inc = _reshapeIncident({ ...row, latitude: lat, longitude: lng });
    const cat = inc.primary_category || "OPS";
    if (!results[cat]) results[cat] = { incidents: [] };
    results[cat].incidents.push(inc);
  }
  if (!Object.keys(results).length) return null;
  return { day: d, sweep: { generated_at: `${d}T00:00:00.000Z`, schema_version: "daily-aggregated", newsroom: newsroom || undefined, results } };
}

// preferDay / incidentId: a deep link (?date= / ?incident=) pins the first
// paint to that day instead of the newest one (loadOneDayFast has usually
// painted it already; this pass adds every other day for liveDaysRef).
async function loadIncidentsFast(preferDay = null, incidentId = null) {
  if (typeof window === "undefined" || typeof fetch !== "function") return null;
  const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
  const url = env.VITE_SUPABASE_URL, key = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  // Keep this list in lockstep with incidentCols in loadFromSupabase — a name
  // that is not on public.incidents 400s this fast-paint query and drops the
  // first render back to the baked May sweeps. See the note there.
  const cols = "id,headline,summary,entity,sector,industry,location_name,country,latitude,longitude,event_date,disclosure_date,incident_day,primary_category,primary_subcategory_code,primary_subcategory_name,severity,severity_rationale,confidence,image_url";
  try {
    // vi_incidents / vi_sweeps were dropped on 2026-07-28. They 404'd on every
    // single page load; keep the downstream shape with empty arrays instead.
    const [reg, reporters] = await Promise.all([
      _fetchSupabaseTable(url, key, "incidents", `select=${cols}&incident_day=not.is.null&latitude=not.is.null&longitude=not.is.null&order=incident_day.desc&limit=10000`),
      _fetchSupabaseTable(url, key, "reporters", "select=slug,name,desk,cats,color&limit=200"),
    ]);
    const vi = [], sweeps = [];
    let newsroom = null;
    if (reporters.length) {
      newsroom = {};
      for (const r of reporters) if (r && r.slug) newsroom[r.slug] = { name: r.name, desk: r.desk, cats: r.cats || [], color: r.color };
    }
    const viDay = new Map();
    for (const s of sweeps) if (s && s.id && typeof s.generated_at === "string") viDay.set(s.id, s.generated_at.slice(0, 10));
    const byDay = new Map();
    for (const row of reg) {
      const lat = typeof row.latitude === "string" ? parseFloat(row.latitude) : row.latitude;
      const lng = typeof row.longitude === "string" ? parseFloat(row.longitude) : row.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const day = (row.incident_day || row.event_date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const inc = _reshapeIncident({ ...row, latitude: lat, longitude: lng });
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(inc);
    }
    for (const row of vi) {
      const lat = typeof row.latitude === "string" ? parseFloat(row.latitude) : row.latitude;
      const lng = typeof row.longitude === "string" ? parseFloat(row.longitude) : row.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const day = viDay.get(row.vi_sweep_id) || (row.event_date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const inc = _reshapeViIncident({ ...row, latitude: lat, longitude: lng });
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(inc);
    }
    if (byDay.size === 0) return null;
    const days = [...byDay.keys()].sort();
    const newest = days[days.length - 1];
    const toSweep = (day) => {
      const results = {};
      for (const inc of byDay.get(day)) {
        const cat = inc.primary_category || "OPS";
        if (!results[cat]) results[cat] = { incidents: [] };
        results[cat].incidents.push(inc);
      }
      return { generated_at: `${day}T00:00:00.000Z`, schema_version: "daily-aggregated", newsroom: newsroom || undefined, results };
    };
    // Every day, light. Lets a ?incident= deep link resolve its day here and
    // gives the deep-link effect somewhere to switch to before the full boot.
    const sweepsByDay = new Map(days.map((d) => [d, toSweep(d)]));
    let pick = preferDay && byDay.has(preferDay) ? preferDay : null;
    if (!pick && incidentId != null) {
      const w = String(incidentId);
      for (const d of days) if (byDay.get(d).some((i) => i && i.id != null && String(i.id) === w)) { pick = d; break; }
    }
    if (!pick) pick = newest;
    return { day: pick, sweep: sweepsByDay.get(pick), sweepsByDay };
  } catch (e) {
    console.warn("Fast incident load failed:", e?.message || e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP MERGE LAYER — for the Day / Week / Month / All time-window views.
// ----------------------------------------------------------------------------
// Takes an array of { date, sweep } objects (each `sweep` being a full
// GUARD sweep JSON read from the existing archive) and merges them into ONE
// synthetic sweep object with the same shape parseSweep already understands:
//   { results: { CAT: { incidents:[] } }, newsroom, generated_at, ... }
// so the merged result feeds the existing setSweep → parseSweep path and the
// map / filters / cascade are untouched.
//
// Behaviour (confirmed design decisions):
//   • DEDUPE across days — one incident per unique identity. Identity key is
//     entity + headline + country, case-normalised. Same incident recurring
//     across days collapses to a single pin.
//   • Severity for a deduped pin = HIGHEST severity seen across the window.
//   • Each merged incident is stamped with:
//       _occurrences  — how many days it appeared in
//       _firstSeen    — earliest source date it appeared
//       _lastSeen     — latest source date it appeared
//       _sourceDate   — date of the kept representative (drives _id keying in
//                       parseSweep so merged ids are globally unique)
//   • The kept representative is the FIRST-SEEN occurrence's object, severity
//     bumped to the window max, stamps applied — so narrative fields are the
//     original sighting.
function mergeIdentity(inc) {
  const norm = v => (v == null ? "" : String(v)).trim().toLowerCase();
  return [norm(inc.entity), norm(inc.headline), norm(inc.country)].join("\u0001");
}

function mergeSweeps(inputs) {
  const valid = (Array.isArray(inputs) ? inputs : [])
    .filter(x => x && x.sweep && typeof x.sweep === "object")
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const dedupeMap = new Map();
  let newsroom = null;

  for (const { date, sweep } of valid) {
    if (!newsroom && sweep.newsroom) newsroom = sweep.newsroom;
    const results = sweep.results || {};
    for (const [catCode, payload] of Object.entries(results)) {
      const incs = (payload && payload.incidents) || [];
      for (const inc of incs) {
        const key = mergeIdentity(inc);
        const sev = (typeof inc.severity === "number") ? inc.severity : 0;
        const existing = dedupeMap.get(key);
        if (!existing) {
          dedupeMap.set(key, {
            rep: inc, cat: catCode,
            firstSeen: date, lastSeen: date,
            occurrences: 1, maxSev: sev,
          });
        } else {
          existing.occurrences += 1;
          if (date < existing.firstSeen) { existing.firstSeen = date; existing.rep = inc; existing.cat = catCode; }
          if (date > existing.lastSeen) existing.lastSeen = date;
          if (sev > existing.maxSev) existing.maxSev = sev;
        }
      }
    }
  }

  const mergedResults = {};
  for (const entry of dedupeMap.values()) {
    const cat = entry.cat || "UNK";
    if (!mergedResults[cat]) mergedResults[cat] = { incidents: [] };
    mergedResults[cat].incidents.push({
      ...entry.rep,
      severity: entry.maxSev > 0 ? entry.maxSev : entry.rep.severity,
      _occurrences: entry.occurrences,
      _firstSeen: entry.firstSeen,
      _lastSeen: entry.lastSeen,
      _sourceDate: entry.firstSeen,
    });
  }

  return {
    results: mergedResults,
    newsroom: newsroom || undefined,
    generated_at: valid.length ? valid[valid.length - 1].date : undefined,
    _merged: true,
    _windowDays: valid.length,
    _windowFrom: valid.length ? valid[0].date : null,
    _windowTo: valid.length ? valid[valid.length - 1].date : null,
  };
}

// Given the archive index (array of { date, ... } sorted desc) and an anchor
// date (the day currently centred on), return the subset of dates within the
// requested window. Windows are inclusive of the anchor and look BACKWARD:
//   "day"   → just the anchor; "week" → anchor + 6 prior (7-day span)
//   "month" → anchor + ~29 prior (30-day span); "all" → every archived date
// Only dates actually present in the index are returned.
function datesInWindow(archiveIndex, anchorDate, windowKind) {
  const allDates = (Array.isArray(archiveIndex) ? archiveIndex : [])
    .map(e => e && e.date).filter(Boolean);
  if (allDates.length === 0) return [];
  if (windowKind === "all") return [...allDates];

  const anchor = anchorDate || allDates[0]; // index is desc, [0] is newest
  if (windowKind === "day") {
    return allDates.includes(anchor) ? [anchor] : [];
  }

  const span = windowKind === "week" ? 7 : 30;
  const anchorMs = Date.parse(anchor + "T00:00:00Z");
  if (Number.isNaN(anchorMs)) {
    return allDates.includes(anchor) ? [anchor] : [];
  }
  const lowerMs = anchorMs - (span - 1) * 86400000;
  return allDates.filter(d => {
    const ms = Date.parse(d + "T00:00:00Z");
    return !Number.isNaN(ms) && ms <= anchorMs && ms >= lowerMs;
  });
}

// Pick reporter for a given category (matches scraper logic)
function reporterForCat(catCode, reporters) {
  for (const [id, r] of Object.entries(reporters || {})) {
    if (r.cats?.includes(catCode)) return { id, ...r };
  }
  return null;
}

// Search match: case-insensitive substring across headline, entity, country,
// summary, sector, cat code + label, and vendor names. Empty query = match all.
function searchMatches(inc, query) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const cat = CATEGORIES[inc._cat];
  const vendorBlob = (inc.vendors || [])
    .map(v => typeof v === "string" ? v : (v?.name || ""))
    .join(" ");
  const haystack = [
    inc.headline,
    inc.entity,
    inc.country,
    inc.location_name,
    inc.summary,
    inc.sector,
    inc._cat,
    cat?.label,
    vendorBlob,
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(q);
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE UPLOAD ZONE
// ─────────────────────────────────────────────────────────────────────────────
function UploadZone({ onLoad, onError }) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const json = JSON.parse(e.target.result);
        onLoad(json, file.name);
      } catch (err) {
        onError(`Invalid JSON: ${err.message}`);
      }
    };
    reader.onerror = () => onError(`Failed to read ${file.name}`);
    reader.readAsText(file);
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      }}
      onClick={() => fileInputRef.current?.click()}
      style={{
        width: "min(640px, 90vw)",
        margin: "0 auto",
        padding: "64px 48px",
        background: dragOver ? BRAND.goldTint : BRAND.obsidianCard,
        border: `2px dashed ${dragOver ? BRAND.gold : BRAND.borderSubtle}`,
        borderRadius: 0,
        textAlign: "center",
        cursor: "pointer",
        transition: "all 200ms cubic-bezier(0.4,0,0.2,1)",
      }}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={e => handleFile(e.target.files?.[0])}
      />
      <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 32, color: BRAND.white, marginBottom: 12 }}>
        Drop a daily intelligence file
      </div>
      <div style={{ fontFamily: "Inter, sans-serif", fontSize: 14, color: BRAND.textSecondary, marginBottom: 24 }}>
        or click to browse · accepts GUARD daily exports (JSON)
      </div>
      <div style={{ display: "inline-block", padding: "8px 20px", background: BRAND.gold, color: BRAND.obsidian, fontFamily: "Inter, sans-serif", fontSize: 13, fontWeight: 600, letterSpacing: "0.04em", borderRadius: 0 }}>
        SELECT FILE
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAP CANVAS — d3.geoNaturalEarth1 projection, country fills, pins, arcs
// ─────────────────────────────────────────────────────────────────────────────
// Ocean colour for the flat map. Blue Marble's own sea is near-black navy
// (mid-Pacific measures #070e28) which looked nothing like the bright sky blue
// of the ArcGIS imagery on the globe, so the sea is painted rather than taken
// from the texture. Tune here — this is the only place it is defined.
const OCEAN_BLUE = "#2C6E9B";

function MapCanvas({ world, visibleIncidents, viewMode, hoveredId, selectedId, onHover, onSelect, showBlastRadius, showHeat, showLabels }) {
  const containerRef = useRef(null);
  const [dims, setDims] = useState({ width: 1200, height: 720 });

  // Resize observer — height fills the available vertical space, with a
  // floor of 480px so the map is never claustrophobic on small windows.
  // Falls back to viewport-derived height so on a tall window the map uses
  // the room available rather than clamping to a fixed aspect ratio.
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        const w = e.contentRect.width;
        // Use the parent's actual height when it has one (the parent flex
        // cell stretches with the viewport). If the parent is shorter than
        // ideal aspect, fall back to a calculated height.
        const parentH = e.contentRect.height;
        // Prefer the parent height when available; only fall back to a
        // computed height (via window.innerHeight) when ResizeObserver
        // returns zero, which happens on first paint before layout.
        const fallbackH = (typeof window !== "undefined")
          ? Math.max(480, window.innerHeight - 280)
          : 600;
        // Take the parent's real height. The old Math.max(480, …) floor meant
        // that in a stage shorter than 480px the SVG was taller than the box
        // containing it, so the map overflowed and had to be scrolled — the
        // opposite of "the whole world in one frame". The projection already
        // scales to fit whatever height it is given, so no floor is needed.
        const h = parentH > 100 ? parentH : fallbackH;
        setDims({ width: w, height: h });
      }
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const projection = useMemo(() => {
    // Equirectangular (plate carrée), NOT Natural Earth. Natural Earth is the
    // rounded/oval world map with curved edges — pretty, but it can never fill
    // a rectangular frame, so there is always dead space at the corners and
    // the map reads as a graphic rather than an operational world map.
    //
    // Equirectangular is a true rectangle with an exact 2:1 ratio: longitude
    // maps to x linearly and latitude to y linearly. Because d3 spans
    // 2π·scale horizontally and π·scale vertically, taking the smaller of
    // w/2π and h/π guarantees the WHOLE world fits inside the canvas on any
    // aspect ratio — one frame, always, with no cropping and no scrolling.
    // The trade is area distortion near the poles (Greenland looks huge),
    // which does not matter for plotting incident positions.
    const scale = Math.min(dims.width / (2 * Math.PI), dims.height / Math.PI);
    return d3.geoEquirectangular()
      .scale(scale)
      .translate([dims.width / 2, dims.height / 2]);
  }, [dims]);

  const pathGen = useMemo(() => d3.geoPath(projection), [projection]);

  // Exact on-screen rectangle the whole world occupies, read back out of the
  // projection itself rather than recomputed from scale — so the satellite
  // texture can never drift out of register with the vector borders drawn on
  // top of it. Equirectangular is what makes this trivial: a standard 2:1
  // plate-carrée Earth image maps corner-to-corner onto this rect with no
  // resampling, which is not true of Natural Earth or any oval projection.
  const worldRect = useMemo(() => {
    const tl = projection([-180, 90]);
    const br = projection([180, -90]);
    if (!tl || !br) return null;
    return { x: tl[0], y: tl[1], w: br[0] - tl[0], h: br[1] - tl[1] };
  }, [projection]);

  // Project a [lng, lat] → [x, y] safely
  function project(lng, lat) {
    if (typeof lng !== "number" || typeof lat !== "number") return null;
    const p = projection([lng, lat]);
    if (!p || isNaN(p[0]) || isNaN(p[1])) return null;
    return p;
  }

  // ───────────────────────────────────────────────────────────────────────
  // PAN / ZOOM (v3 — intelligence-grade, d3-zoom driven)
  // Every incident is plotted at its exact lat/lng. No clustering. As the
  // user zooms in, dense city stacks naturally separate. When two pins share
  // EXACTLY the same coordinates (e.g. AWS Washington DC × 2), spiderfy:
  // fan them on a small ring so each is individually clickable at any zoom.
  // ───────────────────────────────────────────────────────────────────────
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 20;
  const svgRef = useRef(null);
  const zoomBehaviorRef = useRef(null);
  const [zoomTransform, setZoomTransform] = useState({ k: 1, x: 0, y: 0 });
  const k = zoomTransform.k; // shorthand — used heavily for counter-scaling
  // Hovered blast-radius destination entity (separate from hovered incident pin)
  const [hoveredEntity, setHoveredEntity] = useState(null);

  // Belt-and-braces: blast arcs only render when a pin is hovered or
  // selected. If both are null, the destination dots are unmounted and any
  // lingering hoveredEntity is stale — clear it. Fixes the "tooltip pinned
  // on load" bug where mouse movement through the artifact-panel edge
  // unmounts the dot before its onMouseLeave can fire.
  useEffect(() => {
    if (!hoveredId && !selectedId) setHoveredEntity(null);
  }, [hoveredId, selectedId]);

  // Attach d3-zoom once. We listen for zoom events and mirror the transform
  // into React state so the SVG can be re-rendered with the right transform
  // attribute. The actual DOM transform is applied by React, not by d3 — this
  // keeps d3 as the gesture handler and React as the renderer.
  useEffect(() => {
    if (!svgRef.current) return;
    const sel = d3.select(svgRef.current);
    const zoom = d3.zoom()
      .scaleExtent([ZOOM_MIN, ZOOM_MAX])
      // Tuned wheel sensitivity — d3's default is calibrated for legacy
      // mice and feels sluggish on trackpads/modern wheels. ×3 gives a much
      // snappier "one notch = noticeable zoom" feel without becoming jumpy.
      .wheelDelta(event => -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * 3)
      .filter(event => {
        // Allow wheel, drag, double-click; ignore right-click drag
        if (event.type === "mousedown" && event.button !== 0) return false;
        return !event.ctrlKey;
      })
      .on("zoom", event => {
        setZoomTransform({ k: event.transform.k, x: event.transform.x, y: event.transform.y });
      });
    zoomBehaviorRef.current = zoom;
    sel.call(zoom);
    // Double-click zooms in by a clean 2× (default d3 behaviour kept)
    return () => { sel.on(".zoom", null); };
  }, []);

  // Keep the zoom's translateExtent synced with current canvas size, so the
  // user can't pan the map off into empty space. The extent is generous (one
  // full canvas of slack in each direction) so panning still feels free.
  useEffect(() => {
    if (!zoomBehaviorRef.current) return;
    // Pinned to exactly the canvas, NOT the old one-canvas-of-slack in every
    // direction. That slack meant that at 1× the world could still be dragged
    // half a screen off-frame in any direction — the "it scrolls left and
    // right" complaint. With the extent equal to the canvas, 1× has exactly
    // one legal transform (the fully-framed world) so it cannot be panned at
    // all, while zooming in still pans freely within the map's own bounds.
    zoomBehaviorRef.current.translateExtent([
      [0, 0],
      [dims.width, dims.height],
    ]);
  }, [dims]);

  // Reset zoom when the visible set changes substantially (e.g. new file).
  // Filter changes shouldn't reset zoom — the user might have zoomed into a
  // region and then applied a filter to narrow what they see there.
  // We use the SVG dimensions as the trigger: if they change, world re-layout.
  // (Manual zoom controls reset zoom explicitly via resetZoom.)
  function programmaticZoom(scale, cx, cy) {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    const sel = d3.select(svgRef.current);
    const t = d3.zoomIdentity.translate(cx - cx * scale, cy - cy * scale).scale(scale);
    sel.transition().duration(280).call(zoomBehaviorRef.current.transform, t);
  }
  function zoomBy(factor) {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    const sel = d3.select(svgRef.current);
    sel.transition().duration(220).call(zoomBehaviorRef.current.scaleBy, factor);
  }
  function resetZoom() {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    const sel = d3.select(svgRef.current);
    sel.transition().duration(280).call(zoomBehaviorRef.current.transform, d3.zoomIdentity);
  }

  // Hold-to-zoom: while the user holds the +/- button, fire zoomBy on an
  // interval so the map continues to zoom smoothly until they release.
  // Works for mouse, touch, and stylus via pointer events.
  const holdTimerRef = useRef(null);
  function startHoldZoom(factor) {
    // Fire one immediate step so the first press always does something
    zoomBy(factor);
    // Clear any existing timer (defensive — pointerup may have been missed)
    if (holdTimerRef.current) clearInterval(holdTimerRef.current);
    // Smaller factor per tick (the button's full factor is ~1.8×; here we
    // step ~1.18× every 150ms which feels like continuous zoom)
    const tickFactor = factor > 1 ? 1.18 : 1 / 1.18;
    holdTimerRef.current = setInterval(() => {
      zoomBy(tickFactor);
    }, 150);
  }
  function stopHoldZoom() {
    if (holdTimerRef.current) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }
  // Guarantee cleanup if the component unmounts mid-hold
  useEffect(() => () => stopHoldZoom(), []);

  // Shift+click anywhere on the map → zoom OUT centered on that point.
  // Mirrors d3-zoom's built-in double-click-to-zoom-in. The transform math:
  // we want the clicked point in world space to stay at the same screen
  // position after the zoom-out by factor 0.6.
  function zoomOutAtPoint(e) {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    if (!e.shiftKey) return;
    // Only respond to clicks on empty SVG/rect surfaces — pin clicks call
    // stopPropagation() so they never reach us
    const tag = e.target.tagName;
    if (tag !== "svg" && tag !== "rect" && tag !== "path") return;
    const sel = d3.select(svgRef.current);
    const rect = svgRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = 0.6;
    // d3.zoomTransform gives current transform; .scaleBy + point keeps the
    // clicked point fixed under the cursor (same as d3-zoom's dblclick logic)
    sel.transition().duration(280).call(zoomBehaviorRef.current.scaleBy, factor, [px, py]);
  }

  // Keyboard shortcuts: + / - / 0 when the SVG (or its container) has focus
  useEffect(() => {
    function onKey(e) {
      // Only handle if nothing else is focused (avoid clobbering inputs)
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "+" || e.key === "=") { zoomBy(1.4); e.preventDefault(); }
      else if (e.key === "-" || e.key === "_") { zoomBy(1 / 1.4); e.preventDefault(); }
      else if (e.key === "0") { resetZoom(); e.preventDefault(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ───────────────────────────────────────────────────────────────────────
  // SPIDERFY (exact-coordinate collision avoidance)
  // When multiple incidents share the same lat/lng to 4 decimal places
  // (~11m precision), they would render on top of each other forever, even
  // at maximum zoom. Spiderfy them: each gets a small offset on a ring
  // around the original position, so all pins are reachable. Ring radius
  // counter-scales with zoom — bigger when zoomed out, smaller when zoomed
  // in (so spiderfied pins eventually look like a tight cluster of dots).
  // ───────────────────────────────────────────────────────────────────────
  const spiderfyMap = useMemo(() => {
    // Group by lat/lng key. Returns: Map<incidentId, {dx, dy}> in projected
    // coords at zoom=1. Apply / k at render time to counter-scale.
    const groups = new Map();
    for (const inc of visibleIncidents) {
      if (typeof inc.latitude !== "number" || typeof inc.longitude !== "number") continue;
      const key = `${inc.latitude.toFixed(4)},${inc.longitude.toFixed(4)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inc);
    }
    const map = new Map();
    for (const members of groups.values()) {
      if (members.length === 1) continue; // no spiderfy needed
      const n = members.length;
      // Ring radius in projected pixels at zoom=1. Will be divided by k at
      // render time, so at zoom=10 it's a 1.4px ring (tight) — at zoom=1
      // it's a 14px ring (clearly fanned).
      const ringR = 14 + Math.min(8, n);
      members.forEach((inc, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        map.set(inc._id, {
          dx: ringR * Math.cos(angle),
          dy: ringR * Math.sin(angle),
        });
      });
    }
    return map;
  }, [visibleIncidents]);

  // Compute the on-screen position of an incident, including spiderfy offset
  // (the offset is in projected-pixel space at zoom=1, divided by k so it
  // shrinks proportionally as we zoom in)
  function incidentPos(inc) {
    const p = project(inc.longitude, inc.latitude);
    if (!p) return null;
    const offset = spiderfyMap.get(inc._id);
    if (!offset) return { x: p[0], y: p[1], hasOffset: false };
    return {
      x: p[0] + offset.dx / k,
      y: p[1] + offset.dy / k,
      hasOffset: true,
      anchorX: p[0],
      anchorY: p[1],
    };
  }

  // (Filter logic moved to parent — MapCanvas receives pre-filtered visibleIncidents)

  // Build blast-radius arc data for selected incident (or all if hovering nothing)
  const blastArcs = useMemo(() => {
    if (!showBlastRadius) return [];
    const arcs = [];
    const targets = selectedId
      ? visibleIncidents.filter(i => i._id === selectedId)
      : (hoveredId ? visibleIncidents.filter(i => i._id === hoveredId) : []);
    for (const inc of targets) {
      // Must use incidentPos(), NOT the raw projection: when several incidents
      // share coordinates they are spiderfied onto a ring, so the pin the user
      // sees is offset from the anchor. Projecting raw made every arc start at
      // the un-offset anchor — i.e. visually sprouting from a *neighbouring*
      // pin instead of the selected one.
      const originPos = incidentPos(inc);
      if (!originPos) continue;
      const origin = [originPos.x, originPos.y];
      const radius = inc.blast_radius || {};
      for (const [channel, entities] of Object.entries(radius)) {
        if (!Array.isArray(entities)) continue;
        const channelDef = BLAST_CHANNELS[channel];
        if (!channelDef) continue;
        entities.forEach((ent, i) => {
          if (typeof ent.latitude !== "number" || typeof ent.longitude !== "number") return;
          const dest = project(ent.longitude, ent.latitude);
          if (!dest) return;
          arcs.push({
            id: `${inc._id}-${channel}-${i}`,
            x1: origin[0], y1: origin[1],
            x2: dest[0], y2: dest[1],
            channel,
            channelDef,
            label: ent.name || ent.entity || "",
            entity: ent,
          });
        });
      }
    }
    // Blast entities frequently carry the incident's own coordinates (an
    // "internal" team, an on-site depot) or duplicate each other. Stacked at
    // one point they read as a single anonymous dot with no visible arc. Fan
    // any co-located cluster onto a ring so every entity is separately
    // hoverable, and so an arc is always visible leaving the pin.
    const byPoint = new Map();
    for (const arc of arcs) {
      const key = `${arc.x2.toFixed(1)},${arc.y2.toFixed(1)}`;
      if (!byPoint.has(key)) byPoint.set(key, []);
      byPoint.get(key).push(arc);
    }
    for (const group of byPoint.values()) {
      if (group.length === 1) continue;
      const ringR = (18 + Math.min(10, group.length)) / k;
      group.forEach((arc, i) => {
        const angle = (i / group.length) * Math.PI * 2 - Math.PI / 2;
        arc.x2 += ringR * Math.cos(angle);
        arc.y2 += ringR * Math.sin(angle);
      });
    }
    return arcs;
  }, [visibleIncidents, hoveredId, selectedId, showBlastRadius, projection, spiderfyMap, k]);

  // Compute graticule once
  const graticule = useMemo(() => {
    const g = d3.geoGraticule().step([20, 20]);
    return pathGen(g());
  }, [pathGen]);

  return (
    // No minHeight: a 480px floor inside a shorter stage pushed the map past
    // the bottom of its own container. The projection fits itself to whatever
    // height it is given, so the frame should simply be the stage.
    // Background is the SPACE around the map, not the sea. Because the world
    // is a fixed 2:1 rectangle and the stage rarely is, there are bands above
    // and below it; they were a dark navy (#020b1c) which read as more dark
    // blue next to the ocean. Black matches the globe, whose Cesium
    // backgroundColor is BLACK with a starfield — so both views now sit in the
    // same void and only the planet differs.
    <div ref={containerRef} style={{ position: "relative", width: "100%", height: "100%", background: "#050505", borderRadius: 0, overflow: "hidden", border: `1px solid ${BRAND.borderSubtle}` }}>
      {/* Deep space starfield behind the map */}
      <canvas style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 0, pointerEvents: "none" }}
        ref={el => {
          if (!el || el._starsDrawn) return;
          el._starsDrawn = true;
          const ctx = el.getContext("2d");
          el.width = el.offsetWidth || 1200;
          el.height = el.offsetHeight || 800;
          for (let i = 0; i < 350; i++) {
            const x = Math.random() * el.width;
            const y = Math.random() * el.height;
            const r = Math.random() * 0.9 + 0.1;
            const opacity = Math.random() * 0.7 + 0.15;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,255,255,${opacity})`;
            ctx.fill();
          }
        }}
      />
      {/* Subtle deep-space ambient glow */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse 62% 54% at 50% 48%, rgba(30,80,160,0.08) 0%, rgba(30,80,160,0.015) 40%, transparent 72%)",
        zIndex: 0,
      }} />
      <svg
        ref={svgRef}
        width={dims.width}
        height={dims.height}
        style={{ display: "block", cursor: "grab", touchAction: "none", position: "relative", zIndex: 1 }}
        onMouseDown={e => { if (e.currentTarget) e.currentTarget.style.cursor = "grabbing"; }}
        onMouseUp={e => { if (e.currentTarget) e.currentTarget.style.cursor = "grab"; }}
        onMouseLeave={e => {
          // Clear all hover state when cursor leaves the SVG entirely.
          // Without this, fast cursor movement out of the iframe (e.g. into
          // the chat panel) can leave onMouseLeave handlers on inner dots
          // ungated, leaving blast-radius tooltips stuck visible. Belt-and-
          // braces: wipe both pin hover and entity hover here.
          if (e.currentTarget) e.currentTarget.style.cursor = "grab";
          setHoveredEntity(null);
          onHover(null);
        }}
        onClick={zoomOutAtPoint}
      >
        <defs>
          {/* Severity-tier radial-glow gradients */}
          {Object.entries(SEVERITY).map(([level, s]) => (
            <radialGradient key={level} id={`heat-${level}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.55} />
              <stop offset="60%" stopColor={s.color} stopOpacity={0.15} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </radialGradient>
          ))}
          {/* Soft pin glow */}
          <filter id="pin-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
          {/* Clip path so geographic content doesn't bleed outside the viewport */}
          <clipPath id="map-viewport">
            <rect x={0} y={0} width={dims.width} height={dims.height} />
          </clipPath>

          {/* Gentle lift on the LAND only (the sea is painted separately
              below). Gamma rather than brightness, so shadowed terrain opens
              up without blowing out the deserts. */}
          <filter id="earth-sky" colorInterpolationFilters="sRGB">
            <feComponentTransfer>
              <feFuncR type="gamma" exponent="0.88" amplitude="1" offset="0" />
              <feFuncG type="gamma" exponent="0.86" amplitude="1" offset="0" />
              <feFuncB type="gamma" exponent="0.86" amplitude="1" offset="0" />
            </feComponentTransfer>
            <feColorMatrix type="saturate" values="1.1" />
          </filter>

          {/* Land mask. Blue Marble's sea is essentially black — I measured
              mid-Pacific at #070e28 — so no tone curve can lift it to the sky
              blue the ArcGIS globe shows without destroying the land with it
              (a gamma strong enough to fix the sea turned the Amazon from
              #1b2c0c to #2c5037). Instead the sea is painted as a flat colour
              and the satellite imagery is clipped to the coastlines, so the
              land stays photographic and the sea is exactly the colour we
              choose. Built from the same pathGen as the borders, so the
              coastline of the mask and of the outlines are the same curve. */}
          {world && (
            <clipPath id="land-only">
              {world.features.map((feat, i) => {
                const d = pathGen(feat);
                return d ? <path key={i} d={d} /> : null;
              })}
            </clipPath>
          )}
        </defs>

        {/* Ocean — transparent so the deep-blue container and stars show through. */}
        <rect x={0} y={0} width={dims.width} height={dims.height} fill="transparent" />

        {/* All geographic content goes inside the zoom transform group */}
        <g
          clipPath="url(#map-viewport)"
          transform={`translate(${zoomTransform.x},${zoomTransform.y}) scale(${k})`}>

          {/* Real Earth imagery — the same photographic basemap the GLOBE
              shows, so switching FLAT/GLOBE no longer changes what the planet
              looks like. This replaced a hardcoded palette of ten dark-green
              landmass tones over a near-black ocean, which read as a schematic
              rather than the satellite view used everywhere else.
              NASA Blue Marble is 4096x2048 plate carrée — exactly the
              projection in use — so it lands corner-to-corner on worldRect
              with no distortion. Inside the zoom group, so it pans and scales
              with the vector layers on top of it.
              MUST be the first child: it is opaque, so anything drawn before
              it (the graticule) would simply be painted over. */}
          {worldRect && (
            <>
              {/* Sea first — a real sky blue, matching the ArcGIS basemap the
                  globe renders rather than Blue Marble's near-black navy. This
                  single constant is the dial for the ocean colour. */}
              <rect
                x={worldRect.x} y={worldRect.y}
                width={worldRect.w} height={worldRect.h}
                fill={OCEAN_BLUE}
                style={{ pointerEvents: "none" }}
              />
              {/* Then the photographic land on top, clipped to the coastlines */}
              <image
                href="/textures/earth-blue-marble.jpg"
                x={worldRect.x} y={worldRect.y}
                width={worldRect.w} height={worldRect.h}
                preserveAspectRatio="none"
                clipPath="url(#land-only)"
                filter="url(#earth-sky)"
                style={{ pointerEvents: "none" }}
              />
            </>
          )}

          {/* Graticule — now sits ON the imagery, so it is a faint white
              rather than the old blue: a 0.07-alpha blue that was legible
              against a near-black schematic disappears entirely over ocean
              and desert photography. */}
          <path d={graticule} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={0.3 / k} strokeOpacity={1} />

          {/* Country borders — outlines only now. The imagery below supplies
              the land colour, so filling the polygons would just paint over
              the photograph. */}
          {(() => {
            // Deliberately NO country-wide focus flood. An incident is a point
            // event — a strike on one base, a tanker seized in a strait. Filling
            // an entire nation's landmass asserts the whole country is affected,
            // which is false, and for shared international waters (the Strait of
            // Hormuz is Iran/Oman transit) it also mis-attributes the event to
            // one state. The focus highlight now lives at the incident's real
            // coordinates instead — see the place-highlight block below.
            return world && world.features.map((feat, i) => {
              const d = pathGen(feat);
              if (!d) return null;
              return (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  // Warm hairline rather than the old green: it has to read as
                  // a border over both bright desert and dark ocean without
                  // competing with the severity-coloured pins.
                  stroke="rgba(255,255,255,0.22)"
                  strokeWidth={0.5 / k}
                />
              );
            });
          })()}

          {/* Country labels — gated on the showLabels toggle. When off, only
              the country of the selected or hovered incident gets a soft label
              so the user is never lost. When on, all countries label with the
              previous zoom-fade behaviour. */}
          {world && (() => {
            // When labels are globally off, label the focused incident's PLACE
            // at its real coordinates (the pin), not its country's centroid.
            // location_name is the specific place ("Strait of Hormuz",
            // "Naval Support Activity Bahrain, Juffair"); country is both
            // coarse and inconsistently coded ("US" vs "United States"), so it
            // is only a last-resort fallback here.
            if (!showLabels) {
              const focusInc = visibleIncidents.find(i => i._id === (selectedId || hoveredId));
              if (!focusInc) return null;
              const pos = incidentPos(focusInc);
              if (!pos) return null;
              const place = placeLabelFor(focusInc);
              if (!place) return null;
              const fontSize = 11 / k;
              return (
                <text
                  key="focus-place"
                  x={pos.x}
                  y={pos.y - 16 / k}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={BRAND.gold}
                  fillOpacity={0.95}
                  stroke={BRAND.obsidianDeep}
                  strokeWidth={3 / k}
                  strokeOpacity={0.75}
                  paintOrder="stroke"
                  fontFamily="Inter, sans-serif"
                  fontSize={fontSize}
                  fontWeight={600}
                  letterSpacing={`${0.08 / k}em`}
                  style={{ pointerEvents: "none", textTransform: "uppercase" }}>
                  {place}
                </text>
              );
            }
            // Full labels mode (toggle on) — previous zoom-fade behaviour
            const opacity = k >= 7 ? 0 : k >= 4 ? (7 - k) / 3 : 1;
            if (opacity <= 0.02) return null;
            const fontSize = (k >= 1.5 ? 9 : 9) / k;
            return world.features.map((feat, i) => {
              const name = feat.properties?.name;
              if (!name) return null;
              const centroid = d3.geoCentroid(feat);
              if (!centroid) return null;
              const p = projection(centroid);
              if (!p || isNaN(p[0])) return null;
              return (
                <text
                  key={`country-${i}`}
                  x={p[0]}
                  y={p[1]}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={BRAND.textSecondary}
                  fillOpacity={opacity * 0.7}
                  stroke={BRAND.obsidianDeep}
                  strokeWidth={2.5 / k}
                  strokeOpacity={opacity * 0.5}
                  paintOrder="stroke"
                  fontFamily="Inter, sans-serif"
                  fontSize={fontSize}
                  fontWeight={500}
                  letterSpacing={`${0.04 / k}em`}
                  style={{ pointerEvents: "none", textTransform: "uppercase" }}>
                  {name}
                </text>
              );
            });
          })()}

          {/* City labels — gated on showLabels toggle. When off, completely
              hidden so the map stays clean. When on, appear at zoom ≥ 2.5×,
              ramping to full opacity by 4×. */}
          {showLabels && (() => {
            const opacity = k <= 2.5 ? 0 : k >= 4 ? 1 : (k - 2.5) / 1.5;
            if (opacity <= 0.02) return null;
            // At higher zooms, show smaller text; at lower, slightly larger
            const fontSize = (k >= 8 ? 9 : 10) / k;
            // Compute world-space viewport extents so we cull labels off-screen
            const visMinX = -zoomTransform.x / k;
            const visMaxX = (dims.width - zoomTransform.x) / k;
            const visMinY = -zoomTransform.y / k;
            const visMaxY = (dims.height - zoomTransform.y) / k;
            return WORLD_CITIES.map(([name, lat, lng]) => {
              const p = projection([lng, lat]);
              if (!p || isNaN(p[0])) return null;
              // Cull cities outside the visible viewport in world space
              if (p[0] < visMinX - 50 || p[0] > visMaxX + 50) return null;
              if (p[1] < visMinY - 30 || p[1] > visMaxY + 30) return null;
              return (
                <g key={`city-${name}`} style={{ pointerEvents: "none" }}>
                  {/* Small dot at the city point */}
                  <circle
                    cx={p[0]}
                    cy={p[1]}
                    r={1.5 / k}
                    fill={BRAND.textMuted}
                    fillOpacity={opacity * 0.8}
                  />
                  {/* Label, offset above-right of the dot */}
                  <text
                    x={p[0] + 4 / k}
                    y={p[1] - 4 / k}
                    fill={BRAND.white}
                    fillOpacity={opacity * 0.85}
                    stroke={BRAND.obsidianDeep}
                    strokeWidth={2.5 / k}
                    strokeOpacity={opacity * 0.7}
                    paintOrder="stroke"
                    fontFamily="Inter, sans-serif"
                    fontSize={fontSize}
                    fontWeight={500}>
                    {name}
                  </text>
                </g>
              );
            });
          })()}

          {/* Severity heat halos — one per incident, drawn at the spiderfied
              position. Radius counter-scales so halos stay a fixed visual size
              at every zoom level (they shouldn't bloat or shrink). */}
          {showHeat && visibleIncidents.map(inc => {
            const pos = incidentPos(inc);
            if (!pos) return null;
            const sev = inc.severity || 3;
            const baseR = 14 + (sev || 1) * 8;
            return (
              <circle
                key={`heat-${inc._id}`}
                cx={pos.x}
                cy={pos.y}
                r={baseR / k}
                fill={`url(#heat-${sev})`}
                style={{ pointerEvents: "none" }}
              />
            );
          })}

          {/* Blast-radius arcs — stroke counter-scales */}
          {blastArcs.map(arc => {
            const dx = arc.x2 - arc.x1;
            const dy = arc.y2 - arc.y1;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const sag = Math.min(dist * 0.15, 80);
            const mx = (arc.x1 + arc.x2) / 2;
            const my = (arc.y1 + arc.y2) / 2 - sag;
            const d = `M ${arc.x1} ${arc.y1} Q ${mx} ${my} ${arc.x2} ${arc.y2}`;
            // Dash array must counter-scale too, else dashes stretch at zoom
            const dashStr = arc.channelDef.dash === "0"
              ? "0"
              : arc.channelDef.dash.split(",").map(v => (parseFloat(v) / k).toFixed(2)).join(",");
            return (
              <path
                key={arc.id}
                d={d}
                fill="none"
                stroke={arc.channelDef.color}
                strokeWidth={arc.channelDef.width / k}
                strokeDasharray={dashStr}
                strokeOpacity={arc.channelDef.opacity}
                style={{ pointerEvents: "none" }}
              />
            );
          })}

          {/* Blast-radius destination markers — counter-scaled, interactive.
              Each marker is wrapped in a group with a generous invisible hit
              target so the small visual dots are easy to hover at any zoom. */}
          {blastArcs.map(arc => {
            const isHovered = hoveredEntity && hoveredEntity._id === arc.id;
            const baseR = arc.channelDef.kind === "primary" ? 2.8 : 3.2;
            const r = (isHovered ? baseR + 1.6 : baseR) / k;
            return (
              <g
                key={`dest-${arc.id}`}
                transform={`translate(${arc.x2},${arc.y2})`}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => {
                  setHoveredEntity({ _id: arc.id, entity: arc.entity, channel: arc.channel, channelDef: arc.channelDef, x: arc.x2, y: arc.y2 });
                }}
                onMouseLeave={() => setHoveredEntity(null)}
              >
                {/* Invisible hit target — 10/k radius so dots stay reachable at any zoom */}
                <circle r={10 / k} fill="transparent" />
                {/* Hovered halo */}
                {isHovered && (
                  <circle r={(baseR + 4) / k} fill="none" stroke={arc.channelDef.color} strokeWidth={1 / k} strokeOpacity={0.6} />
                )}
                {/* Visible marker */}
                {arc.channelDef.kind === "primary" ? (
                  <circle
                    r={r}
                    fill={arc.channelDef.color}
                    fillOpacity={isHovered ? 1 : 0.85}
                  />
                ) : (
                  <circle
                    r={r}
                    fill="none"
                    stroke={arc.channelDef.color}
                    strokeWidth={1.2 / k}
                    strokeDasharray={`${2 / k},${1.5 / k}`}
                    strokeOpacity={isHovered ? 1 : 0.85}
                  />
                )}
              </g>
            );
          })}

          {/* Spiderfy tether lines — only when offset is in effect, only at
              lower zoom levels where the spiderfy ring is large enough to see */}
          {visibleIncidents.map(inc => {
            const pos = incidentPos(inc);
            if (!pos || !pos.hasOffset) return null;
            // Hide tether when offset is sub-pixel
            const dx = pos.x - pos.anchorX;
            const dy = pos.y - pos.anchorY;
            if (Math.sqrt(dx * dx + dy * dy) * k < 4) return null;
            return (
              <line
                key={`tether-${inc._id}`}
                x1={pos.anchorX}
                y1={pos.anchorY}
                x2={pos.x}
                y2={pos.y}
                stroke={BRAND.gold}
                strokeWidth={0.5 / k}
                strokeOpacity={0.25}
                style={{ pointerEvents: "none" }}
              />
            );
          })}

          {/* Incident pins — one per incident, no clustering. Pin size and
              stroke widths counter-scale so they read identically at any zoom.
              Geographic accuracy preserved: pin sits at exact projected lat/lng
              (or spiderfied if same-coord collision). */}
          {visibleIncidents.map(inc => {
            const pos = incidentPos(inc);
            if (!pos) return null;
            const sev = SEVERITY[inc.severity] || SEVERITY[3];
            const cat = CATEGORIES[inc._cat] || { color: BRAND.gold };
            const isActive = hoveredId === inc._id || selectedId === inc._id;
            const isSelected = selectedId === inc._id;
            const isCritical = (inc.severity || 0) >= 5;
            const basePinSize = 3 + (inc.severity || 1) * 1.2;
            const pinSize = basePinSize / k;
            return (
              <g
                key={inc._id}
                transform={`translate(${pos.x},${pos.y})`}
                onMouseEnter={() => onHover(inc._id)}
                onMouseLeave={() => onHover(null)}
                onClick={e => { e.stopPropagation(); onSelect(inc._id); }}
                style={{ cursor: "pointer" }}>
                {/* Soft outer glow — small bleed outside the ring */}
                <circle
                  r={pinSize + 5 / k}
                  fill={sev.color}
                  fillOpacity={isActive ? 0.22 : 0.12}
                  filter="url(#pin-glow)"
                  style={{ transition: "fill-opacity 320ms cubic-bezier(0.4,0,0.2,1)" }}
                />
                {/* Idle breathing — only on critical (sev 5) pins. Very slow
                    and subtle so it draws the eye without being noisy.
                    Suppressed while hovering/selecting so the louder pulse
                    can take over without ringing into it. */}
                {isCritical && !isActive && (
                  <circle r={pinSize + 4 / k} fill="none" stroke={sev.color} strokeWidth={1 / k} strokeOpacity={0.4}>
                    <animate attributeName="r" values={`${pinSize + 3 / k};${pinSize + 8 / k};${pinSize + 3 / k}`} dur="3.5s" repeatCount="indefinite" />
                    <animate attributeName="stroke-opacity" values="0.4;0;0.4" dur="3.5s" repeatCount="indefinite" />
                  </circle>
                )}
                {/* Hover / selected pulse — louder, faster. Two concentric
                    pulses on the SELECTED pin so the user has a clear "this
                    is the one you're looking at" signal that persists while
                    the panel is open. */}
                {isActive && (
                  <>
                    <circle r={pinSize + 6 / k} fill="none" stroke={sev.color} strokeWidth={1.5 / k} strokeOpacity={0.85}>
                      <animate attributeName="r" from={pinSize + 5 / k} to={pinSize + 14 / k} dur="1.5s" repeatCount="indefinite" />
                      <animate attributeName="stroke-opacity" from="0.85" to="0" dur="1.5s" repeatCount="indefinite" />
                    </circle>
                    {isSelected && (
                      <circle r={pinSize + 6 / k} fill="none" stroke={sev.color} strokeWidth={1.5 / k} strokeOpacity={0.6}>
                        <animate attributeName="r" from={pinSize + 5 / k} to={pinSize + 18 / k} dur="1.8s" begin="0.5s" repeatCount="indefinite" />
                        <animate attributeName="stroke-opacity" from="0.6" to="0" dur="1.8s" begin="0.5s" repeatCount="indefinite" />
                      </circle>
                    )}
                  </>
                )}
                {/* Severity ring — sits directly at the dot's edge so it
                    reads as an attached border, not a separate halo.
                    Thickens slightly when active for tactile feedback. */}
                <circle
                  r={pinSize + 1.5 / k}
                  fill="none"
                  stroke={sev.color}
                  strokeWidth={(isActive ? 2.2 : 1.5) / k}
                  strokeOpacity={1}
                  style={{ transition: "stroke-width 220ms cubic-bezier(0.4,0,0.2,1)" }}
                />
                {/* Severity-coloured core. Scales up subtly on hover for a
                    "pressable" feel. */}
                <circle
                  r={isActive ? pinSize * 1.12 : pinSize}
                  fill={sev.color}
                  style={{ transition: "r 220ms cubic-bezier(0.4,0,0.2,1)" }}
                />
                {(inc.severity || 0) >= 4 && (
                  <circle r={pinSize * 0.45} fill="#FFFFFF" fillOpacity={0.95} />
                )}
              </g>
            );
          })}
        </g>

        {/* Hover tooltip — rendered OUTSIDE the zoom layer so it stays at
            fixed screen size and doesn't get clipped at high zoom. Position
            is computed in screen space (post-transform) and we account for
            spiderfy offset. */}
        {hoveredId && (() => {
          const inc = visibleIncidents.find(i => i._id === hoveredId);
          if (!inc) return null;
          const pos = incidentPos(inc);
          if (!pos) return null;
          // Convert from world-space to screen-space using the zoom transform
          const screenX = pos.x * k + zoomTransform.x;
          const screenY = pos.y * k + zoomTransform.y;
          // Off-screen? hide tooltip
          if (screenX < -50 || screenX > dims.width + 50 || screenY < -50 || screenY > dims.height + 50) return null;
          const sev = SEVERITY[inc.severity] || SEVERITY[3];
          const cat = CATEGORIES[inc._cat];
          const labelText = inc.headline || "";
          const tooltipWidth = Math.min(360, Math.max(220, labelText.length * 6.2));
          const tooltipHeight = 62;
          // HUD safe-zones — never sit under the control strip / caption bar
          const HUD_TOP = 56;
          const HUD_BOTTOM = 96;
          let tx = screenX + 16;
          let ty = screenY - 10;
          if (tx + tooltipWidth > dims.width - 12) tx = screenX - tooltipWidth - 16;
          if (tx < 8) tx = 8;
          if (ty < HUD_TOP) ty = screenY + 24;
          if (ty + tooltipHeight > dims.height - HUD_BOTTOM) ty = dims.height - HUD_BOTTOM - tooltipHeight;
          if (ty < HUD_TOP) ty = HUD_TOP;
          return (
            <g transform={`translate(${tx},${ty})`} style={{ pointerEvents: "none" }}>
              <rect width={tooltipWidth} height={62} fill={BRAND.obsidianElevated} stroke={BRAND.borderGold} strokeWidth={1} rx={4} fillOpacity={0.98} />
              <text x={10} y={16} fill={sev.color} fontFamily="Inter, sans-serif" fontSize={9} letterSpacing="0.08em">
                {cat?.label?.toUpperCase()} · SEV {inc.severity} · {sev.label}
              </text>
              <foreignObject x={10} y={22} width={tooltipWidth - 20} height={36}>
                <div style={{ fontFamily: "Inter, sans-serif", fontSize: 12, color: BRAND.white, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                  {labelText}
                </div>
              </foreignObject>
            </g>
          );
        })()}

        {/* Blast-destination entity tooltip — shows when hovering a related-
            party dot in the flat view. Same data as the globe's destination
            tooltip: channel pill (DIRECT / INDIRECT), entity name, country,
            and the analyst-written `reason` text. Positioned in screen space
            (post-transform). */}
        {hoveredEntity && (() => {
          const { entity: ent, channel, channelDef, x: wx, y: wy } = hoveredEntity;
          const screenX = wx * k + zoomTransform.x;
          const screenY = wy * k + zoomTransform.y;
          if (screenX < -50 || screenX > dims.width + 50 || screenY < -50 || screenY > dims.height + 50) return null;
          const name = ent.name || ent.entity || "—";
          const reason = ent.reason || "";
          const country = ent.country || "";
          const typeStr = ent.type || "";
          const shownName = name.length > 64 ? name.slice(0, 64) + "…" : name;
          // Wrap reason
          const reasonLines = [];
          if (reason) {
            const words = reason.split(/\s+/);
            let line = "";
            for (const w of words) {
              if ((line + " " + w).trim().length > 62) {
                reasonLines.push(line.trim());
                line = w;
              } else {
                line += " " + w;
              }
              if (reasonLines.length >= 3) break;
            }
            if (line && reasonLines.length < 3) reasonLines.push(line.trim());
          }
          // ── Geometry — same layout rules as the globe tooltip so both
          //    surfaces stay visually identical and reason text never spills.
          const PILL_H = 14;
          const REASON_GAP = 14;
          const PAD_BOTTOM = 12;
          const pillBaselineY = 20;
          const nameY = 38;
          const countryY = country ? 52 : nameY;
          const firstReasonY = (country ? countryY : nameY) + 14;
          const lastReasonY = firstReasonY + Math.max(0, reasonLines.length - 1) * REASON_GAP;
          const contentBottom = (reasonLines.length > 0) ? lastReasonY : (country ? countryY : nameY);
          const tooltipWidth = 380;
          const tooltipHeight = Math.ceil(contentBottom + PAD_BOTTOM);
          // ── Pill geometry — width fits the actual label so the outline
          //    never breaks against the type label sitting beside it.
          const pillLabel = `${channelDef.kind === "primary" ? "DIRECT" : "INDIRECT"} · ${channelDef.label.toUpperCase()}`;
          const pillTextWidth = pillLabel.length * 5.4;
          const pillWidth = Math.ceil(pillTextWidth + 14);
          const pillX = 10;
          const pillRight = pillX + pillWidth;
          const typeX = pillRight + 8;
          // HUD safe-zones. The parent overlays the control strip at the
          // bottom (height 56) and the filter chips at the top (height 56).
          // Keep the tooltip outside those bands so it never sits under chrome.
          const HUD_TOP = 56;
          const HUD_BOTTOM = 96;  // bottom strip + caption row
          let tx = screenX + 14;
          let ty = screenY - 8;
          if (tx + tooltipWidth > dims.width - 8) tx = screenX - tooltipWidth - 14;
          if (tx < 8) tx = 8;
          if (ty < HUD_TOP) ty = screenY + 22;
          if (ty + tooltipHeight > dims.height - HUD_BOTTOM) ty = dims.height - HUD_BOTTOM - tooltipHeight;
          if (ty < HUD_TOP) ty = HUD_TOP;
          return (
            <g transform={`translate(${tx},${ty})`} style={{ pointerEvents: "none" }}>
              <rect
                width={tooltipWidth}
                height={tooltipHeight}
                fill={BRAND.obsidianElevated}
                stroke={channelDef.color}
                strokeWidth={1}
                rx={4}
                fillOpacity={0.98}
              />
              <rect x={pillX} y={10} width={pillWidth} height={PILL_H} rx={2} fill={channelDef.color} fillOpacity={0.15} stroke={channelDef.color} strokeWidth={0.6} />
              <text x={pillX + pillWidth / 2} y={pillBaselineY} textAnchor="middle" fill={channelDef.color} fontFamily="Inter, sans-serif" fontSize={8} letterSpacing="0.1em">
                {pillLabel}
              </text>
              {typeStr && (() => {
                const raw = typeStr.toUpperCase().replace(/_/g, " ");
                const maxChars = Math.max(4, Math.floor((tooltipWidth - typeX - 12) / 5.2));
                const shown = raw.length > maxChars ? raw.slice(0, maxChars - 1) + "…" : raw;
                return (
                  <text x={typeX} y={pillBaselineY} fill={BRAND.textMuted} fontFamily="Inter, sans-serif" fontSize={8} letterSpacing="0.08em">
                    {shown}
                  </text>
                );
              })()}
              <text x={10} y={nameY} fill={BRAND.white} fontFamily="Inter, sans-serif" fontSize={11} fontWeight={600}>
                {shownName}
              </text>
              {country && (
                <text x={10} y={countryY} fill={BRAND.textSecondary} fontFamily="Inter, sans-serif" fontSize={10}>
                  {country}
                </text>
              )}
              {reasonLines.map((ln, i) => (
                <text
                  key={i}
                  x={10}
                  y={firstReasonY + i * REASON_GAP}
                  fill={BRAND.textSecondary}
                  fontFamily="Inter, sans-serif"
                  fontSize={10}
                  fontStyle="italic"
                >
                  {ln}
                </text>
              ))}
            </g>
          );
        })()}
      </svg>

      {/* Cinematic vignette — radial darken at edges for filmic depth.
          Non-interactive overlay; pins/HUD controls stay above (zIndex 10+). */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse 90% 70% at 50% 50%, transparent 55%, rgba(0,0,0,0.45) 100%)",
        zIndex: 2,
      }} />

      {/* Zoom controls — moved up to bottom: 170 to prevent overlap with the Risk Level legend */}
      <div style={{
        position: "absolute",
        bottom: 170,
        right: 12,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        zIndex: 11,
      }}>
        <button
          onPointerDown={e => { e.preventDefault(); startHoldZoom(1.8); }}
          onPointerUp={stopHoldZoom}
          onPointerLeave={stopHoldZoom}
          onPointerCancel={stopHoldZoom}
          title="Zoom in (+) — hold for continuous zoom"
          style={{
            width: 32, height: 32, padding: 0,
            background: "rgba(36,36,36,0.92)",
            backdropFilter: "blur(8px)",
            color: BRAND.gold,
            border: `1px solid ${BRAND.borderGold}`,
            borderRadius: 0,
            fontFamily: "Inter, sans-serif",
            fontSize: 18, lineHeight: 1, fontWeight: 500,
            cursor: "pointer",
          }}>+</button>
        <button
          onPointerDown={e => { e.preventDefault(); startHoldZoom(1 / 1.8); }}
          onPointerUp={stopHoldZoom}
          onPointerLeave={stopHoldZoom}
          onPointerCancel={stopHoldZoom}
          title="Zoom out (−) — hold for continuous zoom"
          style={{
            width: 32, height: 32, padding: 0,
            background: "rgba(36,36,36,0.92)",
            backdropFilter: "blur(8px)",
            color: BRAND.gold,
            border: `1px solid ${BRAND.borderGold}`,
            borderRadius: 0,
            fontFamily: "Inter, sans-serif",
            fontSize: 18, lineHeight: 1, fontWeight: 500,
            cursor: "pointer",
          }}>−</button>
        <button
          onClick={resetZoom}
          title="Reset view (0)"
          style={{
            width: 32, height: 32, padding: 0,
            background: "rgba(36,36,36,0.92)",
            backdropFilter: "blur(8px)",
            color: BRAND.textSecondary,
            border: `1px solid ${BRAND.borderSubtle}`,
            borderRadius: 0,
            fontFamily: "Inter, sans-serif",
            fontSize: 11, lineHeight: 1,
            cursor: "pointer",
          }}>⌂</button>
        {/* Zoom level indicator */}
        <div style={{
          marginTop: 4,
          padding: "3px 0",
          textAlign: "center",
          fontFamily: "Inter, sans-serif",
          fontSize: 9,
          color: k > 1.05 ? BRAND.gold : BRAND.textMuted,
          letterSpacing: "0.04em",
          background: "rgba(36,36,36,0.92)",
          backdropFilter: "blur(8px)",
          border: `1px solid ${BRAND.borderSubtle}`,
          borderRadius: 0,
        }}>
          {k.toFixed(1)}×
        </div>
      </div>

      {/* Loading state */}
      {!world && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
          <div style={{ width: 32, height: 32, border: `2px solid ${BRAND.borderSubtle}`, borderTopColor: BRAND.gold, borderRadius: "50%", animation: "spin 1s linear infinite" }} />
          <div style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: BRAND.textMuted, letterSpacing: "0.1em" }}>LOADING WORLD ATLAS…</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBE ERROR BOUNDARY — catches any runtime error from GlobeCanvas so a
// rendering issue can't take down the whole app. Should rarely fire now that
// the globe is pure SVG (no async workers, no WebGL context), but kept as
// belt-and-braces protection.
// ─────────────────────────────────────────────────────────────────────────────
class GlobeErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("GlobeCanvas runtime error:", error, info);
  }
  render() {
    if (this.state.error) {
      const errStr = String(this.state.error?.message || this.state.error);
      return (
        <div style={{
          position: "relative", width: "100%", minHeight: 480,
          background: BRAND.obsidianDeep, borderRadius: 0,
          border: `1px solid rgba(255,107,107,0.3)`,
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 40,
        }}>
          <div style={{ textAlign: "center", maxWidth: 560 }}>
            <div style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: "#FF6B6B", letterSpacing: "0.16em", marginBottom: 12 }}>
              ◇ GLOBE VIEW · RUNTIME ERROR
            </div>
            <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 24, color: BRAND.white, lineHeight: 1.25, marginBottom: 16 }}>
              The 3D globe encountered a runtime error.
            </div>
            <div style={{
              padding: "10px 14px",
              background: BRAND.obsidianCard,
              border: `1px solid ${BRAND.borderSubtle}`,
              borderRadius: 0,
              fontFamily: "Inter, sans-serif",
              fontSize: 10,
              color: BRAND.textMuted,
              textAlign: "left",
              lineHeight: 1.5,
              wordBreak: "break-word",
            }}>
              <div style={{ color: "#FF6B6B", marginBottom: 4 }}>// error</div>
              <div>{errStr}</div>
            </div>
            <div style={{ marginTop: 16, fontFamily: "Inter, sans-serif", fontSize: 12, color: BRAND.textMuted }}>
              Switch back to flat view to continue.
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBE CANVAS — d3.geoOrthographic SVG globe
// ─────────────────────────────────────────────────────────────────────────────
// Pure SVG globe (no Cesium, no Three.js, no WebGL). Uses d3.geoOrthographic
// with clipAngle(90) so back-of-globe geometry is automatically culled. Drag
// to rotate (longitude + latitude); scroll-wheel to zoom in/out. Click a pin
// to rotate the globe to centre it. Click a pin to select; hover for highlight.
// All filters, sidebar, KPI overlay, detail panel, audit drawer, and search
// come from the parent and apply identically — only the projection changes.
//
// Layers (back-to-front in the SVG):
//   1. Ocean sphere (obsidian fill)
//   2. Graticule grid (10° lat/lng lines, very subtle)
//   3. Country outlines from the world-atlas TopoJSON
//   4. Blast-radius arcs (great-circle geodesics)
//   5. Incident pins (severity-coloured)
// ─────────────────────────────────────────────────────────────────────────────
function GlobeCanvas({ world, visibleIncidents, viewMode, hoveredId, selectedId, onHover, onSelect, showBlastRadius, showHeat, showLabels }) {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);

  // Globe state lives in refs so drag/zoom handlers can mutate without
  // forcing React re-renders on every animation frame. We bump a counter
  // to trigger redraws when needed.
  const rotationRef = useRef([0, -20, 0]);  // [lambda, phi, gamma]
  const scaleRef = useRef(260);              // base scale; grows on zoom
  const [, forceRender] = useState(0);
  const tick = () => forceRender(n => n + 1);

  // Auto-rotate state — pauses on interaction, resumes after a beat of idle.
  const autoRotateRef = useRef(true);
  const lastInteractionRef = useRef(0);

  // Hovered blast-radius destination entity (separate from hovered incident).
  // Holds the full entity object plus its channel definition for the tooltip.
  const [hoveredEntity, setHoveredEntity] = useState(null);

  // Belt-and-braces: blast arcs only render when a pin is hovered or
  // selected. If both are null, the destination dots are unmounted and any
  // lingering hoveredEntity is stale — clear it.
  useEffect(() => {
    if (!hoveredId && !selectedId) setHoveredEntity(null);
  }, [hoveredId, selectedId]);

  // Container dimensions — matches v3 flat-view canvas height
  const WIDTH = 1000;
  const HEIGHT = 580;
  const CX = WIDTH / 2;
  const CY = HEIGHT / 2;

  // ── Spiderfy: cluster by lat/lng to 4dp and offset members on a ring.
  //    Globe uses degrees so the offset works regardless of projection scale.
  const spiderfyMap = useMemo(() => {
    const groups = new Map();
    for (const inc of visibleIncidents) {
      if (typeof inc.latitude !== "number" || typeof inc.longitude !== "number") continue;
      const key = `${inc.latitude.toFixed(4)},${inc.longitude.toFixed(4)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inc);
    }
    const map = new Map();
    const ringDeg = 0.9;
    for (const members of groups.values()) {
      if (members.length === 1) continue;
      const n = members.length;
      members.forEach((inc, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        map.set(inc._id, {
          dLng: ringDeg * Math.cos(angle),
          dLat: ringDeg * Math.sin(angle),
        });
      });
    }
    return map;
  }, [visibleIncidents]);

  // Country centroid fallback — covers every ISO-2 code seen in the sweep data.
  const COUNTRY_CENTROIDS_MAP = {
    US:[-98.58,39.83],GB:[-3.44,55.38],DE:[10.45,51.17],FR:[2.21,46.23],JP:[138.25,36.20],
    CN:[104.20,35.86],IN:[78.96,20.59],RU:[105.32,61.52],BR:[-51.93,-14.24],AU:[133.78,-25.27],
    CA:[-96.80,56.13],KR:[127.77,35.91],IT:[12.57,41.87],ES:[-3.75,40.46],NL:[5.29,52.13],
    SE:[18.64,60.13],CH:[8.23,46.82],SG:[103.82,1.36],IL:[34.85,30.80],AE:[53.85,23.42],
    SA:[45.08,23.89],ZA:[25.08,-29.00],NG:[8.68,9.08],EG:[30.80,26.82],MX:[-102.55,23.95],
    AR:[-63.62,-38.42],CO:[-74.30,4.57],PL:[19.15,51.92],BE:[4.47,50.50],AT:[14.55,47.52],
    NO:[8.47,60.47],DK:[9.50,56.26],FI:[25.75,61.92],PT:[-8.22,39.40],IE:[-8.24,53.41],
    TR:[35.24,38.96],UA:[31.17,48.38],PK:[69.35,30.38],BD:[90.36,23.68],ID:[117.75,-0.79],
    MY:[109.70,4.21],TH:[100.99,15.87],VN:[108.28,14.06],PH:[122.87,12.88],NZ:[174.89,-40.90],
    CZ:[15.47,49.82],HU:[19.50,47.16],RO:[24.97,45.94],GR:[21.82,39.07],ZZ:[0.00,20.00],
    EU:[10.00,50.00],
  };
  function coordFor(inc) {
    const offset = spiderfyMap.get(inc._id);
    const hasCoords = typeof inc.latitude === "number" && typeof inc.longitude === "number"
                      && inc.latitude !== 0 && inc.longitude !== 0;
    let lng = inc.longitude, lat = inc.latitude;
    if (!hasCoords) {
      const fb = COUNTRY_CENTROIDS_MAP[inc.country];
      if (!fb) return [0, 0]; // will be filtered out by isVisible / projection
      [lng, lat] = fb;
    }
    if (offset) return [lng + offset.dLng, lat + offset.dLat];
    return [lng, lat];
  }

  // ── Projection + path generator
  const projection = useMemo(() => {
    return d3.geoOrthographic()
      .scale(scaleRef.current)
      .translate([CX, CY])
      .rotate(rotationRef.current)
      .clipAngle(90)
      .precision(0.3);
  }, [rotationRef.current[0], rotationRef.current[1], scaleRef.current]); // eslint-disable-line

  const path = useMemo(() => d3.geoPath(projection), [projection]);

  // ── Drag-to-rotate + wheel-to-zoom
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);

    let r0, p0;
    const drag = d3.drag()
      .on("start", (event) => {
        autoRotateRef.current = false;
        lastInteractionRef.current = performance.now();
        r0 = rotationRef.current;
        p0 = [event.x, event.y];
      })
      .on("drag", (event) => {
        const sensitivity = 75 / scaleRef.current;
        const dx = (event.x - p0[0]) * sensitivity;
        const dy = (event.y - p0[1]) * sensitivity;
        const newPhi = Math.max(-90, Math.min(90, r0[1] - dy));
        rotationRef.current = [r0[0] + dx, newPhi, r0[2]];
        lastInteractionRef.current = performance.now();
        tick();
      })
      .on("end", () => {
        lastInteractionRef.current = performance.now();
      });

    svg.call(drag);

    function onWheel(event) {
      event.preventDefault();
      autoRotateRef.current = false;
      lastInteractionRef.current = performance.now();
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newScale = Math.max(180, Math.min(1400, scaleRef.current * factor));
      scaleRef.current = newScale;
      tick();
    }
    const node = svgRef.current;
    node.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      svg.on(".drag", null);
      node.removeEventListener("wheel", onWheel);
    };
  }, []);

  // ── Idle auto-rotation. Runs constantly via requestAnimationFrame. Pauses
  //    on any user interaction; resumes 3.5s after the last interaction.
  //    Spins at 4° per second around the longitude axis (lambda).
  useEffect(() => {
    let raf;
    let lastFrame = performance.now();
    function frame(now) {
      const dt = now - lastFrame;
      lastFrame = now;
      const idleFor = now - lastInteractionRef.current;
      // Resume auto-rotate after 3.5s of idle
      if (!autoRotateRef.current && idleFor > 3500) {
        autoRotateRef.current = true;
      }
      if (autoRotateRef.current) {
        const degPerSec = 2.5;
        const deltaLambda = (degPerSec * dt) / 1000;
        const [lambda, phi, gamma] = rotationRef.current;
        rotationRef.current = [lambda + deltaLambda, phi, gamma];
        tick();
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Smooth tween from current rotation/scale to a target
  function rotateGlobeTo(lambda, phi, dur = 900, targetScale = null) {
    autoRotateRef.current = false;
    lastInteractionRef.current = performance.now();
    const startRot = rotationRef.current;
    const startScale = scaleRef.current;
    const endRot = [lambda, phi, 0];
    const endScale = targetScale != null ? targetScale : startScale;
    const interpRot = d3.interpolate(startRot, endRot);
    const interpScale = d3.interpolate(startScale, endScale);
    const t0 = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - t0) / dur);
      const eased = d3.easeCubicInOut(t);
      rotationRef.current = interpRot(eased);
      scaleRef.current = interpScale(eased);
      lastInteractionRef.current = performance.now();
      tick();
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ── When selectedId changes externally, rotate to centre that incident
  useEffect(() => {
    if (!selectedId) return;
    const inc = visibleIncidents.find(i => i._id === selectedId);
    if (!inc || typeof inc.latitude !== "number" || typeof inc.longitude !== "number") return;
    const [lng, lat] = coordFor(inc);
    rotateGlobeTo(-lng, -lat, 1200, Math.max(scaleRef.current, 380));
  }, [selectedId]);

  // ── Graticule
  const graticule = useMemo(() => d3.geoGraticule10(), []);

  // ── Visible-hemisphere test for point culling
  function isVisible(lng, lat) {
    const [rLng, rLat] = rotationRef.current;
    const toRad = Math.PI / 180;
    const c1 = Math.cos(lat * toRad);
    const x1 = c1 * Math.cos(lng * toRad);
    const y1 = c1 * Math.sin(lng * toRad);
    const z1 = Math.sin(lat * toRad);
    const lng2 = -rLng;
    const lat2 = -rLat;
    const c2 = Math.cos(lat2 * toRad);
    const x2 = c2 * Math.cos(lng2 * toRad);
    const y2 = c2 * Math.sin(lng2 * toRad);
    const z2 = Math.sin(lat2 * toRad);
    return (x1 * x2 + y1 * y2 + z1 * z2) > 0;
  }

  // ── Pause auto-rotation when hovered (so labels stay readable)
  function pauseAutoRotate() {
    autoRotateRef.current = false;
    lastInteractionRef.current = performance.now();
  }

  // ── Country labels — use centroid of each country, show only large-enough
  //    countries on the visible hemisphere. Fade with rotation cull.
  const countryLabels = useMemo(() => {
    if (!world || !world.features) return [];
    return world.features
      .map(f => {
        if (!f.properties || !f.properties.name) return null;
        let centroid;
        try {
          centroid = d3.geoCentroid(f);
        } catch { return null; }
        if (!centroid) return null;
        // Filter to substantial countries only (rough area heuristic)
        let bounds;
        try { bounds = d3.geoBounds(f); } catch { return null; }
        const w = Math.abs(bounds[1][0] - bounds[0][0]);
        const h = Math.abs(bounds[1][1] - bounds[0][1]);
        if (w * h < 12) return null; // skip tiny territories
        return { name: f.properties.name, lng: centroid[0], lat: centroid[1] };
      })
      .filter(Boolean);
  }, [world]);

  // ── Build a lookup of incident locations for the hover tooltip lookup
  const incLookup = useMemo(() => {
    const m = new Map();
    for (const i of visibleIncidents) m.set(i._id, i);
    return m;
  }, [visibleIncidents]);

  return (
    <div ref={wrapRef} style={{
      position: "relative",
      width: "100%",
      height: "100%",
      minHeight: 480,
      background: "#000005",
      borderRadius: 0,
      overflow: "hidden",
      border: `1px solid ${BRAND.borderSubtle}`,
    }}>
      {/* Deep space starfield behind the globe */}
      <canvas style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 0, pointerEvents: "none" }}
        ref={el => {
          if (!el || el._starsDrawn) return;
          el._starsDrawn = true;
          const ctx = el.getContext("2d");
          el.width = el.offsetWidth || 1200;
          el.height = el.offsetHeight || 800;
          for (let i = 0; i < 320; i++) {
            const x = Math.random() * el.width;
            const y = Math.random() * el.height;
            const r = Math.random() * 0.9 + 0.1;
            const opacity = Math.random() * 0.7 + 0.15;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,255,255,${opacity})`;
            ctx.fill();
          }
        }}
      />
      {/* Subtle deep-space ambient glow */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse 60% 60% at 50% 50%, rgba(30,80,160,0.08) 0%, transparent 70%)",
        zIndex: 0,
      }} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "100%", display: "block", cursor: "grab", userSelect: "none", position: "relative", zIndex: 1 }}
        onMouseEnter={pauseAutoRotate}
        onMouseLeave={() => {
          // Clear stuck hover state when cursor exits the globe SVG. Mirrors
          // the flat-map behaviour; without this, blast-radius tooltips can
          // remain pinned if cursor leaves through the iframe edge.
          setHoveredEntity(null);
          onHover(null);
        }}
      >
        <defs>
          {/* Ocean — deep satellite-blue, lit from top-left like sun */}
          <radialGradient id="globe-ocean-grad" cx="0.38" cy="0.35" r="0.65">
            <stop offset="0%"   stopColor="#1a4a8a" />
            <stop offset="40%"  stopColor="#0d2d5e" />
            <stop offset="75%"  stopColor="#071a3a" />
            <stop offset="100%" stopColor="#020b1c" />
          </radialGradient>
          {/* Atmospheric rim — cyan-blue glow like real Earth from space */}
          <radialGradient id="globe-atmosphere" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%"   stopColor="rgba(60,140,255,0)" />
            <stop offset="88%"  stopColor="rgba(60,140,255,0)" />
            <stop offset="95%"  stopColor="rgba(80,160,255,0.25)" />
            <stop offset="100%" stopColor="rgba(100,200,255,0.0)" />
          </radialGradient>
          {/* Land shading — lit from top-left, dark on far side */}
          <radialGradient id="globe-land-light" cx="0.35" cy="0.32" r="0.70">
            <stop offset="0%"   stopColor="rgba(255,255,255,0.13)" />
            <stop offset="50%"  stopColor="rgba(255,255,255,0.04)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.22)" />
          </radialGradient>
          {/* Specular glint on ocean near light source */}
          <radialGradient id="globe-ocean-specular" cx="0.32" cy="0.28" r="0.28">
            <stop offset="0%"   stopColor="rgba(120,180,255,0.18)" />
            <stop offset="100%" stopColor="rgba(120,180,255,0)" />
          </radialGradient>
          {/* Pin glow — softer Gaussian for the cinematic bloom */}
          <filter id="globe-pin-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
          {/* Heat-tier radial gradients — one per severity level. Used by
              the HEAT toggle to render density halos at each incident's
              projected position. Prefixed `globe-heat-` so the IDs don't
              collide with MapCanvas's `heat-` defs. */}
          {Object.entries(SEVERITY).map(([level, s]) => (
            <radialGradient key={level} id={`globe-heat-${level}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor={s.color} stopOpacity={0.55} />
              <stop offset="60%"  stopColor={s.color} stopOpacity={0.15} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </radialGradient>
          ))}
        </defs>

        {/* Ocean sphere */}
        <circle
          cx={CX}
          cy={CY}
          r={scaleRef.current}
          fill="url(#globe-ocean-grad)"
          stroke="rgba(255,255,255,0.04)"
          strokeWidth={0.6}
        />

        {/* Atmospheric rim halo — sits a couple of pixels larger than the
            sphere so the gold fade reads as light bleeding off the edge.
            Pointer-events disabled so it doesn't intercept clicks. */}
        <circle
          cx={CX}
          cy={CY}
          r={scaleRef.current + 3}
          fill="url(#globe-atmosphere)"
          pointerEvents="none"
        />

        {/* Graticule grid — faint blue-white lines for realism */}
        <path
          d={path(graticule) || ""}
          fill="none"
          stroke="rgba(100,160,255,0.08)"
          strokeWidth={0.35}
          opacity={1}
          pointerEvents="none"
        />

        {/* Country fills — earth-tone browns/greens, lit from top-left */}
        {world && world.features && (
          <g pointerEvents="none">
            {world.features.map((feature, i) => {
              const d = path(feature);
              if (!d) return null;
              // Subtle per-country tonal variation — cycles through earth tones
              const tones = [
                "#2d3d1e","#324020","#2a3a1c","#2e3b1d","#304220",
                "#28381b","#334521","#2b3e1e","#2f4122","#263519",
              ];
              const fill = tones[i % tones.length];
              return (
                <path
                  key={i}
                  d={d}
                  fill={fill}
                  stroke="rgba(60,80,40,0.55)"
                  strokeWidth={0.35}
                  opacity={1}
                />
              );
            })}
          </g>
        )}
        {/* Land lighting overlay — top-left lit, bottom-right shadowed */}
        <circle
          cx={CX} cy={CY} r={scaleRef.current}
          fill="url(#globe-land-light)"
          pointerEvents="none"
        />
        {/* Ocean specular glint near light source */}
        <circle
          cx={CX} cy={CY} r={scaleRef.current}
          fill="url(#globe-ocean-specular)"
          pointerEvents="none"
        />

        {/* Country labels — gated on showLabels toggle. When off, only the
            country of the selected or hovered incident shows (gold, soft).
            When on, all countries label when zoomed close enough. */}
        {(() => {
          if (!showLabels) {
            const focusInc = visibleIncidents.find(i => i._id === (selectedId || hoveredId));
            if (!focusInc) return null;
            if (typeof focusInc.latitude !== "number" || typeof focusInc.longitude !== "number") return null;
            if (!isVisible(focusInc.longitude, focusInc.latitude)) return null;
            const p = projection([focusInc.longitude, focusInc.latitude]);
            if (!p) return null;
            // Name the PLACE, not the country — see placeLabelFor().
            const place = placeLabelFor(focusInc);
            if (!place) return null;
            return (
              <g pointerEvents="none">
                <text
                  x={p[0]}
                  y={p[1] - 18}
                  textAnchor="middle"
                  fill={BRAND.gold}
                  stroke={BRAND.obsidianDeep}
                  strokeWidth={3}
                  strokeOpacity={0.7}
                  paintOrder="stroke"
                  fontFamily="Inter, sans-serif"
                  fontSize={11}
                  fontWeight={600}
                  letterSpacing="0.16em"
                  opacity={0.9}
                  style={{ textTransform: "uppercase" }}
                >
                  {place}
                </text>
              </g>
            );
          }
          // Full labels mode
          if (scaleRef.current <= 300) return null;
          return (
            <g pointerEvents="none">
              {countryLabels.map((c, i) => {
                if (!isVisible(c.lng, c.lat)) return null;
                const p = projection([c.lng, c.lat]);
                if (!p) return null;
                const opacity = Math.min(1, (scaleRef.current - 300) / 250);
                return (
                  <text
                    key={`country-${i}`}
                    x={p[0]}
                    y={p[1]}
                    textAnchor="middle"
                    fill={BRAND.textSecondary}
                    fontFamily="Inter, sans-serif"
                    fontSize={9}
                    fontWeight={500}
                    letterSpacing="0.12em"
                    opacity={opacity * 0.85}
                    style={{ textTransform: "uppercase" }}
                  >
                    {c.name}
                  </text>
                );
              })}
            </g>
          );
        })()}

        {/* City labels — gated on showLabels toggle. Off by default. */}
        {showLabels && scaleRef.current > 420 && (
          <g pointerEvents="none">
            {WORLD_CITIES.map(([name, lat, lng], i) => {
              if (!isVisible(lng, lat)) return null;
              const p = projection([lng, lat]);
              if (!p) return null;
              const opacity = Math.min(1, (scaleRef.current - 420) / 180);
              return (
                <g key={`city-${i}`} transform={`translate(${p[0]},${p[1]})`}>
                  <circle r={1.5} fill={BRAND.textMuted} opacity={opacity * 0.7} />
                  <text
                    x={4}
                    y={3}
                    fill={BRAND.textMuted}
                    fontFamily="Inter, sans-serif"
                    fontSize={9}
                    opacity={opacity}
                  >
                    {name}
                  </text>
                </g>
              );
            })}
          </g>
        )}

        {/* Blast-radius arcs — great-circle paths from incident origin to
            each related entity in blast_radius{}. Mirrors the flat view's
            data model: filtered to selected (or hovered if nothing selected),
            grouped by channel, primary = solid arc/filled dot, indirect =
            dashed arc/hollow ring. Paths are real geodesics, so they trace
            the shortest path over the sphere — the visual signature of a
            globe-based intelligence map. Back-of-globe segments are clipped
            automatically by clipAngle(90). */}
        {showBlastRadius && (() => {
          const sourceId = selectedId || hoveredId;
          if (!sourceId) return null;
          const sel = visibleIncidents.find(i => i._id === sourceId);
          if (!sel || typeof sel.latitude !== "number") return null;
          const [origLng, origLat] = coordFor(sel);
          const radius = sel.blast_radius || {};
          const arcs = [];
          for (const [channel, entities] of Object.entries(radius)) {
            if (!Array.isArray(entities)) continue;
            const channelDef = BLAST_CHANNELS[channel];
            if (!channelDef) continue;
            entities.forEach((ent, i) => {
              if (typeof ent.latitude !== "number" || typeof ent.longitude !== "number") return;
              arcs.push({
                id: `${sel._id}-${channel}-${i}`,
                from: [origLng, origLat],
                to: [ent.longitude, ent.latitude],
                channel,
                channelDef,
                entity: ent,
              });
            });
          }
          return (
            <g>
              {/* Arc paths — non-interactive */}
              <g pointerEvents="none">
                {arcs.map(arc => {
                  const geo = { type: "LineString", coordinates: [arc.from, arc.to] };
                  const d = path(geo);
                  if (!d) return null;
                  return (
                    <path
                      key={arc.id}
                      d={d}
                      fill="none"
                      stroke={arc.channelDef.color}
                      strokeWidth={arc.channelDef.width + 0.8}
                      strokeDasharray={arc.channelDef.dash === "0" ? "0" : arc.channelDef.dash}
                      strokeOpacity={Math.min(1, arc.channelDef.opacity + 0.35)}
                      strokeLinecap="round"
                    />
                  );
                })}
              </g>
              {/* Destination markers — clickable, with a generous invisible
                  hit target so the small visual dots are easy to grab. Hover
                  pauses auto-rotate and shows the entity-name tooltip. */}
              {arcs.map(arc => {
                if (!isVisible(arc.to[0], arc.to[1])) return null;
                const p = projection(arc.to);
                if (!p) return null;
                const isHovered = hoveredEntity && hoveredEntity._id === arc.id;
                const r = isHovered ? 6.5 : 4.8;
                return (
                  <g
                    key={`dest-${arc.id}`}
                    transform={`translate(${p[0]},${p[1]})`}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => {
                      pauseAutoRotate();
                      setHoveredEntity({ _id: arc.id, entity: arc.entity, channel: arc.channel, channelDef: arc.channelDef, x: p[0], y: p[1] });
                    }}
                    onMouseLeave={() => setHoveredEntity(null)}
                  >
                    {/* Invisible hit target — 12px radius so tiny dots are reachable */}
                    <circle r={12} fill="transparent" />
                    {/* Always-on soft glow so the dots read clearly on the dark globe */}
                    <circle r={r + 4} fill={arc.channelDef.color} fillOpacity={isHovered ? 0.30 : 0.18} />
                    {/* Hovered halo ring */}
                    {isHovered && (
                      <circle r={r + 5} fill="none" stroke={arc.channelDef.color} strokeWidth={1.2} strokeOpacity={0.7} />
                    )}
                    {/* Visible marker — primary = filled dot, indirect = hollow dashed ring */}
                    {arc.channelDef.kind === "primary" ? (
                      <circle
                        r={r}
                        fill={arc.channelDef.color}
                        fillOpacity={isHovered ? 1 : 0.9}
                        stroke={BRAND.obsidianDeep}
                        strokeWidth={0.6}
                      />
                    ) : (
                      <circle
                        r={r + 0.3}
                        fill="none"
                        stroke={arc.channelDef.color}
                        strokeWidth={1.3}
                        strokeDasharray="2,1.5"
                        strokeOpacity={isHovered ? 1 : 0.9}
                      />
                    )}
                  </g>
                );
              })}
            </g>
          );
        })()}

        {/* Incident pins — cinematic: a soft severity-coloured glow halo
            (the visual signature of the reference demo), then a crisp
            severity ring, then a saturated severity-coloured core. The pin
            colour now matches severity (red/orange/gold/green/grey) rather
            than category, because severity is what makes the map readable
            at a glance from a distance. Category is still surfaced in
            tooltips, sidebar, and detail panel. */}

        {/* HEAT halos — density visualisation, only when the toggle is on.
            Rendered before pins so the pins sit on top. Each halo is a
            radial gradient circle centred at the incident's projected
            screen position, sized by severity. Same `isVisible` cull as
            pins so halos don't bleed onto the back-of-globe hemisphere. */}
        {showHeat && (
          <g pointerEvents="none">
            {visibleIncidents.map(inc => {
              if (typeof inc.latitude !== "number" || typeof inc.longitude !== "number") return null;
              const [lng, lat] = coordFor(inc);
              if (!isVisible(lng, lat)) return null;
              const point = projection([lng, lat]);
              if (!point) return null;
              const sev = inc.severity || 3;
              const baseR = 14 + sev * 8;
              return (
                <circle
                  key={`globe-heat-${inc._id}`}
                  cx={point[0]}
                  cy={point[1]}
                  r={baseR}
                  fill={`url(#globe-heat-${sev})`}
                />
              );
            })}
          </g>
        )}

        <g>
          {visibleIncidents.map(inc => {
            if (typeof inc.latitude !== "number" || typeof inc.longitude !== "number") return null;
            const [lng, lat] = coordFor(inc);
            if (!isVisible(lng, lat)) return null;
            const point = projection([lng, lat]);
            if (!point) return null;
            const sev = SEVERITY[inc.severity] || SEVERITY[3];
            const cat = CATEGORIES[inc._cat] || { color: BRAND.gold };
            const isActive = hoveredId === inc._id || selectedId === inc._id;
            const isSelected = selectedId === inc._id;
            const isCritical = (inc.severity || 0) >= 5;
            const pinSize = 3 + (inc.severity || 1) * 1.2;
            return (
              <g
                key={inc._id}
                transform={`translate(${point[0]},${point[1]})`}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => { pauseAutoRotate(); onHover(inc._id); }}
                onMouseLeave={() => onHover(null)}
                onClick={() => {
                  onSelect(inc._id);
                  rotateGlobeTo(-lng, -lat, 900, Math.max(scaleRef.current, 380));
                }}
              >
                {/* Soft outer glow */}
                <circle
                  r={pinSize + 5}
                  fill={sev.color}
                  fillOpacity={isActive ? 0.22 : 0.12}
                  filter="url(#globe-pin-glow)"
                  style={{ transition: "fill-opacity 320ms cubic-bezier(0.4,0,0.2,1)" }}
                />
                {/* Idle breathing on critical pins */}
                {isCritical && !isActive && (
                  <circle r={pinSize + 4} fill="none" stroke={sev.color} strokeWidth={1} strokeOpacity={0.4}>
                    <animate attributeName="r" values={`${pinSize + 3};${pinSize + 9};${pinSize + 3}`} dur="3.5s" repeatCount="indefinite" />
                    <animate attributeName="stroke-opacity" values="0.4;0;0.4" dur="3.5s" repeatCount="indefinite" />
                  </circle>
                )}
                {/* Hover/selected pulse */}
                {isActive && (
                  <>
                    <circle r={pinSize + 6} fill="none" stroke={sev.color} strokeWidth={1.5} strokeOpacity={0.85}>
                      <animate attributeName="r" from={pinSize + 5} to={pinSize + 16} dur="1.5s" repeatCount="indefinite" />
                      <animate attributeName="stroke-opacity" from="0.85" to="0" dur="1.5s" repeatCount="indefinite" />
                    </circle>
                    {isSelected && (
                      <circle r={pinSize + 6} fill="none" stroke={sev.color} strokeWidth={1.5} strokeOpacity={0.6}>
                        <animate attributeName="r" from={pinSize + 5} to={pinSize + 20} dur="1.8s" begin="0.5s" repeatCount="indefinite" />
                        <animate attributeName="stroke-opacity" from="0.6" to="0" dur="1.8s" begin="0.5s" repeatCount="indefinite" />
                      </circle>
                    )}
                  </>
                )}
                {/* Severity ring — sits at the dot's edge with thicker stroke
                    when active for tactile feedback */}
                <circle
                  r={pinSize + 1.5}
                  fill="none"
                  stroke={sev.color}
                  strokeWidth={isActive ? 2.2 : 1.5}
                  strokeOpacity={1}
                  style={{ transition: "stroke-width 220ms cubic-bezier(0.4,0,0.2,1)" }}
                />
                {/* Core dot — scales up on hover */}
                <circle
                  r={isActive ? pinSize * 1.12 : pinSize}
                  fill={sev.color}
                  style={{ transition: "r 220ms cubic-bezier(0.4,0,0.2,1)" }}
                />
                {(inc.severity || 0) >= 4 && (
                  <circle r={pinSize * 0.45} fill="#FFFFFF" fillOpacity={0.95} />
                )}
              </g>
            );
          })}
        </g>

        {/* Hover tooltip — same shape as flat-view: cat label, sev, headline,
            entity. Positioned next to the projected pin location. */}
        {hoveredId && (() => {
          const inc = incLookup.get(hoveredId);
          if (!inc || typeof inc.latitude !== "number") return null;
          const [lng, lat] = coordFor(inc);
          if (!isVisible(lng, lat)) return null;
          const p = projection([lng, lat]);
          if (!p) return null;
          const sev = SEVERITY[inc.severity] || SEVERITY[3];
          const cat = CATEGORIES[inc._cat];
          const headline = inc.headline || "";
          const tooltipWidth = Math.min(340, Math.max(220, headline.length * 6.2));
          const tooltipHeight = 62;
          // HUD safe-zones — keeps tooltip from sliding under the control strip
          // or the LIVE / filter-chip overlays that live above the SVG.
          const HUD_TOP = 56;
          const HUD_BOTTOM = 96;
          let tx = p[0] + 14;
          let ty = p[1] - 8;
          if (tx + tooltipWidth > WIDTH - 8) tx = p[0] - tooltipWidth - 14;
          if (tx < 8) tx = 8;
          if (ty < HUD_TOP) ty = p[1] + 22;
          if (ty + tooltipHeight > HEIGHT - HUD_BOTTOM) ty = HEIGHT - HUD_BOTTOM - tooltipHeight;
          if (ty < HUD_TOP) ty = HUD_TOP;
          // Truncate headline visually
          const shownHeadline = headline.length > 56 ? headline.slice(0, 56) + "…" : headline;
          return (
            <g transform={`translate(${tx},${ty})`} pointerEvents="none">
              <rect width={tooltipWidth} height={62} fill={BRAND.obsidianElevated} stroke={BRAND.borderGold} strokeWidth={1} rx={4} fillOpacity={0.98} />
              <text x={10} y={16} fill={sev.color} fontFamily="Inter, sans-serif" fontSize={9} letterSpacing="0.08em">
                {cat?.label?.toUpperCase()} · SEV {inc.severity} · {sev.label}
              </text>
              <text x={10} y={34} fill={BRAND.white} fontFamily="Inter, sans-serif" fontSize={11} fontWeight={600}>
                {shownHeadline}
              </text>
              <text x={10} y={50} fill={BRAND.textSecondary} fontFamily="Inter, sans-serif" fontSize={10}>
                {(inc.entity || "—")}{inc.country ? ` · ${inc.country}` : ""}
              </text>
            </g>
          );
        })()}

        {/* Blast-destination entity tooltip — appears when hovering any of
            the small dots radiating from the selected/hovered incident.
            Larger than the incident tooltip because it includes the
            channel label, country, and the analyst-written `reason`. */}
        {hoveredEntity && (() => {
          const { entity: ent, channel, channelDef, x, y } = hoveredEntity;
          const name = ent.name || ent.entity || "—";
          const reason = ent.reason || "";
          const country = ent.country || "";
          const typeStr = ent.type || "";
          const shownName = name.length > 64 ? name.slice(0, 64) + "…" : name;
          // Wrap reason to multiple lines (very rough: ~62 chars per line)
          const reasonLines = [];
          if (reason) {
            const words = reason.split(/\s+/);
            let line = "";
            for (const w of words) {
              if ((line + " " + w).trim().length > 62) {
                reasonLines.push(line.trim());
                line = w;
              } else {
                line += " " + w;
              }
              if (reasonLines.length >= 3) break;
            }
            if (line && reasonLines.length < 3) reasonLines.push(line.trim());
            if (reason.split(/\s+/).length > reasonLines.join(" ").split(/\s+/).length) {
              const last = reasonLines[reasonLines.length - 1] || "";
              reasonLines[reasonLines.length - 1] = (last.length > 58 ? last.slice(0, 58) : last) + "…";
            }
          }
          // ── Geometry. We lay text out top-to-bottom and size the rect to
          //    actually contain every row. Previous code under-sized the rect
          //    so reason lines spilled past the bottom edge.
          //    Rows: [pill row · 28px] [name · 18px] [country · 16px?] [reasons · 14px each] + bottom pad
          const PAD_TOP = 10;          // pill row start
          const PILL_H = 14;
          const PILL_TO_NAME = 14;     // gap from pill bottom (y=24) to name baseline (y=38)
          const NAME_TO_COUNTRY = 14;
          const REASON_GAP = 14;
          const PAD_BOTTOM = 12;
          const pillBaselineY = PAD_TOP + 10;                 // = 20
          const nameY = pillBaselineY + PILL_TO_NAME + 4;     // = 38
          const countryY = country ? nameY + NAME_TO_COUNTRY - 2 : nameY;  // = 50 when country present
          const firstReasonY = (country ? countryY : nameY) + 14;
          const lastReasonY = firstReasonY + Math.max(0, reasonLines.length - 1) * REASON_GAP;
          const contentBottom = (reasonLines.length > 0) ? lastReasonY : (country ? countryY : nameY);
          const tooltipWidth = 380;
          const tooltipHeight = Math.ceil(contentBottom + PAD_BOTTOM);
          // ── Pill geometry — width must fit the actual label text or the
          //    pill outline visually breaks ("INDIRECT · CAPITAL" overflowed
          //    the fixed 84-px pill and ran into the type label). Approx 5.4px
          //    per char at fontSize 8 + letterSpacing 0.1em, with 14px side pad.
          const pillLabel = `${channelDef.kind === "primary" ? "DIRECT" : "INDIRECT"} · ${channelDef.label.toUpperCase()}`;
          const pillTextWidth = pillLabel.length * 5.4;
          const pillWidth = Math.ceil(pillTextWidth + 14);
          const pillX = 10;
          const pillRight = pillX + pillWidth;
          const typeX = pillRight + 8;  // 8-px gap after pill
          // HUD safe-zones (viewBox space): bottom band reserved for caption +
          // control strip (~96px), top band for LIVE counter / filter chips.
          // Keeps tooltip from sliding under chrome.
          const HUD_TOP = 56;
          const HUD_BOTTOM = 96;
          let tx = x + 14;
          let ty = y - 8;
          if (tx + tooltipWidth > WIDTH - 8) tx = x - tooltipWidth - 14;
          if (tx < 8) tx = 8;
          if (ty < HUD_TOP) ty = y + 22;
          if (ty + tooltipHeight > HEIGHT - HUD_BOTTOM) ty = HEIGHT - HUD_BOTTOM - tooltipHeight;
          if (ty < HUD_TOP) ty = HUD_TOP; // final safety clamp
          return (
            <g transform={`translate(${tx},${ty})`} pointerEvents="none">
              <rect
                width={tooltipWidth}
                height={tooltipHeight}
                fill={BRAND.obsidianElevated}
                stroke={channelDef.color}
                strokeWidth={1}
                rx={4}
                fillOpacity={0.98}
              />
              {/* Channel pill — width fits the label text so the outline
                  never breaks. Text is positioned dead-centre of the pill. */}
              <rect x={pillX} y={10} width={pillWidth} height={PILL_H} rx={2} fill={channelDef.color} fillOpacity={0.15} stroke={channelDef.color} strokeWidth={0.6} />
              <text x={pillX + pillWidth / 2} y={pillBaselineY} textAnchor="middle" fill={channelDef.color} fontFamily="Inter, sans-serif" fontSize={8} letterSpacing="0.1em">
                {pillLabel}
              </text>
              {typeStr && (() => {
                // Type label sits after the pill. Truncate if it would overflow
                // the right edge of the tooltip so it can't bleed past the rect.
                const raw = typeStr.toUpperCase().replace(/_/g, " ");
                const maxChars = Math.max(4, Math.floor((tooltipWidth - typeX - 12) / 5.2));
                const shown = raw.length > maxChars ? raw.slice(0, maxChars - 1) + "…" : raw;
                return (
                  <text x={typeX} y={pillBaselineY} fill={BRAND.textMuted} fontFamily="Inter, sans-serif" fontSize={8} letterSpacing="0.08em">
                    {shown}
                  </text>
                );
              })()}
              {/* Entity name */}
              <text x={10} y={nameY} fill={BRAND.white} fontFamily="Inter, sans-serif" fontSize={11} fontWeight={600}>
                {shownName}
              </text>
              {country && (
                <text x={10} y={countryY} fill={BRAND.textSecondary} fontFamily="Inter, sans-serif" fontSize={10}>
                  {country}
                </text>
              )}
              {/* Reason — wrapped, italic */}
              {reasonLines.map((ln, i) => (
                <text
                  key={i}
                  x={10}
                  y={firstReasonY + i * REASON_GAP}
                  fill={BRAND.textSecondary}
                  fontFamily="Inter, sans-serif"
                  fontSize={10}
                  fontStyle="italic"
                >
                  {ln}
                </text>
              ))}
            </g>
          );
        })()}
      </svg>

      {/* Cinematic vignette — radial darken at edges for filmic depth */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse 90% 70% at 50% 50%, transparent 55%, rgba(0,0,0,0.45) 100%)",
        zIndex: 2,
      }} />

      {/* Controls hint bottom-left */}
      <div style={{
        position: "absolute",
        bottom: 12,
        left: 12,
        fontFamily: "Inter, sans-serif",
        fontSize: 9,
        color: BRAND.textMuted,
        letterSpacing: "0.08em",
        pointerEvents: "none",
        zIndex: 5,
      }}>
        DRAG · SCROLL · CLICK PIN
      </div>

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGEND — categories, severity, channels
// ─────────────────────────────────────────────────────────────────────────────
function Legend({ visibleCats, showBlastRadius, showHeat, onToggleHeat, onToggleBlast }) {
  return (
    <div style={{ background: BRAND.obsidianCard, border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0, padding: 16, fontFamily: "Inter, sans-serif" }}>
      {/* Toggles */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={onToggleHeat}
          style={{ flex: 1, padding: "6px 10px", fontSize: 10, fontFamily: "Inter, sans-serif", letterSpacing: "0.06em",
            background: showHeat ? BRAND.gold : "transparent", color: showHeat ? BRAND.obsidian : BRAND.textSecondary,
            border: `1px solid ${showHeat ? BRAND.gold : BRAND.borderSubtle}`, borderRadius: 0, cursor: "pointer" }}>
          {showHeat ? "✓ HEAT" : "○ HEAT"}
        </button>
        <button onClick={onToggleBlast}
          style={{ flex: 1, padding: "6px 10px", fontSize: 10, fontFamily: "Inter, sans-serif", letterSpacing: "0.06em",
            background: showBlastRadius ? BRAND.gold : "transparent", color: showBlastRadius ? BRAND.obsidian : BRAND.textSecondary,
            border: `1px solid ${showBlastRadius ? BRAND.gold : BRAND.borderSubtle}`, borderRadius: 0, cursor: "pointer" }}>
          {showBlastRadius ? "✓ BLAST" : "○ BLAST"}
        </button>
      </div>

      {/* Severity scale */}
      <div style={{ fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontFamily: "Inter, sans-serif" }}>SEVERITY</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 18 }}>
        {[5, 4, 3, 2, 1].map(level => {
          const s = SEVERITY[level];
          return (
            <div key={level} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 0, background: s.color }} />
              <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: BRAND.textSecondary }}>{level}</span>
              <span style={{ color: BRAND.textSecondary }}>{s.label}</span>
            </div>
          );
        })}
      </div>

      {/* Visible categories */}
      <div style={{ fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontFamily: "Inter, sans-serif" }}>CATEGORIES IN VIEW</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 18 }}>
        {Array.from(visibleCats).sort().map(cat => {
          const c = CATEGORIES[cat];
          if (!c) return null;
          return (
            <div key={cat} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 0, background: c.color }} />
              <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: BRAND.textSecondary }}>{cat}</span>
              <span style={{ color: BRAND.textSecondary }}>{c.label}</span>
            </div>
          );
        })}
      </div>

      {/* Blast-radius channels */}
      {showBlastRadius && (
        <>
          <div style={{ fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6, fontFamily: "Inter, sans-serif" }}>BLAST · DIRECT</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {Object.entries(BLAST_CHANNELS).filter(([, ch]) => ch.kind === "primary").map(([k, ch]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                <svg width={22} height={8}>
                  <line x1={0} y1={4} x2={14} y2={4} stroke={ch.color} strokeWidth={ch.width} strokeDasharray={ch.dash} strokeOpacity={ch.opacity * 1.6} />
                  <circle cx={17} cy={4} r={2.5} fill={ch.color} fillOpacity={0.85} />
                </svg>
                <span style={{ color: BRAND.textSecondary }}>{ch.label}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6, fontFamily: "Inter, sans-serif" }}>BLAST · INDIRECT</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {Object.entries(BLAST_CHANNELS).filter(([, ch]) => ch.kind === "indirect").map(([k, ch]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                <svg width={22} height={8}>
                  <line x1={0} y1={4} x2={14} y2={4} stroke={ch.color} strokeWidth={ch.width} strokeDasharray={ch.dash} strokeOpacity={ch.opacity * 1.6} />
                  <circle cx={17} cy={4} r={3} fill="none" stroke={ch.color} strokeWidth={1.2} strokeDasharray="2,1.5" strokeOpacity={0.85} />
                </svg>
                <span style={{ color: BRAND.textSecondary }}>{ch.label}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INCIDENT CASCADE — manual-step carousel modelled on the GUARD Sentinel demo
// (single incident card position, top-right). One panel visible at a time;
// user advances through up to six sections with ← / → arrow buttons or the
// keyboard. Globe stays full-bleed underneath.
//
// Sequence (each section auto-skipped if its source data is empty):
//   1. Classification
//   2. Blast Radius
//   3. Peer Watchlist
//   4. Adaptive Controls
//   5. Historical Analogues
//   6. Vendor Marketplace  (newsroom mode only)
//
// Behaviour:
//   • Always starts at index 0 (Classification) on new incident
//   • Next → / Prev ← arrows advance/retreat; disabled at the ends
//   • ArrowRight / ArrowLeft keyboard keys do the same
//   • On incident change, key={incident._id} forces remount → resets to 0
//   • On close (✕ or Esc, handled by parent), the whole cascade unmounts
// ─────────────────────────────────────────────────────────────────────────────

// Defensive renderer for fields that might be plain strings OR structured
// objects. The GUARD pipeline emits some fields (velocity_signal,
//  severity_rationale, peer_watchlist entries) either
// as prose strings or as structured objects with keys like { pattern,
// count_quarter, trajectory, brief }. React throws "objects are not valid
// as a React child" if we try to render the object directly — so coerce.
function toText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(" · ");
  if (typeof v === "object") {
    if (typeof v.brief === "string") return v.brief;
    if (typeof v.description === "string") return v.description;
    if (typeof v.statement === "string") return v.statement;
    if (typeof v.text === "string") return v.text;
    if (typeof v.summary === "string") return v.summary;
    const parts = [];
    if (v.pattern) parts.push(`Pattern: ${v.pattern}`);
    if (v.trajectory) parts.push(`Trajectory: ${v.trajectory}`);
    if (v.count_quarter != null) parts.push(`Q-count: ${v.count_quarter}`);
    if (parts.length > 0) return parts.join(" · ");
    try { return JSON.stringify(v).slice(0, 200); }
    catch { return ""; }
  }
  return String(v);
}

// Shared CSS for the cascade. Keyframes are reused across the body
// components for internal row stagger; the panel itself swaps cards via a
// React-state-driven crossfade rather than CSS animation.
const CASCADE_STYLES = `
  @keyframes panelInTR { from { opacity: 0; transform: translate(28px, -10px); } to { opacity: 1; transform: translate(0, 0); } }
  @keyframes panelInTL { from { opacity: 0; transform: translate(-28px, -10px); } to { opacity: 1; transform: translate(0, 0); } }
  @keyframes panelInBR { from { opacity: 0; transform: translate(28px, 10px); } to { opacity: 1; transform: translate(0, 0); } }
  @keyframes panelInBL { from { opacity: 0; transform: translate(-28px, 10px); } to { opacity: 1; transform: translate(0, 0); } }
  @keyframes panelOutTR { from { opacity: 1; transform: translate(0,0); } to { opacity: 0; transform: translate(20px, 0); } }
  @keyframes panelOutTL { from { opacity: 1; transform: translate(0,0); } to { opacity: 0; transform: translate(-20px, 0); } }
  @keyframes panelOutBR { from { opacity: 1; transform: translate(0,0); } to { opacity: 0; transform: translate(20px, 0); } }
  @keyframes panelOutBL { from { opacity: 1; transform: translate(0,0); } to { opacity: 0; transform: translate(-20px, 0); } }
  @keyframes rowIn      { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes rowInLeft  { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes barFill    { from { width: 0; } to { width: var(--bar-w, 100%); } }

  /* Scene-panel — the shared shell for every panel in a scene. Each
     instance is positioned by a corner-specific override class below. */
  .scene-panel {
    position: fixed;
    width: 380px;
    max-height: calc(100vh - 200px);
    background: rgba(22,22,24,0.94);
    backdrop-filter: blur(22px);
    border: 1px solid rgba(252,189,0,0.20);
    border-radius:0;
    font-family: Inter, sans-serif;
    color: #FFFFFF;
    z-index: 99;
    display: flex; flex-direction: column;
    box-shadow: 0 26px 70px rgba(0,0,0,0.62);
    overflow: hidden;
  }
  /* Four corner anchors. Width varies per slot — top panels narrower so
     they don't crowd the centre, bottom panels can grow wider for the
     denser content (controls, vendors).

     Per-slot max-height: keep Classification (tr) generous because its
     content fits naturally; cap Blast Radius (tl), Outreach (br), and
     Adaptive Controls (bl) to roughly 60% of viewport so they stay
     readable without dominating the screen. Internal overflow scrolls
     inside the body. */
  .scene-panel.slot-tr { top: 128px;   right: 28px; width: 380px; }
  .scene-panel.slot-tl { top: 128px;   left:  28px; width: 360px; max-height: 60vh; }
  .scene-panel.slot-br { bottom: 28px; right: 28px; width: 380px; max-height: 60vh; }
  .scene-panel.slot-bl { bottom: 28px; left:  28px; width: 460px; max-height: 60vh; }
  /* Slide direction matched to anchor — feels like the panel "emerges"
     from its corner rather than appearing arbitrarily. */
  .scene-panel.slot-tr { animation: panelInTR 480ms cubic-bezier(0.16,1,0.3,1); }
  .scene-panel.slot-tl { animation: panelInTL 480ms cubic-bezier(0.16,1,0.3,1); }
  .scene-panel.slot-br { animation: panelInBR 480ms cubic-bezier(0.16,1,0.3,1); }
  .scene-panel.slot-bl { animation: panelInBL 480ms cubic-bezier(0.16,1,0.3,1); }
  /* When the scene transitions out, the panels slide back toward their
     respective corners — opposite directions for top vs bottom feel
     intentional rather than random. */
  .scene-panel.slot-tr.leaving { animation: panelOutTR 200ms cubic-bezier(0.4,0,0.6,1) forwards; }
  .scene-panel.slot-tl.leaving { animation: panelOutTL 200ms cubic-bezier(0.4,0,0.6,1) forwards; }
  .scene-panel.slot-br.leaving { animation: panelOutBR 200ms cubic-bezier(0.4,0,0.6,1) forwards; }
  .scene-panel.slot-bl.leaving { animation: panelOutBL 200ms cubic-bezier(0.4,0,0.6,1) forwards; }

  /* ── Mobile (<=768px): corner panels become full-width bands ──────────────
     Each scene only ever shows two panels in DIAGONAL corners (one top + one
     bottom — see scenes[] in the component), so anchoring all top panels to the
     top and all bottom panels to the bottom (both full-width) guarantees they
     never overlap. The map stays visible in the gap between them. */
  @media (max-width: 768px) {
    .scene-panel {
      width: auto !important;
      max-width: none !important;
      left: 10px !important; right: 10px !important;
      max-height: 44vh !important;
    }
    .scene-panel.slot-tr, .scene-panel.slot-tl { top: 84px !important; bottom: auto !important; }
    .scene-panel.slot-br, .scene-panel.slot-bl { bottom: 14px !important; top: auto !important; }

    /* Bottom control strip: wrap to multiple rows instead of running off-screen
       so every toggle (legend / flat-globe / view / layers) stays reachable. */
    .map-ctrl-strip {
      flex-wrap: wrap !important;
      left: 10px !important; right: 10px !important;
      max-width: calc(100vw - 20px) !important;
      justify-content: flex-start !important;
      row-gap: 6px !important;
    }
    /* Top-left filter HUD: its desktop maxWidth calc(100% - 500px) goes negative
       on a phone (collapsing the Filters button). Give it the full width. */
    .map-hud-tl { max-width: calc(100% - 40px) !important; }
  }

  .scene-panel-header {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    flex-shrink: 0;
  }
  .scene-panel-body {
    padding: 18px 22px 20px;
    overflow-y: auto;
    flex: 1 1 auto;
    /* Firefox: thin gold-tinted scrollbar */
    scrollbar-width: thin;
    scrollbar-color: rgba(252,189,0,0.30) transparent;
  }
  /* WebKit/Blink: custom thin scrollbar. The default bright white
     stripe is harsh against the dark panel — we want a quiet gold
     thumb that's only visible when actually needed. */
  /* Scrollbars hidden on the cards — clean edge, still scrollable. */
  .scene-panel-body { scrollbar-width: none; -ms-overflow-style: none; }
  .scene-panel-body::-webkit-scrollbar { width: 0; height: 0; display: none; }

  .scene-panel-footer {
    display: flex; justify-content: space-between; align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
  }
  .cascade-tag {
    font-family: 'Inter', sans-serif; font-size: 9px;
    letter-spacing: 0.18em; color: #FCBD00; text-transform: uppercase;
    font-weight: 600;
    flex: 1 1 auto; min-width: 0; line-height: 1.5;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; text-overflow: ellipsis;
  }
  .cascade-nav-btn {
    min-width: 34px; height: 28px;
    background: rgba(252,189,0,0.08);
    border: 1px solid rgba(252,189,0,0.30);
    color: #FCBD00;
    border-radius:0; cursor: pointer;
    font-family: 'Inter', sans-serif; font-size: 14px;
    line-height: 1; padding: 0 8px;
    display: inline-flex; align-items: center; justify-content: center;
    transition: all 220ms cubic-bezier(0.16,1,0.3,1);
  }
  .cascade-nav-btn:hover:not(:disabled) {
    background: rgba(252,189,0,0.18);
    border-color: #FCBD00;
    transform: translateY(-1px);
  }
  .cascade-nav-btn:disabled {
    opacity: 0.25; cursor: not-allowed;
  }
  .cascade-counter {
    font-family: 'Inter', sans-serif; font-size: 10px;
    letter-spacing: 0.10em; color: rgba(255,255,255,0.5);
  }
  .scene-close {
    width: 24px; height: 24px; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(252,189,0,0.08);
    border: 1px solid rgba(252,189,0,0.30);
    color: #FCBD00;
    border-radius:0; cursor: pointer;
    font-family: 'Inter', sans-serif; font-size: 12px;
    line-height: 1; padding: 0;
    transition: all 220ms cubic-bezier(0.16,1,0.3,1);
  }
  .scene-close:hover {
    background: rgba(252,189,0,0.18);
    border-color: #FCBD00;
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// ACCESS GATING (Phase 2) — tier-driven view splitter.
// ----------------------------------------------------------------------------
// AccessContext carries the current viewer's tier: 'public' or 'partner'.
// Mapping from AuthProvider's user-tier:
//   • anonymous / 'free'          → 'public'   (gated view — see SHAPE only)
//   • 'partner' / 'admin'         → 'partner'  (full unlocked view)
//   • ?preview=partner|public URL → overrides anything (dev/QA only)
//
// IMPORTANT: this is a VIEW-LAYER gate. A blurred DOM still contains the
// data. True public deployment must strip these fields server-side. See
// the feed_gating_spec for Phase 5 server-side payload work.
// ─────────────────────────────────────────────────────────────────────────────
const AccessContext = React.createContext("subscriber");
function useAccess() { return React.useContext(AccessContext); }

// The real number of rows a gated relation holds, whatever this reader was
// served. A free reader is sent ONE row plus the total (public.incident_teaser),
// so without this the footer would read "Showing 1 of 1" instead of "1 of 6".
function gatedTotal(incident, key, fallback) {
  const t = incident && incident._gatedTotals;
  const n = t && typeof t[key] === "number" ? t[key] : 0;
  return n > fallback ? n : fallback;
}

// GateBlock — reusable locked placeholder. Carries the count (the "shape")
// at the top so the user sees there IS something here, with the actual rows
// blurred behind a partner-only CTA. No real data inside.
function GateBlock({ title, sub, count, countLabel }) {
  return (
    <div style={{
      position: "relative", borderRadius: 0, overflow: "hidden",
      border: "1px solid rgba(252,189,0,0.3)",
      background: "rgba(8,8,8,0.6)", padding: "16px",
    }}>
      {typeof count === "number" && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 22, fontWeight: 700, color: "#FCBD00" }}>{count}</span>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, color: "rgba(255,255,255,0.5)", marginLeft: 6, letterSpacing: "0.08em", textTransform: "uppercase" }}>{countLabel}</span>
        </div>
      )}
      <div style={{ filter: "blur(5px)", userSelect: "none", pointerEvents: "none", display: "flex", flexDirection: "column", gap: 8, opacity: 0.7 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ padding: "10px 12px", background: "rgba(36,36,36,0.7)", borderRadius: 0 }}>
            <div style={{ height: 9, width: `${62 - i * 9}%`, background: "rgba(255,255,255,0.5)", borderRadius: 0, marginBottom: 6 }} />
            <div style={{ height: 7, width: "85%", background: "rgba(255,255,255,0.22)", borderRadius: 0 }} />
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, background: "rgba(8,8,8,0.45)" }}>
        <div style={{ fontSize: 20 }}>🔒</div>
        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "#FCBD00", letterSpacing: "0.06em", textTransform: "uppercase", textAlign: "center", maxWidth: 250, lineHeight: 1.5 }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", textAlign: "center", maxWidth: 250, lineHeight: 1.45 }}>{sub}</div>}

        {/* Dual CTA: Subscribe (primary) +                                 */}
        {/* Enterprise subscribe (secondary, immediate access at higher  */}
        {/* price). Gives the free user TWO unlock paths instead of one. */}
        <button
          onClick={openSubscribeModal}
          style={{
            marginTop: 6, padding: "7px 14px",
            background: "#FCBD00", color: "#1A1A1A",
            border: "1px solid #FCBD00", borderRadius: 0,
            fontFamily: "'Inter', sans-serif", fontSize: 9.5,
            letterSpacing: "0.10em", textTransform: "uppercase",
            cursor: "pointer", fontWeight: 700,
            transition: "transform 160ms ease, box-shadow 160ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 6px 16px rgba(252,189,0,0.3)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "none"; }}
        >
          Subscribe →
        </button>

        {/* "or" divider — tiny, lets the eye see two options without */}
        {/* needing them to look like equal primaries. */}
        <div style={{
          fontFamily: "'Inter', sans-serif", fontSize: 9,
          color: "rgba(255,255,255,0.35)", letterSpacing: "0.18em",
          textTransform: "uppercase", marginTop: 2,
        }}>or</div>

        {/* Enterprise subscribe link — opens /?pricing in a new tab so the */}
        {/* user doesn't lose their map state. Cheaper visually than the    */}
        {/* primary button — text link with underline-on-hover.             */}
        <a
          href="/?pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="map-touch44"
          style={{
            fontFamily: "'Inter', sans-serif", fontSize: 9.5,
            color: "rgba(255,255,255,0.7)", letterSpacing: "0.10em",
            textTransform: "uppercase", fontWeight: 600,
            textDecoration: "none", borderBottom: "1px solid rgba(255,255,255,0.25)",
            paddingBottom: 1,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#FFFFFF"; e.currentTarget.style.borderBottomColor = "#FCBD00"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(255,255,255,0.7)"; e.currentTarget.style.borderBottomColor = "rgba(255,255,255,0.25)"; }}
        >
          Subscribe Enterprise ₹14,999/mo →
        </a>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// TeaserFooter — used after the FIRST entry of a gated body when the viewer
// is on the public/free tier. Shows N-1 ghost rows (blurred shape only,
// no real data) + a count line + dual CTA (partner application + enterprise
// subscribe). Replaces the full GateBlock for free users — they now see one
// real entry as a taste, with the rest implied behind the lock.
//
// Counter line forms (concrete vs abstract noun):
//   • peers       → "5 more companies for partners"
//   • controls    → "9 more controls for partners"
//   • channels    → "5 more blast channels for partners"
//   • vendors     → "3 more vendor analyses for partners"
// ─────────────────────────────────────────────────────────────────────────
function TeaserFooter({ shown, total, itemLabel = "entries" }) {
  const remaining = Math.max(0, total - shown);
  if (remaining <= 0) return null;
  return (
    <div style={{
      position: "relative",
      marginTop: 10,
      borderRadius: 0, overflow: "hidden",
      border: "1px solid rgba(252,189,0,0.3)",
      background: "rgba(8,8,8,0.6)",
      padding: "14px 12px 12px",
    }}>
      {/* Blurred ghost rows — shape of locked content */}
      <div style={{
        filter: "blur(5px)", userSelect: "none", pointerEvents: "none",
        display: "flex", flexDirection: "column", gap: 6, opacity: 0.55,
      }}>
        {[0, 1].map(i => (
          <div key={i} style={{
            padding: "8px 10px",
            background: "rgba(36,36,36,0.7)",
                        borderRadius: 0,
          }}>
            <div style={{ height: 8, width: `${65 - i * 10}%`, background: "rgba(255,255,255,0.5)", borderRadius: 0, marginBottom: 5 }} />
            <div style={{ height: 6, width: "85%", background: "rgba(255,255,255,0.22)", borderRadius: 0 }} />
          </div>
        ))}
      </div>

      {/* Counter pill + lock icon */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 8, marginTop: 12, marginBottom: 10,
      }}>
        <span style={{ fontSize: 14 }}>🔒</span>
        <span style={{
          fontFamily: "'Inter', sans-serif", fontSize: 10.5,
          color: "#FCBD00", letterSpacing: "0.08em",
          textTransform: "uppercase", fontWeight: 600,
        }}>
          Showing 1 of {total} · {remaining} more {itemLabel} for subscribers
        </span>
      </div>

      {/* Dual CTA — same as GateBlock for consistency */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        <button
          onClick={openSubscribeModal}
          style={{
            padding: "7px 14px",
            background: "#FCBD00", color: "#1A1A1A",
            border: "1px solid #FCBD00", borderRadius: 0,
            fontFamily: "'Inter', sans-serif", fontSize: 9.5,
            letterSpacing: "0.10em", textTransform: "uppercase",
            cursor: "pointer", fontWeight: 700,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 6px 16px rgba(252,189,0,0.3)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "none"; }}
        >
          Subscribe →
        </button>
        <div style={{
          fontFamily: "'Inter', sans-serif", fontSize: 9,
          color: "rgba(255,255,255,0.35)", letterSpacing: "0.18em",
          textTransform: "uppercase",
        }}>or</div>
        <a
          href="/?pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="map-touch44"
          style={{
            fontFamily: "'Inter', sans-serif", fontSize: 9.5,
            color: "rgba(255,255,255,0.7)", letterSpacing: "0.10em",
            textTransform: "uppercase", fontWeight: 600,
            textDecoration: "none", borderBottom: "1px solid rgba(255,255,255,0.25)",
            paddingBottom: 1,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#FFFFFF"; e.currentTarget.style.borderBottomColor = "#FCBD00"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(255,255,255,0.7)"; e.currentTarget.style.borderBottomColor = "rgba(255,255,255,0.25)"; }}
        >
          Subscribe Enterprise ₹14,999/mo →
        </a>
      </div>
    </div>
  );
}

// shortEntity — collapse a verbose/overstuffed entity value down to a clean
// short name for headers. Some sweep records dump a whole description into the
// `entity` field (e.g. "npm registry (html-to-gutenberg, …) — Fake Font / …
// (DPRK-linked)"); the header only wants "npm registry". Cuts at the first
// descriptive separator, repairs common mojibake dashes/quotes, and hard-caps
// length. The full text still shows in the panel body. Safe on normal entities
// (won't split on plain hyphens like "Air-India").
function shortEntity(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  s = s.replace(/â€"|â€"|â€“/g, "—").replace(/â€œ|â€|â€/g, '"'); // mojibake repair
  s = s.split(/\s*[(—–/;|]\s*/)[0].trim();      // stop at first ( — – / ; |
  s = s.replace(/[\s,.–-]+$/, "").trim();         // tidy trailing punctuation
  if (s.length > 44) s = s.slice(0, 42).trim() + "…";
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// IncidentCascade — scene-paired panel layout modelled on the demo's
// scene flow (Classification + Controls together → Blast + Peers together
// → History + Vendors together). Two panels are visible at once, each
// anchored to a different corner. Arrows advance through scenes.
// ─────────────────────────────────────────────────────────────────────────────

// MobileIncidentCards — the phone-native incident detail. A full-screen deck of
// swipe cards (one per cascade slot: Classification, Blast Radius, Controls,
// Peers, History, Vendors). Native CSS scroll-snap drives the swipe; dots +
// arrows mirror the position. Reuses the same body components as desktop.
function MobileIncidentCards({ incident, cards, onClose, autoPlay, onSkip }) {
  const trackRef = useRef(null);
  const [idx, setIdx] = useState(0);
  const [auto, setAuto] = useState(!!autoPlay);
  const [voiceOn, setVoiceOn] = useState(false);
  const N = cards.length;

  const stopAuto = () => setAuto(false);

  // Desktop-tour-style explanation for each card type — the same plain-language
  // framing the desktop walkthrough uses, mapped to the mobile cards.
  const captionFor = (card) => {
    const L = String(card?.label || "").toUpperCase();
    if (L.includes("CLASSIF") || L.includes("INCIDENT")) return "Graded through the GUARD framework — the category and the reasoning behind it, so every incident is comparable.";
    if (L.includes("BLAST")) return "The blast radius — who else is exposed: suppliers, customers, regulators and competitive peers. Tap a ring for the named entities.";
    if (L.includes("CONTROL")) return "Adaptive controls — what should have been in place, and the concrete, testable steps that reduce the risk.";
    if (L.includes("PEER")) return "Peer watchlist — companies showing comparable risk signals. Your read-across to watch.";
    if (L.includes("HISTOR") || L.includes("ANALOG")) return "Historical analogues — has this happened before, and how it played out.";
    if (L.includes("VENDOR")) return "Who can actually help — real vendors mapped to the controls, each with an AI verdict.";
    return "This card breaks the incident down so you can act on it.";
  };

  // Narrate the active card while sound is on (guided preview), using the same
  // explanation shown on screen. The first card also reads the incident headline.
  useEffect(() => {
    if (!autoPlay || !voiceOn) return;
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return;
    const cap = captionFor(cards[idx]);
    const line = idx === 0 ? `${incident.headline}. ${cap}` : cap;
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(line);
      u.rate = 0.98; u.volume = 1;
      synth.speak(u);
    } catch { /* noop */ }
    return () => { try { synth.cancel(); } catch { /* noop */ } };
  }, [idx, voiceOn, autoPlay]);

  // Cancel any narration when paused or on unmount.
  useEffect(() => {
    if (auto) return;
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* noop */ }
  }, [auto]);

  function onScroll() {
    const el = trackRef.current; if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setIdx(prev => (i !== prev ? Math.max(0, Math.min(N - 1, i)) : prev));
  }
  function goto(i) {
    const el = trackRef.current; if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  }
  // Guided preview — auto-advance through the cards on a timer, then stop on the
  // last one. Any manual interaction (touch/arrow/dot) cancels it via stopAuto.
  useEffect(() => {
    if (!auto) return;
    if (idx >= N - 1) { setAuto(false); return; }
    const t = setTimeout(() => { setIdx(idx + 1); goto(idx + 1); }, 4200);
    return () => clearTimeout(t);
  }, [auto, idx, N]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const navBtn = (disabled) => ({
    width: 40, height: 40, borderRadius: 0, flexShrink: 0,
    background: disabled ? "rgba(255,255,255,0.04)" : "rgba(252,189,0,0.12)",
    border: `1px solid ${disabled ? "rgba(255,255,255,0.10)" : "rgba(252,189,0,0.4)"}`,
    color: disabled ? "rgba(255,255,255,0.25)" : "#FCBD00",
    fontSize: 20, lineHeight: 1, cursor: disabled ? "default" : "pointer",
  });

  return (
    <div className="mobi-incident-overlay" style={{
      position: "fixed", inset: 0, zIndex: 300, background: "#0b0b0c",
      display: "flex", flexDirection: "column", fontFamily: "Inter, sans-serif",
    }}>
      {/* Cascade keyframes (rowIn, rowInLeft, …) — the body components animate
          their rows in from opacity:0 using these. We include the stylesheet AND
          collapse the entrance animations to ~instant inside the deck, so the
          content is ALWAYS visible (the staggered fade-in is desktop polish and
          was leaving rows stuck at opacity:0 on the phone). */}
      <style>{CASCADE_STYLES}</style>
      <style>{`
        /* The body rows start at opacity:0 and fade in via the rowIn/rowInLeft
           keyframes. If the animation doesn't run (reduced-motion, a renderer
           that doesn't advance animation time, etc.) the content stays invisible.
           Match them by their inline animation name and force them visible —
           no dependence on the animation actually playing. */
        .mobi-incident-overlay [style*="rowIn"] {
          opacity: 1 !important;
          transform: none !important;
          animation: none !important;
        }
      `}</style>
      {/* Header — scene label + headline + counter + close */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 9.5, letterSpacing: "0.14em", color: "#FCBD00", textTransform: "uppercase", fontWeight: 700 }}>
            {auto ? "◆ Guided preview" : (cards[idx]?.sceneLabel || "Incident")}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>
            {incident.headline}
          </div>
        </div>
        {autoPlay && (
          <>
            <button onClick={() => setAuto(a => !a)} aria-label={auto ? "Pause" : "Play"} title={auto ? "Pause" : "Play"} style={{
              width: 34, height: 34, borderRadius: 0, flexShrink: 0,
              background: "rgba(252,189,0,0.12)", border: "1px solid rgba(252,189,0,0.4)",
              color: "#FCBD00", fontSize: 13, cursor: "pointer",
            }}>{auto ? "⏸" : "▶"}</button>
            <button onClick={() => { setVoiceOn(v => !v); }} aria-label={voiceOn ? "Sound off" : "Sound on"} title={voiceOn ? "Sound off" : "Sound on"} style={{
              width: 34, height: 34, borderRadius: 0, flexShrink: 0,
              background: voiceOn ? "rgba(252,189,0,0.12)" : "rgba(255,255,255,0.06)",
              border: `1px solid ${voiceOn ? "rgba(252,189,0,0.4)" : "rgba(255,255,255,0.14)"}`,
              color: voiceOn ? "#FCBD00" : "#fff", fontSize: 13, cursor: "pointer",
            }}>{voiceOn ? "🔊" : "🔇"}</button>
          </>
        )}
        {!autoPlay && (
          <div style={{ fontSize: 11, color: "#A8A8A8", fontWeight: 600, whiteSpace: "nowrap" }}>{idx + 1} / {N}</div>
        )}
        <button onClick={() => (onSkip || onClose)()} aria-label={autoPlay ? "Skip" : "Close"} title={autoPlay ? "Skip" : "Close"} style={{
          width: 34, height: 34, borderRadius: 0, flexShrink: 0,
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
          color: "#fff", fontSize: 18, cursor: "pointer",
        }}>×</button>
      </div>

      {/* Swipe track — each card full-width, snaps, scrolls vertically inside.
          A user touch cancels the guided auto-advance so they can take over. */}
      <div ref={trackRef} onScroll={onScroll} onPointerDown={stopAuto} style={{
        flex: "1 1 auto", display: "flex", overflowX: "auto", overflowY: "hidden",
        scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch",
      }}>
        {cards.map((card, i) => (
          <div key={`${card.slot}-${i}`} style={{
            flex: "0 0 100%", width: "100%", scrollSnapAlign: "start",
            overflowY: "auto", padding: autoPlay && auto ? "16px 16px 200px" : "16px 16px 84px",
          }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", color: "#fff", marginBottom: 14 }}>
              {card.label}
            </div>
            {card.render()}
          </div>
        ))}
      </div>

      {/* Guided-preview caption — same plain-language explanation the desktop
          tour uses for each card. Sits above the footer; only during preview. */}
      {autoPlay && auto && (
        <div style={{
          position: "absolute", left: 12, right: 12, bottom: 66, zIndex: 2,
          background: "rgba(16,16,18,0.94)", backdropFilter: "blur(10px)",
          border: "1px solid rgba(252,189,0,0.30)", borderRadius: 0,
          padding: "12px 14px", boxShadow: "0 12px 34px rgba(0,0,0,0.5)",
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#FCBD00", marginBottom: 5 }}>
            ◆ {cards[idx]?.label || "Guided preview"}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5, color: "#fff", fontWeight: 500 }}>
            {captionFor(cards[idx])}
          </div>
        </div>
      )}

      {/* Footer — arrows + dot indicator */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px calc(12px + env(safe-area-inset-bottom))",
        background: "linear-gradient(0deg, #0b0b0c 55%, transparent)", flexShrink: 0,
      }}>
        <button onClick={() => { stopAuto(); goto(Math.max(0, idx - 1)); }} disabled={idx === 0} style={navBtn(idx === 0)}>‹</button>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {cards.map((_, i) => (
            <span key={i} onClick={() => { stopAuto(); goto(i); }} style={{
              width: i === idx ? 22 : 7, height: 7, borderRadius: 0, cursor: "pointer",
              background: i === idx ? "#FCBD00" : "rgba(255,255,255,0.25)", transition: "all 180ms ease",
            }} />
          ))}
        </div>
        <button onClick={() => { stopAuto(); goto(Math.min(N - 1, idx + 1)); }} disabled={idx === N - 1} style={navBtn(idx === N - 1)} aria-label="Next scene">›</button>
      </div>
    </div>
  );
}

function IncidentCascade({ incident, viewMode, onClose, autoPlay, onSkip }) {
  if (!incident) return null;
  const sev = SEVERITY[incident.severity] || SEVERITY[3];
  const cat = CATEGORIES[incident._cat];
  const newsroomMode = viewMode === "newsroom";

  // ── Compute which sections actually have data ───────────────────────
  const blastChannels = useMemo(() => incident.blast_radius
    ? Object.entries(incident.blast_radius).filter(([, v]) => Array.isArray(v) && v.length > 0)
    : [],
    [incident]
  );
  const objs = useMemo(() => Array.isArray(incident.adaptive_objectives) ? incident.adaptive_objectives : [], [incident]);
  const masters = useMemo(() => Array.isArray(incident.adaptive_master_controls) ? incident.adaptive_master_controls : [], [incident]);
  // Adapted controls arrive under two different keys depending on the source:
  // the Supabase path (adaptive_controls table, lazily hydrated) fills
  // `adaptive_controls`, while the baked sweep files in public/sweeps/*.json
  // carry the same rows under `adaptive_controls_v2`. Only the first was read,
  // so every baked incident rendered its objectives and NOTHING else — the
  // Adaptive Controls card showed a column of OBJECTIVE chips with no DIRECT
  // rows, even though the file held 15 fully-adapted AC-* controls.
  const acts = useMemo(() => {
    if (Array.isArray(incident.adaptive_controls) && incident.adaptive_controls.length)
      return incident.adaptive_controls;
    if (Array.isArray(incident.adaptive_controls_v2) && incident.adaptive_controls_v2.length)
      return incident.adaptive_controls_v2.map(c => ({
        ...c,
        id: c.id || c.ac_id || c.control_id,
        control_kind: c.control_kind || c.kind,
      }));
    return [];
  }, [incident]);
  const bps = useMemo(() => Array.isArray(incident.best_practices) ? incident.best_practices : [], [incident]);
  const hasControls = (
    incident.if_you_operate_x_then_y || incident.severity_rationale ||
    incident.velocity_signal || incident.emerging_risk_signal ||
    objs.length > 0 || masters.length > 0 || acts.length > 0 || bps.length > 0
  );
  const history = useMemo(() => Array.isArray(incident.historical_analogues) ? incident.historical_analogues : [], [incident]);
  const vendors = useMemo(() => Array.isArray(incident.vendors) ? incident.vendors : [], [incident]);

  // ── Build scenes. Each scene is { label, slots: [{slot, panel}] }.
  // A scene is included only if it has at least one panel with data —
  // empty scenes are skipped entirely.
  const scenes = useMemo(() => {
    const all = [];

    // Scene 1: What happened + What to do about it
    // (Classification top-right, Adaptive Controls bottom-left)
    const scene1Slots = [];
    scene1Slots.push({
      slot: "slot-tr", label: "INCIDENT · CLASSIFIED",
      render: () => <ClassificationBody incident={incident} sev={sev} cat={cat} />,
    });
    if (hasControls) {
      scene1Slots.push({
        slot: "slot-bl", label: "ADAPTIVE CONTROLS",
        render: () => <AdaptiveControlsBody incident={incident} objs={objs} masters={masters} acts={acts} bps={bps}
          total={gatedTotal(incident, "adaptive_controls", acts.length)} />,
      });
    }
    if (scene1Slots.length > 0) all.push({ id: "scene1", label: "Incident & Response", slots: scene1Slots });

    // Scene 2: Who else is exposed + What to say to them
    // (Blast Radius top-left, Outreach Hooks bottom-right). Matches the
    // demo's Scene 6 + 7 pairing — blast panel stays visible while the
    // outreach panel appears alongside it, so the user sees the
    // exposed entities AND the editorial hooks to reach them in the
    // same view.
    const scene2Slots = [];
    if (blastChannels.length > 0) {
      // Eyebrow includes the incident entity name (e.g. "BLAST RADIUS ·
      // AIR INDIA 787") — matches the demo's bp-tag exactly. Falls back
      // to just "BLAST RADIUS" if no entity is available.
      const blastEntity = shortEntity(incident.entity || incident.affected_entity).toUpperCase();
      scene2Slots.push({
        slot: "slot-tl",
        label: blastEntity ? `BLAST RADIUS · ${blastEntity}` : "BLAST RADIUS",
        render: () => <BlastRadiusBody incident={incident} channels={blastChannels} />,
      });
    }
    // Peer Watchlist panel (replaces the former Outreach Hooks panel) —
    // surfaces peers showing comparable risk signals: the analyst
    // "read-across" view. Primary source is incident.peer_watchlist[];
    // when that's empty we fall back to blast_radius.competitive_peer[]
    // (which is where real sweeps carry peer entities — e.g. the Mali/JNIM
    // sweep's "Africa Corps Command" peer), so the panel never renders
    // blank when peer data exists. PeerWatchlistBody handles both shapes.
    // OutreachBody is left defined but uncalled — harmless and restorable.
    const peerList = Array.isArray(incident.peer_watchlist) ? incident.peer_watchlist : [];
    const competitivePeers = Array.isArray(incident.blast_radius?.competitive_peer)
      ? incident.blast_radius.competitive_peer
      : [];
    const peers = peerList.length > 0 ? peerList : competitivePeers;
    if (peers.length > 0) {
      scene2Slots.push({
        slot: "slot-br", label: "PEER WATCHLIST · READ-ACROSS",
        render: () => <PeerWatchlistBody peers={peers} total={gatedTotal(incident, "peer_watchlist", peers.length)} />,
      });
    }
    if (scene2Slots.length > 0) all.push({ id: "scene2", label: "Exposure & Engagement", slots: scene2Slots });

    // Scene 3: Has this happened before + Who can help
    // (Historical top-right, Vendors bottom-left). Vendors are
    // newsroom-mode only per the original product gating.
    const scene3Slots = [];
    if (history.length > 0) {
      scene3Slots.push({
        slot: "slot-tr", label: "HISTORICAL ANALOGUES",
        render: () => <HistoricalBody items={history} total={gatedTotal(incident, "historical_analogues", history.length)} />,
      });
    }
    const vendorIntel = incident.vendor_intelligence || null;
    const hasVendorIntel = vendorIntel && (
      (Array.isArray(vendorIntel.risk_coverage_vendors) && vendorIntel.risk_coverage_vendors.length > 0)
      || (Array.isArray(vendorIntel.incident_handler_vendors) && vendorIntel.incident_handler_vendors.length > 0)
    );
    // Rich vendor_intelligence is too valuable to hide behind newsroom mode —
    // show it whenever present. Simple chip view stays newsroom-gated.
    const showVendors = hasVendorIntel || (newsroomMode && vendors.length > 0);
    if (showVendors) {
      scene3Slots.push({
        slot: "slot-bl", label: "VENDORS",
        render: () => <VendorBody vendors={vendors} vendorIntel={vendorIntel} />,
      });
    }
    if (scene3Slots.length > 0) {
      // Scene 3 label adapts to what's actually inside — historical
      // analogues alone, vendors alone, or both. Avoids the
      // generic "History & Help" when only one panel is rendering.
      const hasHistory = history.length > 0;
      const hasVendors = showVendors;
      let scene3Label = "Precedent & Vendors";
      if (hasHistory && !hasVendors) scene3Label = "Historical Precedent";
      else if (!hasHistory && hasVendors) scene3Label = "Vendor Marketplace";
      all.push({ id: "scene3", label: scene3Label, slots: scene3Slots });
    }

    return all;
  }, [incident, sev, cat, blastChannels, hasControls, objs, masters, acts, bps, history, vendors, newsroomMode]);

  const [sceneIndex, setSceneIndex] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const isMobile = useIsMobile();

  // Per-scene dismissed slots. Each entry is a Set of slot keys
  // (e.g. "slot-tl", "slot-br") that the user has individually closed
  // within the current scene. Resets on every scene transition —
  // dismissals don't bleed across scenes because each scene is its
  // own chapter. If the user closes every panel in a scene, the
  // cascade auto-advances to the next scene with content.
  const [dismissedSlots, setDismissedSlots] = useState(new Set());

  // Reset dismissed slots whenever the scene index changes — each
  // scene starts fresh with all its panels visible.
  useEffect(() => {
    setDismissedSlots(new Set());
  }, [sceneIndex]);

  // Keyboard nav: ← / → step between scenes; Esc closes the cascade.
  useEffect(() => {
    function onKey(e) {
      if (e.key === "ArrowRight") { advance(1); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { advance(-1); e.preventDefault(); }
      else if (e.key === "Escape") { onClose && onClose(); e.preventDefault(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function advance(delta) {
    setSceneIndex(prev => {
      const next = prev + delta;
      if (next < 0 || next >= scenes.length) return prev;
      // Leave animation runs on current panels, then we swap. The leave
      // window must match panelOut* duration in CSS (200ms) plus a small
      // buffer so the new entry doesn't compete with the old exit.
      setLeaving(true);
      setTimeout(() => { setLeaving(false); }, 220);
      return next;
    });
  }

  // Dismiss a single panel within the current scene. If this dismissal
  // empties the scene, behavior depends on where we are:
  //   • If a next scene exists  → auto-advance (user's signaling "next")
  //   • If we're on the last scene → fully close the cascade
  function dismissSlot(slotKey) {
    setDismissedSlots(prev => {
      const newSet = new Set(prev);
      newSet.add(slotKey);
      // Check if every slot in this scene is now dismissed
      const currentSceneSlots = scenes[sceneIndex]?.slots || [];
      const allDismissed = currentSceneSlots.every(s => newSet.has(s.slot));
      if (allDismissed) {
        // Defer the decision so the dismissal animation can play
        setTimeout(() => {
          if (sceneIndex < scenes.length - 1) {
            advance(1);
          } else {
            onClose && onClose();
          }
        }, 220);
      }
      return newSet;
    });
  }

  if (scenes.length === 0) return null;

  // ── MOBILE: swipe-card deck (replaces the desktop corner panels) ──
  // Flatten every scene's slots into one card deck the user swipes through.
  // Reuses the exact same body components — just a phone-native container.
  if (isMobile) {
    const cards = scenes.flatMap(s => s.slots.map(slot => ({ ...slot, sceneLabel: s.label })));
    if (cards.length === 0) return null;
    return <MobileIncidentCards incident={incident} cards={cards} onClose={onClose} autoPlay={autoPlay} onSkip={onSkip} />;
  }

  // The teaser arrives a moment after the incident and brings its scenes with
  // it, so for one render sceneIndex can point past the end. The sibling read
  // below already used ?. — this one did not, and took the whole map down.
  // The teaser arrives a moment after the incident and brings its scenes with
  // it, and selecting another incident can shorten the list again, so for one
  // render sceneIndex can point past the end. Clamp it here rather than read
  // .slots off undefined — that took the whole map down.
  const safeIndex = Math.min(sceneIndex, scenes.length - 1);
  const currentScene = scenes[safeIndex] || { slots: [] };
  const canPrev = safeIndex > 0;
  const canNext = safeIndex < scenes.length - 1;

  // Filter out the slots the user has individually dismissed from
  // the current scene. The remaining (visible) slots are what we
  // actually render. The footer (arrows + counter) attaches to
  // whichever visible slot is rendered last so the navigation
  // controls are always present somewhere on screen.
  const visibleSlots = (currentScene.slots || []).filter(s => !dismissedSlots.has(s.slot));

  // If somehow every slot got dismissed but auto-advance hasn't
  // fired yet (mid-animation window), render nothing — avoids a
  // flash of an empty cascade.
  if (visibleSlots.length === 0) return <style>{CASCADE_STYLES}</style>;

  return (
    <>
      <style>{CASCADE_STYLES}</style>

      {visibleSlots.map((slot, slotIdx) => {
        // The footer (with arrows + counter) attaches to the LAST
        // VISIBLE panel in the scene, so the nav controls follow
        // whichever panel is still on screen even after dismissals.
        const isLastSlot = slotIdx === visibleSlots.length - 1;
        return (
          <div
            key={`${currentScene.id}-${slot.slot}`}
            className={`scene-panel ${slot.slot}${leaving ? " leaving" : ""}`}
          >
            {/* Header — section tag + per-panel close button. Each
                panel has its own × which dismisses only itself. If
                the user closes every panel in this scene, the cascade
                auto-advances to the next scene (or closes entirely
                if this was the last scene). */}
            <div className="scene-panel-header">
              <div className="cascade-tag">{slot.label}</div>
              <button
                className="scene-close"
                onClick={() => dismissSlot(slot.slot)}
                title="Close this panel (Esc to close all)"
                aria-label={`Close ${slot.label}`}
              >✕</button>
            </div>

            {/* Body — re-mounts on scene change so the row-stagger
                animations replay cleanly */}
            <div className="scene-panel-body" key={safeIndex}>
              {slot.render()}
            </div>

            {/* Footer — only on the last panel of the scene. Holds the
                scene nav arrows and counter. */}
            {isLastSlot && (
              <div className="scene-panel-footer">
                <button
                  className="cascade-nav-btn"
                  onClick={() => advance(-1)}
                  disabled={!canPrev}
                  title={canPrev ? `Previous: ${(scenes[safeIndex - 1] || {}).label || "—"}` : "Previous scene (←)"}
                  aria-label="Previous scene"
                >‹</button>
                {/* Counter — shows the CURRENT scene's meaningful label
                    on top with a quiet ordinal underneath. The user sees
                    "EXPOSURE & OUTREACH · 02 / 03" instead of a generic
                    "SCENE 02 / 03". Tooltips on the nav arrows preview
                    the destination scene's name. */}
                <span className="cascade-counter" style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.1, gap: 2 }}>
                  <span style={{
                    fontFamily: "'Inter', sans-serif", fontSize: 10,
                    color: "#FCBD00", letterSpacing: "0.14em",
                    textTransform: "uppercase", fontWeight: 600,
                  }}>
                    {(scenes[safeIndex] || {}).label || `Scene ${safeIndex + 1}`}
                  </span>
                  <span style={{
                    fontFamily: "'Inter', sans-serif", fontSize: 8,
                    color: "rgba(255,255,255,0.35)", letterSpacing: "0.10em",
                  }}>
                    {String(safeIndex + 1).padStart(2, "0")} / {String(scenes.length).padStart(2, "0")}
                  </span>
                </span>
                <button
                  className="cascade-nav-btn"
                  onClick={() => advance(1)}
                  disabled={!canNext}
                  title={canNext ? `Next: ${(scenes[safeIndex + 1] || {}).label || "—"}` : "Next scene (→)"}
                  aria-label="Next scene"
                >›</button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CARD BODIES — each returns content only, no positioning, no panel chrome.
// The carousel shell handles positioning, header, footer, transitions.
// Internal row staggering uses CSS keyframes defined in CASCADE_STYLES.
// ─────────────────────────────────────────────────────────────────────────────
// ───── 0. INCIDENT IMAGE ─────
// Pull an 11-char YouTube id out of a full URL or a bare id.
function toYouTubeId(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function MapIncidentImage({ incident, height = 150 }) {
  const [failed, setFailed] = useState(false);

  // ── Tier 1: real news-channel video. A curated video wins over any image.
  //    Sourced from incident.video_url when present, else a small curated map
  //    keyed by headline substring (same pattern as the image overrides below).
  //    DEMO: two incidents wired to Reuters footage. ──
  let videoId = toYouTubeId(incident.video_url);
  if (!videoId && incident.headline) {
    if (incident.headline.includes("Cuba's national power grid collapses")) {
      videoId = "60zKwesD9s4"; // WPLG Local 10 — Cuba hit by massive, nationwide blackout
    } else if (incident.headline.includes("Strait of Hormuz tanker traffic grinds to a halt")) {
      videoId = "WwS0CsblyVI"; // Bloomberg — Oil climbs as fresh tanker strike highlights Hormuz risks
    } else if (incident.headline.includes("Cruise Robotaxi Exit")) {
      videoId = "zEwvIpr5lns"; // Reuters — GM gives up on loss-making Cruise robotaxi business (archived sweep)
    } else if (incident.headline.includes("When the Balance Sheet Is the Breach")) {
      videoId = "YJqbDPkYQuQ"; // Reuters — Swedish battery maker Northvolt files for bankruptcy (archived sweep)
    }
  }

  if (videoId) {
    return (
      <div style={{ position: "relative", height, overflow: "hidden", borderRadius: 0, marginBottom: 14, border: "1px solid rgba(255,255,255,0.1)" }}>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1`}
          title={incident.headline || "Incident news video"}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          style={{ width: "100%", height: "100%", border: "none", display: "block", background: "#000" }}
        />
        <span style={{
          position: "absolute", top: 8, left: 8, zIndex: 2, pointerEvents: "none",
          background: "rgba(0,0,0,0.66)", color: "#fff", fontSize: 9, fontWeight: 700,
          letterSpacing: "0.1em", textTransform: "uppercase", padding: "3px 7px", borderRadius: 0,
          display: "inline-flex", alignItems: "center", gap: 5,
        }}>
          <span style={{ width: 5, height: 5, borderRadius: 0, background: "#FCBD00" }} />
          News video
        </span>
      </div>
    );
  }

  // No live generator in the browser (its free tier now refuses these requests
  // with 402): the stored picture, a hand-made one, else the category photo.
  const generatedImg = incidentImage({ id: incident.id, primary_category: incident._cat || incident.primary_category });

  // The stored picture (incidents.image_url, written once per incident by the
  // incident-images function or an admin) wins; the local overrides and the
  // on-the-fly generator only cover rows the backfill has not reached.
  let primary = incident.image_url || generatedImg;

  // Specific overrides for the images we generated locally
  if (!incident.image_url && incident.headline) {
    if (incident.headline.includes("Rocket Lab")) {
      primary = "/incidents/rocket_lab_iridium_1782896030009.png";
    } else if (incident.headline.includes("The Founder-Fused Brand")) {
      primary = "/incidents/corporate_reputation_crisis_1782896048377.png";
    } else if (incident.headline.includes("EU Anti-Subsidy Duties")) {
      primary = "/incidents/eu_chinese_ev_1782896064535.png";
    } else if (incident.headline.includes("China's Rare-Earth Valve")) {
      primary = "/incidents/rare_earth_valve_1782896707184.png";
    } else if (incident.headline.includes("When the Balance Sheet Is the Breach")) {
      primary = "/incidents/northvolt_fraud_probe_1782896738561.png";
    } else if (incident.headline.includes("Concentration-Risk Ransomware")) {
      primary = "/incidents/dealership_ransomware_1782896754530.png";
    } else if (incident.headline.includes("The Yield Trap")) {
      primary = "/incidents/yield_trap_gigafactory.png";
    } else if (incident.headline.includes("BMW–Northvolt")) {
      primary = "/incidents/bmw_northvolt_contract.png";
    } else if (incident.headline.includes("The Fuse, Not the Shot")) {
      primary = "/incidents/pentagon_catl_fuse.png";
    } else if (incident.headline.includes("SPAC-Fraud Wells Notice")) {
      primary = "/incidents/spac_fraud_faraday.png";
    } else if (incident.headline.includes("Regulatory Enforcement Sets a New Recall-Compliance Bar")) {
      primary = "/incidents/nhtsa_ford_recall.png";
    } else if (incident.headline.includes("Strategic Repricing of a Legacy-OEM EV Program")) {
      primary = "/incidents/ford_lightning_scrap.png";
    } else if (incident.headline.includes("Cruise Robotaxi Exit")) {
      primary = "/incidents/gm_cruise_exit.png";
    } else if (incident.headline.includes("First-of-Kind FTC Enforcement")) {
      primary = "/incidents/ftc_gm_onstar.png";
    } else if (incident.headline.includes("California's First Data-Minimization Strike")) {
      primary = "/incidents/california_gm_ccpa.png";
    } else if (incident.headline.includes("The Sovereign Cost Reset")) {
      primary = "/incidents/sovereign_cost_reset.png";
    } else if (incident.headline.includes("When One Country Owns the Valve")) {
      primary = "/incidents/drc_cobalt_ban.png";
    } else if (incident.headline.includes("Akira's Battery-Supply Gambit")) {
      primary = "/incidents/akira_lges_breach.png";
    }
  }

  // Branded fallback
  if (failed) {
    return (
      <div style={{
        height, width: "100%",
        background: "linear-gradient(135deg, #141417, #1A1A1A 70%)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6,
        border: "1px solid rgba(255,255,255,0.05)",
        borderRadius: 0,
        marginBottom: 14,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: 0, background: "#FCBD00" }} />
        <span style={{ color: "rgba(255,255,255,0.4)", fontWeight: 700, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase" }}>
          {incident.primary_category || "Incident"}
        </span>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", height, overflow: "hidden", borderRadius: 0, marginBottom: 14, border: "1px solid rgba(255,255,255,0.1)" }}>
      <img
        src={primary}
        alt={incident.headline || ""}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(8,8,8,0), rgba(8,8,8,0.5))" }} />
    </div>
  );
}

// ───── 1. CLASSIFICATION ─────
function ClassificationBody({ incident, sev, cat }) {
  const stats = useMemo(() => {
    // Only surface the stats trio when there are REAL impact numbers to
    // show — financial loss, records compromised, downtime, casualties.
    // Falling back to severity / country / confidence here was duplicating
    // information already shown in the severity pill and the VICTIM meta
    // block above, which made the card feel padded with redundant filler.
    // If no real impact stats exist, the trio is hidden entirely — the
    // card reads as a cleaner 2-section piece.
    const out = [];
    if (incident.financial_impact) out.push({ num: incident.financial_impact, lbl: "FINANCIAL" });
    if (incident.records_affected) out.push({ num: incident.records_affected, lbl: "RECORDS" });
    if (incident.downtime) out.push({ num: incident.downtime, lbl: "DOWNTIME" });
    if (incident.casualties) out.push({ num: incident.casualties, lbl: "CASUALTIES" });
    if (incident.affected_systems_count) out.push({ num: incident.affected_systems_count, lbl: "SYSTEMS" });
    // Only render if we have at least 2 real impact stats — a single number
    // alone looks lost.
    return out.length >= 2 ? out.slice(0, 3) : [];
  }, [incident]);

  const secondaryCats = useMemo(() => {
    if (Array.isArray(incident._secondary_cats)) return incident._secondary_cats;
    if (Array.isArray(incident.secondary_adaptive_mappings)) {
      return incident.secondary_adaptive_mappings
        .map(m => m.category || m.code || m)
        .filter(c => typeof c === "string")
        .slice(0, 4);
    }
    return [];
  }, [incident]);

  // Long dossier summaries are clamped to a few lines with a Read-more
  // toggle so the card stays compact instead of a wall of text.
  const [showFullSummary, setShowFullSummary] = useState(false);
  const summaryText = toText(incident.summary) || "";

  return (
    <>
      <div style={{
        fontFamily: "'Inter', sans-serif",
        fontWeight: 700, letterSpacing: "-0.005em",
        fontSize: 18, lineHeight: 1.25, marginBottom: 8,
      }}>
        {toText(incident.headline) || "—"}
      </div>
      {incident.summary && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 11, color: "rgba(255,255,255,0.68)",
            fontStyle: "italic", lineHeight: 1.5,
            ...(showFullSummary ? {} : {
              display: "-webkit-box", WebkitLineClamp: 5,
              WebkitBoxOrient: "vertical", overflow: "hidden",
            }),
          }}>
            "{summaryText}"
          </div>
          {summaryText.length > 320 && (
            <button className="map-readmore" onClick={() => setShowFullSummary(s => !s)} style={{
              marginTop: 5, padding: 0, background: "transparent", border: "none",
              color: BRAND.gold, fontFamily: "Inter, sans-serif", fontSize: 9.5,
              fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
              cursor: "pointer",
            }}>
              {showFullSummary ? "▲ Show less" : "▼ Read more"}
            </button>
          )}
        </div>
      )}

      {/* Render the incident-specific image or clean branded fallback */}
      <MapIncidentImage incident={incident} />

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{
          padding: "3px 10px", borderRadius: 0,
          fontFamily: "'Inter', sans-serif", fontSize: 10,
          fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase",
          color: "#1A1A1A", background: sev.color,
        }}>
          {sev.label}
        </span>
        {cat && (
          <span style={{
            padding: "3px 9px", borderRadius: 0,
            border: "1px solid rgba(252,189,0,0.30)",
            fontFamily: "'Inter', sans-serif", fontSize: 10,
            color: "#FCBD00", letterSpacing: "0.06em",
          }}>
            {incident._cat}
          </span>
        )}
        {secondaryCats.map((sc, i) => (
          <span key={i} style={{
            padding: "3px 9px", borderRadius: 0,
            border: "1px solid rgba(252,189,0,0.18)",
            fontFamily: "'Inter', sans-serif", fontSize: 10,
            color: "rgba(252,189,0,0.7)", letterSpacing: "0.06em",
          }}>
            {toText(sc)}
          </span>
        ))}
      </div>

      <div style={{ fontSize: 11 }}>
        {incident.adversary && (
          <>
            <div style={{
              fontWeight: 600, fontSize: 8, letterSpacing: "0.18em",
              color: "rgba(255,255,255,0.4)", textTransform: "uppercase",
              marginTop: 8, marginBottom: 2,
            }}>
              Adversary
            </div>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 11 }}>
              {toText(incident.adversary)}
              {incident.adversary_origin && <> &nbsp;·&nbsp; ORIGIN &nbsp;{toText(incident.adversary_origin)}</>}
            </div>
          </>
        )}
        {(incident.entity || incident.country) && (
          <>
            <div style={{
              fontWeight: 600, fontSize: 8, letterSpacing: "0.18em",
              color: "rgba(255,255,255,0.4)", textTransform: "uppercase",
              marginTop: 8, marginBottom: 2,
            }}>
              Victim
            </div>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 11 }}>
              {toText(incident.entity || "—")}
              {incident.sector && <> &nbsp;·&nbsp; {toText(incident.sector)}</>}
              {incident.country && <> &nbsp;·&nbsp; {toText(incident.country)}</>}
            </div>
          </>
        )}
      </div>

      {stats.length > 0 && (
        <div style={{
          display: "grid", gridTemplateColumns: `repeat(${stats.length}, 1fr)`,
          gap: 8, marginTop: 12, paddingTop: 12,
          borderTop: "1px solid rgba(255,255,255,0.08)",
        }}>
          {stats.map((s, i) => (
            <div key={i}>
              <div style={{
                fontFamily: "'Inter', sans-serif", fontSize: 18,
                color: "#FCBD00", fontWeight: 600, lineHeight: 1.1,
              }}>{toText(s.num)}</div>
              <div style={{
                fontSize: 8, fontWeight: 600, letterSpacing: "0.16em",
                color: "rgba(255,255,255,0.4)", textTransform: "uppercase",
                marginTop: 3,
              }}>{s.lbl}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ───── 2. BLAST RADIUS ─────
// Demo-faithful compact ring-list. The blast panel shows ONE row per
// ring (6 rings max), each row a 4-column grid:
//
//   num   RING NAME         org1 · org2 · org3       +N
//
// Per-entity detail (impact_rationale, mechanism, recommended action)
// is intentionally NOT in this panel — that depth lives in the audit
// drawer and (for the top 3 entities) in the Outreach Hooks panel.
// The blast panel itself is about BREADTH: who is in the radius,
// grouped by ring type, at a single glance.
function BlastRadiusBody({ incident, channels }) {
  const totalEntities = channels.reduce((acc, [, ents]) => acc + ents.length, 0);
  const ringCount = channels.length;
  // Watchlist-hit count must match what the Peer Watchlist panel renders:
  // peer_watchlist[] when present, else blast_radius.competitive_peer[].
  // Counting only peer_watchlist[] showed "0 hits" next to a populated
  // panel on sweeps (e.g. Rosneft) that carry peers under competitive_peer.
  const watchlistHits = (() => {
    const pw = Array.isArray(incident.peer_watchlist) ? incident.peer_watchlist : [];
    if (pw.length > 0) return pw.length;
    const cp = Array.isArray(incident.blast_radius?.competitive_peer) ? incident.blast_radius.competitive_peer : [];
    return cp.length;
  })();

  // Which ring is expanded for detail view? Null = none. Click a row
  // to reveal the per-entity rich detail (impact rationale, mechanism,
  // horizon, recommended action) for that ring. Click again to collapse.
  const [expandedRing, setExpandedRing] = useState(null);
  const tier = useAccess();

  // Impact score → traffic-light colours for the IMPACT N/5 badge in
  // the expanded view. Same palette as the audit drawer so the same
  // entity reads identically across surfaces.
  function impactColors(score) {
    if (typeof score !== "number") return null;
    if (score >= 4) return { bg: "#FF3B3022", fg: "#FF6B6B", bd: "#FF6B6B55" };
    if (score >= 3) return { bg: "#FF8C5A22", fg: "#FF8C5A", bd: "#FF8C5A55" };
    return { bg: "#34C75922", fg: "#34C759", bd: "#34C75955" };
  }

  return (
    <>
      {/* Title — Inter bold anchor matching the demo's "Who else
          should care." headline */}
      <div style={{
        fontFamily: "'Inter', sans-serif",
        fontWeight: 700, letterSpacing: "-0.005em",
        fontSize: 22, marginBottom: 12, lineHeight: 1.2,
      }}>
        Who else should care.
      </div>

      {/* Stats trio — Named accounts / Ring types / Watchlist hits.
          3-col grid with top/bottom borders, identical to the demo's
          .bp-stats pattern. */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10,
        padding: "10px 0", margin: "10px 0 14px",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
      }}>
        <Stat n={totalEntities} l="Named accounts" />
        <Stat n={ringCount} l="Ring types" />
        <Stat n={watchlistHits} l="Watchlist hits" />
      </div>

      {/* Tap-to-expand hint — small mono caps line above the ring
          list. Tells the user the rows are interactive without
          shouting it. */}
      <div style={{
        fontFamily: "'Inter', sans-serif", fontSize: 8,
        color: "rgba(255,255,255,0.35)", letterSpacing: "0.14em",
        textTransform: "uppercase", fontWeight: 600,
        marginBottom: 6,
      }}>
        {tier === "public"
          ? "Named entities · why · what to do — subscriber access"
          : "Tap a ring to see why · who · when · what to do"}
      </div>

      {/* Ring list — one compact row per channel. 4-column grid:
          number, ring name, comma-separated orgs, count.
          Each ring renders the first ~3 org names inline; the rest
          surface as "+N" on the right edge. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {channels.map(([channelKey, entities], chIdx) => {
          const ch = BLAST_CHANNELS[channelKey] || { label: channelKey.replace(/_/g, " "), color: "#FCBD00" };
          // Take the first 3 org names for the inline list — keeps the
          // row to roughly one line per ring. Anything beyond surfaces
          // as the +N count on the right.
          const orgNames = entities
            .slice(0, 3)
            .map(e => typeof e === "string" ? e : (e && (e.name || e.entity)))
            .filter(Boolean);
          const rowDelay = 250 + chIdx * 140;
          const isExpanded = expandedRing === channelKey;
          return (
            <div key={channelKey}>
              {/* Clickable row. Hover changes background subtly; the
                  chevron rotates 90° when expanded so users see the
                  state without reading. */}
              <div
                onClick={() => {
                  // Teaser model: first channel is the public reveal — let
                  // public viewers expand it to see real entity detail.
                  // Other channels stay click-blocked (TeaserFooter is the
                  // CTA path for those).
                  if (tier === "public" && chIdx > 0) return;
                  setExpandedRing(isExpanded ? null : channelKey);
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "14px 22px 96px 1fr 32px",
                  gap: 8, alignItems: "center",
                  padding: "8px 4px",
                  borderTop: chIdx === 0 ? "none" : "1px solid rgba(255,255,255,0.04)",
                  cursor: (tier === "public" && chIdx > 0) ? "not-allowed" : "pointer",
                  borderRadius: 0,
                  background: isExpanded ? "rgba(252,189,0,0.05)" : "transparent",
                  transition: "background 180ms cubic-bezier(0.16,1,0.3,1)",
                  opacity: 0,
                  animation: `rowInLeft 500ms cubic-bezier(0.16,1,0.3,1) ${rowDelay}ms forwards`,
                }}
                onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = "transparent"; }}
              >
                {/* Disclosure chevron — rotates 90° when row is open */}
                <span style={{
                  fontFamily: "'Inter', sans-serif", fontSize: 9,
                  color: isExpanded ? "#FCBD00" : "rgba(255,255,255,0.4)",
                  transform: isExpanded ? "rotate(90deg)" : "rotate(0)",
                  transition: "transform 220ms cubic-bezier(0.16,1,0.3,1), color 220ms",
                  display: "inline-block", textAlign: "center",
                }}>▸</span>
                {/* Number — small gold mono, 01–06 padded */}
                <span style={{
                  fontFamily: "'Inter', sans-serif", fontSize: 11,
                  color: "#FCBD00", fontWeight: 600,
                }}>
                  {String(chIdx + 1).padStart(2, "0")}
                </span>
                {/* Ring name — uppercase mono, channel-coloured for tonal
                    variety (matches the channel's blast-arc colour on the
                    map so the panel and the map speak the same visual
                    language) */}
                <span style={{
                  fontFamily: "'Inter', sans-serif", fontSize: 9,
                  color: ch.color, letterSpacing: "0.12em",
                  textTransform: "uppercase", fontWeight: 600,
                  lineHeight: 1.3,
                }}>
                  {ch.label}
                </span>
                {/* Inline org list — italic Inter, secondary white. The
                    italic is exactly how the demo renders ring-orgs. */}
                <span style={{
                  fontSize: 11, color: "rgba(255,255,255,0.75)",
                  fontStyle: "italic", lineHeight: 1.4,
                  overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {tier === "public" && chIdx > 0
                    ? "•••••  ·  •••••  ·  •••••"
                    : (orgNames.length > 0 ? orgNames.join(" · ") : "—")}
                </span>
                {/* Count — total entities in this ring, gold mono,
                    right-aligned. Matches the demo's "+5 / +4 / +3"
                    pattern where the number is the FULL ring size, not
                    "extras beyond inline". The inline org list is a
                    preview; this count is the truth. */}
                <span style={{
                  fontFamily: "'Inter', sans-serif", fontSize: 11,
                  color: "#FCBD00", fontWeight: 600, textAlign: "right",
                }}>
                  +{entities.length}
                </span>
              </div>

              {/* Expanded entity detail — slides in below the clicked
                  row. Shows EVERY entity in this ring with its full
                  impact rationale, transmission mechanism, horizon, and
                  recommended action. This is the "where do I see the
                  details" answer. */}
              {isExpanded && (
                <div style={{
                  padding: "10px 8px 12px 30px",
                  borderLeft: `2px solid ${ch.color}`,
                  marginLeft: 11,
                  marginBottom: 8,
                  display: "flex", flexDirection: "column", gap: 8,
                  animation: "rowIn 320ms cubic-bezier(0.16,1,0.3,1) both",
                }}>
                  {entities.map((ent, entIdx) => {
                    // Strings (rare schema shape) — render as one-liner
                    if (typeof ent === "string") {
                      return (
                        <div key={entIdx} style={{
                          fontSize: 12, color: "#FFFFFF",
                          padding: "8px 10px",
                          background: "rgba(36,36,36,0.6)",
                          borderRadius: 0,
                        }}>{ent}</div>
                      );
                    }
                    const horizon = IMPACT_HORIZONS[ent.impact_horizon];
                    const mechanism = TRANSMISSION_MECHANISMS[ent.transmission_mechanism];
                    const impactCol = impactColors(ent.impact_score);
                    const showAction = typeof ent.impact_score === "number" && ent.impact_score >= 4 && ent.recommended_action_for_them;
                    const rationale = ent.impact_rationale || ent.reason;
                    return (
                      <div key={entIdx} style={{
                        padding: "10px 11px",
                        background: "rgba(36,36,36,0.6)",
                        borderRadius: 0,
                      }}>
                        {/* Row 1: name + impact badge */}
                        <div style={{
                          display: "flex", justifyContent: "space-between",
                          alignItems: "flex-start", gap: 8,
                          marginBottom: ent.country ? 2 : 7,
                        }}>
                          <div style={{
                            fontSize: 12.5, color: "#FFFFFF", fontWeight: 600,
                            lineHeight: 1.25, flex: 1, minWidth: 0,
                          }}>
                            {toText(ent.name || ent.entity || "—")}
                          </div>
                          {impactCol && (
                            <span style={{
                              flexShrink: 0,
                              padding: "1px 6px", borderRadius: 0,
                              fontFamily: "'Inter', sans-serif", fontSize: 8.5,
                              fontWeight: 600, letterSpacing: "0.08em",
                              background: impactCol.bg, color: impactCol.fg,
                              border: `1px solid ${impactCol.bd}`,
                            }}>
                              IMPACT {ent.impact_score}/5
                            </span>
                          )}
                        </div>
                        {/* Country — subtle mono caps under name */}
                        {ent.country && (
                          <div style={{
                            fontFamily: "'Inter', sans-serif", fontSize: 8.5,
                            color: "rgba(255,255,255,0.4)", letterSpacing: "0.04em",
                            marginBottom: 7,
                          }}>
                            {toText(ent.country)}
                          </div>
                        )}
                        {/* Rationale — the WHY paragraph */}
                        {rationale && (
                          <div style={{
                            fontSize: 11, color: "rgba(255,255,255,0.85)",
                            lineHeight: 1.5,
                            marginBottom: (mechanism || horizon) ? 8 : (showAction ? 9 : 0),
                          }}>
                            {toText(rationale)}
                          </div>
                        )}
                        {/* Mechanism + horizon chips on one row */}
                        {(mechanism || horizon) && (
                          <div style={{
                            display: "flex", gap: 5, flexWrap: "wrap",
                            marginBottom: showAction ? 9 : 0,
                          }}>
                            {mechanism && (
                              <span style={{
                                padding: "2px 6px", borderRadius: 0,
                                border: `1px solid ${ch.color}44`,
                                fontFamily: "'Inter', sans-serif", fontSize: 7.5,
                                color: ch.color, letterSpacing: "0.10em",
                                textTransform: "uppercase",
                              }}>
                                ↬ {mechanism.label}
                              </span>
                            )}
                            {horizon && (
                              <span style={{
                                padding: "2px 6px", borderRadius: 0,
                                border: "1px solid rgba(252,189,0,0.30)",
                                fontFamily: "'Inter', sans-serif", fontSize: 7.5,
                                color: "#FCBD00", letterSpacing: "0.10em",
                                textTransform: "uppercase",
                              }}>
                                ⏱ {horizon.label}
                              </span>
                            )}
                          </div>
                        )}
                        {/* Recommended action callout (impact ≥ 4 only) */}
                        {showAction && (
                          <div style={{
                            padding: "6px 9px",
                            background: "rgba(252,189,0,0.06)",
                                                        borderRadius: 0,
                            fontSize: 10.5, lineHeight: 1.5,
                          }}>
                            <div style={{
                              fontFamily: "'Inter', sans-serif", fontSize: 7.5,
                              color: "#FCBD00", letterSpacing: "0.14em",
                              textTransform: "uppercase", fontWeight: 600,
                              marginBottom: 2,
                            }}>Recommended</div>
                            <div style={{ color: "#FFFFFF" }}>
                              {toText(ent.recommended_action_for_them)}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {tier === "public" && channels.length > 1 && (
          <TeaserFooter shown={1} total={channels.length} itemLabel="blast channels" />
        )}
      </div>
    </>
  );
}

function Stat({ n, l }) {
  return (
    <div>
      <div style={{
        fontFamily: "'Inter', sans-serif", fontSize: 22,
        color: "#FCBD00", fontWeight: 600, lineHeight: 1.1,
      }}>{n}</div>
      <div style={{
        fontSize: 8, fontWeight: 600, letterSpacing: "0.14em",
        color: "rgba(255,255,255,0.4)", textTransform: "uppercase",
        marginTop: 3,
      }}>{l}</div>
    </div>
  );
}

// ───── 3. PEER WATCHLIST ─────
// ───── 3. PEER WATCHLIST ─────
// "Companies showing similar risk" — companies that aren't directly in
// this incident's blast radius, but show similar trajectory / pattern in
// their own data. The WHY is the most important content here, so the
// rationale gets prominent placement (not buried as italic footer text).
function PeerWatchlistBody({ peers, total }) {
  const tier = useAccess();
  // TEASER MODEL — public/free viewers see ONE peer fully rendered (real
  // name, why they share the risk, etc.) and a TeaserFooter showing
  // "N-1 more for partners". Partners see up to 6 rows as before. This
  // converts better than full lock because the user gets a taste of the
  // data quality before deciding to apply.
  const isPublic = tier === "public";
  const visiblePeers = isPublic ? peers.slice(0, 1) : peers.slice(0, 6);
  return (
    <>
      <div style={{
        fontFamily: "'Inter', sans-serif",
        fontWeight: 700, letterSpacing: "-0.005em",
        fontSize: 22, marginBottom: 4,
      }}>
        Companies showing similar risk.
      </div>
      <div style={{
        fontSize: 11.5, color: "rgba(255,255,255,0.6)",
        fontStyle: "italic", lineHeight: 1.5, marginBottom: 14,
      }}>
        {isPublic
          ? "Peers tracking comparable signals — first reveal shown, rest subscriber only."
          : "Peers tracking comparable signals in their own activity — read-across to watch."}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {visiblePeers.map((p, i) => {
          const rowDelay = 200 + i * 100;
          const isStr = typeof p === "string";

          // ── Field extraction — handles BOTH real schemas ──────────────
          // peer_watchlist[] entries carry: name, country, exposure_reason,
          //   confidence, source_anchor{citation,url}.
          // blast_radius.competitive_peer[] entries carry: name, type,
          //   country, reason, impact_score (2-5), impact_rationale,
          //   transmission_mechanism, impact_horizon,
          //   recommended_action_for_them, attacked_ai_product_hook{cta_label},
          //   confidence, source_anchor.
          // We surface every field that exists; missing ones just don't render.
          const name = isStr ? p : (p.name || p.entity || p.pattern || "—");
          const country = !isStr ? (p.country || null) : null;

          // WHY this peer shares the risk. peer_watchlist → exposure_reason;
          // competitive_peer → reason (the trade-reported linkage) with
          // impact_rationale as a secondary fallback. Legacy fields kept.
          const why = !isStr ? (
            p.exposure_reason || p.reason || p.impact_rationale ||
            p.brief || p.rationale || p.description || p.pattern_description
          ) : null;

          // WHAT TO DO — the analyst action. Shown as its own line so it is
          // no longer swallowed by the "why" fallback (the previous bug).
          const action = !isStr ? (p.recommended_action_for_them || null) : null;
          // Only show action if it isn't literally the same string as why.
          const showAction = action && action !== why;

          // Attacked.ai product hook CTA (greyteaming / wargaming etc.)
          const hook = !isStr && p.attacked_ai_product_hook && typeof p.attacked_ai_product_hook === "object"
            ? p.attacked_ai_product_hook : null;
          const hookCta = hook && (hook.cta_label || hook.label) ? (hook.cta_label || hook.label) : null;

          // Analytical chips — real schema fields (transmission mechanism,
          // impact horizon, competitor type). Replace the old pattern/traj
          // chips, which don't exist in this schema.
          const mechanism = !isStr && p.transmission_mechanism ? p.transmission_mechanism : null;
          const horizon = !isStr && p.impact_horizon ? p.impact_horizon : null;
          const peerType = !isStr && p.type && p.type !== "competitor" ? p.type : null;

          // Confidence badge — HIGH / MEDIUM / DIRECTIONAL / CONFIRMED.
          const conf = !isStr && p.confidence ? String(p.confidence).toUpperCase() : null;
          const confStyle = (() => {
            switch (conf) {
              case "CONFIRMED": return { color: "#FF6B6B", bg: "#FF3B3022", bd: "#FF6B6B55" };
              case "HIGH":      return { color: "#FF8C5A", bg: "#FF8C5A22", bd: "#FF8C5A55" };
              case "MEDIUM":    return { color: "#FCBD00", bg: "#FCBD0022", bd: "#FCBD0055" };
              case "DIRECTIONAL": return { color: "#34C759", bg: "#34C75922", bd: "#34C75955" };
              default:          return conf ? { color: "#9D7BEC", bg: "#9D7BEC22", bd: "#9D7BEC55" } : null;
            }
          })();

          // Signal-strength bar — driven by the REAL impact_score (2-5) on
          // competitive_peer entries. peer_watchlist has no score, so the bar
          // is simply omitted there. impact_score 5 → 100%, 2 → 40%.
          const score = !isStr && typeof p.impact_score === "number" ? p.impact_score : null;
          const pct = score != null ? Math.min(100, Math.max(0, Math.round((score / 5) * 100))) : null;
          const barColor = pct == null ? "#FCBD00"
            : pct >= 80 ? "#FF6B6B" : pct >= 60 ? "#FF8C5A" : "#34C759";

          // Source citation — surfaced as a small line, with the url linked.
          const src = !isStr && p.source_anchor && typeof p.source_anchor === "object" ? p.source_anchor : null;
          const srcCitation = src ? (src.citation || src.url || null) : null;
          const srcUrl = src && typeof src.url === "string" ? src.url : null;

          return (
            <div key={i} style={{
              padding: "11px 13px",
              background: "rgba(36,36,36,0.6)",
                            borderRadius: 0,
              opacity: 0,
              animation: `rowIn 500ms cubic-bezier(0.16,1,0.3,1) ${rowDelay}ms forwards`,
            }}>
              {/* Row 1: company name (+ country) + confidence badge (right) */}
              <div style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "flex-start", gap: 10, marginBottom: 4,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: 13, color: "#FFFFFF", fontWeight: 600,
                    lineHeight: 1.3,
                  }}>{toText(name)}</div>
                  {country && (
                    <div style={{
                      fontFamily: "'Inter', sans-serif", fontSize: 9,
                      color: "rgba(255,255,255,0.4)", letterSpacing: "0.04em",
                      marginTop: 2,
                    }}>{toText(country)}</div>
                  )}
                </div>
                {conf && confStyle && (
                  <span style={{
                    flexShrink: 0,
                    padding: "2px 7px", borderRadius: 0,
                    fontFamily: "'Inter', sans-serif", fontSize: 8,
                    fontWeight: 600, letterSpacing: "0.10em",
                    background: confStyle.bg,
                    color: confStyle.color,
                    border: `1px solid ${confStyle.bd}`,
                  }}>
                    {conf}
                  </span>
                )}
              </div>

              {/* Row 2: WHY this peer is at similar risk — primary content. */}
              {why && (
                <div style={{
                  fontSize: 11.5, color: "rgba(255,255,255,0.85)",
                  lineHeight: 1.45, marginTop: 6, marginBottom: 6,
                }}>
                  {toText(why)}
                </div>
              )}

              {/* Row 3: WHAT TO DO — analyst recommended action, its own line
                  with a quiet label so it reads as guidance, not narrative. */}
              {showAction && (
                <div style={{
                  marginTop: 6, marginBottom: 6, paddingLeft: 8,
                                  }}>
                  <div style={{
                    fontFamily: "'Inter', sans-serif", fontSize: 8,
                    color: "#FCBD00", letterSpacing: "0.10em",
                    textTransform: "uppercase", marginBottom: 3,
                  }}>▸ Recommended action</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.78)", lineHeight: 1.4 }}>
                    {toText(action)}
                  </div>
                </div>
              )}

              {/* Row 4: analytical chips — transmission mechanism · impact
                  horizon · peer type. Real competitive_peer fields. */}
              {(mechanism || horizon || peerType) && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, marginBottom: pct != null ? 8 : 0 }}>
                  {mechanism && (
                    <span style={{
                      padding: "2px 7px", borderRadius: 0,
                      border: "1px solid rgba(252,189,0,0.30)",
                      fontFamily: "'Inter', sans-serif", fontSize: 8,
                      color: "#FCBD00", letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}>
                      ◇ {toText(mechanism).replace(/_/g, " ")}
                    </span>
                  )}
                  {horizon && (
                    <span style={{
                      padding: "2px 7px", borderRadius: 0,
                      border: "1px solid rgba(157,123,236,0.35)",
                      fontFamily: "'Inter', sans-serif", fontSize: 8,
                      color: "#9D7BEC", letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}>
                      ↗ {toText(horizon)} horizon
                    </span>
                  )}
                  {peerType && (
                    <span style={{
                      padding: "2px 7px", borderRadius: 0,
                      border: "1px solid rgba(255,255,255,0.15)",
                      fontFamily: "'Inter', sans-serif", fontSize: 8,
                      color: "rgba(255,255,255,0.55)", letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}>
                      {toText(peerType)}
                    </span>
                  )}
                </div>
              )}

              {/* Row 5: impact-score signal bar — only for entries that
                  carry a real impact_score (competitive_peer). */}
              {pct != null && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8, marginTop: 4,
                }}>
                  <span style={{
                    fontFamily: "'Inter', sans-serif", fontSize: 9,
                    color: "rgba(255,255,255,0.4)", letterSpacing: "0.10em",
                    textTransform: "uppercase", minWidth: 64,
                  }}>impact {score}/5</span>
                  <span style={{
                    flex: 1, height: 3,
                    background: "rgba(255,255,255,0.06)",
                    borderRadius: 0, overflow: "hidden",
                  }}>
                    <span style={{
                      display: "block", height: "100%",
                      background: barColor,
                      borderRadius: 0,
                      width: `${pct}%`,
                      animation: `barFill 800ms cubic-bezier(0.4,0,0.2,1) ${rowDelay + 250}ms both`,
                      ["--bar-w"]: `${pct}%`,
                    }} />
                  </span>
                </div>
              )}

              {/* Row 6: Attacked.ai product hook CTA — the "simulate this"
                  action that ties the peer back to a product (greyteaming
                  / wargaming). Matches the demo's ▸ CTA styling. */}
              {hookCta && (
                <div style={{
                  marginTop: 8,
                  padding: "5px 9px",
                  background: "rgba(252,189,0,0.08)",
                  border: "1px solid rgba(252,189,0,0.25)",
                  borderRadius: 0,
                  fontFamily: "'Inter', sans-serif", fontSize: 9,
                  color: "#FCBD00", letterSpacing: "0.04em",
                }}>
                  ▸ {toText(hookCta)}
                </div>
              )}

              {/* Row 7: source citation — provenance line, url linked. */}
              {srcCitation && (
                <div style={{
                  marginTop: 8, paddingTop: 7,
                  borderTop: "1px solid rgba(255,255,255,0.06)",
                  fontFamily: "'Inter', sans-serif", fontSize: 8.5,
                  color: "rgba(255,255,255,0.4)", lineHeight: 1.5,
                }}>
                  {srcUrl ? (
                    <a className="map-src" href={srcUrl} target="_blank" rel="noopener noreferrer"
                      style={{ color: "rgba(252,189,0,0.7)", textDecoration: "none" }}>
                      ⌖ {toText(srcCitation)}
                    </a>
                  ) : (
                    <span>⌖ {toText(srcCitation)}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!isPublic && peers.length > 6 && (
          <div style={{
            fontFamily: "'Inter', sans-serif", fontSize: 9,
            color: "rgba(255,255,255,0.4)", textAlign: "center",
            fontStyle: "italic", padding: "4px 0",
          }}>+ {peers.length - 6} more in audit</div>
        )}
        {isPublic && (
          <TeaserFooter shown={visiblePeers.length} total={total || peers.length} itemLabel="companies" />
        )}
      </div>
    </>
  );
}

// ───── 4. ADAPTIVE CONTROLS ─────
// Each control row shows: number, ID, statement, and a right-side stack
// of (1) control kind (DIRECT/INDIRECT/OBJECTIVE) and (2) fit pill if
// the JSON provides one. The kind classification is derived from which
// section the row came from (objectives vs masters/acts vs best practices)
// so the user always sees whether a control is direct or indirect, even
// when the JSON's `fit` field isn't populated.
function AdaptiveControlsBody({ incident, objs, masters, acts, bps, total }) {
  const rows = useMemo(() => {
    const out = [];
    // OBJ = Adaptive Objective — desired-outcome goal (not a control per se)
    objs.forEach((o, i) => out.push({
      kind: "OBJ", kindLabel: "OBJECTIVE", kindTone: "objective",
      // Baked sweeps store the semantic code on plain `id` ("CO-GEO-002");
      // the Supabase path puts it on `objective_id`. Dropping the `id` branch
      // made every baked incident fall through to the positional placeholder,
      // which is why the card read CO-1 / CO-2 / CO-3. Accept `id` only when it
      // actually looks like a code, so a numeric DB primary key never leaks in.
      id: o.objective_id || o.co_id ||
          (typeof o.id === "string" && /[A-Za-z]/.test(o.id) ? o.id : null) ||
          `CO-${i + 1}`,
      text: o.statement || o.description || (typeof o === "string" ? o : toText(o)),
      fit: o.fit || null,
    }));
    // MC = Master Control — the raw GUARD framework library.
    // DELIBERATELY NOT RENDERED: this is proprietary IP and generic boilerplate.
    // The customer sees its ADAPTED form (AC-* below), which is derived from it.
    // Provenance is preserved on each AC row via parent_mc_id (internal only).
    //
    // AC = Adaptive Controls — incident-specific, executable, from the
    // adaptive_controls table (real semantic ids like "AC-REP-020-BCH-01").
    // These replace the master controls as the DIRECT control the customer acts on.
    // DIRECT vs INDIRECT comes from the control's own nature, carried on the
    // row as `kind` (derived from the parent master control's framework
    // capability): Respond/Recover/Prevent = DIRECT (act on it now),
    // Detect/Monitor/Govern = INDIRECT (watch it, govern it).
    acts.forEach((a, i) => {
      const isIndirect = a.control_kind === "indirect";
      out.push({
        kind: "AC",
        kindLabel: (isIndirect ? "INDIRECT" : "DIRECT") + (a.layer === "secondary" ? " · SECONDARY" : ""),
        kindTone: isIndirect ? "indirect" : "direct",
        id: a.id || `AC-${i + 1}`,
        text: a.statement || a.description || (typeof a === "string" ? a : toText(a)),
        fit: a.fit || null,
      });
    });
    // Fallback: if an incident has no adapted controls yet, show nothing here
    // rather than leaking the raw master-control library to the customer.
    // BP = Best Practice (NIST/ISO clauses) — DELIBERATELY NOT RENDERED HERE.
    // They are generic public standards, not adaptive controls: putting them in
    // this panel mislabelled them, duplicated the dedicated "Reference standards"
    // section, and buried the incident-specific controls under boilerplate.
    // They still render in full in that section.
    //
    // No row cap — show every control the DB has for this incident. Some
    // incidents have 5, others have 15+; we trust the data + the panel
    // scrolls inside the cascade if it overflows.
    return out;
  }, [objs, masters, acts, bps]);

  // Fit pill colour — solid background with dark text (demo style).
  // Maps directly to the demo's pill palette: STRONG/FULL = green, PARTIAL = grey,
  // GAP/FAIL = red. The original had orange for STRONG; demo screenshot shows
  // orange for STRONG/HIGH-impact pills so we'll match it.
  const fitColor = (f) => {
    const fu = (f || "").toUpperCase();
    if (fu === "FULL" || fu === "OK")     return "#34C759";     // green = full coverage
    if (fu === "STRONG")                  return "#FF8C5A";     // orange = strong fit (demo)
    if (fu === "PARTIAL")                 return "#9A9A9A";     // grey = partial (demo)
    if (fu === "GAP" || fu === "FAIL")    return "#FF6B6B";     // red = gap
    return null;
  };

  // Kind tag style — demo-faithful solid pills. No outlines, dark text on
  // saturated background. DIRECT = bright gold (primary), INDIRECT = muted
  // grey-gold (advisory), OBJECTIVE = neutral grey (goal not action).
  const kindStyle = (tone) => {
    const base = {
      padding: "3px 9px", borderRadius: 0,
      fontFamily: "'Inter', sans-serif", fontSize: 9,
      fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase",
      textAlign: "center", border: "none",
      color: "#1A1A1A",  // demo uses dark text on solid pill
      whiteSpace: "nowrap",
    };
    if (tone === "direct")   return { ...base, background: "#FCBD00" };
    if (tone === "indirect") return { ...base, background: "rgba(252,189,0,0.55)" };
    // Opaque, NOT translucent: rgba(255,255,255,0.35) composited against
    // the dark panel behind this pill and left the dark label at 1.04:1 —
    // effectively invisible. An opaque ground makes the chip self-contained.
    return { ...base, background: "#C9C9CE", color: "#1A1A1A" }; // objective
  };

  const tier = useAccess();
  // TEASER MODEL — public/free users see ONE control rendered fully (with
  // statement + fit + kind), then a TeaserFooter showing how many more are
  // gated. Gives users a real taste of the operational depth before paywall.
  const isPublic = tier === "public";
  const visibleRows = isPublic ? rows.slice(0, 1) : rows;

  return (
    <>
      <div style={{
        fontFamily: "'Inter', sans-serif",
        fontWeight: 700, letterSpacing: "-0.005em",
        fontSize: 22, marginBottom: 14,
      }}>
        GUARD controls in scope
      </div>

      {incident.if_you_operate_x_then_y && (
        <div style={{
          padding: "10px 12px",
          background: "rgba(252,189,0,0.06)",
          border: "1px solid rgba(252,189,0,0.18)",
          borderRadius: 0, marginBottom: 14,
          fontSize: 11, lineHeight: 1.5,
          fontStyle: "italic", color: "#FFFFFF",
        }}>
          {toText(incident.if_you_operate_x_then_y)}
        </div>
      )}

      <div>
        {visibleRows.map((r, i) => {
          const fc = fitColor(r.fit);
          const rowDelay = 150 + i * 70;
          return (
            <div key={i} className="ac-row" style={{
              display: "grid", gridTemplateColumns: "28px 100px 1fr 76px",
              gap: 12,
              // Generous vertical breathing room (demo has ~14px padding
              // top/bottom per row). No top border — let whitespace separate
              // rows so the visual rhythm comes from gaps not lines.
              padding: "12px 0",
              alignItems: "center",
              opacity: 0,
              animation: `rowIn 400ms cubic-bezier(0.4,0,0.2,1) ${rowDelay}ms forwards`,
            }}>
              {/* Row number — large gold mono, vertically centred with the
                  longest line of the statement */}
              <span style={{
                fontFamily: "'Inter', sans-serif", fontSize: 14,
                fontWeight: 600, color: "#FCBD00", lineHeight: 1.4,
                alignSelf: "center",
              }}>{String(i + 1).padStart(2, "0")}</span>
              {/* Control ID — vertically centred */}
              <span style={{
                fontFamily: "'Inter', sans-serif", fontSize: 11,
                color: "#FFFFFF", fontWeight: 500,
                wordBreak: "break-word", overflowWrap: "anywhere",
                lineHeight: 1.4, alignSelf: "center",
              }}>{toText(r.id)}</span>
              {/* Statement text — full text, allowed to wrap naturally.
                  Vertically centred so single-line and multi-line both look
                  good alongside the row number and pills. */}
              <span style={{
                fontSize: 11.5, color: "rgba(255,255,255,0.85)", lineHeight: 1.5,
                wordBreak: "break-word",
                alignSelf: "center",
              }}>{toText(r.text)}</span>
              {/* Right column: kind tag + fit pill stacked, vertically
                  centred against the statement. Pills are solid demo-style
                  blocks with no outline. */}
              <div style={{
                display: "flex", flexDirection: "column", gap: 4,
                alignItems: "flex-end", alignSelf: "center",
              }}>
                <span style={kindStyle(r.kindTone)}>{r.kindLabel}</span>
                {r.fit && (
                  <span style={{
                    padding: "3px 9px", borderRadius: 0,
                    fontFamily: "'Inter', sans-serif", fontSize: 9,
                    fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase",
                    textAlign: "center", color: "#1A1A1A", border: "none",
                    background: fc || "rgba(255,255,255,0.35)",
                    whiteSpace: "nowrap",
                  }}>{r.fit}</span>
                )}
              </div>
            </div>
          );
        })}
        {isPublic && (
          <TeaserFooter shown={visibleRows.length} total={total || rows.length} itemLabel="controls" />
        )}
      </div>
    </>
  );
}

// ───── 5. HISTORICAL ANALOGUES ─────
function HistoricalBody({ items, total }) {
  return (
    <>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
        marginBottom: 14,
      }}>
        <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 20, letterSpacing: "-0.005em" }}>
          Has this happened before?
        </div>
        <span style={{
          fontFamily: "'Inter', sans-serif", fontSize: 10,
          color: "rgba(255,255,255,0.4)",
        }}>{items.length} {items.length === 1 ? "event" : "events"}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.slice(0, 4).map((h, i) => {
          const rowDelay = 150 + i * 80;
          return (
            <div key={i} style={{
              padding: "10px 12px",
              background: "rgba(36,36,36,0.7)",
              border: "1px solid rgba(255,255,255,0.08)",
                            borderRadius: 0,
              opacity: 0,
              animation: `rowInLeft 400ms cubic-bezier(0.4,0,0.2,1) ${rowDelay}ms forwards`,
            }}>
              <div style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "baseline", gap: 8, marginBottom: 4,
              }}>
                <span style={{
                  fontWeight: 700, letterSpacing: "-0.01em",
                  fontSize: 13, color: "#FFFFFF", lineHeight: 1.2,
                }}>{toText(h.event_name || h.event || h.name || "—")}</span>
                {h.year && (
                  <span style={{
                    fontFamily: "'Inter', sans-serif", fontSize: 10,
                    color: "#FCBD00", flexShrink: 0, fontWeight: 600,
                  }}>{toText(h.year)}</span>
                )}
              </div>
              {h.entity && (
                <div style={{
                  fontFamily: "'Inter', sans-serif", fontSize: 8,
                  color: "rgba(255,255,255,0.4)", letterSpacing: "0.06em",
                  marginBottom: 5, textTransform: "uppercase",
                }}>{toText(h.entity)}</div>
              )}
              {h.summary && (
                <div style={{
                  fontSize: 10.5, color: "rgba(255,255,255,0.7)",
                  lineHeight: 1.45, fontStyle: "italic",
                  marginBottom: h.outcome ? 6 : 0,
                }}>{toText(h.summary)}</div>
              )}
              {h.outcome && (
                <div style={{
                  fontSize: 10.5, color: "#FFFFFF", lineHeight: 1.45,
                  paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.08)",
                }}>
                  <span style={{
                    fontFamily: "'Inter', sans-serif", fontSize: 8,
                    color: "#FCBD00", letterSpacing: "0.12em", textTransform: "uppercase",
                    marginRight: 6, fontWeight: 600,
                  }}>Outcome</span>
                  {toText(h.outcome)}
                </div>
              )}
            </div>
          );
        })}
        {items.length > 4 && (
          <div style={{
            fontFamily: "'Inter', sans-serif", fontSize: 10,
            color: "rgba(255,255,255,0.4)", textAlign: "center", fontStyle: "italic",
          }}>+ {items.length - 4} more analogues</div>
        )}
        {total > items.length && (
          <TeaserFooter shown={items.length} total={total} itemLabel="analogues" />
        )}
      </div>
    </>
  );
}

// ───── 6. VENDOR MARKETPLACE ─────
// Two surfaces:
//   • Rich cards when incident.vendor_intelligence is present (merged-format
//     sweeps). Each card surfaces name, AI verdict /100, product link,
//     covers-controls chips, mitigation mechanism paragraph, capability
//     claims with source links + control mapping, and score rationale.
//     Editorial picks get a gold pill badge.
//   • Simple chips for plain sweeps where only contextual_vendors[] is
//     available — preserved exactly as the original layout.

function VendorSectionLabel({ children }) {
  return (
    <div style={{
      fontFamily: "'Inter', sans-serif", fontSize: 9,
      color: "#FCBD00", letterSpacing: "0.14em", textTransform: "uppercase",
      fontWeight: 600, marginBottom: 6,
    }}>{children}</div>
  );
}

function ControlChip({ id }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px",
      fontFamily: "'Inter', sans-serif", fontSize: 9.5,
      color: "rgba(255,255,255,0.92)",
      background: "rgba(252,189,0,0.06)",
      border: "1px solid rgba(252,189,0,0.28)",
      borderRadius: 0, letterSpacing: "0.04em",
    }}>
      <span style={{ color: "#FCBD00", fontSize: 8 }}>◇</span>
      {toText(id)}
    </span>
  );
}

function SourceLink({ url }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{
      fontFamily: "'Inter', sans-serif", fontSize: 9.5,
      color: "#FCBD00", textDecoration: "none", letterSpacing: "0.04em",
      marginLeft: 6, whiteSpace: "nowrap",
    }}>↗ source</a>
  );
}

function VendorRichCard({ v, idx, badge }) {
  const rowDelay = 150 + idx * 80;
  const tier = useAccess();
  const score = typeof v.ai_verdict === "number" ? Math.round(v.ai_verdict) : null;
  const controls = Array.isArray(v.covers_controls) ? v.covers_controls : [];
  const claims = Array.isArray(v.capability_claims) ? v.capability_claims : [];
  const mech = v.mitigation_mechanism && typeof v.mitigation_mechanism === "object"
    ? (v.mitigation_mechanism.summary || "")
    : (typeof v.mitigation_mechanism === "string" ? v.mitigation_mechanism : "");
  const rationale = typeof v.score_rationale === "string" ? v.score_rationale : "";
  const what = typeof v.what_they_do === "string" ? v.what_they_do : "";

  return (
    <div style={{
      padding: "14px 16px",
      background: "rgba(20,20,20,0.85)",
      border: "1px solid rgba(252,189,0,0.22)",
            borderRadius: 0,
      opacity: 0,
      animation: `rowIn 400ms cubic-bezier(0.4,0,0.2,1) ${rowDelay}ms forwards`,
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      {/* HEADER: name + badge + score */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{
              fontFamily: "Inter, sans-serif", fontSize: 16, fontWeight: 700,
              color: "#FFFFFF", letterSpacing: "-0.01em",
            }}>{toText(v.name || v.vendor_name || "Unnamed vendor")}</div>
            {badge && (
              <span style={{
                padding: "2px 8px",
                fontFamily: "'Inter', sans-serif", fontSize: 9,
                color: "#1A1A1A", background: "#FCBD00",
                borderRadius: 0, letterSpacing: "0.08em", fontWeight: 700,
                textTransform: "uppercase", whiteSpace: "nowrap",
              }}>+ {badge}</span>
            )}
          </div>
          {v.product_name && (
            v.product_url
              ? <a href={v.product_url} target="_blank" rel="noopener noreferrer" style={{
                  fontFamily: "'Inter', sans-serif", fontSize: 11,
                  color: "#FCBD00", textDecoration: "none", letterSpacing: "0.02em",
                }}>{toText(v.product_name)} ↗</a>
              : <div style={{
                  fontFamily: "'Inter', sans-serif", fontSize: 11,
                  color: "rgba(252,189,0,0.85)", letterSpacing: "0.02em",
                }}>{toText(v.product_name)}</div>
          )}
        </div>
        {score !== null && tier !== "public" && (
          <div style={{ textAlign: "right", lineHeight: 1, whiteSpace: "nowrap" }}>
            <div style={{
              fontFamily: "'Inter', sans-serif", fontSize: 22,
              color: "#FCBD00", fontWeight: 700, letterSpacing: "-0.01em",
            }}>{score}<span style={{
              fontSize: 11, color: "rgba(252,189,0,0.55)", fontWeight: 400, marginLeft: 2,
            }}>/100</span></div>
            <div style={{
              fontFamily: "'Inter', sans-serif", fontSize: 8,
              color: "rgba(255,255,255,0.45)", letterSpacing: "0.14em",
              textTransform: "uppercase", marginTop: 3,
            }}>AI Verdict</div>
          </div>
        )}
        {score !== null && tier === "public" && (
          <div style={{ flexShrink: 0, textAlign: "right", minWidth: 92 }}>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "3px 9px", borderRadius: 0,
              background: "rgba(252,189,0,0.10)", border: "1px solid rgba(252,189,0,0.4)",
            }}>
              <span style={{ fontSize: 11 }}>🔒</span>
              <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, fontWeight: 600, color: "#FCBD00", letterSpacing: "0.06em" }}>RATING</span>
            </div>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 7, color: "rgba(255,255,255,0.4)", letterSpacing: "0.08em", marginTop: 2 }}>SUBSCRIBER</div>
          </div>
        )}
      </div>

      {/* WHAT THEY DO */}
      {what && (
        <div style={{
          fontFamily: "Inter, sans-serif", fontSize: 12,
          color: "rgba(255,255,255,0.82)", lineHeight: 1.55,
        }}>{toText(what)}</div>
      )}

      {/* COVERS CONTROLS */}
      {controls.length > 0 && (
        <div>
          <VendorSectionLabel>Covers Controls</VendorSectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {controls.map((c, i) => <ControlChip key={i} id={c} />)}
          </div>
        </div>
      )}

      {/* MITIGATION MECHANISM */}
      {mech && (
        <div>
          <VendorSectionLabel>Mitigation Mechanism</VendorSectionLabel>
          <div style={{
            fontFamily: "Inter, sans-serif", fontSize: 11.5,
            color: "rgba(255,255,255,0.82)", lineHeight: 1.55,
          }}>{toText(mech)}</div>
        </div>
      )}

      {/* CAPABILITY CLAIMS */}
      {claims.length > 0 && (
        <div>
          <VendorSectionLabel>Capability Claims</VendorSectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {claims.slice(0, 4).map((c, i) => {
              const text = typeof c === "string" ? c : (c.claim || "");
              const addr = typeof c === "object" ? c.addresses_control : null;
              const src = typeof c === "object" ? c.source_url : null;
              return (
                <div key={i} style={{
                  fontFamily: "Inter, sans-serif", fontSize: 11.5,
                  color: "rgba(255,255,255,0.82)", lineHeight: 1.5,
                  display: "flex", flexDirection: "column", gap: 4,
                }}>
                  <div>
                    <span style={{ color: "#FCBD00", marginRight: 6 }}>•</span>
                    {toText(text)}
                  </div>
                  {(addr || src) && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 14, flexWrap: "wrap" }}>
                      {addr && <ControlChip id={addr} />}
                      {src && <SourceLink url={src} />}
                    </div>
                  )}
                </div>
              );
            })}
            {claims.length > 4 && (
              <div style={{
                fontFamily: "'Inter', sans-serif", fontSize: 10,
                color: "rgba(255,255,255,0.4)", fontStyle: "italic", paddingLeft: 14,
              }}>+ {claims.length - 4} more claims</div>
            )}
          </div>
        </div>
      )}

      {/* SCORE RATIONALE */}
      {rationale && (
        <div>
          <VendorSectionLabel>Score Rationale</VendorSectionLabel>
          <div style={{
            fontFamily: "Inter, sans-serif", fontSize: 11.5,
            fontStyle: "italic",
            color: "rgba(255,255,255,0.72)", lineHeight: 1.55,
          }}>{toText(rationale)}</div>
        </div>
      )}
    </div>
  );
}

function VendorBody({ vendors, vendorIntel }) {
  const tier = useAccess();
  const isPublic = tier === "public";
  // Collect rich vendors from all groups. Editorial picks + sponsored slots
  // can come as either an array OR an object keyed by vendor — normalize both.
  const asArr = v => Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : []);
  const rich = [];
  const seen = new Set();
  const push = (list, badgeFn) => {
    for (const item of asArr(list)) {
      if (!item || typeof item !== "object") continue;
      const key = item.vendor_id || item.name;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      rich.push({ v: item, badge: badgeFn ? badgeFn(item) : null });
    }
  };
  if (vendorIntel) {
    // Order matters — editorial picks lead, then risk-coverage, then incident handlers, then sponsored.
    push(vendorIntel.editorial_picks, () => "EDITORIAL PICK");
    push(vendorIntel.risk_coverage_vendors, item => item?.editorial_pick ? "EDITORIAL PICK" : null);
    push(vendorIntel.incident_handler_vendors, item => item?.editorial_pick ? "EDITORIAL PICK" : null);
    push(vendorIntel.sponsored_slots, () => "SPONSORED");
  }

  if (rich.length > 0) {
    return (
      <>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "baseline",
          marginBottom: 12,
        }}>
          <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 20, letterSpacing: "-0.005em" }}>
            Who can help.
          </div>
          <span style={{
            fontFamily: "'Inter', sans-serif", fontSize: 10,
            color: "rgba(255,255,255,0.4)",
          }}>{rich.length}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {(isPublic ? rich.slice(0, 1) : rich.slice(0, 6)).map(({ v, badge }, i) => (
            <VendorRichCard key={v.vendor_id || v.name || i} v={v} idx={i} badge={badge} />
          ))}
          {!isPublic && rich.length > 6 && (
            <div style={{
              fontFamily: "'Inter', sans-serif", fontSize: 10,
              color: "rgba(255,255,255,0.4)", textAlign: "center", fontStyle: "italic",
              paddingTop: 4,
            }}>+ {rich.length - 6} more vendors</div>
          )}
          {isPublic && rich.length > 1 && (
            <TeaserFooter shown={1} total={rich.length} itemLabel="vendor analyses" />
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
        marginBottom: 12,
      }}>
        <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 20, letterSpacing: "-0.005em" }}>
          Who can help.
        </div>
        <span style={{
          fontFamily: "'Inter', sans-serif", fontSize: 10,
          color: "rgba(255,255,255,0.4)",
        }}>{vendors.length}</span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {vendors.slice(0, 16).map((v, i) => {
          const rowDelay = 150 + i * 40;
          const name = typeof v === "string" ? v : (v.name || v.label || toText(v));
          return (
            <span key={i} style={{
              padding: "4px 10px",
              fontSize: 10,
              background: "rgba(36,36,36,0.7)",
              color: "rgba(255,255,255,0.85)",
              border: "1px solid rgba(252,189,0,0.18)",
              borderRadius: 0,
              fontFamily: "'Inter', sans-serif",
              letterSpacing: "0.04em",
              opacity: 0,
              animation: `rowIn 400ms cubic-bezier(0.4,0,0.2,1) ${rowDelay}ms forwards`,
            }}>{toText(name)}</span>
          );
        })}
        {vendors.length > 16 && (
          <span style={{
            fontFamily: "'Inter', sans-serif", fontSize: 9,
            color: "rgba(255,255,255,0.4)", padding: "4px 10px",
            fontStyle: "italic",
          }}>+ {vendors.length - 16} more</span>
        )}
      </div>
    </>
  );
}

// ───── 7. OUTREACH HOOKS ─────
// Strategic engagement intelligence — each card answers
// "what should we say or do about this exposed entity, right now?"
//
// Reads like an analyst-authored brief: entity name as hero, severity
// + ring context anchoring beneath, exposure bar as visual signal,
// operational narrative as the body, single strategic verb as the
// closing action line.
//
// Rules:
//   1. Entity name is the visual lead (Inter 16px bold)
//   2. CTAs are strategic verbs (SIMULATE, MODEL, BRIEF) — never the
//      raw product name. Buyers see operational intent, not product
//      pitch. The product is the means; the strategic action is the
//      headline.
//   3. The narrative is the heart. impact_rationale +
//      recommended_action_for_them are joined into one operational
//      brief — real analyst-written prose, never generated labels.
//   4. No product icons, no "Via Wargaming.ai", no progress-bar
//      labels that scream "data". Just signal.
//   5. Top 3 cards. Restraint is the point.
//
// Source field mapping (real fields, not placeholder hook_* labels):
//   impact_rationale            → the WHY ("Directly owns the
//                                  rulemaking docket and registrant
//                                  disclosure review workstream")
//   recommended_action_for_them → the WHAT + WHEN ("Convene
//                                  cross-divisional working group to
//                                  redraft staff comment guidance
//                                  within 30 days")
//   reason                      → legacy alias for impact_rationale
//   hook_product                → mapped to strategic verb via
//                                  PRODUCT_TO_VERB (the only hook_*
//                                  field still used)
//
// Why we don't use hook_scenario_seed or hook_cta_label: those fields
// currently contain noun-phrase topic labels generated by the
// pipeline (e.g. "SEC Corp Finance comment review gap") rather than
// analyst prose. The two real fields above carry the actual
// operational sentences the analyst wrote.

// Strategic verb mapping — abstracts product-specific pitch ("Run
// IndiGo cascade disruption sim") into operational intelligence
// language ("MODEL CASCADE EXPOSURE"). The buyer reads strategic
// action; the system handles which product fires.
const PRODUCT_TO_VERB = {
  wargaming_sim:          "SIMULATE CASCADE EXPOSURE",
  apple_supply:           "MODEL SUPPLY-CHAIN EXPOSURE",
  greyteaming:            "STAGE STAKEHOLDER SIMULATION",
  fdri_watchlist:         "MONITOR REGULATORY EXPOSURE",
  attacked_brief:         "PREPARE INTELLIGENCE BRIEF",
  replaceable_workforce:  "MODEL WORKFORCE EXPOSURE",
};

function OutreachBody({ channels }) {
  // Flatten every hook-bearing entity across rings. Each entry
  // surfaces the operational narrative (scenario_seed), the entity
  // identity (name + sub-id + ring), the severity (impact_score),
  // and the strategic verb (derived from hook_product).
  const hooks = useMemo(() => {
    const out = [];
    channels.forEach(([channelKey, entities], chIdx) => {
      const ch = BLAST_CHANNELS[channelKey];
      const ringLabel = ch ? ch.label.toUpperCase() : channelKey.replace(/_/g, " ").toUpperCase();
      entities.forEach(ent => {
        if (typeof ent !== "object" || ent == null) return;

        // Pull the REAL operational fields, not the placeholder hook_*
        // ones. impact_rationale carries the "why this entity is
        // exposed" sentence (e.g. "Directly owns the rulemaking docket
        // and registrant disclosure review workstream"). The legacy
        // `reason` field is an older alias kept as fallback.
        const rationale = ent.impact_rationale || ent.reason;
        // recommended_action_for_them carries the operational next
        // step with stakeholders and timeframes baked in (e.g.
        // "Convene cross-divisional working group to redraft staff
        // comment guidance within 30 days"). This is the analyst's
        // actual recommendation, not a generated label.
        const recommendedAction = ent.recommended_action_for_them;

        // Hooks_product is still useful — it tells us which Attacked.ai
        // product the strategic verb should map to. Accept either flat
        // or nested shape.
        const nested = ent.attacked_ai_product_hook || {};
        const productKey = ent.hook_product || nested.product;

        // Skip entities without at least one of the two real fields —
        // a card without rationale OR action has nothing operational
        // to communicate. We do NOT use hook_scenario_seed or
        // hook_cta_label as the narrative anymore (they contain
        // pipeline-generated topic labels, not analyst prose).
        if (!rationale && !recommendedAction) return;

        // Compose the narrative from the two real fields. Both
        // present → joined into one operational brief. One present
        // → use it alone. Never invents text; only joins what exists.
        let narrative;
        if (rationale && recommendedAction) {
          // Ensure rationale ends cleanly before appending the action.
          // If rationale already ends with punctuation, just append;
          // otherwise add a period.
          const trimmed = rationale.trim();
          const endsClean = /[.!?]$/.test(trimmed);
          narrative = `${trimmed}${endsClean ? "" : "."} ${recommendedAction.trim()}`;
        } else {
          narrative = (rationale || recommendedAction).trim();
        }

        // Strategic verb — derived from hook_product so the closing
        // action line reads as operational intelligence, not as a
        // product pitch. Falls back to "REVIEW EXPOSURE" if no
        // product mapping exists.
        const strategicVerb = (productKey && PRODUCT_TO_VERB[productKey]) || "REVIEW EXPOSURE";

        out.push({
          name: ent.name || ent.entity || "—",
          // Sub-identifier — ticker / sector / type / country, in
          // priority order. Matches demo's "NYSE: BA" / "Govt of
          // Dubai" / "Aviation hull market" pattern.
          sub: ent.ticker || ent.sector || ent.type || ent.country || null,
          ringIdx: chIdx + 1,
          ringLabel,
          impactScore: typeof ent.impact_score === "number" ? ent.impact_score : null,
          narrative,
          strategicVerb,
        });
      });
    });
    // Highest impact first — most urgent outreach to the top
    out.sort((a, b) => (b.impactScore || 0) - (a.impactScore || 0));
    return out;
  }, [channels]);

  // Severity pill — solid colour, dark text. Same palette as demo
  // and consistent with Blast Radius impact badges so the same
  // entity reads identically across panels.
  function sevPill(score) {
    if (typeof score !== "number") return null;
    if (score >= 5) return { label: "CRITICAL", bg: "#FF3B30" };
    if (score >= 4) return { label: "HIGH",     bg: "#FF6B6B" };
    if (score >= 3) return { label: "MEDIUM",   bg: "#FF8C5A" };
    if (score >= 2) return { label: "LOW",      bg: "#34C759" };
    return { label: "MINIMAL", bg: "rgba(255,255,255,0.30)" };
  }

  if (hooks.length === 0) return null;

  // Top 3 — cinematic restraint, matches demo's "3 / 14" pattern.
  const top = hooks.slice(0, 3);

  return (
    <>
      {/* Count badge — eyebrow lives in scene-panel header. Just the
          "3 / 14" indicator here, right-aligned, quiet. */}
      <div style={{
        display: "flex", justifyContent: "flex-end",
        alignItems: "baseline", marginBottom: 12,
      }}>
        <span style={{
          fontFamily: "'Inter', sans-serif", fontSize: 10,
          color: "rgba(255,255,255,0.4)",
        }}>{top.length} / {hooks.length}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {top.map((h, i) => {
          const rowDelay = 200 + i * 140;
          const pill = sevPill(h.impactScore);
          const pct = typeof h.impactScore === "number" ? Math.min(100, h.impactScore * 20) : null;
          return (
            <div key={i} style={{
              padding: 13,
              background: "rgba(36,36,36,0.7)",
              border: "1px solid rgba(255,255,255,0.08)",
                            borderRadius: 0,
              opacity: 0,
              animation: `rowIn 500ms cubic-bezier(0.16,1,0.3,1) ${rowDelay}ms forwards`,
            }}>
              {/* Row 1: entity name (hero) + severity pill.
                  Name takes 16px Inter bold — visual lead position. */}
              <div style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "flex-start", marginBottom: 3, gap: 10,
              }}>
                <div style={{
                  fontFamily: "Inter, sans-serif", fontWeight: 700,
                  letterSpacing: "-0.01em",
                  fontSize: 16, color: "#FFFFFF", lineHeight: 1.15,
                  flex: 1, minWidth: 0,
                }}>{toText(h.name)}</div>
                {pill && (
                  <span style={{
                    flexShrink: 0,
                    padding: "2px 8px", borderRadius: 0,
                    fontFamily: "'Inter', sans-serif", fontSize: 9,
                    fontWeight: 600, letterSpacing: "0.10em",
                    textTransform: "uppercase",
                    color: "#1A1A1A", background: pill.bg,
                    alignSelf: "flex-start",
                  }}>{pill.label}</span>
                )}
              </div>

              {/* Row 2: sub-identifier (left) + ring tag (right).
                  Tight 9px mono — institutional metadata, not
                  competing with the name. */}
              <div style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "baseline", marginBottom: 10, gap: 8,
              }}>
                <span style={{
                  fontFamily: "'Inter', sans-serif", fontSize: 9,
                  color: "rgba(255,255,255,0.45)", letterSpacing: "0.04em",
                }}>{h.sub ? toText(h.sub) : ""}</span>
                <span style={{
                  fontFamily: "'Inter', sans-serif", fontSize: 8,
                  color: "#FCBD00", letterSpacing: "0.10em",
                  textAlign: "right", fontWeight: 600,
                }}>
                  RING {String(h.ringIdx).padStart(1, "0")} · {h.ringLabel}
                </span>
              </div>

              {/* Row 3: exposure bar — visual signal only, no
                  "%" label that screams "data app". Just a quiet
                  gold bar showing severity weight. */}
              {pct != null && (
                <div style={{
                  height: 3, background: "rgba(255,255,255,0.06)",
                  borderRadius: 0, overflow: "hidden", marginBottom: 11,
                }}>
                  <div style={{
                    height: "100%", background: "#FCBD00",
                    borderRadius: 0, width: `${pct}%`,
                    animation: `barFill 800ms cubic-bezier(0.4,0,0.2,1) ${rowDelay + 200}ms both`,
                    ["--bar-w"]: `${pct}%`,
                  }} />
                </div>
              )}

              {/* Row 4: OPERATIONAL NARRATIVE — the heart of the card.
                  Quoted, italic, white, dense. Reads as analyst-authored
                  brief: time-sensitive, business-aware, executive-readable.
                  No bullets, no headers, just the narrative. */}
              {h.narrative && (
                <div style={{
                  fontFamily: "Inter, sans-serif", fontSize: 11,
                  color: "rgba(255,255,255,0.92)", fontStyle: "italic",
                  lineHeight: 1.5,
                  marginBottom: 12,
                }}>
                  &ldquo;{toText(h.narrative)}&rdquo;
                </div>
              )}

              {/* Row 5: STRATEGIC ACTION — a single mono caps line, gold,
                  subtle. Reads as the system's recommended operational
                  next-step. No button styling, no border, no icon. Just
                  the verb. The product is invisible; only the strategic
                  action is named. */}
              <div style={{
                fontFamily: "'Inter', sans-serif", fontSize: 9,
                color: "#FCBD00", letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 600,
                paddingTop: 9,
                borderTop: "1px solid rgba(255,255,255,0.05)",
              }}>
                ▸ {h.strategicVerb}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// INCIDENT DETAIL PANEL (right side, slides in on click)
// ─────────────────────────────────────────────────────────────────────────────
function IncidentPanel({ incident, reporter, viewMode, onClose }) {
  if (!incident) return null;
  const sev = SEVERITY[incident.severity] || SEVERITY[3];
  const cat = CATEGORIES[incident._cat];
  const newsroomMode = viewMode === "newsroom";

  // Accordion state: a Set of currently-expanded section IDs. Multiple
  // sections can be open at once (user decides what to compare). Resets
  // every time the incident changes; auto-opens whichever section has the
  // strongest data signal for the current incident so the user lands on
  // something useful rather than a wall of collapsed headings.
  const [openSections, setOpenSections] = useState(() => new Set());
  useEffect(() => {
    // Auto-open priority — whichever section has the strongest data signal
    // for this incident so the user lands on something useful:
    //   1. "controls"  — the full GUARD Adaptive Controls section (A through F)
    //   2. "blast"     — if blast_radius has entities
    //   3. "sources"   — fallback
    let firstOpen = "sources";
    const hasControls = (
      incident.if_you_operate_x_then_y ||
      incident.severity_rationale ||
      incident.velocity_signal ||
      incident.emerging_risk_signal ||
      (incident.adaptive_objectives?.length > 0) ||
      (incident.adaptive_master_controls?.length > 0) ||
      (incident.adaptive_controls?.length > 0) ||
      (incident.secondary_adaptive_mappings?.length > 0) ||
      (incident.best_practices?.length > 0)
    );
    if (hasControls) {
      firstOpen = "controls";
    } else if (incident.blast_radius && Object.values(incident.blast_radius).some(v => Array.isArray(v) && v.length > 0)) {
      firstOpen = "blast";
    }
    setOpenSections(new Set([firstOpen]));
  }, [incident._id || incident.headline]);

  // Local state for the Classification card's secondary mappings reveal.
  // Resets per incident so each new selection starts collapsed.
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  useEffect(() => {
    setSecondaryExpanded(false);
  }, [incident._id || incident.headline]);

  const toggleSection = (id) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div style={{
      position: "fixed",
      top: 72, right: 24, bottom: 24,
      width: "min(440px, 90vw)",
      background: "rgba(26,26,26,0.95)",
      backdropFilter: "blur(20px)",
      border: `1px solid rgba(252,189,0,0.20)`,
      borderRadius: 0,
      boxShadow: "0 22px 60px rgba(0,0,0,0.6)",
      overflowY: "auto",
      zIndex: 100,
      padding: "20px 24px 32px 24px",
      fontFamily: "Inter, sans-serif",
      animation: "slideIn 220ms cubic-bezier(0.4,0,0.2,1)",
    }}>
      <style>{`
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      `}</style>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span style={{ padding: "3px 8px", fontFamily: "Inter, sans-serif", fontSize: 9, letterSpacing: "0.08em", background: sev.color + "22", color: sev.color, border: `1px solid ${sev.color}55`, borderRadius: 0 }}>
            SEV {incident.severity} · {sev.label}
          </span>
          {cat && (
            <span style={{ padding: "3px 8px", fontFamily: "Inter, sans-serif", fontSize: 9, letterSpacing: "0.08em", background: cat.color + "22", color: cat.color, border: `1px solid ${cat.color}55`, borderRadius: 0 }}>
              {incident._cat} · {cat.label.toUpperCase()}
            </span>
          )}
          {/* Reporter chip — shows which editorial desk owns the incident */}
          {(() => {
            const rep = REPORTER_BADGES[incident.reporter];
            if (!rep && !incident.reporter) return null;
            const color = rep?.color || BRAND.gold;
            const icon = rep?.icon || "◯";
            return (
              <span title={rep?.desk || incident.desk || ""}
                style={{ padding: "3px 8px", fontFamily: "Inter, sans-serif", fontSize: 9, letterSpacing: "0.08em", background: color + "22", color: color, border: `1px solid ${color}55`, borderRadius: 0, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontSize: 10, lineHeight: 1 }}>{icon}</span>
                {(incident.reporter || "—").toUpperCase()}
              </span>
            );
          })()}
        </div>
        <button onClick={onClose}
          title="Close detail panel"
          style={{
            flexShrink: 0,
            background: "rgba(252,189,0,0.08)",
            border: `1px solid ${BRAND.borderGold}`,
            color: BRAND.gold,
            width: 32, height: 32,
            borderRadius: 0, cursor: "pointer",
            fontFamily: "Inter, sans-serif", fontSize: 16,
            lineHeight: 1,
          }}>✕</button>
      </div>

      {/* Headline */}
      <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 24, color: BRAND.white, lineHeight: 1.25, margin: "0 0 8px 0" }}>
        {incident.headline}
      </h2>

      {/* Reporter byline — desk attribution under headline */}
      {incident.reporter && (
        <div style={{ fontFamily: "Inter, sans-serif", fontSize: 11, color: BRAND.textMuted, fontStyle: "italic", marginBottom: 12 }}>
          By <span style={{ color: REPORTER_BADGES[incident.reporter]?.color || BRAND.gold, fontStyle: "normal", fontWeight: 600 }}>{incident.reporter}</span>
          {incident.desk && <span> · {incident.desk} Desk</span>}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          CLASSIFICATION CARD — always visible, the panel's anchor.
          Every field rendered comes directly from the incident JSON; nothing
          fabricated. Structure (top → bottom):

            1. Severity strip            ← uses sev.color edge + SEV N + label
                Confidence chip          ← right-aligned (incident.confidence)
            2. Primary classification    ← subcategory code pill + full name
            3. Secondary mappings        ← chips; tap "expand" to reveal each
                                            mapping's full name + why text
            4. Compact meta row          ← event_date · days_to_disclosure ·
                                            location_name (mono one-liner)
            5. Victim + Actor rows       ← entity + sector / threat_actor
            6. Summary prose             ← incident.summary
            7. Financial impact callout  ← if financial_impact_disclosed
            8. CVE chip row              ← if related_cve_ids exists
          ═══════════════════════════════════════════════════════════════════ */}
      <div style={{
        marginBottom: 14,
        background: BRAND.obsidianElevated,
        border: `1px solid ${BRAND.borderSubtle}`,
        borderRadius: 0,
        overflow: "hidden",
      }}>
        {/* ── Top header strip ──
            Severity owns the visual weight; confidence sits opposite as a
            small right-aligned indicator. The whole strip uses the severity
            color as a left edge accent so the card carries the severity
            signal at a glance. */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px 10px 12px",
          borderLeft: `3px solid ${sev.color}`,
          background: `linear-gradient(90deg, ${sev.color}10 0%, transparent 60%)`,
          borderBottom: `1px solid ${BRAND.borderSubtle}`,
        }}>
          <span style={{
            fontFamily: "Inter, sans-serif", fontSize: 10,
            color: sev.color, letterSpacing: "0.14em",
            textTransform: "uppercase", fontWeight: 700,
          }}>
            SEV {incident.severity} · {sev.label}
          </span>
          <span style={{
            fontFamily: "Inter, sans-serif", fontSize: 9,
            color: BRAND.textMuted, letterSpacing: "0.12em",
            textTransform: "uppercase", marginLeft: 4,
          }}>
            Classification
          </span>
          {incident.confidence && (
            <span style={{
              marginLeft: "auto",
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "2px 7px",
              fontFamily: "Inter, sans-serif", fontSize: 9, fontWeight: 600,
              letterSpacing: "0.10em", textTransform: "uppercase",
              color: String(incident.confidence).toLowerCase() === "high" ? "#34C759"
                   : String(incident.confidence).toLowerCase() === "medium" ? BRAND.gold
                   : BRAND.textSecondary,
              border: `1px solid ${
                String(incident.confidence).toLowerCase() === "high" ? "#34C75944"
              : String(incident.confidence).toLowerCase() === "medium" ? BRAND.gold + "44"
              : BRAND.borderSubtle}`,
              borderRadius: 0,
            }}>
              {incident.confidence} conf
            </span>
          )}
        </div>

        {/* ── Card body — primary + secondary + meta ── */}
        <div style={{ padding: "14px 16px 0 16px" }}>
          {/* Primary classification — code pill + full name */}
          {(incident.primary_subcategory_code || incident.primary_subcategory_name) && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              {incident.primary_subcategory_code && (
                <span style={{
                  padding: "3px 8px",
                  fontFamily: "Inter, sans-serif", fontSize: 10, fontWeight: 600,
                  letterSpacing: "0.06em",
                  background: (cat?.color || BRAND.gold) + "22",
                  color: cat?.color || BRAND.gold,
                  border: `1px solid ${(cat?.color || BRAND.gold)}55`,
                  borderRadius: 0,
                }}>
                  {incident.primary_subcategory_code}
                </span>
              )}
              {incident.primary_subcategory_name && (
                <span style={{ fontSize: 12, color: BRAND.white, fontWeight: 500 }}>
                  {incident.primary_subcategory_name}
                </span>
              )}
            </div>
          )}

          {/* Secondary mappings — chips with optional expand for full detail */}
          {Array.isArray(incident.secondary_mappings) && incident.secondary_mappings.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                <span style={{
                  fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.textMuted,
                  letterSpacing: "0.14em", textTransform: "uppercase", marginRight: 4,
                }}>
                  Also:
                </span>
                {incident.secondary_mappings.map((m, i) => {
                  const mc = CATEGORIES[m.category];
                  const mcColor = mc?.color || BRAND.textSecondary;
                  return (
                    <span key={i}
                      title={m.why || m.subcategory_name || ""}
                      style={{
                        padding: "2px 7px",
                        fontFamily: "Inter, sans-serif", fontSize: 9, fontWeight: 500,
                        letterSpacing: "0.06em",
                        background: mcColor + "15",
                        color: mcColor,
                        border: `1px solid ${mcColor}44`,
                        borderRadius: 0,
                      }}>
                      {m.subcategory_code || m.category}
                    </span>
                  );
                })}
                {/* Expand toggle — only shows if any mapping has a name or why */}
                {incident.secondary_mappings.some(m => m.subcategory_name || m.why) && (
                  <button
                    onClick={() => setSecondaryExpanded(v => !v)}
                    style={{
                      marginLeft: 4,
                      padding: "2px 7px",
                      fontFamily: "Inter, sans-serif", fontSize: 8,
                      letterSpacing: "0.12em", textTransform: "uppercase",
                      color: BRAND.gold,
                      background: "transparent",
                      border: `1px solid ${BRAND.gold}55`,
                      borderRadius: 0,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}>
                    {secondaryExpanded ? "− hide" : "+ details"}
                  </button>
                )}
              </div>
              {/* Expanded rows — full subcategory name + why for each mapping */}
              {secondaryExpanded && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                  {incident.secondary_mappings.map((m, i) => {
                    const mc = CATEGORIES[m.category];
                    const mcColor = mc?.color || BRAND.textSecondary;
                    return (
                      <div key={i} style={{
                        padding: "8px 10px",
                        background: BRAND.obsidian,
                        borderRadius: 0,
                        borderLeft: `2px solid ${mcColor}`,
                      }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: m.why ? 4 : 0, flexWrap: "wrap" }}>
                          <span style={{
                            fontFamily: "Inter, sans-serif", fontSize: 9,
                            color: mcColor, fontWeight: 600, letterSpacing: "0.06em",
                          }}>
                            {m.subcategory_code || m.category}
                          </span>
                          {m.subcategory_name && (
                            <span style={{ fontSize: 11, color: BRAND.white, fontWeight: 500 }}>
                              {m.subcategory_name}
                            </span>
                          )}
                        </div>
                        {m.why && (
                          <div style={{ fontSize: 11, color: BRAND.textSecondary, lineHeight: 1.45, fontStyle: "italic" }}>
                            {m.why}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Compact meta row — event_date · disclosure gap · location.
              Single mono one-liner. Only renders parts that exist. */}
          {(() => {
            const parts = [];
            if (incident.event_date) parts.push(incident.event_date);
            // days_to_disclosure: integer; render only when meaningfully > 0
            if (typeof incident.days_to_disclosure === "number" && incident.days_to_disclosure > 0) {
              const d = incident.days_to_disclosure;
              parts.push(`disclosed ${d}d later`);
            } else if (typeof incident.days_to_disclosure === "number" && incident.days_to_disclosure === 0) {
              parts.push("disclosed same-day");
            }
            const loc = incident.location_name || incident.country;
            if (loc) parts.push(loc);
            if (parts.length === 0) return null;
            return (
              <div style={{
                marginBottom: 12,
                fontFamily: "Inter, sans-serif", fontSize: 10,
                color: BRAND.textSecondary, letterSpacing: "0.04em",
                lineHeight: 1.5,
              }}>
                {parts.join(" · ")}
              </div>
            );
          })()}
        </div>

        {/* ── Victim + Threat actor zone ── */}
        {(incident.entity || incident.threat_actor) && (
          <div style={{
            padding: "12px 16px",
            borderTop: `1px solid ${BRAND.borderSubtle}`,
          }}>
            {incident.entity && (
              <div style={{ marginBottom: incident.threat_actor ? 8 : 0, display: "flex", gap: 10, alignItems: "baseline" }}>
                <span style={{
                  fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.textMuted,
                  letterSpacing: "0.14em", textTransform: "uppercase",
                  minWidth: 56, flexShrink: 0,
                }}>
                  Victim
                </span>
                <span style={{ fontSize: 12, color: BRAND.white, fontWeight: 500, lineHeight: 1.4 }}>
                  {incident.entity}
                  {incident.sector && (
                    <span style={{ color: BRAND.textMuted, fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                      · {incident.sector}
                    </span>
                  )}
                  {incident.industry && (
                    <span style={{
                      display: "inline-block",
                      marginLeft: 8, padding: "1px 7px",
                      borderRadius: 0,
                      background: "rgba(252,189,0,0.10)",
                      border: "1px solid rgba(252,189,0,0.30)",
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 9, color: BRAND.gold,
                      letterSpacing: "0.06em",
                      verticalAlign: "middle",
                    }}>
                      {incident.industry}
                    </span>
                  )}
                </span>
              </div>
            )}
            {incident.threat_actor && (
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <span style={{
                  fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.textMuted,
                  letterSpacing: "0.14em", textTransform: "uppercase",
                  minWidth: 56, flexShrink: 0,
                }}>
                  Actor
                </span>
                <span style={{ fontSize: 12, color: BRAND.white, fontWeight: 500, lineHeight: 1.4 }}>
                  {typeof incident.threat_actor === "string"
                    ? incident.threat_actor
                    : (incident.threat_actor.name || JSON.stringify(incident.threat_actor))}
                </span>
              </div>
            )}
          </div>
        )}

        {/* ── Summary prose ── */}
        {incident.summary && (
          <div style={{
            padding: "12px 16px",
            borderTop: `1px solid ${BRAND.borderSubtle}`,
            fontSize: 13, color: BRAND.white, lineHeight: 1.55,
          }}>
            {incident.summary}
          </div>
        )}

        {/* ── Financial impact + CVE row (when present) ── */}
        {(incident.financial_impact_disclosed || (Array.isArray(incident.related_cve_ids) && incident.related_cve_ids.length > 0)) && (
          <div style={{
            padding: "12px 16px",
            borderTop: `1px solid ${BRAND.borderSubtle}`,
          }}>
            {incident.financial_impact_disclosed && (
              <div style={{
                padding: "9px 12px",
                background: BRAND.goldTint,
                                borderRadius: "0 3px 3px 0",
                marginBottom: (Array.isArray(incident.related_cve_ids) && incident.related_cve_ids.length > 0) ? 10 : 0,
              }}>
                <div style={{ fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.gold, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 3, fontWeight: 600 }}>
                  Financial Impact
                </div>
                <div style={{ fontSize: 12, color: BRAND.white, lineHeight: 1.45 }}>
                  {incident.financial_impact_disclosed}
                </div>
              </div>
            )}
            {Array.isArray(incident.related_cve_ids) && incident.related_cve_ids.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                <span style={{
                  fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.textMuted,
                  letterSpacing: "0.14em", textTransform: "uppercase", marginRight: 4,
                }}>
                  CVE:
                </span>
                {incident.related_cve_ids.map((cveId, i) => (
                  <a key={i}
                    href={`https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveId)}`}
                    target="_blank" rel="noreferrer"
                    style={{
                      padding: "2px 7px",
                      fontFamily: "Inter, sans-serif", fontSize: 10, fontWeight: 600,
                      letterSpacing: "0.04em",
                      background: BRAND.obsidian,
                      color: BRAND.gold,
                      border: `1px solid ${BRAND.borderGold}`,
                      borderRadius: 0,
                      textDecoration: "none",
                    }}>
                    {cveId}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>






      {/* ═══════════════════════════════════════════════════════════════════
          ACCORDION SECTION — BLAST RADIUS
          Collapsed by default unless auto-opened (when this is the strongest
          data signal). Header is the tap target. Body shows when open.
          Returns null entirely if no blast_radius data exists.
          ═══════════════════════════════════════════════════════════════════ */}
      {(() => {
        const id = "blast";
        const channels = incident.blast_radius
          ? Object.entries(incident.blast_radius).filter(([, v]) => Array.isArray(v) && v.length > 0)
          : [];
        if (channels.length === 0) return null;
        const totalEntities = channels.reduce((acc, [, ents]) => acc + ents.length, 0);
        const isOpen = openSections.has(id);
        return (
          <div style={{
            marginBottom: 8,
            background: BRAND.obsidianElevated,
            border: `1px solid ${BRAND.borderSubtle}`,
            borderRadius: 0,
            overflow: "hidden",
          }}>
            <button
              onClick={() => toggleSection(id)}
              style={{
                width: "100%", padding: "12px 16px",
                display: "flex", alignItems: "center", gap: 10,
                background: "transparent", border: "none",
                cursor: "pointer", textAlign: "left",
                fontFamily: "inherit",
              }}>
              <span style={{
                fontFamily: "Inter, sans-serif", fontSize: 10,
                color: isOpen ? BRAND.gold : BRAND.white, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 600,
              }}>
                Blast Radius
              </span>
              <span style={{
                padding: "1px 6px",
                fontFamily: "Inter, sans-serif", fontSize: 9,
                color: BRAND.textMuted, letterSpacing: "0.06em",
                border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
              }}>
                {totalEntities} accounts · {channels.length} rings
              </span>
              <span style={{
                marginLeft: "auto",
                fontFamily: "Inter, sans-serif", fontSize: 14,
                color: BRAND.gold, lineHeight: 1,
                transform: isOpen ? "rotate(45deg)" : "rotate(0deg)",
                transition: "transform 220ms cubic-bezier(0.4,0,0.2,1)",
              }}>+</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 16px 16px 16px" }}>

      {/* Blast radius summary — opens with a "Who else should care" master
          card showing the big stats (named accounts / ring types / watchlist
          hits), then renders the existing rich per-entity cards beneath. */}
      {incident.blast_radius && (() => {
        const channels = Object.entries(incident.blast_radius).filter(([, v]) => Array.isArray(v) && v.length > 0);
        if (channels.length === 0) return null;
        const totalEntities = channels.reduce((acc, [, ents]) => acc + ents.length, 0);
        const watchlistHits = channels.reduce((acc, [, ents]) => {
          return acc + ents.filter(e => e?.attacked_ai_product_hook).length;
        }, 0);
        return (
          <div style={{ marginBottom: 24 }}>
            {/* "Who else should care" master header card */}
            <div style={{
              padding: "16px 16px 18px 16px", marginBottom: 16,
              background: BRAND.obsidianElevated,
              border: `1px solid ${BRAND.borderSubtle}`,
                            borderRadius: 0,
            }}>
              <div style={{
                fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.gold,
                letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 4,
                fontWeight: 600,
              }}>
                Blast Radius · {incident.entity ? incident.entity.split(' ').slice(0, 3).join(' ') : 'Network'}
              </div>
              <div style={{
                fontFamily: "'Inter', sans-serif", fontWeight: 700,
                fontSize: 22, color: BRAND.white, lineHeight: 1.2, marginBottom: 14,
              }}>
                Who else should care.
              </div>
              {/* Three big stats: named accounts · ring types · watchlist hits */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <div>
                  <div style={{ fontFamily: "Inter, sans-serif", fontSize: 24, color: BRAND.gold, fontWeight: 600, lineHeight: 1 }}>{totalEntities}</div>
                  <div style={{ fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.textMuted, letterSpacing: "0.16em", textTransform: "uppercase", marginTop: 4 }}>Named Accounts</div>
                </div>
                <div>
                  <div style={{ fontFamily: "Inter, sans-serif", fontSize: 24, color: BRAND.gold, fontWeight: 600, lineHeight: 1 }}>{channels.length}</div>
                  <div style={{ fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.textMuted, letterSpacing: "0.16em", textTransform: "uppercase", marginTop: 4 }}>Ring Types</div>
                </div>
                <div>
                  <div style={{ fontFamily: "Inter, sans-serif", fontSize: 24, color: BRAND.gold, fontWeight: 600, lineHeight: 1 }}>{watchlistHits}</div>
                  <div style={{ fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.textMuted, letterSpacing: "0.16em", textTransform: "uppercase", marginTop: 4 }}>Watchlist Hits</div>
                </div>
              </div>
              {/* Numbered ring summary row — like the demo's 01/02/03 layout */}
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${BRAND.borderSubtle}` }}>
                {channels.map(([channel, entities], i) => {
                  const ch = BLAST_CHANNELS[channel];
                  if (!ch) return null;
                  const top3 = entities.slice(0, 3).map(e => (e.name || e.entity || '—').split('(')[0].trim()).join(' · ');
                  const extra = entities.length > 3 ? ` · +${entities.length - 3}` : '';
                  return (
                    <div key={channel} style={{
                      display: 'flex', alignItems: 'baseline', gap: 10,
                      padding: '4px 0', fontSize: 10, lineHeight: 1.4,
                    }}>
                      <span style={{
                        fontFamily: 'Inter, sans-serif', fontSize: 9, fontWeight: 600,
                        color: BRAND.textMuted, minWidth: 18,
                      }}>0{i + 1}</span>
                      <span style={{
                        fontFamily: 'Inter, sans-serif', fontSize: 9, fontWeight: 600,
                        color: ch.color, letterSpacing: '0.10em', textTransform: 'uppercase',
                        minWidth: 78,
                      }}>{ch.label}</span>
                      <span style={{
                        fontStyle: 'italic', fontSize: 11, color: BRAND.textSecondary,
                        fontFamily: 'Inter, sans-serif', flex: 1,
                      }}>
                        {top3}<span style={{ color: BRAND.gold }}>{extra}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Full per-entity rich cards (collapsible label) */}
            <div style={{
              fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted,
              letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 10, paddingLeft: 2,
            }}>
              Every Named Account
            </div>
            {channels.map(([channel, entities]) => {
              const ch = BLAST_CHANNELS[channel];
              if (!ch) return null;
              return (
                <div key={channel} style={{ marginBottom: 16 }}>
                  {/* Channel header — icon + label + count */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${ch.color}33` }}>
                    <span style={{ color: ch.color, fontFamily: "Inter, sans-serif", fontSize: 14, lineHeight: 1 }}>{ch.icon}</span>
                    <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: ch.color, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>
                      {ch.label}
                    </span>
                    <span style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, marginLeft: "auto" }}>
                      {entities.length}
                    </span>
                  </div>
                  {/* Per-entity rich cards. Each card surfaces every field that exists
                      in the new (May 2026+) schema; older sweeps with thinner data
                      simply skip the missing fields. */}
                  {entities.map((ent, i) => {
                    const horizon = IMPACT_HORIZONS[ent.impact_horizon];
                    const mechanism = TRANSMISSION_MECHANISMS[ent.transmission_mechanism];
                    const hook = ent.attacked_ai_product_hook;
                    const product = hook && PRODUCT_HOOKS[hook.product];
                    return (
                      <div key={i} style={{
                        padding: "10px 12px",
                        marginBottom: 8,
                        background: BRAND.obsidianElevated,
                        borderLeft: `2px solid ${ch.color}`,
                        borderRadius: 0,
                      }}>
                        {/* Entity name + country + impact badge */}
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                          <div>
                            <div style={{ color: BRAND.white, fontSize: 12, fontWeight: 600, lineHeight: 1.35 }}>
                              {ent.name || ent.entity || "—"}
                            </div>
                            {ent.country && (
                              <div style={{ color: BRAND.textMuted, fontSize: 10, marginTop: 2 }}>
                                <span style={{ marginRight: 4 }}>📍</span>{ent.country}
                              </div>
                            )}
                          </div>
                          {typeof ent.impact_score === "number" && (
                            <div style={{
                              flexShrink: 0, alignSelf: "flex-start",
                              padding: "2px 7px", borderRadius: 0,
                              fontFamily: "Inter, sans-serif", fontSize: 9, fontWeight: 600,
                              background: ent.impact_score >= 4 ? "#FF3B3022" : ent.impact_score >= 3 ? "#FF8C5A22" : "#34C75922",
                              color:      ent.impact_score >= 4 ? "#FF6B6B"   : ent.impact_score >= 3 ? "#FF8C5A"   : "#34C759",
                              border: `1px solid ${ent.impact_score >= 4 ? "#FF6B6B55" : ent.impact_score >= 3 ? "#FF8C5A55" : "#34C75955"}`,
                              letterSpacing: "0.08em",
                            }}>
                              IMPACT {ent.impact_score}/5
                            </div>
                          )}
                        </div>
                        {/* Impact rationale (or fallback to reason) */}
                        {(ent.impact_rationale || ent.reason) && (
                          <div style={{ color: BRAND.textSecondary, fontSize: 11, lineHeight: 1.45, marginBottom: 6 }}>
                            {ent.impact_rationale || ent.reason}
                          </div>
                        )}
                        {/* Mechanism + horizon row — small mono tags */}
                        {(mechanism || horizon) && (
                          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 6, fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.04em" }}>
                            {mechanism && <span><span style={{ color: ch.color, marginRight: 4 }}>↬</span>{mechanism.label}</span>}
                            {horizon && <span><span style={{ color: BRAND.gold, marginRight: 4 }}>⏱</span>{horizon.label} · {horizon.hint}</span>}
                          </div>
                        )}
                        {/* Recommended action — italic */}
                        {ent.recommended_action_for_them && (
                          <div style={{ marginTop: 6, padding: "6px 8px", background: "rgba(252,189,0,0.05)", borderRadius: 0 }}>
                            <span style={{ fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.gold, letterSpacing: "0.10em", textTransform: "uppercase", marginRight: 6 }}>ACTION</span>
                            <span style={{ color: BRAND.white, fontSize: 11, fontStyle: "italic", lineHeight: 1.45 }}>
                              {ent.recommended_action_for_them}
                            </span>
                          </div>
                        )}
                        {/* Product hook CTA — Attacked.ai cross-product chip */}
                        {product && hook?.cta_label && (
                          <div style={{
                            marginTop: 8, padding: "5px 9px",
                            display: "inline-flex", alignItems: "center", gap: 6,
                            background: `${product.color}15`,
                            border: `1px solid ${product.color}44`,
                            borderRadius: 0, cursor: "pointer",
                          }}>
                            <span style={{ color: product.color, fontSize: 12, lineHeight: 1 }}>{product.icon}</span>
                            <span style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: product.color, letterSpacing: "0.08em", fontWeight: 600 }}>
                              {product.label}
                            </span>
                            <span style={{ color: BRAND.textSecondary, fontSize: 10 }}>·</span>
                            <span style={{ color: BRAND.textSecondary, fontSize: 10, fontStyle: "italic" }}>
                              {hook.cta_label}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })()}

              </div>
            )}
          </div>
        );
      })()}{/* end Blast Radius accordion */}

      {/* ═══════════════════════════════════════════════════════════════════
          ACCORDION SECTION — ADAPTIVE CONTROLS
          ═══════════════════════════════════════════════════════════════════ */}
      {(() => {
        const id = "controls";
        const objs = Array.isArray(incident.adaptive_objectives) ? incident.adaptive_objectives : [];
        const masters = Array.isArray(incident.adaptive_master_controls) ? incident.adaptive_master_controls : [];
        const acts = Array.isArray(incident.adaptive_controls) ? incident.adaptive_controls : [];
        const mappings = Array.isArray(incident.secondary_adaptive_mappings) ? incident.secondary_adaptive_mappings : [];
        const bps = Array.isArray(incident.best_practices) ? incident.best_practices : [];
        const totalCount = objs.length + masters.length + acts.length;
        // Section renders if any of the nine GUARD Adaptive Controls fields exist
        const hasAny = (
          incident.if_you_operate_x_then_y ||
          incident.severity_rationale ||
          incident.velocity_signal ||
          incident.emerging_risk_signal ||
          totalCount > 0 ||
          mappings.length > 0 ||
          bps.length > 0
        );
        if (!hasAny) return null;
        // Build meta chip summary that reflects what's actually in this section
        const metaParts = [];
        if (totalCount > 0) metaParts.push(`${totalCount} controls`);
        if (mappings.length > 0) metaParts.push(`${mappings.length} cross-map`);
        if (bps.length > 0) metaParts.push(`${bps.length} std`);
        // If only A/B/C signals exist (no D/E/F), surface a generic label
        if (metaParts.length === 0) metaParts.push("guidance");
        const metaLabel = metaParts.join(" · ");
        const isOpen = openSections.has(id);
        return (
          <div style={{
            marginBottom: 8,
            background: BRAND.obsidianElevated,
            border: `1px solid ${BRAND.borderSubtle}`,
            borderRadius: 0,
            overflow: "hidden",
          }}>
            <button
              onClick={() => toggleSection(id)}
              style={{
                width: "100%", padding: "12px 16px",
                display: "flex", alignItems: "center", gap: 10,
                background: "transparent", border: "none",
                cursor: "pointer", textAlign: "left",
                fontFamily: "inherit",
              }}>
              <span style={{
                fontFamily: "Inter, sans-serif", fontSize: 10,
                color: isOpen ? BRAND.gold : BRAND.white, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 600,
              }}>
                Adaptive Controls
              </span>
              <span style={{
                padding: "1px 6px",
                fontFamily: "Inter, sans-serif", fontSize: 9,
                color: BRAND.textMuted, letterSpacing: "0.06em",
                border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
              }}>
                {metaLabel}
              </span>
              <span style={{
                marginLeft: "auto",
                fontFamily: "Inter, sans-serif", fontSize: 14,
                color: BRAND.gold, lineHeight: 1,
                transform: isOpen ? "rotate(45deg)" : "rotate(0deg)",
                transition: "transform 220ms cubic-bezier(0.4,0,0.2,1)",
              }}>+</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 16px 16px 16px" }}>

      {/* ─────────────────────────────────────────────────────────────────
          GUARD ADAPTIVE CONTROLS — full editorial rendering of every field
          the sweep enrichment pipeline produces. Six conceptual sections,
          each rendered only if the underlying data exists. Designed from the
          incident JSON schema (not from any reference design), keeping the
          same mono section-label + gold-edge styling already used across the
          panel so visual language stays consistent.

          Sections (in reading order):
            A. "If you operate X then Y" callout      — incident.if_you_operate_x_then_y
            B. Severity rationale                       — incident.severity_rationale
            C. Velocity + emerging-risk signals         — incident.velocity_signal / .emerging_risk_signal
            D. Three-layer control hierarchy            — adaptive_objectives → adaptive_master_controls → adaptive_controls
            E. Cross-category mappings                  — incident.secondary_adaptive_mappings
            F. Reference standards / best practices     — incident.best_practices
          ──────────────────────────────────────────────────────────────── */}
      {(() => {
        // Renders the full GUARD Adaptive Controls section — all six fields
        // produced by the sweep enrichment pipeline, in reading order:
        //   A. If-this-is-you           — if_you_operate_x_then_y
        //   B. Severity rationale       — severity_rationale
        //   C. Velocity + emerging risk — velocity_signal / emerging_risk_signal
        //   D. Control hierarchy        — adaptive_objectives / master_controls / controls
        //   E. Cross-category mappings  — secondary_adaptive_mappings
        //   F. Reference standards      — best_practices
        const hasAny = (
          incident.if_you_operate_x_then_y ||
          incident.severity_rationale ||
          incident.velocity_signal ||
          incident.emerging_risk_signal ||
          (incident.adaptive_objectives?.length > 0) ||
          (incident.adaptive_master_controls?.length > 0) ||
          (incident.adaptive_controls?.length > 0) ||
          (incident.secondary_adaptive_mappings?.length > 0) ||
          (incident.best_practices?.length > 0)
        );
        if (!hasAny) return null;
        return (
          <div>

            {/* ── A. "If you operate X then Y" callout ─────────────────────
                Highest-signal data point: tells the reader whether *they*
                should care. Gold-edged callout in white prose. */}
            {incident.if_you_operate_x_then_y && (
              <div style={{
                marginBottom: 14, padding: "12px 14px",
                background: BRAND.goldTint,
                borderRadius: 0,
              }}>
                <div style={{
                  fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.gold,
                  letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6,
                  fontWeight: 600,
                }}>
                  If This Is You
                </div>
                <div style={{ fontSize: 13, color: BRAND.white, lineHeight: 1.5 }}>
                  {typeof incident.if_you_operate_x_then_y === "string"
                    ? incident.if_you_operate_x_then_y
                    : JSON.stringify(incident.if_you_operate_x_then_y)}
                </div>
              </div>
            )}

            {/* ── B. Severity rationale — italic secondary text ────────── */}
            {incident.severity_rationale && (
              <div style={{ marginBottom: 16, paddingLeft: 12, borderLeft: `2px solid ${BRAND.borderSubtle}` }}>
                <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 4 }}>
                  Severity Rationale
                </div>
                <div style={{ fontSize: 12, color: BRAND.textSecondary, lineHeight: 1.5, fontStyle: "italic" }}>
                  {incident.severity_rationale}
                </div>
              </div>
            )}

            {/* ── C. Velocity + emerging-risk signals (two-column) ────── */}
            {(incident.velocity_signal || incident.emerging_risk_signal) && (() => {
              const v = incident.velocity_signal;
              const e = incident.emerging_risk_signal;
              const trajectoryArrow = { rising: "↑", falling: "↓", steady: "→", flat: "→" };
              return (
                <div style={{
                  display: "grid",
                  gridTemplateColumns: (v && e) ? "1fr 1fr" : "1fr",
                  gap: 10, marginBottom: 16,
                }}>
                  {v && typeof v === "object" && (
                    <div style={{ padding: "10px 12px", background: BRAND.obsidian, borderRadius: 0 }}>
                      <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
                        Velocity Signal
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                        {typeof v.count_quarter === "number" && (
                          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 22, color: BRAND.gold, fontWeight: 600, lineHeight: 1 }}>
                            {v.count_quarter}
                          </span>
                        )}
                        {v.trajectory && (
                          <span style={{
                            fontFamily: "Inter, sans-serif", fontSize: 11,
                            color: v.trajectory === "rising" ? "#FF6B35" : v.trajectory === "falling" ? "#34C759" : BRAND.textSecondary,
                            letterSpacing: "0.08em", textTransform: "uppercase",
                          }}>
                            {trajectoryArrow[v.trajectory] || "•"} {v.trajectory}
                          </span>
                        )}
                      </div>
                      {v.pattern && (
                        <div style={{ fontSize: 11, color: BRAND.white, lineHeight: 1.4, fontWeight: 500, marginBottom: 4 }}>
                          {v.pattern}
                        </div>
                      )}
                      {v.brief && (
                        <div style={{ fontSize: 10, color: BRAND.textSecondary, lineHeight: 1.4, fontStyle: "italic" }}>
                          {v.brief}
                        </div>
                      )}
                    </div>
                  )}
                  {e && (
                    <div style={{ padding: "10px 12px", background: BRAND.obsidian, borderRadius: 0 }}>
                      <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: "#FF8C5A", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
                        Emerging Risk
                      </div>
                      <div style={{ fontSize: 11, color: BRAND.white, lineHeight: 1.5 }}>
                        {typeof e === "string" ? e : JSON.stringify(e)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ── D. Three-layer control hierarchy ──────────────────────
                Objectives → Master Controls → Recommended Actions, each as
                a labelled subsection. Full statement text — no truncation. */}
            {Array.isArray(incident.adaptive_objectives) && incident.adaptive_objectives.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.gold,
                  letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8,
                  fontWeight: 600,
                }}>
                  Control Objectives · {incident.adaptive_objectives.length}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {incident.adaptive_objectives.map((o, i) => (
                    <div key={i} style={{
                      padding: "10px 12px",
                      background: BRAND.obsidianElevated,
                      borderRadius: 0,
                                          }}>
                      <div style={{
                        fontFamily: "Inter, sans-serif", fontSize: 10, color: BRAND.gold,
                        letterSpacing: "0.04em", marginBottom: 5, fontWeight: 600,
                      }}>
                        {o.id || `CO-${i + 1}`}
                      </div>
                      <div style={{ fontSize: 12, color: BRAND.white, lineHeight: 1.5 }}>
                        {o.statement || o.description || (typeof o === "string" ? o : "")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {Array.isArray(incident.adaptive_master_controls) && incident.adaptive_master_controls.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.goldDim,
                  letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8,
                  fontWeight: 600,
                }}>
                  Master Controls · {incident.adaptive_master_controls.length}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {incident.adaptive_master_controls.map((c, i) => (
                    <div key={i} style={{
                      padding: "10px 12px",
                      background: BRAND.obsidianElevated,
                      borderRadius: 0,
                                            marginLeft: 12, // indented to show implementation of objectives
                    }}>
                      <div style={{
                        fontFamily: "Inter, sans-serif", fontSize: 10, color: BRAND.goldDim,
                        letterSpacing: "0.04em", marginBottom: 5, fontWeight: 600,
                      }}>
                        {c.id || `AC-${i + 1}`}
                      </div>
                      <div style={{ fontSize: 12, color: BRAND.white, lineHeight: 1.5 }}>
                        {c.statement || c.description || (typeof c === "string" ? c : "")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {Array.isArray(incident.adaptive_controls) && incident.adaptive_controls.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textSecondary,
                  letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8,
                  fontWeight: 600,
                }}>
                  Recommended Actions · {incident.adaptive_controls.length}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {incident.adaptive_controls.map((a, i) => (
                    <div key={i} style={{
                      padding: "8px 12px",
                      background: BRAND.obsidian,
                      borderRadius: 0,
                      border: `1px solid ${BRAND.borderSubtle}`,
                      display: "flex", gap: 10,
                    }}>
                      <span style={{
                        fontFamily: "Inter, sans-serif", fontSize: 10, color: BRAND.gold,
                        flexShrink: 0, paddingTop: 1, fontWeight: 600,
                      }}>
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span style={{ fontSize: 12, color: BRAND.textSecondary, lineHeight: 1.5 }}>
                        {typeof a === "string" ? a : (a.statement || a.description || "")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── E. Cross-category mappings ─────────────────────────────
                Each secondary mapping shows its category code and the
                objective/master-control IDs it triggers there. Tight rows. */}
            {Array.isArray(incident.secondary_adaptive_mappings) && incident.secondary_adaptive_mappings.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted,
                  letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8,
                  fontWeight: 600,
                }}>
                  Cross-Category Mappings · {incident.secondary_adaptive_mappings.length}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {incident.secondary_adaptive_mappings.map((m, i) => {
                    const cat = CATEGORIES[m.category];
                    const catColor = cat?.color || BRAND.textSecondary;
                    return (
                      <div key={i} style={{
                        padding: "8px 12px",
                        background: BRAND.obsidian,
                        borderRadius: 0,
                        border: `1px solid ${BRAND.borderSubtle}`,
                        borderLeft: `2px solid ${catColor}`,
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <span style={{
                            padding: "2px 6px", borderRadius: 0,
                            fontFamily: "Inter, sans-serif", fontSize: 9,
                            fontWeight: 600, letterSpacing: "0.08em",
                            background: catColor + "22", color: catColor,
                            border: `1px solid ${catColor}55`,
                          }}>
                            {m.subcategory_code || m.category}
                          </span>
                          {cat && (
                            <span style={{ fontSize: 11, color: BRAND.textSecondary }}>
                              {cat.label}
                            </span>
                          )}
                        </div>
                        {/* Show triggered IDs from this secondary mapping */}
                        {(Array.isArray(m.objective_ids) && m.objective_ids.length > 0) && (
                          <div style={{ marginBottom: 4 }}>
                            <span style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.10em", textTransform: "uppercase", marginRight: 6 }}>
                              Objectives:
                            </span>
                            {m.objective_ids.map((id, j) => (
                              <span key={j} style={{
                                display: "inline-block", marginRight: 4, marginBottom: 2,
                                padding: "2px 5px", fontSize: 9,
                                fontFamily: "Inter, sans-serif", color: BRAND.gold,
                                background: BRAND.obsidianElevated,
                                border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
                              }}>{id}</span>
                            ))}
                          </div>
                        )}
                        {(Array.isArray(m.master_control_ids) && m.master_control_ids.length > 0) && (
                          <div>
                            <span style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.10em", textTransform: "uppercase", marginRight: 6 }}>
                              Controls:
                            </span>
                            {m.master_control_ids.map((id, j) => (
                              <span key={j} style={{
                                display: "inline-block", marginRight: 4, marginBottom: 2,
                                padding: "2px 5px", fontSize: 9,
                                fontFamily: "Inter, sans-serif", color: BRAND.goldDim,
                                background: BRAND.obsidianElevated,
                                border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
                              }}>{id}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── F. Reference standards / best practices ────────────────
                ICAO / ISO / NIST / etc. framework references with clause +
                jurisdiction + URL + relevance text. */}
            {Array.isArray(incident.best_practices) && incident.best_practices.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{
                  fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted,
                  letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8,
                  fontWeight: 600,
                }}>
                  Reference Standards · {incident.best_practices.length}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {incident.best_practices.map((bp, i) => (
                    <div key={i} style={{
                      padding: "10px 12px",
                      background: BRAND.obsidianElevated,
                      borderRadius: 0,
                      border: `1px solid ${BRAND.borderSubtle}`,
                    }}>
                      {/* Framework badge + version + jurisdiction */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 6 }}>
                        {bp.framework && (
                          <span style={{
                            padding: "2px 7px", borderRadius: 0,
                            fontFamily: "Inter, sans-serif", fontSize: 9,
                            fontWeight: 600, letterSpacing: "0.10em",
                            background: BRAND.gold, color: BRAND.obsidian,
                          }}>
                            {bp.framework}
                          </span>
                        )}
                        {bp.version && (
                          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: BRAND.textSecondary }}>
                            {bp.version}
                          </span>
                        )}
                        {bp.jurisdiction && (
                          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, marginLeft: "auto" }}>
                            {bp.jurisdiction}
                          </span>
                        )}
                      </div>
                      {/* Title (linked if URL exists) */}
                      {bp.title && (
                        <div style={{ marginBottom: 4 }}>
                          {bp.url ? (
                            <a href={bp.url} target="_blank" rel="noreferrer" style={{
                              color: BRAND.white, fontSize: 12, fontWeight: 600,
                              textDecoration: "none", borderBottom: `1px dashed ${BRAND.borderGold}`,
                              lineHeight: 1.4,
                            }}>
                              {bp.title}
                            </a>
                          ) : (
                            <span style={{ color: BRAND.white, fontSize: 12, fontWeight: 600, lineHeight: 1.4 }}>
                              {bp.title}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Clause */}
                      {bp.clause && (
                        <div style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: BRAND.gold, letterSpacing: "0.04em", marginBottom: 4 }}>
                          {bp.clause}
                        </div>
                      )}
                      {/* Relevance — why this standard matters here */}
                      {bp.relevance && (
                        <div style={{ fontSize: 11, color: BRAND.textSecondary, lineHeight: 1.45, fontStyle: "italic" }}>
                          {bp.relevance}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Also-mapped IDs — compact fallback if any mapped_controls or
                mapped_objectives IDs aren't already shown above. */}
            {(() => {
              const shown = new Set();
              (incident.adaptive_master_controls || []).forEach(c => c?.id && shown.add(c.id));
              (incident.adaptive_objectives || []).forEach(o => o?.id && shown.add(o.id));
              (incident.secondary_adaptive_mappings || []).forEach(m => {
                (m.master_control_ids || []).forEach(id => shown.add(id));
                (m.objective_ids || []).forEach(id => shown.add(id));
              });
              const extras = [
                ...(incident.mapped_controls || []),
                ...(incident.mapped_objectives || []),
              ].filter(id => !shown.has(id));
              if (extras.length === 0) return null;
              return (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${BRAND.borderSubtle}` }}>
                  <div style={{
                    fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted,
                    letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6,
                  }}>
                    Also Mapped
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {extras.map((id, i) => (
                      <span key={i} style={{
                        padding: "2px 6px", fontSize: 9, fontFamily: "Inter, sans-serif",
                        background: BRAND.obsidian, color: BRAND.goldDim,
                        border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
                        letterSpacing: "0.04em",
                      }}>
                        {id}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })()}

              </div>
            )}
          </div>
        );
      })()}{/* end Adaptive Controls accordion */}

      {/* ═══════════════════════════════════════════════════════════════════
          ACCORDION SECTION — HISTORICAL ANALOGUES
          ═══════════════════════════════════════════════════════════════════ */}
      {(() => {
        const id = "history";
        const items = Array.isArray(incident.historical_analogues) ? incident.historical_analogues : [];
        if (items.length === 0) return null;
        const isOpen = openSections.has(id);
        return (
          <div style={{
            marginBottom: 8,
            background: BRAND.obsidianElevated,
            border: `1px solid ${BRAND.borderSubtle}`,
            borderRadius: 0,
            overflow: "hidden",
          }}>
            <button
              onClick={() => toggleSection(id)}
              style={{
                width: "100%", padding: "12px 16px",
                display: "flex", alignItems: "center", gap: 10,
                background: "transparent", border: "none",
                cursor: "pointer", textAlign: "left",
                fontFamily: "inherit",
              }}>
              <span style={{
                fontFamily: "Inter, sans-serif", fontSize: 10,
                color: isOpen ? BRAND.gold : BRAND.white, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 600,
              }}>
                Historical Analogues
              </span>
              <span style={{
                padding: "1px 6px",
                fontFamily: "Inter, sans-serif", fontSize: 9,
                color: BRAND.textMuted, letterSpacing: "0.06em",
                border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
              }}>
                {items.length} {items.length === 1 ? "event" : "events"}
              </span>
              <span style={{
                marginLeft: "auto",
                fontFamily: "Inter, sans-serif", fontSize: 14,
                color: BRAND.gold, lineHeight: 1,
                transform: isOpen ? "rotate(45deg)" : "rotate(0deg)",
                transition: "transform 220ms cubic-bezier(0.4,0,0.2,1)",
              }}>+</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 16px 16px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                {items.map((h, i) => (
                  <div key={i} style={{
                    padding: "10px 12px",
                    background: BRAND.obsidian,
                    border: `1px solid ${BRAND.borderSubtle}`,
                    borderRadius: 0,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: BRAND.white, fontWeight: 600 }}>
                        {h.event_name || h.event || h.name || "—"}
                      </span>
                      {h.year && (
                        <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: BRAND.gold, flexShrink: 0 }}>
                          {h.year}
                        </span>
                      )}
                    </div>
                    {h.entity && (
                      <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.04em", marginBottom: 5 }}>
                        {h.entity}
                      </div>
                    )}
                    {h.summary && (
                      <div style={{ fontSize: 11, color: BRAND.textSecondary, lineHeight: 1.45, marginBottom: h.outcome ? 6 : 0 }}>
                        {h.summary}
                      </div>
                    )}
                    {h.outcome && (
                      <div style={{
                        fontSize: 11, color: BRAND.white, lineHeight: 1.45,
                        paddingTop: 6, borderTop: `1px solid ${BRAND.borderSubtle}`,
                        fontStyle: "italic",
                      }}>
                        <span style={{ fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.gold, letterSpacing: "0.12em", textTransform: "uppercase", marginRight: 6, fontStyle: "normal" }}>
                          Outcome
                        </span>
                        {h.outcome}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════════════════
          ACCORDION SECTION — SOURCES
          ═══════════════════════════════════════════════════════════════════ */}
      {(() => {
        const id = "sources";
        const items = Array.isArray(incident.sources) ? incident.sources : [];
        if (items.length === 0) return null;
        const isOpen = openSections.has(id);
        return (
          <div style={{
            marginBottom: 8,
            background: BRAND.obsidianElevated,
            border: `1px solid ${BRAND.borderSubtle}`,
            borderRadius: 0,
            overflow: "hidden",
          }}>
            <button
              onClick={() => toggleSection(id)}
              style={{
                width: "100%", padding: "12px 16px",
                display: "flex", alignItems: "center", gap: 10,
                background: "transparent", border: "none",
                cursor: "pointer", textAlign: "left",
                fontFamily: "inherit",
              }}>
              <span style={{
                fontFamily: "Inter, sans-serif", fontSize: 10,
                color: isOpen ? BRAND.gold : BRAND.white, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 600,
              }}>
                Sources
              </span>
              <span style={{
                padding: "1px 6px",
                fontFamily: "Inter, sans-serif", fontSize: 9,
                color: BRAND.textMuted, letterSpacing: "0.06em",
                border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
              }}>
                {items.length} cited
              </span>
              <span style={{
                marginLeft: "auto",
                fontFamily: "Inter, sans-serif", fontSize: 14,
                color: BRAND.gold, lineHeight: 1,
                transform: isOpen ? "rotate(45deg)" : "rotate(0deg)",
                transition: "transform 220ms cubic-bezier(0.4,0,0.2,1)",
              }}>+</span>
            </button>
            {isOpen && (
              <ul style={{ margin: 0, padding: "0 16px 16px 16px", listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
                {items.map((s, i) => (
                  <li key={i} style={{ fontSize: 11, color: BRAND.textSecondary, padding: "8px 10px", background: BRAND.obsidian, borderRadius: 0, border: `1px solid ${BRAND.borderSubtle}` }}>
                    <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.gold, marginBottom: 3 }}>[S{i + 1}] {s.publisher || "?"}</div>
                    <div style={{ color: BRAND.white, lineHeight: 1.4 }}>{s.title || "—"}</div>
                    {s.url && (
                      <a href={s.url} target="_blank" rel="noreferrer"
                        style={{ color: BRAND.gold, fontSize: 10, textDecoration: "none", wordBreak: "break-all", display: "inline-block", marginTop: 4 }}>
                        {s.url}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════════════════
          ACCORDION SECTION — VENDORS (newsroom mode only)
          ═══════════════════════════════════════════════════════════════════ */}
      {newsroomMode && (() => {
        const id = "vendors";
        const items = Array.isArray(incident.vendors) ? incident.vendors : [];
        if (items.length === 0) return null;
        const isOpen = openSections.has(id);
        return (
          <div style={{
            marginBottom: 8,
            background: BRAND.obsidianElevated,
            border: `1px solid ${BRAND.borderSubtle}`,
            borderRadius: 0,
            overflow: "hidden",
          }}>
            <button onClick={() => toggleSection(id)}
              style={{
                width: "100%", padding: "12px 16px",
                display: "flex", alignItems: "center", gap: 10,
                background: "transparent", border: "none",
                cursor: "pointer", textAlign: "left", fontFamily: "inherit",
              }}>
              <span style={{
                fontFamily: "Inter, sans-serif", fontSize: 10,
                color: isOpen ? BRAND.gold : BRAND.white, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 600,
              }}>
                Vendors
              </span>
              <span style={{
                padding: "1px 6px",
                fontFamily: "Inter, sans-serif", fontSize: 9,
                color: BRAND.textMuted, letterSpacing: "0.06em",
                border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
              }}>{items.length}</span>
              <span style={{
                marginLeft: "auto",
                fontFamily: "Inter, sans-serif", fontSize: 14,
                color: BRAND.gold, lineHeight: 1,
                transform: isOpen ? "rotate(45deg)" : "rotate(0deg)",
                transition: "transform 220ms cubic-bezier(0.4,0,0.2,1)",
              }}>+</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 16px 16px 16px", display: "flex", flexWrap: "wrap", gap: 6 }}>
                {items.map((v, i) => (
                  <span key={i} style={{ padding: "3px 8px", fontSize: 11, background: BRAND.obsidian, color: BRAND.textSecondary, border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0 }}>
                    {typeof v === "string" ? v : (v.name || JSON.stringify(v).slice(0, 40))}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════════════════
          ACCORDION SECTION — PEER WATCHLIST (newsroom mode only)
          ═══════════════════════════════════════════════════════════════════ */}
      {newsroomMode && (() => {
        const id = "peers";
        const items = Array.isArray(incident.peer_watchlist) ? incident.peer_watchlist : [];
        if (items.length === 0) return null;
        const isOpen = openSections.has(id);
        return (
          <div style={{
            marginBottom: 8,
            background: BRAND.obsidianElevated,
            border: `1px solid ${BRAND.borderSubtle}`,
            borderRadius: 0,
            overflow: "hidden",
          }}>
            <button onClick={() => toggleSection(id)}
              style={{
                width: "100%", padding: "12px 16px",
                display: "flex", alignItems: "center", gap: 10,
                background: "transparent", border: "none",
                cursor: "pointer", textAlign: "left", fontFamily: "inherit",
              }}>
              <span style={{
                fontFamily: "Inter, sans-serif", fontSize: 10,
                color: isOpen ? BRAND.gold : BRAND.white, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 600,
              }}>
                Peer Watchlist
              </span>
              <span style={{
                padding: "1px 6px",
                fontFamily: "Inter, sans-serif", fontSize: 9,
                color: BRAND.textMuted, letterSpacing: "0.06em",
                border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
              }}>{items.length}</span>
              <span style={{
                marginLeft: "auto",
                fontFamily: "Inter, sans-serif", fontSize: 14,
                color: BRAND.gold, lineHeight: 1,
                transform: isOpen ? "rotate(45deg)" : "rotate(0deg)",
                transition: "transform 220ms cubic-bezier(0.4,0,0.2,1)",
              }}>+</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 16px 16px 16px", display: "flex", flexWrap: "wrap", gap: 6 }}>
                {items.map((p, i) => (
                  <span key={i} style={{ padding: "3px 8px", fontSize: 11, background: BRAND.obsidian, color: BRAND.textSecondary, border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0 }}>
                    {typeof p === "string" ? p : (p.name || p.entity || JSON.stringify(p).slice(0, 40))}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════════════════
          ACCORDION SECTION — VERIFICATION (newsroom mode only)
          ═══════════════════════════════════════════════════════════════════ */}
      {newsroomMode && incident._verified !== undefined && (() => {
        const id = "verify";
        const isOpen = openSections.has(id);
        return (
          <div style={{
            marginBottom: 8,
            background: BRAND.obsidianElevated,
            border: `1px solid ${BRAND.borderSubtle}`,
            borderRadius: 0,
            overflow: "hidden",
          }}>
            <button onClick={() => toggleSection(id)}
              style={{
                width: "100%", padding: "12px 16px",
                display: "flex", alignItems: "center", gap: 10,
                background: "transparent", border: "none",
                cursor: "pointer", textAlign: "left", fontFamily: "inherit",
              }}>
              <span style={{
                fontFamily: "Inter, sans-serif", fontSize: 10,
                color: isOpen ? BRAND.gold : BRAND.white, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 600,
              }}>
                Verification
              </span>
              <span style={{
                padding: "1px 6px",
                fontFamily: "Inter, sans-serif", fontSize: 9,
                color: incident._verified ? "#34C759" : "#FF6B6B",
                letterSpacing: "0.10em", textTransform: "uppercase", fontWeight: 600,
                border: `1px solid ${incident._verified ? "#34C75955" : "#FF6B6B55"}`, borderRadius: 0,
              }}>
                {incident._verified ? "verified" : "unverified"}
              </span>
              <span style={{
                marginLeft: "auto",
                fontFamily: "Inter, sans-serif", fontSize: 14,
                color: BRAND.gold, lineHeight: 1,
                transform: isOpen ? "rotate(45deg)" : "rotate(0deg)",
                transition: "transform 220ms cubic-bezier(0.4,0,0.2,1)",
              }}>+</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 16px 16px 16px", fontSize: 11, color: BRAND.textSecondary }}>
                Status: <strong style={{ color: incident._verified ? "#34C759" : "#FF6B6B" }}>{incident._verified ? "verified" : "unverified"}</strong>
                {incident._verification_confidence && <> · confidence: <strong style={{ color: BRAND.white }}>{incident._verification_confidence}</strong></>}
                {incident._verification_flagged_claims && <> · flagged: <strong style={{ color: BRAND.white }}>{incident._verification_flagged_claims.length}</strong></>}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI OVERLAY — floats top-left of the map
// ─────────────────────────────────────────────────────────────────────────────
function KpiOverlay({ visibleIncidents, totalIncidents }) {
  const stats = useMemo(() => {
    const highSev = visibleIncidents.filter(i => i.severity >= 4).length;
    const countries = new Set(visibleIncidents.map(i => i.country).filter(Boolean));
    const cats = new Set(visibleIncidents.map(i => i._cat));
    return {
      total: visibleIncidents.length,
      filteredOut: totalIncidents - visibleIncidents.length,
      highSev,
      countries: countries.size,
      cats: cats.size,
    };
  }, [visibleIncidents, totalIncidents]);

  return (
    <div style={{
      position: "absolute",
      top: 12,
      left: 12,
      display: "flex",
      gap: 8,
      zIndex: 10,
      pointerEvents: "none",
    }}>
      {[
        { label: "Incidents",      value: stats.total,     sub: stats.filteredOut > 0 ? `+${stats.filteredOut} filtered` : "all visible" },
        { label: "Sev 4 & 5",      value: stats.highSev,   sub: "high + critical" },
        { label: "Countries",      value: stats.countries, sub: "geolocated" },
        { label: "GUARD cats",     value: `${stats.cats}/13`, sub: "categories hit" },
      ].map((k, i) => (
        <div key={i} style={{
          background: "rgba(36,36,36,0.92)",
          backdropFilter: "blur(8px)",
          border: `1px solid ${BRAND.borderSubtle}`,
          borderRadius: 0,
          padding: "8px 14px",
          minWidth: 92,
        }}>
          <div style={{ fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 2 }}>
            {k.label}
          </div>
          <div style={{ fontFamily: "Inter, sans-serif", fontWeight: 500, fontSize: 22, color: BRAND.gold, lineHeight: 1 }}>
            {k.value}
          </div>
          <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, marginTop: 3 }}>
            {k.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INCIDENT LIST PANEL — persistent left sidebar with all incidents, click to select
// ─────────────────────────────────────────────────────────────────────────────
function IncidentListPanel({ visibleIncidents, selectedId, onSelect, onHover, hoveredId, reporters, onClose }) {
  // Group by severity, descending
  const grouped = useMemo(() => {
    const buckets = { 5: [], 4: [], 3: [], 2: [], 1: [] };
    for (const inc of visibleIncidents) {
      // Clamp into 1-5 so an out-of-range severity is never silently dropped.
      let sev = Math.round(Number(inc.severity)) || 1;
      if (sev > 5) sev = 5;
      if (sev < 1) sev = 1;
      buckets[sev].push(inc);
    }
    return buckets;
  }, [visibleIncidents]);

  return (
    <div style={{
      background: "rgba(26,26,26,0.95)",
      backdropFilter: "blur(20px)",
      border: `1px solid rgba(252,189,0,0.20)`,
      borderRadius: 0,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      position: "relative",
      boxShadow: "0 22px 60px rgba(0,0,0,0.55)",
    }}>
      <div style={{
        padding: "12px 14px",
        borderBottom: `1px solid ${BRAND.borderSubtle}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 8,
      }}>
        <div style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: BRAND.gold, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 600 }}>
          ☷ FLEET · <span style={{ color: BRAND.white }}>{visibleIncidents.length}</span>
        </div>
        {onClose && (
          <button onClick={onClose}
            title="Close fleet panel"
            style={{
              width: 24, height: 24, padding: 0,
              background: "transparent", color: BRAND.textSecondary,
              border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
              cursor: "pointer", fontFamily: "Inter, sans-serif", fontSize: 13,
              lineHeight: 1,
            }}>
            ×
          </button>
        )}
      </div>
      <div style={{ overflowY: "auto", flex: 1, padding: "4px 0" }}>


        {[5, 4, 3, 2, 1].map(level => {
          const items = grouped[level];
          if (!items || items.length === 0) return null;
          const sev = SEVERITY[level];
          return (
            <div key={level}>
              <div style={{ padding: "6px 14px 4px 14px", fontFamily: "Inter, sans-serif", fontSize: 9, color: sev.color, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.8 }}>
                Sev {level} · {sev.label} · {items.length}
              </div>
              {items.map(inc => {
                const isSel = inc._id === selectedId;
                const isHover = inc._id === hoveredId;
                const cat = CATEGORIES[inc._cat];
                const rep = reporterForCat(inc._cat, reporters);
                return (
                  <div
                    key={inc._id}
                    onClick={() => onSelect(inc._id)}
                    onMouseEnter={() => onHover(inc._id)}
                    onMouseLeave={() => onHover(null)}
                    style={{
                      padding: "8px 14px",
                      borderLeft: isSel ? `3px solid ${sev.color}` : `3px solid transparent`,
                      background: isSel ? BRAND.goldTint : (isHover ? BRAND.obsidianElevated : "transparent"),
                      cursor: "pointer",
                      transition: "background 120ms",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <span style={{ width: 6, height: 6, borderRadius: 0, background: cat?.color || BRAND.gold, display: "inline-block" }} />
                      <span style={{ fontFamily: "Inter, sans-serif", fontSize: 8, color: BRAND.textMuted, letterSpacing: "0.06em" }}>
                        {inc._cat} · {inc.country || "—"} · {inc.event_date}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: BRAND.white, lineHeight: 1.3, marginBottom: 3, fontWeight: 500 }}>
                      {inc.headline}
                    </div>
                    {rep && (
                      <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: rep.color, letterSpacing: "0.04em" }}>
                        {rep.name}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {visibleIncidents.length === 0 && (
          <div style={{ padding: 20, fontSize: 12, color: BRAND.textMuted, textAlign: "center" }}>
            No incidents match active filters.
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT DRAWER — full-screen overlay with source-data audit trail table
// ─────────────────────────────────────────────────────────────────────────────
function AuditDrawer({ incidents, onClose }) {
  // Build a source-level audit: each unique source → list of incidents citing it
  const auditRows = useMemo(() => {
    const sourcesMap = new Map(); // url-or-title → { publisher, title, url, citingIncidents: [] }
    for (const inc of incidents) {
      for (const src of (inc.sources || [])) {
        const key = src.url || `${src.publisher || ""}-${src.title || ""}`;
        if (!key) continue;
        let row = sourcesMap.get(key);
        if (!row) {
          row = {
            publisher: src.publisher || "—",
            title: src.title || "—",
            url: src.url || null,
            citingIncidents: [],
          };
          sourcesMap.set(key, row);
        }
        row.citingIncidents.push(inc);
      }
    }
    return Array.from(sourcesMap.values()).sort((a, b) => b.citingIncidents.length - a.citingIncidents.length);
  }, [incidents]);

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      background: "rgba(8,8,8,0.92)",
      backdropFilter: "blur(6px)",
      zIndex: 200,
      display: "flex",
      flexDirection: "column",
      animation: "fadeIn 180ms cubic-bezier(0.4,0,0.2,1)",
    }}>
      <style>{`@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }`}</style>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 32px", borderBottom: `1px solid ${BRAND.borderSubtle}` }}>
        <div>
          <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 28, color: BRAND.white, margin: 0 }}>
            Source-data audit trail
          </h2>
          <div style={{ fontFamily: "Inter, sans-serif", fontSize: 12, color: BRAND.textSecondary, marginTop: 4 }}>
            Every source cited in the sweep · groupable by publisher · click an incident to navigate
          </div>
        </div>
        <button onClick={onClose}
          style={{ padding: "8px 16px", background: BRAND.gold, color: BRAND.obsidian, border: "none", borderRadius: 0, fontFamily: "Inter, sans-serif", fontSize: 11, letterSpacing: "0.08em", cursor: "pointer", fontWeight: 600 }}>
          CLOSE
        </button>
      </div>
      {/* Stats row */}
      <div style={{ display: "flex", gap: 32, padding: "12px 32px", borderBottom: `1px solid ${BRAND.borderSubtle}`, background: BRAND.obsidianDeep, fontFamily: "Inter, sans-serif", fontSize: 11, color: BRAND.textSecondary, letterSpacing: "0.04em" }}>
        <div><span style={{ color: BRAND.gold, fontSize: 16, marginRight: 6 }}>{auditRows.length}</span>unique sources</div>
        <div><span style={{ color: BRAND.gold, fontSize: 16, marginRight: 6 }}>{incidents.length}</span>incidents</div>
        <div><span style={{ color: BRAND.gold, fontSize: 16, marginRight: 6 }}>{auditRows.reduce((a, r) => a + r.citingIncidents.length, 0)}</span>citations total</div>
      </div>
      {/* Table */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 32px 32px 32px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "Inter, sans-serif", fontSize: 12 }}>
          <thead style={{ position: "sticky", top: 0, background: BRAND.obsidianDeep, zIndex: 1 }}>
            <tr style={{ borderBottom: `1px solid ${BRAND.borderSubtle}` }}>
              <th style={{ textAlign: "left", padding: "12px 8px", fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 500 }}>Publisher</th>
              <th style={{ textAlign: "left", padding: "12px 8px", fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 500 }}>Title</th>
              <th style={{ textAlign: "left", padding: "12px 8px", fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 500, width: 100 }}>Citations</th>
              <th style={{ textAlign: "left", padding: "12px 8px", fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 500 }}>Cited in</th>
            </tr>
          </thead>
          <tbody>
            {auditRows.map((row, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${BRAND.borderSubtle}` }}>
                <td style={{ padding: "10px 8px", color: BRAND.gold, fontFamily: "Inter, sans-serif", fontSize: 11, verticalAlign: "top" }}>
                  {row.publisher}
                </td>
                <td style={{ padding: "10px 8px", color: BRAND.white, verticalAlign: "top", maxWidth: 360 }}>
                  <div style={{ marginBottom: row.url ? 4 : 0 }}>{row.title}</div>
                  {row.url && (
                    <a href={row.url} target="_blank" rel="noreferrer"
                      style={{ color: BRAND.textMuted, fontSize: 10, fontFamily: "Inter, sans-serif", textDecoration: "none", wordBreak: "break-all" }}>
                      {row.url}
                    </a>
                  )}
                </td>
                <td style={{ padding: "10px 8px", color: BRAND.gold, fontFamily: "Inter, sans-serif", fontSize: 14, verticalAlign: "top" }}>
                  {row.citingIncidents.length}
                </td>
                <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {row.citingIncidents.slice(0, 8).map((inc, j) => {
                      const cat = CATEGORIES[inc._cat];
                      const sev = SEVERITY[inc.severity] || SEVERITY[3];
                      return (
                        <span key={j} title={inc.headline}
                          style={{ padding: "2px 7px", fontFamily: "Inter, sans-serif", fontSize: 9, background: BRAND.obsidianElevated, color: cat?.color || BRAND.white, borderLeft: `2px solid ${sev.color}`, borderRadius: 0 }}>
                          {inc._cat}·{inc._idx}
                        </span>
                      );
                    })}
                    {row.citingIncidents.length > 8 && (
                      <span style={{ padding: "2px 6px", fontSize: 10, color: BRAND.textMuted }}>+{row.citingIncidents.length - 8}</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {auditRows.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: BRAND.textMuted }}>No sources in the current sweep.</div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ARCHIVE PANEL — date-wise list of stored sweeps with click-to-load,
// delete, and persistence-status messaging. Reads from the archive index
// (passed in as a prop) so it renders fast without fetching sweeps.
// ─────────────────────────────────────────────────────────────────────────────
function ArchivePanel({ archiveIndex, currentDate, onLoad, onDelete, onClose, busy, storageSubstrate, storageCanaryError, liveDataError, onRefresh, timeWindow, onWindow, windowInfo, timeline }) {
  const persistsAcrossSessions = storageSubstrate === "persistent";
  // Live diagnostics: actual count of stored sweep keys (which may differ
  // from archiveIndex.length if the index is mid-recovery or a write failed)
  const [diag, setDiag] = useState(null);
  const [showDiag, setShowDiag] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const d = await storageDiagnostics();
      if (!cancelled) setDiag(d);
    })();
    return () => { cancelled = true; };
  }, [archiveIndex]);

  // Group entries by month for readability when the archive grows large.
  const groups = useMemo(() => {
    const map = new Map();
    for (const e of archiveIndex) {
      const monthKey = e.date.slice(0, 7); // YYYY-MM
      if (!map.has(monthKey)) map.set(monthKey, []);
      map.get(monthKey).push(e);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [archiveIndex]);

  function formatDate(dateStr) {
    try {
      const d = new Date(dateStr + "T00:00:00Z");
      return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    } catch { return dateStr; }
  }
  function formatMonth(ym) {
    try {
      const [y, m] = ym.split("-");
      const d = new Date(Date.UTC(parseInt(y), parseInt(m) - 1, 1));
      return d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    } catch { return ym; }
  }

  const orphans = diag ? Math.max(0, diag.storedSweepCount - archiveIndex.length) : 0;

  return (
    <div className="r-mappanel map-archive" style={{
      // Compact floating card — same look/placement as the Filters panel
      // (top-left), not a full-height right drawer.
      position: "fixed", top: 108, left: 24, width: 340,
      maxHeight: "72vh", overflowY: "auto",
      background: "rgba(20,20,22,0.96)", backdropFilter: "blur(20px)",
      border: `1px solid ${BRAND.borderGold}`, borderRadius: 0,
      boxShadow: "0 18px 50px rgba(0,0,0,0.6)", zIndex: 30,
      display: "flex", flexDirection: "column",
    }}>
      {/* Header */}
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${BRAND.borderSubtle}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, color: BRAND.gold, letterSpacing: "0.14em", textTransform: "uppercase" }}>
          ◇ Timeline
          <span style={{ color: BRAND.textMuted, fontWeight: 500, marginLeft: 8 }}>{archiveIndex.length} days</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onRefresh}
            title="Re-scan storage for sweeps"
            style={{ width: 32, height: 32, padding: 0, background: "transparent", color: BRAND.gold, fontFamily: "Inter, sans-serif", fontSize: 12, border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0, cursor: "pointer" }}>
            ↻
          </button>
          <button onClick={onClose}
            style={{ width: 32, height: 32, padding: 0, background: "transparent", color: BRAND.textSecondary, fontFamily: "Inter, sans-serif", fontSize: 16, border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0, cursor: "pointer" }}>
            ×
          </button>
        </div>
      </div>

      {/* Live-feed failure. Without this the map degrades in total silence:
          the baked sweeps still paint a full-looking archive, so a stale
          May snapshot is indistinguishable from today's data. ↻ retries. */}
      {liveDataError && (
        <div style={{
          padding: "10px 16px", borderBottom: `1px solid ${BRAND.borderSubtle}`,
          background: "rgba(255,107,107,0.10)",
        }}>
          <div style={{
            fontFamily: "Inter, sans-serif", fontSize: 9, color: "#FF6B6B",
            letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4,
          }}>
            ⚠ Live feed unavailable
          </div>
          <div style={{ fontFamily: "Inter, sans-serif", fontSize: 10.5, color: BRAND.textSecondary, lineHeight: 1.5 }}>
            Showing archived sweeps only — this is not today's data. Press ↻ to retry.
          </div>
        </div>
      )}

      {/* Time-window toggle (Day/Week/Month/All) removed — the archive now
          exposes only the calendar range + play controls below. */}

      {/* Date range → auto-play. Pick From→To; the range renders and then the
          map steps through the days automatically at the chosen interval. */}
      {timeline && archiveIndex.length > 0 && (() => {
        const inStyle = {
          flex: 1, minWidth: 0, background: BRAND.obsidian, color: BRAND.white,
          border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0, padding: "6px 8px",
          fontFamily: "Inter, sans-serif", fontSize: 11, colorScheme: "dark",
        };
        const cur = timeline.playDates[timeline.playPos];
        return (
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${BRAND.borderSubtle}` }}>
            <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>
              ◇ Date Range · Auto-play
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <label style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "Inter, sans-serif", fontSize: 8.5, color: BRAND.textMuted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4 }}>From</div>
                <input type="date" value={timeline.rangeFrom} disabled={busy}
                  onChange={e => timeline.setRangeFrom(e.target.value)} style={{ ...inStyle, width: "100%" }} />
              </label>
              <label style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "Inter, sans-serif", fontSize: 8.5, color: BRAND.textMuted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4 }}>To</div>
                <input type="date" value={timeline.rangeTo} disabled={busy}
                  onChange={e => timeline.setRangeTo(e.target.value)} style={{ ...inStyle, width: "100%" }} />
              </label>
            </div>
            {/* Two explicit actions. "Show range" holds every incident in
                From→To on the map so it can be read and briefed; "Play days"
                animates through the days one at a time. Previously a single
                button did both, and the animation immediately replaced the
                range view — so the range could never actually be seen. */}
            {(() => {
              const noRange = !timeline.rangeFrom || !timeline.rangeTo;
              const dis = busy || noRange;
              const base = {
                flex: 1, padding: "8px 0", borderRadius: 0, fontFamily: "Inter, sans-serif",
                fontSize: 10, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase",
                cursor: busy ? "wait" : (noRange ? "not-allowed" : "pointer"),
              };
              const sameDay = timeline.rangeFrom && timeline.rangeFrom === timeline.rangeTo;
              return (
                <>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
                    <button
                      onClick={() => !dis && timeline.onApplyRange(timeline.rangeFrom, timeline.rangeTo)}
                      disabled={dis}
                      title="Show every incident in this date range on the map at once"
                      style={{
                        ...base,
                        background: dis ? "transparent" : BRAND.gold,
                        color: dis ? BRAND.textMuted : BRAND.obsidian,
                        border: `1px solid ${dis ? BRAND.borderSubtle : BRAND.gold}`,
                      }}>
                      ◈ Show range
                    </button>
                    <button
                      onClick={() => !dis && timeline.onPlayRange(timeline.rangeFrom, timeline.rangeTo)}
                      disabled={dis || sameDay}
                      title={sameDay ? "Pick a From date earlier than To to animate across days" : "Step through the range one day at a time"}
                      style={{
                        ...base,
                        background: "transparent",
                        color: (dis || sameDay) ? BRAND.textMuted : BRAND.gold,
                        border: `1px solid ${(dis || sameDay) ? BRAND.borderSubtle : BRAND.gold}`,
                        cursor: sameDay ? "not-allowed" : base.cursor,
                      }}>
                      ▶ Play days
                    </button>
                  </div>
                  <div style={{ marginTop: 6, fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, lineHeight: 1.5 }}>
                    {sameDay
                      ? `Single day — ${timeline.rangeFrom}. Show range, then 📻 Brief reads that day.`
                      : "Show range = all days at once (Brief reads the whole range). Play days = one day at a time."}
                  </div>
                </>
              );
            })()}

            {timeline.playDates.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontFamily: "Inter, sans-serif", fontSize: 14, fontWeight: 800, color: timeline.playing ? BRAND.gold : BRAND.white }}>{cur || "—"}</span>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <button onClick={() => timeline.onPlayBrief && timeline.onPlayBrief()}
                      title={timeline.briefPlaying ? "Stop the news brief" : "Read out every incident currently on the map — the whole range if a range is shown, otherwise this day"}
                      style={{ background: timeline.briefPlaying ? BRAND.gold : "transparent", border: `1px solid ${BRAND.gold}`, borderRadius: 0, color: timeline.briefPlaying ? BRAND.obsidian : BRAND.gold, padding: "4px 9px", fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      {timeline.briefPlaying ? "■ Brief" : "📻 Brief"}
                    </button>
                    <button onClick={() => timeline.onToggleNarrate()}
                      title={timeline.narrate ? "Mute date narration" : "Enable date narration"}
                      style={{ background: "transparent", border: `1px solid ${timeline.narrate ? BRAND.gold : BRAND.borderSubtle}`, borderRadius: 0, color: timeline.narrate ? BRAND.gold : BRAND.textSecondary, padding: "4px 9px", fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      {timeline.narrate ? "🔊" : "🔇"}
                    </button>
                    <button onClick={() => timeline.onTogglePlay()}
                      style={{ background: "transparent", border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0, color: BRAND.textSecondary, padding: "4px 10px", fontFamily: "Inter, sans-serif", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                      {timeline.playing ? "⏸ Pause" : "▶ Resume"}
                    </button>
                  </div>
                </div>
                <input className="map-range" type="range" min={0} max={timeline.playDates.length - 1} value={timeline.playPos}
                  onChange={e => timeline.onScrub(Number(e.target.value))}
                  style={{ width: "100%", accentColor: BRAND.gold, cursor: "pointer" }} />
                <div style={{ marginTop: 3, fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.04em", textAlign: "right" }}>
                  day {timeline.playPos + 1} / {timeline.playDates.length}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {archiveIndex.length === 0 && (
        <div style={{ padding: "24px 16px", textAlign: "center", color: BRAND.textMuted }}>
          <div style={{ fontFamily: "Inter, sans-serif", fontSize: 14, color: BRAND.white, marginBottom: 6 }}>No archived days yet</div>
          <div style={{ fontFamily: "Inter, sans-serif", fontSize: 11, color: BRAND.textSecondary, lineHeight: 1.5 }}>
            Upload a GUARD daily JSON — it's stored by date automatically.
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GuidedTour — a narrated, auto-playing walkthrough of ONE high-severity
// incident so a first-time visitor instantly understands the map, then explores
// on their own. Features the top incident, opens its cascade cards, and steps
// through 5 captions (incident → classification → blast radius → controls →
// vendors). Captions/visuals auto-play; voice (browser TTS) activates on the
// first "Sound on" tap (required by browser autoplay policy).
// ─────────────────────────────────────────────────────────────────────────────
const _tourTiny = (active, light) => ({
  background: active ? (light ? "rgba(252,189,0,0.14)" : "rgba(252,189,0,0.16)") : (light ? "rgba(10,10,10,0.05)" : "rgba(255,255,255,0.06)"),
  color: active ? (light ? "#8A6D00" : "#FCBD00") : (light ? "#52525B" : "rgba(255,255,255,0.7)"),
  border: light ? "1px solid #E7E7E9" : "1px solid rgba(255,255,255,0.12)", borderRadius: 0, padding: "4px 9px",
  fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer",
  fontFamily: "Inter, sans-serif", textTransform: "uppercase", whiteSpace: "nowrap",
});
const _tourNav = (disabled, light) => ({
  background: disabled ? (light ? "rgba(10,10,10,0.05)" : "rgba(255,255,255,0.04)") : "#FCBD00",
  color: disabled ? (light ? "rgba(10,10,10,0.3)" : "rgba(255,255,255,0.3)") : "#1A1A1A",
  border: "none", borderRadius: 0, padding: "8px 16px", fontSize: 12, fontWeight: 700,
  letterSpacing: "0.04em", cursor: disabled ? "default" : "pointer", fontFamily: "Inter, sans-serif",
});

function GuidedTour({ incident, onFeature, onClose, light }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [voiceOn, setVoiceOn] = useState(false);
  const tokenRef = useRef(0);
  const timerRef = useRef(null);

  const sev = SEVERITY[incident?.severity] || {};
  const cat = CATEGORIES[incident?._cat || incident?.primary_category] || {};
  const entity = String(incident?.entity || incident?.headline || "this incident").split("(")[0].trim();

  const STEPS = useMemo(() => [
    { label: "THE INCIDENT",
      caption: `Start here — ${entity}, rated ${sev.label || "HIGH"}. This card is the plain story: what happened, when, and where.`,
      voice: `Welcome. Let's walk through one real incident so you can see how the map works. We're looking at ${entity}, rated ${(sev.label || "high")} severity. This first card is the plain-language story — what happened, the date, and where it occurred.` },
    { label: "CLASSIFICATION",
      caption: `Every incident is graded through the GUARD framework — here, ${cat.label || "its category"} — with the reasoning shown so you can trust it.`,
      voice: `Next, the classification. Every incident is mapped into the GUARD framework. This one falls under ${cat.label || "its risk category"}, and the card explains exactly why, so you can compare incidents consistently.` },
    { label: "BLAST RADIUS", advance: true,
      caption: `The blast radius — who else is exposed: suppliers, customers, regulators and competitive peers. Tap any ring for the named entities.`,
      voice: `Now the most important part — the blast radius. It's not just this company. The map traces the named entities exposed: the supply chain, customers, regulators and competitive peers. Each carries its own impact score and recommended action.` },
    { label: "WHAT TO DO", advance: true,
      caption: `Adaptive controls — what should have been in place, and the concrete, testable steps that reduce the risk.`,
      voice: `Then, the adaptive controls. This answers the board-level question — what should we have had in place? The engine surfaces the objectives and the concrete controls that close the gap.` },
    { label: "WHO CAN HELP", advance: true,
      caption: `And who can actually help — real vendors mapped to the controls, each with an AI verdict. That's the whole journey. Now explore the map yourself →`,
      voice: `And finally, vendor intelligence. Real vendors are mapped to the controls, each with a transparent A-I verdict. That's the full journey — from one incident, to its blast radius, to the fix, to who can help. Now go ahead and explore the map yourself.` },
  ], [entity, sev.label, cat.label]);

  // Feature the incident on mount (opens its cascade cards).
  useEffect(() => {
    if (incident && onFeature) onFeature(incident._id);
    return () => { try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* noop */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const estimateMs = (t) => Math.max(5600, Math.round(((String(t || "").split(/\s+/).length) / 165) * 60000) + 1400);

  function clickNextScene() {
    try {
      const btns = document.querySelectorAll('[aria-label="Next scene"]');
      const b = btns[btns.length - 1];
      if (b && !b.disabled) b.click();
    } catch { /* noop */ }
  }
  function finish() {
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* noop */ }
    onClose && onClose();
  }

  // Advance the underlying cascade to match the step — ONCE per step entry.
  // Kept separate so play/pause/voice toggles never move the cascade.
  useEffect(() => {
    const s = STEPS[step];
    if (s && s.advance) clickNextScene();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Auto-advance timer + narration — fully gated on `playing`, so Pause stops
  // the timer AND cancels any in-flight speech, without touching the cascade.
  useEffect(() => {
    const s = STEPS[step];
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!s || !playing) {
      try { synth && synth.cancel(); } catch { /* noop */ }
      return;
    }
    const token = ++tokenRef.current;
    const goNext = () => {
      if (token !== tokenRef.current) return;
      if (step < STEPS.length - 1) setStep(step + 1);
      else finish();
    };
    if (voiceOn && synth) {
      try {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(s.voice);
        u.rate = 0.98; u.pitch = 1; u.volume = 1;
        u.onend = goNext; u.onerror = goNext;
        synth.speak(u);
        timerRef.current = setTimeout(goNext, estimateMs(s.voice) + 7000); // safety
      } catch { timerRef.current = setTimeout(goNext, estimateMs(s.caption)); }
    } else {
      timerRef.current = setTimeout(goNext, estimateMs(s.caption));
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, playing, voiceOn]);

  const s = STEPS[step];
  const pct = ((step + 1) / STEPS.length) * 100;

  return (
    <div className="map-tour" style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 200, display: "flex", justifyContent: "center", padding: "0 16px 96px", pointerEvents: "none" }}>
      <div style={{ pointerEvents: "auto", width: "min(760px, 96vw)", background: light ? "rgba(255,255,255,0.98)" : "rgba(16,16,18,0.94)", backdropFilter: "blur(18px)", border: light ? "1px solid #E7E7E9" : "1px solid rgba(252,189,0,0.30)", borderRadius: 0, boxShadow: light ? "0 24px 70px rgba(10,10,10,0.18)" : "0 24px 70px rgba(0,0,0,0.6)", overflow: "hidden", fontFamily: "Inter, sans-serif" }}>
        <div style={{ height: 3, background: light ? "rgba(10,10,10,0.08)" : "rgba(255,255,255,0.08)" }}>
          <div style={{ height: "100%", width: pct + "%", background: "linear-gradient(90deg,#FCBD00,#D4A000)", transition: "width 300ms ease" }} />
        </div>
        <div style={{ padding: "15px 20px 17px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: light ? "#8A6D00" : "#FCBD00" }}>
              ◆ Guided tour · {s.label} <span style={{ color: light ? "rgba(10,10,10,0.4)" : "rgba(255,255,255,0.4)" }}>· {step + 1}/{STEPS.length}</span>
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setVoiceOn(v => !v)} style={_tourTiny(voiceOn, light)}>{voiceOn ? "🔊 Sound on" : "🔇 Tap for sound"}</button>
              <button onClick={finish} style={_tourTiny(false, light)}>Skip ✕</button>
            </div>
          </div>
          <div style={{ fontSize: 16, lineHeight: 1.55, color: light ? "#0A0A0A" : "#FFFFFF", fontWeight: 500, minHeight: 50 }}>{s.caption}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, gap: 12 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} style={_tourNav(step === 0, light)}>‹ Back</button>
              <button onClick={() => { if (step < STEPS.length - 1) setStep(step + 1); else finish(); }} style={_tourNav(false, light)}>{step < STEPS.length - 1 ? "Next ›" : "Finish ✓"}</button>
              <button onClick={() => setPlaying(p => !p)} style={_tourNav(false, light)}>{playing ? "⏸ Pause" : "▶ Play"}</button>
            </div>
            <button className="map-tour-replay" onClick={() => { tokenRef.current++; setStep(0); setPlaying(true); }} style={{ background: "none", border: "none", color: light ? "rgba(10,10,10,0.5)" : "rgba(255,255,255,0.5)", fontSize: 12, cursor: "pointer", fontFamily: "Inter, sans-serif" }}>↻ Replay</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function GlobalAttackMap() {
  const [sweep, setSweep] = useState(null);
  const [sweepName, setSweepName] = useState(null);
  const [error, setError] = useState(null);
  const [viewMode, setViewMode] = useState("buyer"); // "buyer" | "newsroom"

  // Admin chrome (Drop-a-sweep upload zone, NEW FILE button, ARCHIVE admin
  // controls) is the operator's tooling — it should NEVER show to free,
  // partner, enterprise, or vendor users. Real users don't upload JSONs.
  //
  // Gate is now on the authenticated tier (from AuthProvider), not the URL.
  //   • tier === 'admin'                       → admin chrome visible
  //   • everyone else (free/partner/.../anon)  → user mode (chrome hidden)
  //
  // URL override kept for QA / preview links:
  //   ?role=admin → force admin chrome on (only honoured if the user is
  //                 actually admin — prevents a non-admin from leaking
  //                 operator UI by typing the param).
  //   ?role=user  → force user mode on (lets admins screenshot the user view).
  const { tier: chromeTier } = useAuth();
  // Forward the reader's session token to every PostgREST read the map makes
  // (see setReaderToken). Kept in step with sign-in / sign-out.
  // Mirrored into state as well as the module variable: the session resolves
  // AFTER the first render, and the child-record effect had no dependency to
  // re-run on. An incident opened in that window kept the free-tier teaser for
  // the life of the page, so a subscriber who clicked early saw one peer and
  // one control until a full reload.
  const [readerToken, setReaderTokenState] = useState(null);
  useEffect(() => {
    const take = (tok) => { setReaderToken(tok); setReaderTokenState(tok || null); };
    // authClient works on either backend (Supabase, or our API on GCP).
    fetchReaderToken().then(take).catch(() => {});
    return onReaderToken(take);
  }, []);
  const isUserMode = useMemo(() => {
    let override = null;
    if (typeof window !== "undefined") {
      try {
        const params = new URLSearchParams(window.location.search);
        const role = params.get("role");
        if (role === "user" || role === "admin") override = role;
      } catch { /* noop */ }
    }
    // Explicit ?role=user always wins (admin previewing user chrome).
    if (override === "user") return true;
    // ?role=admin only honoured if the signed-in user is actually admin —
    // otherwise a partner could just type the param and see operator UI.
    if (override === "admin" && chromeTier === "admin") return false;
    // Default: hide admin chrome unless the user is admin tier.
    return chromeTier !== "admin";
  }, [chromeTier]);
  const [mapMode, setMapMode] = useState("globe");   // "flat" | "globe" — v4 (default: globe)
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [activeReporters, setActiveReporters] = useState(new Set()); // empty = all
  // Per-category filter — drives the top-left chip strip. Each chip toggles
  // ONE category (CYB, DAT, TEC, …) independently. Previously the chips
  // toggled the whole reporter desk that owned the category, which meant
  // clicking CYB also activated DAT + TEC (both owned by Cyber Bob). This
  // set lets the user select categories one at a time as the chips suggest.
  const [activeCats, setActiveCats] = useState(new Set());
  const [activeIndustries, setActiveIndustries] = useState(new Set());
  const [industryPanelOpen, setIndustryPanelOpen] = useState(false);
  const [activeCountries, setActiveCountries] = useState(new Set());
  const [regionPanelOpen, setRegionPanelOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false); // top-left Filters drawer
  const [showBlastRadius, setShowBlastRadius] = useState(true);
  const [selBlast, setSelBlast] = useState(null);   // blast_radius (grouped) for the selected incident, lazily fetched on tap
  const [childVersion, setChildVersion] = useState(0); // bumped when the selected incident's child rows finish loading
  const [showHeat, setShowHeat] = useState(false);  // off by default — heat halos compete with the cinematic pin bloom; user can toggle on for analytical density view
  const [showLabels, setShowLabels] = useState(false);  // country + city labels off by default
  // v2 additions
  const [activeSeverities, setActiveSeverities] = useState(new Set()); // empty = all
  const [activeConfidences, setActiveConfidences] = useState(new Set()); // empty = all
  const [showListPanel, setShowListPanel] = useState(false);
  const [showAuditDrawer, setShowAuditDrawer] = useState(false);
  const [showFilterPopover, setShowFilterPopover] = useState(false);
  // v3 additions
  const [searchQuery, setSearchQuery] = useState(""); // substring search

  // v4 archive — persistent day-wise storage of uploaded sweeps. The index
  // is loaded once on mount and refreshed whenever a sweep is added or
  // deleted. `currentDate` tracks which date is currently rendered.
  const [archiveIndex, setArchiveIndex] = useState([]);
  const [currentDate, setCurrentDate] = useState(null);
  const [showArchive, setShowArchive] = useState(false);
  const isMobile = useIsMobile();                  // drives the phone shell (bar + sheets)
  const [showLayers, setShowLayers] = useState(false); // mobile "Layers" bottom sheet
  const [booting, setBooting] = useState(true);   // true while the initial data load runs
  const [tourActive, setTourActive] = useState(false); // guided narrated walkthrough overlay
  const tourStartedRef = useRef(false);
  const liveDaysRef = useRef(null);          // every live day's sweep, for ?incident= links off the rendered day
  const deepLinkSwitchedRef = useRef(false); // we already switched the day for a deep link
  const [mobilePreview, setMobilePreview] = useState(false); // mobile guided preview (auto-playing swipe deck)
  const mobilePreviewStartedRef = useRef(false);
  const [deckReady, setDeckReady] = useState(false); // mobile: brief delay so the globe focus+arcs are seen before the deck opens
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showSubscribeModal, setShowSubscribeModal] = useState(false);

  // Global event subscriber — any GateBlock click anywhere opens the modal.
  useEffect(() => {
    const handler = () => setShowSubscribeModal(true);
    window.addEventListener(SUBSCRIBE_MODAL_EVENT, handler);
    return () => window.removeEventListener(SUBSCRIBE_MODAL_EVENT, handler);
  }, []);

  // ────────────────────────────────────────────────────────────────────
  // Access tier — derived from the authenticated user's tier.
  //   • anonymous / 'free'    → 'public'   (gated view)
  //   • 'partner' / 'admin'   → 'partner'  (full view)
  // The ?preview=public|partner URL param (handled in AuthProvider) lets
  // QA flip without real auth — useful for the demo.
  // ────────────────────────────────────────────────────────────────────
  // chromeTier above is the live auth tier; reuse it here as the access gate.
  const accessTier = isSubscriber(chromeTier) ? "subscriber" : "public";
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveToast, setArchiveToast] = useState(null);  // { type, text }
  const [storageSubstrate, setStorageSubstrate] = useState("unknown");  // "persistent" | "session" | "unknown"
  const [storageCanaryError, setStorageCanaryError] = useState(null);
  // Set when the live Supabase pull returns nothing this boot. When that
  // happens the map silently falls back to the 13 sweep files baked into
  // public/sweeps/ — which stop at 2026-05-28 — so the map looks fully
  // populated while actually showing months-old data with no adapted
  // controls. Surfaced in the Timeline panel rather than swallowed.
  const [liveDataError, setLiveDataError] = useState(null);
  // Time-window aggregation — "day" (default, single sweep) | "week" |
  // "month" | "all". When not "day", the rendered sweep is a synthetic
  // merge of the relevant archived days (see applyTimeWindow). currentDate
  // still tracks the anchor day the window is computed backward from.
  const [timeWindow, setTimeWindow] = useState("day");
  const [windowInfo, setWindowInfo] = useState(null);  // { kind, from, to, days, requested }
  // Date-RANGE + AUTO timeline playback. Applying a range shows every incident
  // in it, then automatically steps through the days one at a time (no manual
  // Play button). playDates = ascending days in range; playCacheRef memoises the
  // per-day sweeps so the loop never refetches. See applyRange() + effect below.
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [playing, setPlaying] = useState(false);
  const [playDates, setPlayDates] = useState([]);
  const [playPos, setPlayPos] = useState(0);
  const [playSummary, setPlaySummary] = useState("");
  const [playSpeedMs, setPlaySpeedMs] = useState(35000);  // ~35 s/day default (configurable)
  const [narrate, setNarrate] = useState(true);           // speak the current date as playback advances
  const playCacheRef = useRef(new Map());

  const { world, err: worldErr } = useWorldGeo();

  // On mount: verify storage works (real write/read round-trip), then load
  // the index (with orphan-recovery). If anything's stored, auto-restore
  // the most recent sweep so reopening the app feels like the session
  // never ended. Errors are surfaced via state for the UI to display
  // rather than swallowed silently.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 0) FAST FIRST PAINT — render the newest day's dots immediately from a
        // light incidents-only query, so the map never sits on an empty screen
        // while the heavy enrichment below loads. Applies to users AND admins.
        let fastDay = null;
        // Deep links pin the boot to a day: ?date=YYYY-MM-DD, or ?incident=<id>
        // whose day the first paint resolves. The archive swap below honours
        // the pin, so nothing later moves the map off the linked incident.
        let pinnedDay = null, wantIncident = null;
        try {
          const p = new URLSearchParams(window.location.search);
          const d = p.get("date"); if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) pinnedDay = d;
          wantIncident = p.get("incident");
        } catch { /* noop */ }
        const paint = (day, sweep) => {
          if (cancelled) return;
          setSweep(sweep); setSweepName(`daily_${day}.json`); setCurrentDate(day); fastDay = day;
        };
        // Both loads start now. For a deep link the single-day query (a few
        // hundred rows) usually lands first and paints the linked incident;
        // the every-day light load follows and fills liveDaysRef.
        const oneP = (pinnedDay || wantIncident)
          ? loadOneDayFast(pinnedDay, wantIncident).catch((e) => { console.warn("Deep-link day paint skipped:", e?.message || e); return null; })
          : Promise.resolve(null);
        const fastP = loadIncidentsFast(pinnedDay, wantIncident).catch((e) => { console.warn("Fast paint skipped:", e?.message || e); return null; });
        oneP.then((one) => { if (one && !fastDay) { paint(one.day, one.sweep); if (wantIncident && !pinnedDay) pinnedDay = one.day; } });
        const fast = await fastP;
        if (fast && !cancelled) {
          if (fast.sweepsByDay) liveDaysRef.current = fast.sweepsByDay;
          if (!fastDay || fast.day === fastDay) paint(fast.day, fast.sweep);
          if (wantIncident && !pinnedDay) pinnedDay = fast.day;
        }
        await oneP;
        if (cancelled) return;

        await verifyStorage();
        if (cancelled) return;
        setStorageSubstrate(_storageState.substrate);
        setStorageCanaryError(_storageState.canaryError);

        // Pull in any sweeps baked into /public/sweeps/index.json. Runs only
        // when the substrate doesn't already hold them — keeps reloads fast
        // when window.storage persists data. For the in-memory fallback
        // (e.g. plain browser), this is the source of all data.
        try {
          const existing = await _store().list("sweep:");
          const have = new Set((existing?.keys || []).map(k => k.slice(6)));
          // Always run loadBakedSweeps when nothing is stored; otherwise skip.
          if (have.size === 0) {
            await loadBakedSweeps();
          }
        } catch (e) {
          console.warn("Baked-sweep load skipped:", e?.message || e);
        }
        if (cancelled) return;

        // Overlay live Supabase data on top of baked-in. Matching dates get
        // overwritten by the DB version — newer days are added. Runs every
        // boot so newly-pushed sweeps appear on the next refresh without a
        // redeploy.
        let supa = null;
        try {
          supa = await loadFromSupabase();
        } catch (e) {
          console.warn("Supabase load skipped:", e?.message || e);
          if (!cancelled) setLiveDataError(e?.message || String(e));
        }
        if (cancelled) return;
        if (supa && supa.sweepsByDay) liveDaysRef.current = supa.sweepsByDay;
        // A thrown error is not the only failure mode: _fetchSupabaseTable
        // swallows non-OK responses and returns [], so an exhausted egress
        // allowance or a revoked key comes back as a perfectly ordinary empty
        // result. Treat "no live days at all" as the failure it is.
        if (!supa || !supa.sweepsByDay || supa.sweepsByDay.size === 0) {
          setLiveDataError(prev => prev || "no live incidents returned");
        } else {
          setLiveDataError(null);
        }

        const idx = await readIndex();   // self-healing — discovers orphans
        if (cancelled) return;
        setArchiveIndex(idx);

        let loadedSweep = false;
        if (idx.length > 0) {
          // ?date=YYYY-MM-DD URL param lands the boot on a specific archived
          // sweep so any tier (including free/?preview=free, who don't have
          // the archive button) can reach a past day. Falls back to newest.
          let target = idx[0]; // default: newest
          let explicitDate = pinnedDay;   // ?date=, or the day a ?incident= deep link resolved to
          let archiveHasDay = true;
          if (explicitDate) {
            const match = idx.find(x => x.date === explicitDate);
            if (match) target = match; else archiveHasDay = false;
          }

          // Don't DOWNGRADE the fast-painted day to an OLDER archived day (e.g.
          // baked May data when live shows June). Only swap in the archive
          // sweep if it's the same day (now enriched), newer, or ?date-requested.
          // A pinned day the archive does not hold keeps the fast paint (which
          // already shows it) instead of swapping in a different day.
          if (archiveHasDay && (!fastDay || explicitDate || target.date >= fastDay)) {
            const json = await readSweep(target.date);
            if (cancelled) return;
            if (json) {
              setSweep(json);
              setSweepName(target.fileName || `sweep_${target.date}.json`);
              setCurrentDate(target.date);
              loadedSweep = true;
            }
          }
        }

        // FALLBACK — nothing painted yet (no fast paint, empty index or failed
        // read) but we DID fetch live data this boot. Render the newest day
        // straight from memory so the map ALWAYS opens populated.
        if (!loadedSweep && !fastDay && supa && supa.sweepsByDay && supa.sweepsByDay.size > 0) {
          const days = [...supa.sweepsByDay.keys()]
            .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
            .sort();
          const newest = days[days.length - 1];
          if (newest && !cancelled) {
            setSweep(supa.sweepsByDay.get(newest));
            setSweepName(`daily_${newest}.json`);
            setCurrentDate(newest);
          }
        }
      } catch (e) {
        console.error("Archive boot failed:", e);
        if (!cancelled) {
          setStorageSubstrate("session");
          setStorageCanaryError(e?.message || String(e));
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ESC key closes the topmost open panel in a sensible priority order:
  // archive > audit > detail panel > filter popover > fleet > selection.
  // World-class apps always let Esc dismiss; this gives the user a reliable
  // exit when click-outside isn't obvious.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== "Escape") return;
      if (showArchive)       { setShowArchive(false);       return; }
      if (showAuditDrawer)   { setShowAuditDrawer(false);   return; }
      if (selectedId)        { setSelectedId(null);         return; }
      if (showFilterPopover) { setShowFilterPopover(false); return; }
      if (showListPanel)     { setShowListPanel(false);     return; }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showArchive, showAuditDrawer, selectedId, showFilterPopover, showListPanel]);

  const { incidents, meta } = useMemo(() => parseSweep(sweep), [sweep]);

  // Deep-link: ?incident=<_id> auto-opens that incident's card once the sweep
  // has loaded, so a specific incident can be shared by direct URL. Fires once.
  // Deep link: ?incident=<id> auto-opens that incident. Accepts the map's
  // synthetic _id ("2026-08-13-PHY-3") or the database id ("2583") that the
  // dashboard, the Hub and the landing page link with.
  //
  // The map renders ONE day at a time, so an incident from an earlier day is
  // not in `incidents` at all. Callers pass &date=<day> so the boot lands on
  // that day directly; if it is missing (or the archive lacks the day) we
  // search every live day kept in liveDaysRef and switch to the one that
  // holds the incident. Keeps trying until it is found or the boot finishes.
  const deepLinkDone = useRef(false);
  const deepLinkWantRef = useRef(null);   // the DB id asked for in the URL
  const deepLinkSelRef = useRef(null);    // the _id we selected for it
  const deepLinkSeenRef = useRef(false);  // our selection has been committed at least once
  useEffect(() => {
    if (deepLinkDone.current || !incidents.length) return;
    let want = null;
    try { want = new URLSearchParams(window.location.search).get("incident"); } catch { /* noop */ }
    if (!want) { deepLinkDone.current = true; return; }
    const w = String(want);
    const hit = incidents.find(i => String(i._id) === w) || incidents.find(i => i.id != null && String(i.id) === w);
    if (hit) { deepLinkWantRef.current = hit.id != null ? String(hit.id) : null; deepLinkSelRef.current = hit._id; setSelectedId(hit._id); deepLinkDone.current = true; return; }
    const days = liveDaysRef.current;
    if (days && !deepLinkSwitchedRef.current) {
      for (const [day, sw] of days) {
        const rows = Object.values(sw?.results || {}).flatMap(r => (r && r.incidents) || []);
        if (rows.some(i => i && i.id != null && String(i.id) === w)) {
          deepLinkSwitchedRef.current = true;
          setSweep(sw); setSweepName(`daily_${day}.json`); setCurrentDate(day);
          return; // re-runs when `incidents` recomputes for the new day
        }
      }
    }
    if (!booting) deepLinkDone.current = true;
  }, [incidents, booting]);

  // Hold the linked incident as the sweep is replaced underneath us.
  //
  // `_id` is POSITIONAL within a day ("STR-2" = the 3rd Strategic incident of
  // that sweep), so when the enriched sweep replaces the fast-painted one the
  // same `_id` can point at a DIFFERENT incident — the linked card silently
  // became another story ~10s after opening. Re-find by DATABASE id on every
  // list change and move the selection if it drifted. Only while the selection
  // is still the one we made: if the reader closed the card or clicked another
  // incident, we stop and leave them alone.
  useEffect(() => {
    const want = deepLinkWantRef.current;
    if (!want || !incidents.length) return;
    if (selectedId === deepLinkSelRef.current) {
      deepLinkSeenRef.current = true;          // React has committed our selection
    } else if (deepLinkSeenRef.current) {
      deepLinkWantRef.current = null;          // the reader closed it or picked another — leave them alone
      return;
    } else {
      return;                                  // set but not yet committed: wait, do NOT give up
    }
    const hit = incidents.find(i => i.id != null && String(i.id) === want);
    if (hit && hit._id !== selectedId) { deepLinkSelRef.current = hit._id; setSelectedId(hit._id); }
  }, [incidents, selectedId]);

  const reporters = meta.newsroom || DEFAULT_REPORTERS;

  // Visible incidents after reporter + category + severity + confidence + search filters
  const visibleIncidents = useMemo(() => {
    let filtered = incidents;
    // Per-category filter — top-left chip strip. Empty = all.
    if (activeCats.size > 0) {
      filtered = filtered.filter(inc => activeCats.has(inc._cat));
    }
    // Reporter-desk filter (still used by the Newsroom desk surface). Empty = all.
    if (activeReporters.size > 0) {
      const deskCats = new Set();
      for (const repId of activeReporters) {
        const r = reporters[repId];
        r?.cats?.forEach(c => deskCats.add(c));
      }
      filtered = filtered.filter(inc => deskCats.has(inc._cat));
    }
    // Severity filter (empty = all)
    if (activeSeverities.size > 0) {
      filtered = filtered.filter(inc => activeSeverities.has(inc.severity));
    }
    // Confidence filter (empty = all)
    if (activeConfidences.size > 0) {
      filtered = filtered.filter(inc => activeConfidences.has(inc.confidence));
    }
    // Industry filter — multi-select from 40-list. Empty = all.
    if (activeIndustries.size > 0) {
      filtered = filtered.filter(inc => inc.industry && activeIndustries.has(inc.industry));
    }
    // Country/Region filter — multi-select. Empty = all.
    if (activeCountries.size > 0) {
      filtered = filtered.filter(inc => inc.country && activeCountries.has(inc.country));
    }
    // Search filter (v3 — empty = all)
    if (searchQuery && searchQuery.trim()) {
      filtered = filtered.filter(inc => searchMatches(inc, searchQuery));
    }
    return filtered;
  }, [incidents, activeCats, activeReporters, activeSeverities, activeConfidences, activeIndustries, activeCountries, searchQuery, reporters]);

  const visibleCats = useMemo(() => new Set(visibleIncidents.map(i => i._cat)), [visibleIncidents]);

  // Lazily fetch the selected incident's blast_radius on tap. The fast map
  // loader omits blast_radius (it's heavy), so incidents arrive without it and
  // the globe's blast arcs have nothing to draw. On selection we fetch the
  // rows for that incident, group them by bucket, cache the result on the
  // incident object (so the flat view sees it too) and feed the globe via
  // `selBlast`. Skipped when the incident already carries blast data.
  useEffect(() => {
    if (!selectedId) { setSelBlast(null); return; }
    const inc = visibleIncidents.find(i => String(i._id) === String(selectedId));
    if (!inc) { setSelBlast(null); return; }
    if (inc.blast_radius && Object.keys(inc.blast_radius).length) { setSelBlast(inc.blast_radius); return; }
    const dbId = inc.id;
    if (dbId == null || dbId === "") { setSelBlast(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
        const url = env.VITE_SUPABASE_URL, key = env.VITE_SUPABASE_ANON_KEY;
        if (!url || !key) return;
        const res = await fetch(`${url}/rest/v1/blast_radius?select=*&incident_id=eq.${encodeURIComponent(dbId)}`, {
          headers: { apikey: key, Authorization: `Bearer ${_readerToken || key}` },
        });
        const rows = await res.json();
        if (cancelled || !Array.isArray(rows) || !rows.length) return;
        const grouped = {};
        for (const br of rows) { const b = br.exposure_group || "internal"; (grouped[b] = grouped[b] || []).push(br); }
        inc.blast_radius = grouped;   // also feeds the flat MapCanvas view
        setSelBlast(grouped);
      } catch (_) { /* noop */ }
    })();
    return () => { cancelled = true; };
  }, [selectedId, visibleIncidents]);

  // Lazily fetch the selected incident's child records. The fast map loader
  // now ships only the incident pins (see the initial Promise.all), because
  // these tables are read exclusively by the detail panel and pulling all of
  // them for all 1,099 incidents cost ~14 MB on every page load. Fetched once
  // per incident, cached on the incident object, keyed by incident_id.
  useEffect(() => {
    if (!selectedId) return;
    const inc = visibleIncidents.find(i => String(i._id) === String(selectedId));
    // Keyed by the token the rows were fetched with, not a plain boolean: the
    // free teaser and a subscriber's full set are different answers, so signing
    // in has to re-hydrate rather than keep whatever landed first.
    const authKey = readerToken || "anon";
    if (!inc || inc._hydratedWith === authKey) return;
    const dbId = inc.id;
    if (dbId == null || dbId === "") return;
    let cancelled = false;
    (async () => {
      const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
      const url = env.VITE_SUPABASE_URL, key = env.VITE_SUPABASE_ANON_KEY;
      if (!url || !key) return;
      // [relation, property on the incident, extra query]. blast_radius is
      // handled by its own effect above; adaptive_master_controls no longer
      // exists in the database and stays an empty array.
      const CHILD_RELATIONS = [
        ["adaptive_controls", "adaptive_controls_rows", "select=*"],
        ["adaptive_objectives", "adaptive_objectives", "select=*"],
        ["peer_watchlist", "peer_watchlist", "select=*"],
        ["sources", "sources", "select=*"],
        ["historical_analogues", "historical_analogues", "select=*"],
      ];
      const eq = `incident_id=eq.${encodeURIComponent(dbId)}`;
      let teaser = null;   // filled by the RPC below, applied after the reads
      await Promise.all([
        ...CHILD_RELATIONS.map(async ([rel, prop, sel]) => {
          try {
            const res = await fetch(`${url}/rest/v1/${rel}?${sel}&${eq}`, {
              headers: { apikey: key, Authorization: `Bearer ${_readerToken || key}` },
            });
            if (!res.ok) return;
            const rows = await res.json();
            if (cancelled || !Array.isArray(rows)) return;
            inc[prop] = rows;
            // adaptive_controls needs RESHAPING, not just assigning.
            // _reshapeIncident maps adaptive_controls_rows -> inc.adaptive_controls
            // at load time, when this array is still empty — so it silently took
            // the adaptive_controls_codes fallback (raw sentences) and the
            // Adaptive Controls card rendered objectives and MC-* ids instead of
            // the real AC-* controls. Redo that mapping here, identically.
            if (prop === "adaptive_controls_rows" && rows.length) {
              inc.adaptive_controls = rows.map(c => ({
                id: c.control_id || c.id,
                statement: c.statement,
                rationale: c.rationale,
                parent_mc_id: c.parent_mc_id,
                layer: c.layer,
                control_kind: c.kind,
              }));
            }
          } catch (_) { /* leave the empty array in place */ }
        }),
        // The free-tier teaser. The relations above are RLS'd to subscribers
        // and answer a blocked read with 200 + zero rows, which is how the
        // panels came to vanish: no first entry meant no panel, and no panel
        // meant no scene. public.incident_teaser returns the one row a free
        // reader may see plus the true total, so "Showing 1 of 6" works again
        // and the other five never leave the database. A subscriber's own reads
        // succeed above and these values are simply not used.
        (async () => {
          try {
            const res = await fetch(`${url}/rest/v1/rpc/incident_teaser`, {
              method: "POST",
              headers: { apikey: key, Authorization: `Bearer ${_readerToken || key}`, "Content-Type": "application/json" },
              body: JSON.stringify({ p_incident_id: Number(dbId) }),
            });
            if (!res.ok) return;
            const body = await res.json();
            if (cancelled || !body || typeof body !== "object") return;
            teaser = body;
          } catch (_) { /* no teaser → the panels stay as they are */ }
        })(),
        // Secondary categories (2026-08-01) and vendors (same day) were merged
        // onto the incident row as jsonb, so they come from the incident itself
        // rather than child tables — note the key is `id`, not incident_id.
        // One request covers both, and it stays lazy so neither lands in the
        // initial map payload.
        //
        // The why-not-null filter that used to live in the secondary query is
        // applied here instead: 101 of the 3,267 entries are stubs with no
        // reasoning and no name, and the panel has never rendered them.
        (async () => {
          try {
            const res = await fetch(
              `${url}/rest/v1/incidents?select=secondary_mappings&id=eq.${encodeURIComponent(dbId)}`,
              { headers: { apikey: key, Authorization: `Bearer ${_readerToken || key}` } });
            if (!res.ok) return;
            const rows = await res.json();
            if (cancelled || !Array.isArray(rows) || !rows.length) return;
            const sec = rows[0].secondary_mappings;
            inc.secondary_mappings = Array.isArray(sec) ? sec.filter(m => m && m.why != null) : [];
          } catch (_) { /* leave the empty arrays in place */ }
        })(),
      ]);
      if (cancelled) return;

      // Now that the subscriber-only reads have settled we can see what this
      // reader was actually denied, and stand the teaser in for exactly that.
      if (teaser) {
        const totals = {};
        for (const k of ["peer_watchlist", "adaptive_controls", "historical_analogues", "sources", "blast_radius"]) {
          const part = teaser[k];
          if (!part) continue;
          totals[k] = Number(part.total) || 0;
          if (k === "blast_radius") continue;
          const served = Array.isArray(inc[k]) && inc[k].length > 0;
          if (served || !Array.isArray(part.rows) || !part.rows.length) continue;
          inc[k] = part.rows;
          if (k === "adaptive_controls") {
            inc.adaptive_controls = part.rows.map(c => ({
              id: c.control_id || c.id, statement: c.statement, rationale: c.rationale,
              parent_mc_id: c.parent_mc_id, layer: c.layer, control_kind: c.kind,
            }));
          }
        }
        const chans = teaser.blast_radius && teaser.blast_radius.channels;
        const haveBlast = inc.blast_radius && Object.keys(inc.blast_radius).length > 0;
        if (Array.isArray(chans) && chans.length && !haveBlast) {
          // Every channel keeps its real name and size — the panel lists them
          // all and masks the entity names beyond the first, so the withheld
          // ones stand in as empty placeholders carrying no data.
          const grouped = {};
          for (const ch of chans) {
            const g = ch && ch.group ? ch.group : "internal";
            const rows = Array.isArray(ch.rows) && ch.rows.length
              ? ch.rows
              : Array.from({ length: Math.max(0, Number(ch.count) || 0) }, () => ({ exposure_group: g, _withheld: true }));
            grouped[g] = rows;
          }
          inc.blast_radius = grouped;
        }
        inc._gatedTotals = totals;
      }

      inc._childrenLoaded = true;
      inc._hydratedWith = authKey;
      setChildVersion(v => v + 1);   // force selectedIncident to recompute
    })();
    return () => { cancelled = true; };
  }, [selectedId, visibleIncidents, readerToken]);

  const selectedIncident = useMemo(() => {
    // The deep-linked card must not blink out while the enriched sweep replaces
    // the fast-painted one: `_id` is positional, so for that one incident fall
    // back to its DATABASE id, which is stable. The effect below then moves
    // `selectedId` to the new `_id` on the next tick.
    const found = incidents.find(i => i._id === selectedId)
      || (deepLinkWantRef.current ? incidents.find(i => i.id != null && String(i.id) === deepLinkWantRef.current) : null)
      || null;
    if (!found) return null;
    // blast_radius is lazy-loaded into `selBlast` after selection (it is not
    // fetched inline with the incident list). When the found incident has no
    // inline blast data yet, splice the lazily-loaded blast in as a NEW object
    // so the reference changes and IncidentCascade's blastChannels useMemo
    // recomputes — otherwise the Blast Radius scene never appears and Scene 2
    // shows only the Peer Watchlist.
    const hasBlast = found.blast_radius && Object.keys(found.blast_radius).length > 0;
    if (!hasBlast && selBlast && Object.keys(selBlast).length > 0) {
      return { ...found, blast_radius: selBlast };
    }
    // The hydration effect mutates the child arrays onto `found` in place, so
    // spread into a fresh object once they land. Without this the reference
    // never changes and the detail panel's useMemos keep the empty arrays.
    if (found._childrenLoaded) return { ...found };
    return found;
  }, [incidents, selectedId, selBlast, childVersion]);
  const selectedReporter = useMemo(() => selectedIncident ? reporterForCat(selectedIncident._cat, reporters) : null, [selectedIncident, reporters]);

  // Guided tour — feature the most severe incident of the loaded day (prefer one
  // with a real blast radius so the walkthrough has depth to show).
  const tourIncident = useMemo(() => {
    if (!visibleIncidents.length) return null;
    const score = (i) => (i.severity || 0) * 10 + (i.blast_radius ? Object.keys(i.blast_radius).length : 0);
    return [...visibleIncidents].sort((a, b) => score(b) - score(a))[0] || null;
  }, [visibleIncidents]);

  // Auto-play the walkthrough once per page load, as soon as data is ready.
  // DESKTOP ONLY — on phones the narrated tour would auto-open a full-screen
  // card deck over the map on load (a jarring takeover, and its caption/auto-
  // advance don't fit the swipe deck). Mobile users land on a clean map and
  // open incidents themselves (tap a dot or "Browse incidents").
  useEffect(() => {
    if (tourStartedRef.current) return;
    // A ?incident= deep-link means "show me THIS incident" — suppress the tour
    // so it doesn't step the selection away from the linked incident.
    let deepLink = null;
    try { deepLink = new URLSearchParams(window.location.search).get("incident"); } catch { /* noop */ }
    if (deepLink) { tourStartedRef.current = true; return; }
    // Short landscape phones (844x390 etc.) get the desktop layout, but the
    // ~165px tour card would cover the panels it narrates — skip it there.
    if (tourIncident && !booting && !isMobile && window.innerHeight > 500) {
      tourStartedRef.current = true;
      setTourActive(true);
    }
  }, [tourIncident, booting, isMobile]);

  // MOBILE guided preview — once per load, auto-open the featured incident's
  // swipe-card deck and let it auto-advance (see MobileIncidentCards autoPlay).
  // No narrated caption / no overlap — the preview lives entirely inside the
  // deck, and any touch hands control to the user.
  useEffect(() => {
    if (mobilePreviewStartedRef.current) return;
    let deepLink = null;
    try { deepLink = new URLSearchParams(window.location.search).get("incident"); } catch { /* noop */ }
    if (deepLink) { mobilePreviewStartedRef.current = true; return; }  // deep-link wins over the preview
    if (isMobile && tourIncident && !booting) {
      mobilePreviewStartedRef.current = true;
      setSelectedId(tourIncident._id);
      setMobilePreview(true);
    }
  }, [isMobile, tourIncident, booting]);

  // Mobile: when an incident is selected, let the globe focus + draw its blast
  // arcs FIRST, then reveal the detail deck (~1.1s later). Desktop opens at once.
  useEffect(() => {
    if (!selectedId) { setDeckReady(false); return; }
    if (!isMobile) { setDeckReady(true); return; }
    setDeckReady(false);
    // ~globe rotate (1200ms) + a beat, so the focus + blast arcs finish first.
    const t = setTimeout(() => setDeckReady(true), 1400);
    return () => clearTimeout(t);
  }, [selectedId, isMobile]);

  // Severity histogram (top-bar stat)
  const sevCounts = useMemo(() => {
    const c = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    visibleIncidents.forEach(i => { if (c[i.severity] !== undefined) c[i.severity]++; });
    return c;
  }, [visibleIncidents]);

  function toggleReporter(repId) {
    setActiveReporters(prev => {
      const n = new Set(prev);
      if (n.has(repId)) n.delete(repId); else n.add(repId);
      return n;
    });
  }

  function loadSweep(json, name) {
    setSweep(json);
    setSweepName(name);
    setError(null);
    setSelectedId(null);
    setHoveredId(null);
    setActiveReporters(new Set());
    setActiveCats(new Set());
    setActiveSeverities(new Set());
    setActiveConfidences(new Set());
    setSearchQuery("");
    setTimeWindow("day");
    setWindowInfo(null);
    // Auto-archive the upload. If the substrate is "session" (verified
    // non-persistent), tell the user clearly — their data WILL be lost on
    // reload and they should know that, not discover it tomorrow.
    (async () => {
      try {
        setArchiveBusy(true);
        const { dateKey, index } = await writeSweep(json, name);
        setCurrentDate(dateKey);
        setArchiveIndex(index);
        if (isPersistent()) {
          setArchiveToast({ type: "saved", text: `✓ Archived ${dateKey} · persists across sessions` });
          setTimeout(() => setArchiveToast(null), 2800);
        } else {
          setArchiveToast({ type: "warn", text: `⚠ Loaded ${dateKey} into session only — storage unavailable` });
          setTimeout(() => setArchiveToast(null), 5000);
        }
      } catch (e) {
        console.error("Sweep archive failed:", e);
        setArchiveToast({ type: "warn", text: `⚠ Save failed: ${e?.message || e}` });
        setTimeout(() => setArchiveToast(null), 5000);
      } finally {
        setArchiveBusy(false);
      }
    })();
  }

  // Load an archived sweep by date — used by the archive panel
  async function loadArchivedSweep(dateKey) {
    try {
      setArchiveBusy(true);
      const json = await readSweep(dateKey);
      if (!json) {
        setArchiveToast({ type: "warn", text: `No sweep stored for ${dateKey}` });
        setTimeout(() => setArchiveToast(null), 3000);
        return;
      }
      const entry = archiveIndex.find(x => x.date === dateKey);
      setSweep(json);
      setSweepName(entry?.fileName || `sweep_${dateKey}.json`);
      setCurrentDate(dateKey);
      setTimeWindow("day");
      setWindowInfo({ kind: "day", from: dateKey, to: dateKey, days: 1, requested: 1 });
      setError(null);
      setSelectedId(null);
      setHoveredId(null);
      setActiveReporters(new Set());
      setActiveCats(new Set());
      setActiveSeverities(new Set());
      setActiveConfidences(new Set());
      setSearchQuery("");
      setShowArchive(false);
    } catch (e) {
      setArchiveToast({ type: "warn", text: `Load failed: ${e.message || e}` });
      setTimeout(() => setArchiveToast(null), 3500);
    } finally {
      setArchiveBusy(false);
    }
  }

  // Delete an archived sweep
  async function removeArchivedSweep(dateKey) {
    try {
      setArchiveBusy(true);
      const idx = await deleteSweep(dateKey);
      setArchiveIndex(idx);
      // If we just deleted the currently-rendered sweep, clear the canvas
      if (currentDate === dateKey) {
        setSweep(null);
        setSweepName(null);
        setCurrentDate(null);
      }
      setArchiveToast({ type: "saved", text: `Removed ${dateKey}` });
      setTimeout(() => setArchiveToast(null), 2400);
    } catch (e) {
      setArchiveToast({ type: "warn", text: `Delete failed: ${e.message || e}` });
      setTimeout(() => setArchiveToast(null), 3500);
    } finally {
      setArchiveBusy(false);
    }
  }

  // Apply a time-window aggregation view. "day" renders a single archived
  // sweep exactly as before (no merge, original code path). "week"/"month"/
  // "all" build a synthetic merged sweep from the relevant archived days and
  // feed it through the same setSweep → parseSweep path, so the map, filters
  // and cascade are untouched.
  //
  // Runs orphan-recovery (readIndex) FIRST so any stray sweep: key in the
  // window is discovered before the rollup — otherwise an orphaned day would
  // silently drop from the merge. Warns if the number of days we could
  // actually READ differs from the number the window expected.
  async function applyTimeWindow(kind) {
    setTimeWindow(kind);
    try {
      setArchiveBusy(true);
      const idx = await readIndex();   // self-healing — discovers orphans
      setArchiveIndex(idx);

      const anchor = currentDate || (idx[0] && idx[0].date) || null;

      if (kind === "day") {
        if (!anchor) { setWindowInfo(null); return; }
        const json = await readSweep(anchor);
        if (!json) {
          setArchiveToast({ type: "warn", text: `No sweep stored for ${anchor}` });
          setTimeout(() => setArchiveToast(null), 3000);
          return;
        }
        const entry = idx.find(x => x.date === anchor);
        setSweep(json);
        setSweepName(entry?.fileName || `sweep_${anchor}.json`);
        setCurrentDate(anchor);
        setSelectedId(null);
        setHoveredId(null);
        setWindowInfo({ kind: "day", from: anchor, to: anchor, days: 1, requested: 1 });
        return;
      }

      const wantDates = datesInWindow(idx, anchor, kind);
      const inputs = [];
      for (const date of wantDates) {
        const json = await readSweep(date);
        if (json) inputs.push({ date, sweep: json });
      }

      const requested = wantDates.length;
      const readable = inputs.length;
      if (requested === 0) {
        setArchiveToast({ type: "warn", text: `No archived days in this ${kind} window` });
        setTimeout(() => setArchiveToast(null), 3200);
        setWindowInfo({ kind, from: null, to: null, days: 0, requested: 0 });
        return;
      }

      const merged = mergeSweeps(inputs);
      setSweep(merged);
      setSweepName(`${kind.toUpperCase()} · ${merged._windowFrom} → ${merged._windowTo} · ${readable} day${readable === 1 ? "" : "s"}`);
      setSelectedId(null);
      setHoveredId(null);
      setWindowInfo({ kind, from: merged._windowFrom, to: merged._windowTo, days: readable, requested });

      if (readable !== requested) {
        setArchiveToast({
          type: "warn",
          text: `⚠ ${kind} rollup: ${readable}/${requested} days readable — ${requested - readable} dropped`,
        });
        setTimeout(() => setArchiveToast(null), 5000);
      } else {
        const totalInc = Object.values(merged.results || {}).reduce((n, c) => n + ((c.incidents || []).length), 0);
        setArchiveToast({ type: "saved", text: `✓ ${kind.toUpperCase()} view · ${readable} days · ${totalInc} unique incidents` });
        setTimeout(() => setArchiveToast(null), 3200);
      }
    } catch (e) {
      console.error("Time-window apply failed:", e);
      setArchiveToast({ type: "warn", text: `⚠ ${kind} view failed: ${e?.message || e}` });
      setTimeout(() => setArchiveToast(null), 4500);
    } finally {
      setArchiveBusy(false);
    }
  }

  // Show every incident within an arbitrary [from,to] range, all at once, and
  // STAY there. ISO YYYY-MM-DD strings compare chronologically, so plain string
  // bounds/sort suffice.
  //
  // This deliberately does not start playback. It used to: it merged the range
  // into `sweep` and then immediately setPlaying(true), and the play loop's
  // first tick overwrote `sweep` with a single-day sweep — so the merged range
  // it had just built was never actually visible, and the Brief only ever had
  // one day to read. Stepping through days is now its own button (playRange).
  async function applyRange(from, to) {
    if (!from || !to) return;
    const lo = from <= to ? from : to;
    const hi = from <= to ? to : from;
    setRangeFrom(lo); setRangeTo(hi);
    setPlaying(false);
    try {
      setArchiveBusy(true);
      const idx = await readIndex();
      setArchiveIndex(idx);
      const dates = idx.map(e => e.date).filter(Boolean).filter(d => d >= lo && d <= hi).sort();
      setPlayDates(dates);
      setPlayPos(0);
      if (!dates.length) {
        setWindowInfo({ kind: "range", from: lo, to: hi, days: 0, requested: 0 });
        setArchiveToast({ type: "warn", text: `No archived days between ${lo} and ${hi}` });
        setTimeout(() => setArchiveToast(null), 3200);
        return;
      }
      const inputs = [];
      for (const d of dates) { const j = await readSweep(d); if (j) { inputs.push({ date: d, sweep: j }); playCacheRef.current.set(d, j); } }
      const merged = mergeSweeps(inputs);
      setTimeWindow("range");
      setSweep(merged);
      setSweepName(`RANGE · ${lo} → ${hi} · ${inputs.length} day${inputs.length === 1 ? "" : "s"}`);
      setCurrentDate(hi);
      setSelectedId(null);
      setHoveredId(null);
      setWindowInfo({ kind: "range", from: lo, to: hi, days: inputs.length, requested: dates.length });
      const totalInc = Object.values(merged.results || {}).reduce((n, c) => n + ((c.incidents || []).length), 0);
      setArchiveToast({ type: "saved", text: `✓ Range · ${inputs.length} day${inputs.length === 1 ? "" : "s"} · ${totalInc} incidents on the map` });
      setTimeout(() => setArchiveToast(null), 3200);
    } catch (e) {
      console.error("Range apply failed:", e);
      setArchiveToast({ type: "warn", text: `⚠ Range failed: ${e?.message || e}` });
      setTimeout(() => setArchiveToast(null), 4500);
    } finally {
      setArchiveBusy(false);
    }
  }

  // Step through the days of [from,to] one at a time. Split out of applyRange
  // so that showing a range and animating it are two separate, explicit user
  // actions. Resolves the day list itself, so it works whether or not the user
  // pressed "Show range" first.
  async function playRange(from, to) {
    if (!from || !to) return;
    const lo = from <= to ? from : to;
    const hi = from <= to ? to : from;
    setRangeFrom(lo); setRangeTo(hi);
    try {
      setArchiveBusy(true);
      const idx = await readIndex();
      setArchiveIndex(idx);
      const dates = idx.map(e => e.date).filter(Boolean).filter(d => d >= lo && d <= hi).sort();
      if (!dates.length) {
        setArchiveToast({ type: "warn", text: `No archived days between ${lo} and ${hi}` });
        setTimeout(() => setArchiveToast(null), 3200);
        return;
      }
      setPlayDates(dates);
      setPlayPos(0);
      setSelectedId(null);
      setHoveredId(null);
      await showPlayDay(0, dates); // paint day 1 immediately, don't wait a tick
      if (dates.length > 1) setPlaying(true);
      else setArchiveToast({ type: "saved", text: `Only one archived day in range — showing ${dates[0]}` });
    } catch (e) {
      console.error("Range play failed:", e);
      setArchiveToast({ type: "warn", text: `⚠ Play failed: ${e?.message || e}` });
      setTimeout(() => setArchiveToast(null), 4500);
    } finally {
      setArchiveBusy(false);
    }
  }

  // Render one day of the sequence (shared by the interval and manual scrubbing).
  // `dates` may be passed explicitly by playRange, whose setPlayDates() has not
  // been committed to state yet on the first paint.
  const showPlayDay = async (i, dates) => {
    const list = dates || playDates;
    const d = list[i];
    if (!d) return;
    let json = playCacheRef.current.get(d);
    if (!json) { json = await readSweep(d); if (json) playCacheRef.current.set(d, json); }
    if (!json) return;
    setSweep(json);
    setSweepName(`▶ ${d} · day ${i + 1}/${list.length}`);
    setCurrentDate(d);
    setSelectedId(null);
    setHoveredId(null);
    setPlayPos(i);
  };

  // ── Daily Brief (news-bulletin narration for the current day) ────────────
  const briefActiveRef = useRef(false);
  const briefVoiceRef = useRef(null);
  // Bumped each time the day narration restarts, so a chain left over from
  // a previous day stops speaking instead of interleaving with the new one.
  const daySegTokenRef = useRef(0);
  const [briefPlaying, setBriefPlaying] = useState(false);
  const [briefCaption, setBriefCaption] = useState("");

  // Pick the most natural installed English voice for the anchor read.
  useEffect(() => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return;
    const pick = () => {
      const vs = synth.getVoices() || [];
      briefVoiceRef.current =
        vs.find(v => /en[-_]US/i.test(v.lang) && /google|natural|samantha|aria|jenny|daniel/i.test(v.name)) ||
        vs.find(v => /^en[-_]/i.test(v.lang)) || vs[0] || null;
    };
    pick();
    try { synth.addEventListener("voiceschanged", pick); } catch { /* older browsers */ }
    return () => { try { synth.removeEventListener("voiceschanged", pick); } catch { /* noop */ } };
  }, []);

  const stopBrief = () => {
    briefActiveRef.current = false;
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* noop */ }
    setBriefPlaying(false);
    setBriefCaption("");
  };

  const playDailyBrief = () => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return;
    if (briefActiveRef.current) { stopBrief(); return; }   // toggle off
    briefActiveRef.current = true;                          // set BEFORE stopping autoplay
    setPlaying(false);                                      // don't fight the fast day-stepping
    setBriefPlaying(true);
    // Read whatever is actually on the map. mergeSweeps stamps _windowFrom /
    // _windowTo, so a merged multi-day range announces itself as a range and
    // covers every incident in it; a single day still reads as that one date.
    const fmt = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    const wFrom = sweep?._windowFrom, wTo = sweep?._windowTo;
    let nice;
    try {
      if (wFrom && wTo && wFrom !== wTo) nice = `${fmt(wFrom)} to ${fmt(wTo)}`;
      else if (currentDate) nice = fmt(currentDate);
      else nice = "today";
    } catch { nice = currentDate || "today"; }
    const segs = buildDailyBrief(visibleIncidents, nice);
    try { synth.cancel(); } catch { /* noop */ }
    let idx = 0;
    const next = () => {
      if (!briefActiveRef.current) return;
      if (idx >= segs.length) { stopBrief(); return; }
      const seg = segs[idx++];
      setBriefCaption(seg.text);
      if (seg.id != null) { try { setSelectedId(String(seg.id)); } catch { /* noop */ } }
      const u = new SpeechSynthesisUtterance(seg.text);
      // News-anchor pace. This used to run at 1.28/1.12, which outran the ear —
      // place names and entity names in particular arrived faster than they
      // could be parsed. ~1.0 is a natural read; the quick-hits stay marginally
      // brisker than the lead stories but no longer rush.
      u.rate = seg.fast ? 1.02 : 0.95; u.pitch = 1; u.volume = 1;
      if (briefVoiceRef.current) u.voice = briefVoiceRef.current;
      // Beat between items — long enough to hear where one ends and the next
      // begins, since each one moves the map.
      const gap = seg.fast ? 260 : 420;
      u.onend = () => { if (briefActiveRef.current) setTimeout(next, gap); };
      u.onerror = () => { if (briefActiveRef.current) setTimeout(next, gap); };
      try { synth.speak(u); } catch { setTimeout(next, 260); }
    };
    next();
  };

  // Stop the brief if the map unmounts.
  useEffect(() => () => { briefActiveRef.current = false; try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* noop */ } }, []);

  // Sync Voice Narration and text summary to trigger after state renders the new incidents
  useEffect(() => {
    if (!playing || !currentDate || !sweep) {
      setPlaySummary("");
      return;
    }
    const nice = new Date(currentDate + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    const n = visibleIncidents.length;
    
    let msg = "";
    const segs = [];   // {text, id?} — id opens that incident while it is spoken
    if (n === 0) {
      msg = `No incidents reported for ${nice}.`;
      segs.push({ text: msg });
    } else {
      const sevNames = { 5: "critical", 4: "high severity", 3: "medium severity", 2: "low severity", 1: "minimal severity" };
      // All 13 GUARD categories. The old table covered 5 (and one code, INF,
      // that the pipeline does not emit), so most incidents narrated as the
      // generic "incident" and the category was lost.
      const catNames = {
        CYB: "cyber attack", DAT: "data and privacy breach", ENV: "environmental incident",
        FIN: "financial event", GEO: "geopolitical event", OPS: "operational incident",
        PHY: "physical security incident", PPL: "people and workforce incident",
        REG: "regulatory action", REP: "reputational event", STR: "strategic event",
        TEC: "technology failure", TPR: "third-party incident",
      };

      const getDesc = (inc) => {
        const sev = sevNames[inc.severity] || "medium severity";
        const cat = catNames[inc._cat] || "incident";
        const ent = inc.entity ? `on ${shortEntity(inc.entity)}` : "";
        return `a ${sev} ${cat}${ent ? " " + ent : ""}`;
      };

      // Lead with what matters. Reading the array in its natural order meant a
      // busy day could open on a minimal-severity item while criticals were
      // never spoken; rank descending so the worst is always first.
      const ranked = [...visibleIncidents].sort((a, b) => (b.severity || 0) - (a.severity || 0));
      const sevCount = (min) => ranked.filter(i => (i.severity || 0) >= min).length;
      const crit = sevCount(5), high = ranked.filter(i => (i.severity || 0) === 4).length;

      msg = `Showing ${n} incident${n === 1 ? "" : "s"} for ${nice}. `;

      // Severity headline, mirroring how the Brief opens.
      const parts = [];
      if (crit) parts.push(`${crit} critical`);
      if (high) parts.push(`${high} high severity`);
      if (parts.length) msg += `${parts.join(" and ")} — `;

      // Each named incident becomes its OWN segment carrying its id, so the
      // narration can select it — the card opens as it is spoken, then the
      // next one takes over. Previously this was a single utterance: the
      // incidents were named but never shown, so the voice described things
      // the map never pointed at.
      const named = ranked.slice(0, Math.min(3, n));
      segs.push({ text: msg.trim() });
      named.forEach((inc, i) => {
        const lead = i === 0 ? (n === 1 ? "It is " : "Leading: ") : "";
        const tail = i === named.length - 1 && n <= 3 ? "." : ",";
        segs.push({ text: `${lead}${getDesc(inc)}${tail}`, id: inc._id });
      });
      if (n > 3) segs.push({ text: `plus ${n - 3} further event${n - 3 === 1 ? "" : "s"}.` });
      msg += named.map((inc, i) => `${i === 0 ? (n === 1 ? "It is " : "Leading: ") : ""}${getDesc(inc)}`).join(", ")
           + (n > 3 ? `, plus ${n - 3} further event${n - 3 === 1 ? "" : "s"}.` : ".");
    }

    setPlaySummary(msg);

    if (narrate && typeof window !== "undefined" && window.speechSynthesis) {
      const synth = window.speechSynthesis;
      try { synth.cancel(); } catch { /* noop */ }
      // Token guards against an older day's chain still speaking after the
      // timeline has advanced — without it two days could interleave.
      const myToken = ++daySegTokenRef.current;
      let idx = 0;
      const next = () => {
        if (myToken !== daySegTokenRef.current) return;   // superseded
        if (idx >= segs.length) {
          // Close the last preview so the map is clean before the next day.
          try { setSelectedId(null); } catch { /* noop */ }
          return;
        }
        const seg = segs[idx++];
        // Open this incident's card while its line is spoken.
        if (seg.id != null) { try { setSelectedId(String(seg.id)); } catch { /* noop */ } }
        else if (idx === 1) { try { setSelectedId(null); } catch { /* noop */ } }
        const u = new SpeechSynthesisUtterance(seg.text);
        u.rate = 0.95; u.pitch = 1; u.volume = 1;   // match the Brief's pace
        if (briefVoiceRef.current) u.voice = briefVoiceRef.current;
        const gap = seg.id != null ? 240 : 160;     // let the card land before moving on
        u.onend = () => setTimeout(next, gap);
        u.onerror = () => setTimeout(next, gap);
        try { synth.speak(u); } catch { setTimeout(next, 300); }
      };
      next();
    }
  }, [currentDate, playing, narrate, visibleIncidents]);

  // Silence narration the moment playback stops or pauses — but NOT while the
  // daily brief is intentionally playing (the brief pauses autoplay itself).
  useEffect(() => {
    if (!playing && !briefActiveRef.current) { try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* noop */ } }
  }, [playing]);

  // Auto-playback driver — advances one day every playSpeedMs and swaps the
  // sweep so incidents animate date-by-date. playPos is intentionally NOT a dep
  // (functional updater) so the interval isn't rebuilt every tick; pause/resume
  // and speed changes re-arm it from the current position.
  useEffect(() => {
    if (!playing || playDates.length === 0) return;
    let cancelled = false;
    const show = (i) => { if (!cancelled) showPlayDay(i); };
    show(playPos);
    const id = setInterval(() => {
      setPlayPos(prev => {
        const next = prev + 1;
        if (next >= playDates.length) { clearInterval(id); setPlaying(false); return prev; }
        show(next);
        return next;
      });
    }, Math.max(500, playSpeedMs));
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playSpeedMs, playDates]);

  function reset() {
    setSweep(null);
    setSweepName(null);
    setError(null);
    setSelectedId(null);
    setHoveredId(null);
    setActiveReporters(new Set());
    setActiveCats(new Set());
    setActiveSeverities(new Set());
    setActiveConfidences(new Set());
    setSearchQuery("");
    setShowAuditDrawer(false);
    setTimeWindow("day");
    setWindowInfo(null);
  }

  return (
    <div style={{
      position: "fixed", inset: 0,
      background: BRAND.obsidianDeep,
      fontFamily: "Inter, sans-serif", color: BRAND.white,
      overflow: "hidden",
    }}>
      <FontLoader />
      <style>{`
        @keyframes attackmap-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.4; transform: scale(1.4); }
        }
        @keyframes attackmap-spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* ───── Shared site navbar — identical to landing / every page ───── */}
      <SiteNav active="map" />

      {/* ───── MOBILE MAP BAR — compact toolbar under the nav (phones only).
          Replaces the desktop floating HUD clusters: a live count + date pill
          and three sheet triggers (Filters / Layers / Archive). ───── */}
      {isMobile && sweep && (
        <div className="map-bar" style={{
          position: "relative", zIndex: 40,
          display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          background: "rgba(8,8,8,0.92)", backdropFilter: "blur(12px)",
          borderBottom: "1px solid #222",
        }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 7, height: 7, borderRadius: 0, background: BRAND.gold, boxShadow: "0 0 8px rgba(252,189,0,0.6)", flexShrink: 0 }} />
            <span className="map-bar-count" style={{ fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
              <span>{visibleIncidents.length} live</span>{currentDate ? <><span className="map-bar-sep"> · </span><span className="map-bar-date">{currentDate}</span></> : null}
            </span>
          </div>
          {[
            { k: "filters", label: "Filters", active: filtersOpen, on: () => { setFiltersOpen(o => !o); setShowLayers(false); setShowArchive(false); setShowListPanel(false); } },
            { k: "layers", label: "Layers", active: showLayers, on: () => { setShowLayers(o => !o); setFiltersOpen(false); setShowArchive(false); setShowListPanel(false); } },
            { k: "archive", label: "Timeline", active: showArchive, on: () => { setShowArchive(o => !o); setFiltersOpen(false); setShowLayers(false); setShowListPanel(false); } },
          ].map(b => (
            <button key={b.k} className="map-bar-btn" onClick={b.on} style={{
              flexShrink: 0, padding: "7px 12px", borderRadius: 0, cursor: "pointer",
              background: b.active ? BRAND.gold : "rgba(252,189,0,0.10)",
              border: `1px solid ${BRAND.borderGold}`,
              color: b.active ? BRAND.obsidian : BRAND.gold,
              fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700,
              letterSpacing: "0.04em", textTransform: "uppercase",
            }}>{b.label}</button>
          ))}
        </div>
      )}

      {/* MOBILE — floating "Browse incidents" button (tapping dots is hard on a
          phone, so offer the list as the primary way in). Hidden while a detail
          or sheet is open. */}
      {isMobile && sweep && !selectedId && !showListPanel && !showArchive && !showLayers && !filtersOpen && !industryPanelOpen && !regionPanelOpen && !showFilterPopover && (
        <button onClick={() => setShowListPanel(true)} style={{
          position: "fixed", bottom: "calc(18px + env(safe-area-inset-bottom))", left: "50%", transform: "translateX(-50%)",
          zIndex: 45, padding: "12px 22px", borderRadius: 0, cursor: "pointer",
          background: BRAND.gold, color: BRAND.obsidian, border: "none",
          fontFamily: "Inter, sans-serif", fontSize: 13, fontWeight: 800, letterSpacing: "0.04em",
          boxShadow: "0 10px 28px rgba(0,0,0,0.5)", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap",
        }}>☰ Browse incidents</button>
      )}

      {/* MOBILE — Layers bottom sheet: map mode, view mode, layer toggles, key */}
      {isMobile && showLayers && (
        <div onClick={() => setShowLayers(false)} style={{ position: "fixed", inset: 0, zIndex: 120, background: "rgba(0,0,0,0.55)" }}>
          <div onClick={e => e.stopPropagation()} style={{
            position: "absolute", left: 0, right: 0, bottom: 0,
            background: "#141416", borderTop: "1px solid #333", borderRadius: 0,
            padding: "16px 16px calc(22px + env(safe-area-inset-bottom))", maxHeight: "82vh", overflowY: "auto",
            fontFamily: "Inter, sans-serif",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#fff", letterSpacing: "0.08em", textTransform: "uppercase" }}>Map layers</div>
              <button onClick={() => setShowLayers(false)} aria-label="Close" style={{ width: 32, height: 32, borderRadius: 0, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", color: "#fff", fontSize: 18, cursor: "pointer" }}>×</button>
            </div>

            {(() => {
              const lbl = { fontSize: 9.5, fontWeight: 700, color: BRAND.textMuted, letterSpacing: "0.16em", textTransform: "uppercase", margin: "0 0 8px" };
              const seg = { display: "flex", border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0, overflow: "hidden", marginBottom: 18 };
              const segBtn = (active) => ({ flex: 1, padding: "11px 8px", background: active ? BRAND.gold : "transparent", color: active ? BRAND.obsidian : BRAND.textSecondary, border: "none", cursor: "pointer", fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" });
              return (
                <>
                  <div style={lbl}>Map view</div>
                  <div style={seg}>
                    {[["flat", "▭ Flat"], ["globe", "◯ Globe"]].map(([id, t]) => (
                      <button key={id} onClick={() => setMapMode(id)} style={segBtn(mapMode === id)}>{t}</button>
                    ))}
                  </div>

                  <div style={lbl}>Detail mode</div>
                  <div style={seg}>
                    {["buyer", "newsroom"].map(m => (
                      <button key={m} onClick={() => setViewMode(m)} style={segBtn(viewMode === m)}>{m}</button>
                    ))}
                  </div>

                  <div style={lbl}>Layers</div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
                    {[
                      { id: "labels", t: "Labels", active: showLabels, on: () => setShowLabels(s => !s) },
                      { id: "heat", t: "Heat", active: showHeat, on: () => setShowHeat(s => !s) },
                      { id: "blast", t: "Blast", active: showBlastRadius, on: () => setShowBlastRadius(s => !s) },
                    ].map(b => (
                      <button key={b.id} onClick={b.on} style={{
                        flex: 1, padding: "11px 8px", borderRadius: 0, cursor: "pointer",
                        background: b.active ? "rgba(252,189,0,0.14)" : "transparent",
                        // Inactive toggles used BRAND.textMuted (#585858), which on the
                    // #080808 map chrome is 2.82:1 — an off state should read as quiet,
                    // not unreadable. #8C8C8C keeps it clearly secondary at ~4.7:1.
                    color: b.active ? BRAND.gold : "#8C8C8C",
                        border: `1px solid ${b.active ? BRAND.borderGold : BRAND.borderSubtle}`,
                        fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, textTransform: "uppercase",
                      }}>{b.t}</button>
                    ))}
                  </div>

                  <div style={lbl}>Severity</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                    {[5, 4, 3, 2, 1].map(level => (
                      <span key={level} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: BRAND.textSecondary, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        <span style={{ width: 8, height: 8, borderRadius: 0, background: SEVERITY[level].color }} />
                        {SEVERITY[level].label}
                      </span>
                    ))}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* (Archive moved into the top-left controls group, next to Filters.) */}

      {/* Auth modal — global, opens from AccountChip "Sign in" */}
      <AuthModal open={showAuthModal} onClose={() => setShowAuthModal(false)} />
      {/* Subscribe modal — global, opens from any gated panel's CTA */}
      <SubscribeModal open={showSubscribeModal} onClose={() => setShowSubscribeModal(false)} />

      {/* ───── BOOT LOADER — subtle, while the first data load runs (so the
              map doesn't flash the big empty/upload landing during the fetch) ───── */}
      {!sweep && booting && (
        <div style={{
          position: "absolute", inset: "56px 0 0 0",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 16, background: BRAND.deep,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: "50%",
            border: `3px solid ${BRAND.borderSubtle}`, borderTopColor: BRAND.gold,
            animation: "attackmap-spin 0.8s linear infinite",
          }} />
          <div style={{
            fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700,
            letterSpacing: "0.18em", textTransform: "uppercase", color: BRAND.textMuted,
          }}>
            Loading the live map…
          </div>
        </div>
      )}

      {/* ───── LANDING when no sweep (only AFTER boot completes) ───── */}
      {!sweep && !booting && (
        <div style={{
          position: "absolute", inset: "56px 0 0 0",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 32, gap: 32,
        }}>
          <div style={{ textAlign: "center", maxWidth: 720 }}>
            <div style={{
              fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 64,
              color: BRAND.white, lineHeight: 1.05, marginBottom: 16, letterSpacing: "-0.01em",
            }}>
              A live map of <span style={{ color: BRAND.gold, fontStyle: "italic" }}>corporate harm</span>.
            </div>
            <div style={{
              fontFamily: "Inter, sans-serif", fontSize: 16, color: BRAND.textSecondary,
              maxWidth: 640, margin: "0 auto", lineHeight: 1.55,
            }}>
              {isUserMode
                ? "Daily incident intelligence, mapped to the GUARD framework. The latest incidents load here automatically."
                : "Upload a daily intelligence file to render every materialised incident — geolocated, severity-ranked, blast-radius traced, source-cited."}
            </div>
          </div>
          {/* Upload zone — admin only */}
          {!isUserMode && <UploadZone onLoad={loadSweep} onError={setError} />}
          {!isUserMode && error && (
            <div style={{
              padding: 12, background: "rgba(255,107,107,0.1)",
              border: "1px solid rgba(255,107,107,0.3)", borderRadius: 0,
              color: "#FF6B6B", fontFamily: "Inter, sans-serif", fontSize: 12,
            }}>
              {error}
            </div>
          )}
          {/* Archive shortcut — admin only */}
          {!isUserMode && archiveIndex.length > 0 && (
            <button onClick={() => setShowArchive(true)}
              style={{
                padding: "10px 18px",
                background: "rgba(36,36,36,0.85)", backdropFilter: "blur(12px)",
                color: BRAND.gold,
                fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: "0.08em",
                border: `1px solid ${BRAND.borderGold}`, borderRadius: 0,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
              }}>
              ◇ OPEN ARCHIVE
              <span style={{
                padding: "2px 8px", background: BRAND.gold, color: BRAND.obsidian,
                borderRadius: 0, fontSize: 10,
              }}>
                {archiveIndex.length} {archiveIndex.length === 1 ? "day" : "days"} stored
              </span>
            </button>
          )}
          {/* User-mode waiting indicator — small pulsing badge */}
          {isUserMode && (
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 10,
              padding: "10px 18px", borderRadius: 0,
              background: "rgba(252,189,0,0.08)", border: `1px solid ${BRAND.borderGold}`,
              fontFamily: "Inter, sans-serif", fontSize: 11,
              letterSpacing: "0.16em", color: BRAND.gold, textTransform: "uppercase",
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: 0, background: BRAND.gold,
                animation: "attackmap-pulse 1.6s ease-in-out infinite",
              }} />
              LOADING LATEST INTELLIGENCE
            </div>
          )}
        </div>
      )}

      {/* ───── EMPTY STATE — sweep loaded but no incidents ───── */}
      {sweep && incidents.length === 0 && (
        <div style={{
          position: "absolute", inset: "56px 0 0 0",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 16, padding: 40,
        }}>
          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 32, color: BRAND.white }}>
            No incidents with coordinates
          </div>
          <div style={{ color: BRAND.textSecondary }}>
            The uploaded sweep contained no plottable incidents.
          </div>
        </div>
      )}

      {/* ───── FULL-BLEED STAGE ───── */}
      {sweep && incidents.length > 0 && (
        <div style={{
          position: "absolute", inset: "56px 0 0 0",
          overflow: "hidden",
        }}>
          {/* Map fills entire stage — full-bleed at all times. Cascade
              panels float over the four corners (top-left, top-right,
              bot-left, bot-right) plus the two mid-edges; they do not push
              the globe aside. */}
          <div style={{ position: "absolute", inset: 0 }}>
            {/* FLAT and GLOBE are the SAME Cesium viewer (Globe3D): FLAT is
                its 2D scene mode — the globe morphs into a Web-Mercator map
                with the same satellite imagery, markers, highlights and blast
                radius, and the camera is clamped so the world never repeats
                or leaves the frame (2026-09-23). The SVG MapCanvas survives
                only as the fallback for when the Cesium CDN cannot load. */}
            <GlobeErrorBoundary>
              <Globe3D
                mapMode={mapMode}
                visibleIncidents={visibleIncidents}
                selectedId={selectedId}
                hoveredId={hoveredId}
                activeCountries={activeCountries}
                onSelect={setSelectedId}
                onHover={setHoveredId}
                showBlastRadius={showBlastRadius}
                blastRadius={selBlast}
                showLabels={showLabels}
                world={world}
                fallback={(
                  <MapCanvas
                    world={world}
                    visibleIncidents={visibleIncidents}
                    viewMode={viewMode}
                    hoveredId={hoveredId}
                    selectedId={selectedId}
                    onHover={setHoveredId}
                    onSelect={setSelectedId}
                    showBlastRadius={showBlastRadius}
                    showHeat={showHeat}
                    showLabels={showLabels}
                  />
                )}
              />
            </GlobeErrorBoundary>
          </div>

          {/* ─── HUD: TOP-LEFT — Filters (button → drawer) + active chips ─── */}
          <div className="map-hud-tl" style={{ position: "absolute", top: 20, left: 24, zIndex: 20, maxWidth: "calc(100% - 500px)" }}>
            {(() => {
              const fCount = (activeSeverities.size > 0 ? 1 : 0) + activeCats.size + activeIndustries.size + activeCountries.size;
              const chip = {
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "4px 9px", borderRadius: 0, fontFamily: "Inter, sans-serif",
                fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
                background: "rgba(252,189,0,0.12)", color: BRAND.gold,
                border: `1px solid ${BRAND.borderGold}`, whiteSpace: "nowrap",
              };
              const xs = { cursor: "pointer", opacity: 0.7, fontSize: 12, lineHeight: 1 };
              return (
                <div className="r-hide" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => setFiltersOpen(o => !o)} title="Filter the map"
                    style={{
                      padding: "6px 14px", borderRadius: 0,
                      background: (filtersOpen || fCount > 0) ? "rgba(252,189,0,0.14)" : "rgba(36,36,36,0.85)",
                      backdropFilter: "blur(12px)",
                      border: `1px solid ${(filtersOpen || fCount > 0) ? BRAND.borderGold : BRAND.borderSubtle}`,
                      fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: "0.10em",
                      color: (filtersOpen || fCount > 0) ? BRAND.gold : BRAND.textSecondary,
                      textTransform: "uppercase", cursor: "pointer", display: "flex", alignItems: "center", gap: 7,
                    }}>
                    ⛃ Filters{fCount > 0 ? ` · ${fCount}` : ""}
                  </button>
                  {/* Threat Timeline — grouped with Filters (both scope "what you're viewing"). */}
                  <button onClick={() => setShowArchive(true)}
                    title={`${archiveIndex.length} day${archiveIndex.length === 1 ? "" : "s"} of intelligence`}
                    style={{
                      padding: "6px 14px", borderRadius: 0,
                      background: "rgba(36,36,36,0.85)", backdropFilter: "blur(12px)",
                      border: `1px solid ${BRAND.borderSubtle}`,
                      fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: "0.10em",
                      color: BRAND.textSecondary, textTransform: "uppercase", cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 6,
                    }}>
                    ◇ Timeline
                    {archiveIndex.length > 0 && (
                      <span style={{ padding: "1px 5px", background: BRAND.gold, color: BRAND.obsidian, borderRadius: 0, fontSize: 9 }}>{archiveIndex.length}</span>
                    )}
                  </button>
                  {activeSeverities.size > 0 && (
                    <span style={chip}>Critical+<span style={xs} onClick={() => setActiveSeverities(new Set())}>×</span></span>
                  )}
                  {[...activeCats].map(code => (
                    <span key={code} style={chip}>{code}<span style={xs} onClick={() => setActiveCats(prev => { const n = new Set(prev); n.delete(code); return n; })}>×</span></span>
                  ))}
                  {[...activeIndustries].slice(0, 3).map(ind => (
                    <span key={ind} style={chip}>{String(ind).slice(0, 16)}<span style={xs} onClick={() => setActiveIndustries(prev => { const n = new Set(prev); n.delete(ind); return n; })}>×</span></span>
                  ))}
                  {activeIndustries.size > 3 && <span style={{ ...chip, background: "rgba(255,255,255,0.06)", color: BRAND.textSecondary, border: `1px solid ${BRAND.borderSubtle}` }}>+{activeIndustries.size - 3}</span>}
                  
                  {[...activeCountries].slice(0, 3).map(country => (
                    <span key={country} style={chip}>{String(country).slice(0, 16)}<span style={xs} onClick={() => setActiveCountries(prev => { const n = new Set(prev); n.delete(country); return n; })}>×</span></span>
                  ))}
                  {activeCountries.size > 3 && <span style={{ ...chip, background: "rgba(255,255,255,0.06)", color: BRAND.textSecondary, border: `1px solid ${BRAND.borderSubtle}` }}>+{activeCountries.size - 3}</span>}
                  
                  {fCount > 0 && (
                    <button onClick={() => { setActiveSeverities(new Set()); setActiveCats(new Set()); setActiveIndustries(new Set()); setActiveCountries(new Set()); }}
                      style={{ background: "none", border: "none", color: BRAND.textSecondary, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontFamily: "Inter, sans-serif" }}>Clear all</button>
                  )}
                </div>
              );
            })()}

          {filtersOpen && (
            <div className="r-mappanel map-filters" style={{
              position: "absolute", top: 42, left: 0, width: 340,
              maxHeight: "72vh", overflowY: "auto", padding: 16,
              background: "rgba(20,20,22,0.96)", backdropFilter: "blur(20px)",
              border: `1px solid ${BRAND.borderGold}`, borderRadius: 0,
              boxShadow: "0 18px 50px rgba(0,0,0,0.6)", zIndex: 20,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <span style={{ fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, color: "#fff", letterSpacing: "0.06em", textTransform: "uppercase" }}>Filters</span>
                <button className="map-x" onClick={() => setFiltersOpen(false)} style={{ background: "none", border: "none", color: BRAND.textSecondary, fontSize: 18, cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
              <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9.5, color: BRAND.gold, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>Severity</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
            {/* CRITICAL+ chip — toggles S4+S5 */}
            {(() => {
              const isActive = activeSeverities.has(4) && activeSeverities.has(5) && activeSeverities.size === 2;
              return (
                <button onClick={() => {
                  if (isActive) {
                    setActiveSeverities(new Set());
                  } else {
                    setActiveSeverities(new Set([4, 5]));
                  }
                }}
                  style={{
                    padding: "5px 12px", borderRadius: 0,
                    background: isActive ? "rgba(252,189,0,0.12)" : "rgba(36,36,36,0.85)",
                    backdropFilter: "blur(12px)",
                    border: `1px solid ${isActive ? BRAND.borderGold : BRAND.borderSubtle}`,
                    fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
                    letterSpacing: "0.08em",
                    color: isActive ? BRAND.gold : BRAND.textSecondary,
                    textTransform: "uppercase", cursor: "pointer",
                  }}>
                  CRITICAL+
                </button>
              );
            })()}
              </div>
              <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9.5, color: BRAND.gold, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>GUARD categories</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
            {/* Category chips — one per GUARD category, hiding only the
                ones that have zero incidents in the current data. Users
                need every active category visible on the strip so they can
                filter the map without opening a popover. */}
            {Object.entries(CATEGORIES).map(([code, cat]) => {
              const count = incidents.filter(i => i._cat === code).length;
              if (count === 0) return null;
              const desk = Object.entries(reporters).find(([_, r]) => r.cats?.includes(code));
              const deskName = desk?.[1]?.name;
              const isActive = activeCats.has(code);
              return (
                <button key={code}
                  onClick={() => setActiveCats(prev => {
                    const next = new Set(prev);
                    if (next.has(code)) next.delete(code); else next.add(code);
                    return next;
                  })}
                  title={`${cat.label} · ${count} incident${count === 1 ? "" : "s"}${deskName ? ` · ${deskName}` : ""}`}
                  style={{
                    padding: "5px 12px", borderRadius: 0,
                    background: isActive ? "rgba(252,189,0,0.12)" : "rgba(36,36,36,0.85)",
                    backdropFilter: "blur(12px)",
                    border: `1px solid ${isActive ? BRAND.borderGold : BRAND.borderSubtle}`,
                    fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
                    letterSpacing: "0.08em",
                    color: isActive ? BRAND.gold : BRAND.textSecondary,
                    textTransform: "uppercase", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 5,
                    transition: "all 220ms cubic-bezier(0.4,0,0.2,1)",
                  }}>
                  {code}
                  <span style={{ opacity: 0.6, fontSize: 10 }}>{count}</span>
                </button>
              );
            })}
              </div>
              <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9.5, color: BRAND.gold, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>Industry &amp; more</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {/* INDUSTRY — opens 40-industry filter panel. Badge always
                 shows distinct industry count from current visible set,
                 switching to selected-filter count when filters active. */}
            {(() => {
              const distinctIndustries = new Set();
              for (const inc of visibleIncidents) {
                if (inc.industry) distinctIndustries.add(inc.industry);
              }
              const presentCount = distinctIndustries.size;
              const filterCount = activeIndustries.size;
              const showBadge = filterCount > 0 ? filterCount : presentCount;
              return (
                <button onClick={() => { setIndustryPanelOpen(s => !s); setRegionPanelOpen(false); setShowFilterPopover(false); }}
                  style={{
                    padding: "5px 12px", borderRadius: 0,
                    background: (industryPanelOpen || activeIndustries.size > 0) ? "rgba(252,189,0,0.12)" : "rgba(36,36,36,0.85)",
                    backdropFilter: "blur(12px)",
                    border: `1px solid ${(industryPanelOpen || activeIndustries.size > 0) ? BRAND.borderGold : BRAND.borderSubtle}`,
                    fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
                    letterSpacing: "0.08em",
                    color: (industryPanelOpen || activeIndustries.size > 0) ? BRAND.gold : BRAND.textSecondary,
                    textTransform: "uppercase", cursor: "pointer",
                  }}>
                  ◈ INDUSTRY {showBadge}
                </button>
              );
            })()}

            {/* REGION — opens country filter panel */}
            {(() => {
              const distinctCountries = new Set();
              for (const inc of visibleIncidents) {
                if (inc.country) distinctCountries.add(inc.country);
              }
              const presentCount = distinctCountries.size;
              const filterCount = activeCountries.size;
              const showBadge = filterCount > 0 ? filterCount : presentCount;
              return (
                <button onClick={() => { setRegionPanelOpen(s => !s); setIndustryPanelOpen(false); setShowFilterPopover(false); }}
                  style={{
                    padding: "5px 12px", borderRadius: 0,
                    background: (regionPanelOpen || activeCountries.size > 0) ? "rgba(252,189,0,0.12)" : "rgba(36,36,36,0.85)",
                    backdropFilter: "blur(12px)",
                    border: `1px solid ${(regionPanelOpen || activeCountries.size > 0) ? BRAND.borderGold : BRAND.borderSubtle}`,
                    fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
                    letterSpacing: "0.08em",
                    color: (regionPanelOpen || activeCountries.size > 0) ? BRAND.gold : BRAND.textSecondary,
                    textTransform: "uppercase", cursor: "pointer",
                  }}>
                  ◈ REGION {showBadge}
                </button>
              );
            })()}

            {/* MORE — opens detailed filter popover */}
            <button onClick={() => { setShowFilterPopover(s => !s); setIndustryPanelOpen(false); setRegionPanelOpen(false); }}
              style={{
                padding: "5px 12px", borderRadius: 0,
                background: showFilterPopover ? "rgba(252,189,0,0.12)" : "rgba(36,36,36,0.85)",
                backdropFilter: "blur(12px)",
                border: `1px solid ${showFilterPopover ? BRAND.borderGold : BRAND.borderSubtle}`,
                fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
                letterSpacing: "0.08em",
                color: showFilterPopover ? BRAND.gold : BRAND.textSecondary,
                textTransform: "uppercase", cursor: "pointer",
              }}>
              ☰ MORE
            </button>
              </div>
            </div>
          )}
          </div>

          {/* Industry filter panel — opens below INDUSTRY button. Shows
              all industries present in current dataset grouped by GICS
              sector. Click to toggle filter, "Clear all" to reset. */}
          {industryPanelOpen && (() => {
            // Count incidents per industry from the CURRENTLY VISIBLE set —
            // respects the date window, severity filter, category filter,
            // etc. So the panel reflects "what's in this view" not "all DB".
            const counts = new Map();
            for (const inc of visibleIncidents) {
              if (inc.industry) counts.set(inc.industry, (counts.get(inc.industry) || 0) + 1);
            }
            const presentIndustries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            const untaggedCount = visibleIncidents.filter(i => !i.industry).length;
            return (
              <div className="r-mappanel map-sublist" style={{
                position: "absolute", top: 64, left: 24, width: 440,
                maxHeight: "70vh", overflowY: "auto",
                padding: 16,
                background: "rgba(26,26,26,0.95)", backdropFilter: "blur(20px)",
                border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
                boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                zIndex: 20,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{
                    fontFamily: "Inter, sans-serif", fontSize: 10,
                    color: BRAND.gold, letterSpacing: "0.14em",
                    textTransform: "uppercase", fontWeight: 600,
                  }}>
                    ◈ Filter by Industry · {presentIndustries.length} present
                  </div>
                  <button className="map-x" onClick={() => setIndustryPanelOpen(false)} style={{
                    background: "none", border: "none", color: BRAND.textSecondary,
                    fontSize: 18, cursor: "pointer",
                  }}>×</button>
                </div>

                {activeIndustries.size > 0 && (
                  <button onClick={() => setActiveIndustries(new Set())}
                    style={{
                      width: "100%", padding: "6px 10px", marginBottom: 12,
                      background: "transparent",
                      border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
                      fontFamily: "Inter, sans-serif", fontSize: 10,
                      color: BRAND.textSecondary, letterSpacing: "0.06em",
                      textTransform: "uppercase", cursor: "pointer",
                    }}
                  >
                    Clear all ({activeIndustries.size}) filters
                  </button>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {presentIndustries.map(([ind, cnt]) => {
                    const on = activeIndustries.has(ind);
                    return (
                      <button key={ind}
                        onClick={() => {
                          setActiveIndustries(prev => {
                            const next = new Set(prev);
                            if (next.has(ind)) next.delete(ind); else next.add(ind);
                            return next;
                          });
                        }}
                        style={{
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                          padding: "8px 12px",
                          background: on ? "rgba(252,189,0,0.18)" : "rgba(8,8,8,0.4)",
                          border: `1px solid ${on ? BRAND.gold : BRAND.borderSubtle}`,
                          borderRadius: 0,
                          fontFamily: "Inter, sans-serif", fontSize: 12,
                          color: on ? BRAND.white : BRAND.textSecondary,
                          fontWeight: on ? 600 : 400,
                          textAlign: "left", cursor: "pointer",
                          transition: "all 140ms ease",
                        }}
                      >
                        <span>{ind}</span>
                        <span style={{
                          fontFamily: "'Inter', sans-serif", fontSize: 10,
                          color: on ? BRAND.gold : BRAND.textMuted,
                          fontWeight: 600,
                        }}>{cnt}</span>
                      </button>
                    );
                  })}
                </div>

                {untaggedCount > 0 && (
                  <div style={{
                    marginTop: 12, padding: "8px 10px",
                    background: "rgba(255,255,255,0.04)", borderRadius: 0,
                    fontFamily: "Inter, sans-serif", fontSize: 9.5,
                    color: BRAND.textMuted, letterSpacing: "0.06em",
                    textAlign: "center",
                  }}>
                    {untaggedCount} incidents untagged (Government / Education / Civil Society)
                  </div>
                )}
              </div>
            );
          })()}

          {/* Region/Country filter panel — opens below REGION button. Shows
              all countries present in current dataset. Click to toggle filter, "Clear all" to reset. */}
          {regionPanelOpen && (() => {
            const counts = new Map();
            for (const inc of visibleIncidents) {
              if (inc.country) counts.set(inc.country, (counts.get(inc.country) || 0) + 1);
            }
            const presentCountries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            return (
              <div className="r-mappanel map-sublist" style={{
                position: "absolute", top: 64, left: 24, width: 380,
                maxHeight: "70vh", overflowY: "auto",
                padding: 16,
                background: "rgba(26,26,26,0.95)", backdropFilter: "blur(20px)",
                border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
                boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                zIndex: 20,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{
                    fontFamily: "Inter, sans-serif", fontSize: 10,
                    color: BRAND.gold, letterSpacing: "0.14em",
                    textTransform: "uppercase", fontWeight: 600,
                  }}>
                    ◈ Filter by Region · {presentCountries.length} present
                  </div>
                  <button className="map-x" onClick={() => setRegionPanelOpen(false)} style={{
                    background: "none", border: "none", color: BRAND.textSecondary,
                    fontSize: 18, cursor: "pointer",
                  }}>×</button>
                </div>

                {activeCountries.size > 0 && (
                  <button onClick={() => setActiveCountries(new Set())}
                    style={{
                      width: "100%", padding: "6px 10px", marginBottom: 12,
                      background: "transparent",
                      border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
                      fontFamily: "Inter, sans-serif", fontSize: 10,
                      color: BRAND.textSecondary, letterSpacing: "0.06em",
                      textTransform: "uppercase", cursor: "pointer",
                    }}
                  >
                    Clear all ({activeCountries.size}) filters
                  </button>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {presentCountries.map(([cname, cnt]) => {
                    const on = activeCountries.has(cname);
                    return (
                      <button key={cname}
                        onClick={() => {
                          setActiveCountries(prev => {
                            const next = new Set(prev);
                            if (next.has(cname)) next.delete(cname); else next.add(cname);
                            return next;
                          });
                        }}
                        style={{
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                          padding: "8px 12px",
                          background: on ? "rgba(252,189,0,0.18)" : "rgba(8,8,8,0.4)",
                          border: `1px solid ${on ? BRAND.gold : BRAND.borderSubtle}`,
                          borderRadius: 0,
                          fontFamily: "Inter, sans-serif", fontSize: 12,
                          color: on ? BRAND.white : BRAND.textSecondary,
                          fontWeight: on ? 600 : 400,
                          textAlign: "left", cursor: "pointer",
                          transition: "all 140ms ease",
                        }}
                      >
                        <span>{cname}</span>
                        <span style={{
                          fontFamily: "'Inter', sans-serif", fontSize: 10,
                          color: on ? BRAND.gold : BRAND.textMuted,
                          fontWeight: 600,
                        }}>{cnt}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Detailed filter popover — search + full severity + confidence */}
          {showFilterPopover && (
            <div className="r-mappanel map-popover" style={{
              position: "absolute", top: 64, left: 24, width: 360,
              padding: 18,
              background: "rgba(26,26,26,0.95)", backdropFilter: "blur(20px)",
              border: `1px solid rgba(252,189,0,0.20)`, borderRadius: 0,
              boxShadow: "0 22px 60px rgba(0,0,0,0.55)",
              zIndex: 30,
            }}>
              <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 3, background: `linear-gradient(90deg, ${BRAND.gold}, ${BRAND.goldDim})`, borderRadius: 0 }} />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.gold, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 600 }}>
                  ◇ DETAILED FILTERS
                </div>
                <button className="map-x" onClick={() => setShowFilterPopover(false)}
                  style={{ width: 22, height: 22, padding: 0, background: "transparent", color: BRAND.textMuted, border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0, cursor: "pointer", fontSize: 12 }}>×</button>
              </div>
              {/* Search */}
              <div style={{ position: "relative", marginBottom: 14 }}>
                <span style={{
                  position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
                  fontFamily: "Inter, sans-serif", fontSize: 11,
                  color: searchQuery ? BRAND.gold : BRAND.textMuted, pointerEvents: "none",
                }}>⌕</span>
                <input
                  type="text" value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search incidents…"
                  spellCheck={false}
                  style={{
                    padding: "7px 28px 7px 26px", width: "100%",
                    fontFamily: "Inter, sans-serif", fontSize: 12,
                    background: BRAND.obsidianElevated,
                    color: BRAND.white,
                    border: `1px solid ${searchQuery ? BRAND.borderGold : BRAND.borderSubtle}`,
                    borderRadius: 0, outline: "none",
                  }}
                />
              </div>
              {/* Severity full 5-pill */}
              <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
                SEVERITY
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
                {[5, 4, 3, 2, 1].map(level => {
                  const isActive = activeSeverities.has(level);
                  const count = incidents.filter(i => i.severity === level).length;
                  if (count === 0) return null;
                  const s = SEVERITY[level];
                  return (
                    <button key={level} className="map-sev"
                      onClick={() => setActiveSeverities(prev => {
                        const n = new Set(prev);
                        if (n.has(level)) n.delete(level); else n.add(level);
                        return n;
                      })}
                      style={{
                        padding: "4px 10px",
                        fontFamily: "Inter, sans-serif", fontSize: 10, letterSpacing: "0.06em",
                        background: isActive ? s.color : "transparent",
                        color: isActive ? BRAND.obsidian : s.color,
                        border: `1px solid ${isActive ? s.color : BRAND.borderSubtle}`,
                        borderRadius: 0, cursor: "pointer", fontWeight: 500,
                      }}>
                      S{level} <span style={{ fontSize: 9, opacity: 0.8, marginLeft: 3 }}>{count}</span>
                    </button>
                  );
                })}
              </div>
              {/* Confidence */}
              <div style={{ fontFamily: "Inter, sans-serif", fontSize: 9, color: BRAND.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
                CONFIDENCE
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
                {["high", "medium", "low"].map(level => {
                  const isActive = activeConfidences.has(level);
                  const count = incidents.filter(i => i.confidence === level).length;
                  if (count === 0) return null;
                  return (
                    <button key={level} className="map-sev"
                      onClick={() => setActiveConfidences(prev => {
                        const n = new Set(prev);
                        if (n.has(level)) n.delete(level); else n.add(level);
                        return n;
                      })}
                      style={{
                        padding: "4px 10px",
                        fontFamily: "Inter, sans-serif", fontSize: 10, letterSpacing: "0.06em",
                        background: isActive ? BRAND.gold : "transparent",
                        color: isActive ? BRAND.obsidian : BRAND.textSecondary,
                        border: `1px solid ${isActive ? BRAND.gold : BRAND.borderSubtle}`,
                        borderRadius: 0, cursor: "pointer", fontWeight: 500, textTransform: "uppercase",
                      }}>
                      {level} <span style={{ fontSize: 9, opacity: 0.8, marginLeft: 3 }}>{count}</span>
                    </button>
                  );
                })}
              </div>
              {/* Clear all + fleet/audit buttons */}
              <div style={{ display: "flex", gap: 6, paddingTop: 10, borderTop: `1px solid ${BRAND.borderSubtle}` }}>
                <button onClick={() => {
                    setActiveReporters(new Set());
                    setActiveCats(new Set());
                    setActiveSeverities(new Set());
                    setActiveConfidences(new Set());
                    setSearchQuery("");
                  }}
                  style={{
                    padding: "5px 10px", flex: 1,
                    background: "transparent", color: BRAND.gold,
                    border: `1px solid ${BRAND.borderGold}`, borderRadius: 0,
                    fontFamily: "Inter, sans-serif", fontSize: 10, letterSpacing: "0.08em",
                    cursor: "pointer", textTransform: "uppercase",
                  }}>
                  ✕ CLEAR ALL
                </button>
                <button onClick={() => setShowListPanel(s => !s)}
                  style={{
                    padding: "5px 10px",
                    background: showListPanel ? "rgba(252,189,0,0.12)" : "transparent",
                    color: showListPanel ? BRAND.gold : BRAND.textSecondary,
                    border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
                    fontFamily: "Inter, sans-serif", fontSize: 10, letterSpacing: "0.08em",
                    cursor: "pointer", textTransform: "uppercase",
                  }}>
                  ☷ FLEET
                </button>
                <button onClick={() => setShowAuditDrawer(true)}
                  style={{
                    padding: "5px 10px",
                    background: "transparent", color: BRAND.textSecondary,
                    border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
                    fontFamily: "Inter, sans-serif", fontSize: 10, letterSpacing: "0.08em",
                    cursor: "pointer", textTransform: "uppercase",
                  }}>
                  ◇ AUDIT
                </button>
              </div>
            </div>
          )}

          {/* ─── HUD: RIGHT — severity legend box (desktop). Standalone "Risk
              level" key on the right edge, below the Archive button; replaces
              the old LIVE counter card. Hidden while an incident is open so it
              never sits behind the scene panels. ─── */}
          {!selectedId && (
          <div className="r-hide map-legend" style={{
            position: "absolute", bottom: 24, right: 24, zIndex: 20,
            padding: "9px 12px 10px", minWidth: 120,
            background: "rgba(26,26,28,0.92)", backdropFilter: "blur(14px)",
            border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}>
            <div style={{
              fontFamily: "Inter, sans-serif", fontSize: 8, fontWeight: 700,
              letterSpacing: "0.16em", color: BRAND.textMuted, textTransform: "uppercase",
              marginBottom: 7,
            }}>Risk level</div>
            {[5, 4, 3, 2, 1].map((level, i) => (
              <div key={level} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: i < 4 ? 5 : 0 }}>
                <span style={{ width: 7, height: 7, borderRadius: 0, background: SEVERITY[level].color, flexShrink: 0 }} />
                <span style={{
                  fontFamily: "Inter, sans-serif", fontSize: 9.5, fontWeight: 600,
                  color: BRAND.textSecondary, textTransform: "uppercase", letterSpacing: "0.06em",
                }}>{SEVERITY[level].label}</span>
              </div>
            ))}
          </div>
          )}

          {/* ─── HUD: BOTTOM-CENTRE — single consolidated control strip ───
              All map controls live in one horizontal glass pill, separated
              into four logical groups by thin vertical dividers:
                1. Severity legend  · 2. Map mode  · 3. View mode  · 4. Layer toggles */}
          <div className="map-ctrl-strip r-hide" style={{
            position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)", width: "max-content",
            display: "flex", alignItems: "center",
            padding: "6px 8px",
            background: "rgba(36,36,36,0.85)", backdropFilter: "blur(12px)",
            border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
            boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
            zIndex: 20,
            gap: 4,
          }}>
            {/* Group 2: Map mode (flat / globe) — segmented */}
            <div style={{ display: "flex", borderRadius: 0, overflow: "hidden", border: `1px solid ${BRAND.borderSubtle}` }}>
              {[
                { id: "flat",  label: "▭ FLAT"  },
                { id: "globe", label: "◯ GLOBE" },
              ].map(m => (
                <button key={m.id} onClick={() => setMapMode(m.id)}
                  style={{
                    padding: "5px 10px",
                    fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
                    letterSpacing: "0.08em",
                    background: mapMode === m.id ? BRAND.gold : "transparent",
                    color: mapMode === m.id ? BRAND.obsidian : BRAND.textSecondary,
                    border: "none", cursor: "pointer",
                  }}>
                  {m.label}
                </button>
              ))}
            </div>

            {/* Thin vertical divider */}
            <div style={{ width: 1, height: 18, background: BRAND.borderSubtle, margin: "0 2px" }} />

            {/* Group 3: View mode (buyer / newsroom) — segmented */}
            <div style={{ display: "flex", borderRadius: 0, overflow: "hidden", border: `1px solid ${BRAND.borderSubtle}` }}>
              {["buyer", "newsroom"].map(m => (
                <button key={m} onClick={() => setViewMode(m)}
                  style={{
                    padding: "5px 10px",
                    fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
                    letterSpacing: "0.08em",
                    background: viewMode === m ? BRAND.gold : "transparent",
                    color: viewMode === m ? BRAND.obsidian : BRAND.textSecondary,
                    border: "none", cursor: "pointer", textTransform: "uppercase",
                  }}>
                  {m}
                </button>
              ))}
            </div>

            {/* Thin vertical divider */}
            <div style={{ width: 1, height: 18, background: BRAND.borderSubtle, margin: "0 2px" }} />

            {/* Group 4: Layer toggles — labels / heat / blast */}
            <div style={{ display: "flex", gap: 4 }}>
              {[
                { id: "labels", label: "🅰 LABELS", active: showLabels,       toggle: () => setShowLabels(s => !s) },
                { id: "heat",   label: "◉ HEAT",    active: showHeat,         toggle: () => setShowHeat(h => !h) },
                { id: "blast",  label: "↯ BLAST",   active: showBlastRadius,  toggle: () => setShowBlastRadius(b => !b) },
              ].map(b => (
                <button key={b.id} onClick={b.toggle}
                  style={{
                    padding: "5px 10px",
                    background: b.active ? "rgba(252,189,0,0.12)" : "transparent",
                    color: b.active ? BRAND.gold : "#8C8C8C",   // was BRAND.textMuted (#585858) = 2.82:1 on the #080808 chrome

                    border: `1px solid ${b.active ? BRAND.borderGold : BRAND.borderSubtle}`,
                    borderRadius: 0,
                    fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
                    letterSpacing: "0.08em",
                    cursor: "pointer", textTransform: "uppercase",
                    whiteSpace: "nowrap",
                  }}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          {/* ─── HUD: BOTTOM-CENTRE — contextual caption ─── */}
          {/* Sits ABOVE the control strip (bottom: 90 vs strip's bottom: 24)
              so the two never overlap. Constrained to centre-only width so
              the strip on the left edge can claim its space without fighting. */}
          <div className="map-hint" style={{
            position: "absolute", bottom: 90, left: "50%", transform: "translateX(-50%)",
            padding: "8px 18px",
            background: "rgba(8,8,8,0.7)", backdropFilter: "blur(12px)",
            border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0,
            fontFamily: "Inter, sans-serif", fontSize: 12, color: BRAND.textSecondary,
            maxWidth: 560, textAlign: "center",
            pointerEvents: "none", zIndex: 15,
          }}>
            {(() => {
              if (selectedId) {
                return <>Hover the dots radiating outward — each one is a related entity in the blast radius.</>;
              }
              if (hoveredId) {
                const inc = visibleIncidents.find(i => i._id === hoveredId);
                return <>{inc?.headline ? inc.headline.slice(0, 80) : "Click to open the full GUARD classification."}</>;
              }
              return <>Click any incident to see GUARD classification, blast radius, and adaptive controls.</>;
            })()}
          </div>
        </div>
      )}

      {/* ───── INCIDENT LIST PANEL (slides in from left) ───── */}
      {sweep && showListPanel && (
        <div className="r-mappanel map-fleet" style={{
          position: "fixed", top: 64, left: 24, bottom: 24, width: 320,
          zIndex: 50,
        }}>
          <IncidentListPanel
            visibleIncidents={visibleIncidents}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onHover={setHoveredId}
            hoveredId={hoveredId}
            reporters={reporters}
            onClose={() => setShowListPanel(false)}
          />
        </div>
      )}

      {/* Detail panel — cascade of floating cards. key={_id} forces a full
          remount on incident change so the cascade replays from scratch.
          Wrapped in AccessContext so all 4 gated bodies inside read the
          same tier (derived from auth) without prop-drilling. */}
      {selectedIncident && deckReady && (
        <AccessContext.Provider value={accessTier}>
          <IncidentCascade
            key={selectedIncident._id || selectedIncident.headline}
            incident={selectedIncident}
            reporter={selectedReporter}
            viewMode={viewMode}
            autoPlay={mobilePreview}
            onSkip={() => { setMobilePreview(false); setSelectedId(null); }}
            onClose={() => { setMobilePreview(false); setSelectedId(null); }}
          />
        </AccessContext.Provider>
      )}

      {/* Guided narrated walkthrough — auto-plays for visitors on the latest day */}
      {!isMobile && tourActive && tourIncident && (
        <GuidedTour
          key={tourIncident._id}
          incident={tourIncident}
          onFeature={setSelectedId}
          onClose={() => setTourActive(false)}
        />
      )}

      {/* Audit drawer */}
      {showAuditDrawer && (
        <AuditDrawer
          incidents={incidents}
          onClose={() => setShowAuditDrawer(false)}
        />
      )}

      {/* Auto-play date overlay — the current day, shown large over the map and
          updated in sync as playback steps date-by-date. */}
      {(playing || briefPlaying) && currentDate && (
        <div className="map-date-overlay" style={{
          position: "fixed", top: 92, left: "50%", transform: "translateX(-50%)", zIndex: 65,
          display: "flex", flexDirection: "column", gap: 8, padding: "12px 20px", width: "min(480px, 90vw)",
          background: "rgba(10,10,12,0.92)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
          border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 0, boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          transition: "all 0.3s ease-in-out",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <style>{`@keyframes atkDatePulse {0%,100%{opacity:1}50%{opacity:.3}}`}</style>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#E0091C", boxShadow: "0 0 8px #E0091C", animation: "atkDatePulse 1.2s infinite" }} />
              <span style={{ fontFamily: "Inter, sans-serif", fontWeight: 800, fontSize: 16, color: "#fff", letterSpacing: "0.01em" }}>
                {(() => { try { return new Date(currentDate + "T00:00:00Z").toUTCString().slice(0, 16); } catch { return currentDate; } })()}
              </span>
            </div>
            {playDates.length > 0 && (
              <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, fontWeight: 600, color: BRAND.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                day {playPos + 1} / {playDates.length}
              </span>
            )}
          </div>
          {(briefPlaying ? briefCaption : playSummary) && (
            <div style={{
              fontFamily: "Inter, sans-serif", fontSize: briefPlaying ? 13 : 11.5,
              color: briefPlaying ? BRAND.white : BRAND.textSecondary,
              lineHeight: 1.45, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8,
              textAlign: "left", letterSpacing: "0.01em"
            }}>
              {briefPlaying && <span style={{ color: BRAND.gold, fontWeight: 800, marginRight: 6 }}>📻 BRIEF</span>}
              {briefPlaying ? briefCaption : playSummary}
            </div>
          )}
        </div>
      )}

      {/* Archive drawer */}
      {showArchive && (
        <ArchivePanel
          archiveIndex={archiveIndex}
          currentDate={currentDate}
          onLoad={loadArchivedSweep}
          onDelete={removeArchivedSweep}
          onClose={() => setShowArchive(false)}
          busy={archiveBusy}
          storageSubstrate={storageSubstrate}
          storageCanaryError={storageCanaryError}
          liveDataError={liveDataError}
          timeWindow={timeWindow}
          onWindow={applyTimeWindow}
          windowInfo={windowInfo}
          timeline={{
            rangeFrom, rangeTo, setRangeFrom, setRangeTo,
            onApplyRange: applyRange,
            onPlayRange: playRange,
            playing, onTogglePlay: () => setPlaying(p => !p),
            playDates, playPos, playSpeedMs, setPlaySpeedMs,
            onScrub: (i) => { setPlaying(false); showPlayDay(i); },
            narrate, onToggleNarrate: () => setNarrate(v => !v),
            onPlayBrief: playDailyBrief, briefPlaying,
          }}
          onRefresh={async () => {
            setArchiveBusy(true);
            try {
              await verifyStorage();
              setStorageSubstrate(_storageState.substrate);
              setStorageCanaryError(_storageState.canaryError);
              const idx = await readIndex();
              setArchiveIndex(idx);
              setArchiveToast({ type: "saved", text: `✓ Re-scanned · ${idx.length} sweep${idx.length === 1 ? "" : "s"} found` });
              setTimeout(() => setArchiveToast(null), 2800);
            } catch (e) {
              setArchiveToast({ type: "warn", text: `⚠ Rescan failed: ${e?.message || e}` });
              setTimeout(() => setArchiveToast(null), 4000);
            } finally {
              setArchiveBusy(false);
            }
          }}
        />
      )}

      {/* Toast */}
      {archiveToast && (
        <div style={{
          position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)",
          padding: "10px 18px",
          background: "rgba(46,46,46,0.95)", backdropFilter: "blur(16px)",
          color: archiveToast.type === "warn" ? "#FF8C5A" : BRAND.gold,
          border: `1px solid ${archiveToast.type === "warn" ? "rgba(255,107,107,0.4)" : BRAND.borderGold}`,
          borderRadius: 0,
          fontFamily: "Inter, sans-serif", fontSize: 11, letterSpacing: "0.08em",
          zIndex: 1001, boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        }}>
          {archiveToast.text}
        </div>
      )}

      {worldErr && sweep && (
        <div style={{
          position: "fixed", bottom: 24, right: 24,
          padding: "8px 12px", background: "rgba(255,107,107,0.08)",
          border: "1px solid rgba(255,107,107,0.25)", borderRadius: 0,
          color: "#FF8C5A", fontFamily: "Inter, sans-serif", fontSize: 10,
          zIndex: 50,
        }}>
          World atlas: {worldErr}
        </div>
      )}
    </div>
  );
}
