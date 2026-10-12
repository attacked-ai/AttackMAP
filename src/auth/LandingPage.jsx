// ─────────────────────────────────────────────────────────────────────────
// LandingPage — the editorial front page for anonymous visitors.
//
// Replaces PublicWall as the first thing a stranger sees. Inspired by the
// McKinsey / editorial-intelligence pattern: big headline with gold accent
// words, a floating live incident card pulled from the real database, a
// numbered 01/02/03 capability section, newsletter cards, and the two-gate
// pricing strip.
//
// WELCOME OVERLAY: on first visit (localStorage flag) an overlay greets
// the visitor with today's live numbers and routes them to sign-up. No
// admin entry is surfaced anywhere on this page.
//
// All data shown (ticker numbers, incident card, headlines) is fetched
// live from Supabase — nothing hardcoded, so the page is always current.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useRef } from "react";
import { supabase } from "../lib/supabaseClient";
import { AuthModal } from "./AuthModal";
import { SubscribeModal } from "./SubscribeModal";
import { useAuth } from "./AuthProvider";
import { SiteNav } from "./SiteNav";
import { SiteFooter } from "./SiteFooter";
import { Globe } from "./Globe";
// Design system lives in ONE place now (src/brand.js) — this file used to
// carry its own copy of BRAND, as 17 other components still do. The shared
// token set is a superset of the old keys, so every call site below is
// unchanged; what shifts is the values (blue-black ground, cream paper
// bands) and the new editorial type/component recipes imported alongside.
import { BRAND, TYPE, btn, shell, band, LAYOUT } from "../brand.js";

const SEVERITY_LABEL = { 5: "CRITICAL", 4: "HIGH", 3: "MEDIUM", 2: "LOW", 1: "MINIMAL" };
const SEVERITY_COLOR = { 5: "#FF3B30", 4: "#FF8C5A", 3: BRAND.gold, 2: "#34C759", 1: "#8E8E93" };

// The 13 GUARD categories — [code, name, live?, count] — for the live stripe ticker.
const CATS = [
  ["CYB", "Cyber Security", 1, 38], ["DAT", "Data & Privacy", 1, 21], ["ENV", "Environmental", 0, 9],
  ["FIN", "Financial", 1, 34], ["GEO", "Geopolitical", 1, 27], ["OPS", "Operations", 1, 22],
  ["PHY", "Physical Security", 0, 11], ["PPL", "People", 0, 16], ["REG", "Regulatory", 1, 29],
  ["REP", "Reputation", 1, 24], ["STR", "Strategic", 0, 14], ["TEC", "Technology", 1, 31],
  ["TPR", "Third Party", 1, 19],
];

// Editorial banner imagery keyed to the GUARD category (there is no per-incident
// photo in the DB). Same stable Unsplash CDN set used on the Attacked Hub so the
// two surfaces feel like one product. A failed load falls back to a
// severity-tinted gradient stamped with the category code — a card never breaks.
const CATEGORY_IMG = {
  CYB: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=640&q=60&auto=format&fit=crop",
  DAT: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=640&q=60&auto=format&fit=crop",
  FIN: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=640&q=60&auto=format&fit=crop",
  GEO: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=640&q=60&auto=format&fit=crop",
  REG: "https://images.unsplash.com/photo-1589829545856-d10d557cf95f?w=640&q=60&auto=format&fit=crop",
  PHY: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=640&q=60&auto=format&fit=crop",
  PPL: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=640&q=60&auto=format&fit=crop",
  TEC: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=640&q=60&auto=format&fit=crop",
  STR: "https://images.unsplash.com/photo-1605810230434-7631ac76ec81?w=640&q=60&auto=format&fit=crop",
  REP: "https://images.unsplash.com/photo-1495020689067-958852a7765e?w=640&q=60&auto=format&fit=crop",
  TPR: "https://images.unsplash.com/photo-1556761175-5973dc0f32e7?w=640&q=60&auto=format&fit=crop",
  OPS: "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=640&q=60&auto=format&fit=crop",
  ENV: "https://images.unsplash.com/photo-1473773508845-188df298d2d1?w=640&q=60&auto=format&fit=crop",
  _default: "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?w=640&q=60&auto=format&fit=crop",
};

// Small banner image for a marquee card. Degrades to a severity gradient.
function CardImage({ article, height = 130 }) {
  const [failed, setFailed] = useState(false);
  const cat = article.primary_category || "OPS";
  const sev = SEVERITY_COLOR[article.severity] || BRAND.gold;
  if (failed) {
    return (
      <div style={{
        height, background: `linear-gradient(135deg, ${sev}33, ${BRAND.obsidian} 70%)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        color: sev, fontWeight: 800, fontSize: 18, letterSpacing: "0.12em",
      }}>{cat}</div>
    );
  }
  return (
    <div style={{ position: "relative", height, overflow: "hidden" }}>
      <img src={article.image_url || CATEGORY_IMG[cat] || CATEGORY_IMG._default} alt="" loading="lazy"
        onError={() => setFailed(true)}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(8,8,8,0.05), rgba(8,8,8,0.62))" }} />
    </div>
  );
}

function FontLoader() {
  useEffect(() => {
    if (document.getElementById("attacked-fonts")) return;
    const link = document.createElement("link");
    link.id = "attacked-fonts";
    link.rel = "stylesheet";
    // Load BOTH upright and true italic axes so the gold italic accent text
    // ("calibrated to you.", "blast radius") renders as real Inter italic
    // rather than a browser-synthesized slant that can read as a serif.
    link.href = "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,500;1,600;1,700;1,800;1,900&display=swap";
    document.head.appendChild(link);
  }, []);
  return null;
}

// One-time fetch of live numbers + a hero incident + recent headlines.
// Falls back silently to nulls — the page renders fine without data.
function useLiveIntel() {
  const [intel, setIntel] = useState({
    totalIncidents: null, countries: null, industries: null,
    latestDay: null, heroIncident: null, headlines: [], feedCards: [], rotationPool: [],
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ count: total }, { data: latest }, { data: rows }] = await Promise.all([
          supabase.from("incidents").select("id", { count: "exact", head: true }),
          // nullsFirst:false — five rows carry a NULL incident_day and Postgres sorts
          // NULLs first on DESC, which made "latest day" resolve to null.
          supabase.from("incidents").select("incident_day").not("incident_day", "is", null).order("incident_day", { ascending: false, nullsFirst: false }).limit(1),
          supabase.from("incidents")
            // image_url is BACK since 2026-09-23 (migration 20260923_incident_images:
            // the stored picture written by the incident-images function).
            .select("id,headline,summary,entity,country,sector,severity,primary_category,incident_day,industry,image_url")
            .not("incident_day", "is", null)
            .order("incident_day", { ascending: false, nullsFirst: false })
            .order("severity", { ascending: false })
            .limit(40),
        ]);
        if (cancelled) return;
        const latestDay = latest?.[0]?.incident_day || null;
        const countries = new Set((rows || []).map(r => r.country).filter(Boolean)).size;
        const industries = new Set((rows || []).map(r => r.industry).filter(Boolean)).size;
        // Hero card = highest-severity incident from the latest day
        const dayRows = (rows || []).filter(r => r.incident_day === latestDay);
        const hero = (dayRows.length ? dayRows : rows || [])
          .slice()
          .sort((a, b) => (b.severity || 0) - (a.severity || 0))[0] || null;
        const headlines = (dayRows.length ? dayRows : (rows || []).slice(0, 5))
          .slice(0, 5);
        // Flowing card grid — the freshest 6 incidents excluding the hero
        const feedCards = (rows || []).filter(r => r.id !== hero?.id).slice(0, 6);
        // Rotation pool for the hero sample card — DISTINCT companies/entities
        // across all recent rows, so it cycles through different organisations
        // instead of 4 versions of the same top story.
        const seenEnt = new Set(); const rotationPool = [];
        for (const r of (rows || [])) {
          if (!r.headline) continue;
          const k = String(r.entity || r.headline).toLowerCase().trim();
          if (seenEnt.has(k)) continue;
          seenEnt.add(k); rotationPool.push(r);
          if (rotationPool.length >= 8) break;
        }
        setIntel({ totalIncidents: total ?? null, countries, industries, latestDay, heroIncident: hero, headlines, feedCards, rotationPool });
      } catch { /* keep nulls — page degrades gracefully */ }
    })();
    return () => { cancelled = true; };
  }, []);
  return intel;
}

// ── BlastRadiusViz ──────────────────────────────────────────────────────────
// Cinematic canvas visualization for the method section — a luminous gold
// network of an incident reaching named companies, with light pulses that
// travel outward along curved arcs (brand: gold-only on deep black, JetBrains
// Mono labels). Pure ambience, no app chrome. Matches the reference's craft.
function BlastRadiusViz() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const GOLD = "#FCBD00", RED = "#FF3B30";
    const NODES = [
      { a: -0.35, r: 0.92, nm: "Transneft", role: "SUPPLIER" },
      { a: 0.6, r: 0.82, nm: "Lukoil", role: "CUSTOMER" },
      { a: 2.55, r: 0.74, nm: "Sovcomflot", role: "PEER" },
      { a: 1.6, r: 1.0, you: true, nm: "YOU", role: "YOUR VENDOR" },
      { a: 0.15, r: 0.5 }, { a: 1.05, r: 0.6 }, { a: 2.0, r: 0.52 },
      { a: 3.0, r: 0.86 }, { a: 3.7, r: 0.58 }, { a: 4.3, r: 0.92 },
      { a: 4.9, r: 0.48 }, { a: 5.5, r: 0.8 }, { a: 6.0, r: 0.56 },
      { a: -0.95, r: 0.66 }, { a: 2.2, r: 0.96 }, { a: 4.0, r: 0.44 },
    ];
    let W = 0, H = 0, cx = 0, cy = 0, Rx = 0, Ry = 0, dpr = 1, raf = 0, rt = 0, ro = null;
    function resize() {
      const rect = canvas.getBoundingClientRect(); if (!rect.width) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width; H = rect.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W / 2; cy = H / 2; Rx = Math.min(W * 0.42, 470); Ry = H * 0.4;
    }
    const pos = (n) => [cx + Math.cos(n.a) * Rx * n.r, cy + Math.sin(n.a) * Ry * n.r];
    function ctrl(p) {
      const mx = (cx + p[0]) / 2, my = (cy + p[1]) / 2, dx = p[0] - cx, dy = p[1] - cy;
      const len = Math.hypot(dx, dy) || 1, off = len * 0.16;
      return [mx - dy / len * off, my + dx / len * off];
    }
    const bez = (c, p, t) => { const u = 1 - t; return [u * u * cx + 2 * u * t * c[0] + t * t * p[0], u * u * cy + 2 * u * t * c[1] + t * t * p[1]]; };
    function draw(t) {
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < NODES.length; i++) {
        const n = NODES[i], p = pos(n), c = ctrl(p);
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(c[0], c[1], p[0], p[1]);
        ctx.strokeStyle = n.you ? "rgba(255,59,48,0.22)" : "rgba(252,189,0,0.15)"; ctx.lineWidth = 1; ctx.stroke();
        if (!reduce) {
          const prog = ((t / 2600 + i * 0.17) % 1), pt = bez(c, p, prog);
          ctx.beginPath(); ctx.fillStyle = n.you ? "#FF6B6B" : GOLD;
          ctx.shadowColor = n.you ? RED : GOLD; ctx.shadowBlur = 10;
          ctx.arc(pt[0], pt[1], 2, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;
        }
      }
      for (let i = 0; i < NODES.length; i++) {
        const n = NODES[i], p = pos(n), labeled = !!n.nm;
        const baseR = n.you ? 5 : labeled ? 3.6 : 2.1;
        const tw = reduce ? 1 : (0.7 + 0.3 * Math.sin(t * 0.002 + i));
        ctx.beginPath(); ctx.fillStyle = n.you ? RED : GOLD;
        ctx.shadowColor = n.you ? RED : GOLD; ctx.shadowBlur = (n.you ? 14 : labeled ? 8 : 4) * tw;
        ctx.arc(p[0], p[1], baseR, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;
        if (n.you && !reduce) {
          const pr = ((t / 1600) % 1);
          ctx.beginPath(); ctx.strokeStyle = "rgba(255,59,48," + ((1 - pr) * 0.6).toFixed(3) + ")"; ctx.lineWidth = 1.4;
          ctx.arc(p[0], p[1], 5 + pr * 24, 0, 6.283); ctx.stroke();
        }
      }
      if (!reduce) {
        const ip = ((t / 1800) % 1);
        ctx.beginPath(); ctx.strokeStyle = "rgba(255,59,48," + ((1 - ip) * 0.5).toFixed(3) + ")"; ctx.lineWidth = 1.5;
        ctx.arc(cx, cy, 8 + ip * 32, 0, 6.283); ctx.stroke();
      }
      ctx.beginPath(); ctx.fillStyle = RED; ctx.shadowColor = RED; ctx.shadowBlur = 22; ctx.arc(cx, cy, 7, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.fillStyle = "#fff"; ctx.arc(cx, cy, 2.5, 0, 6.283); ctx.fill();
      ctx.textAlign = "center";
      for (const n of NODES) {
        if (!n.nm) continue; const p = pos(n), you = n.you;
        ctx.fillStyle = you ? "#FF8A8A" : "#fff"; ctx.font = (you ? "700" : "600") + " 12px 'JetBrains Mono', monospace";
        ctx.fillText(n.nm, p[0], p[1] - 12);
        ctx.fillStyle = "#6a6a6a"; ctx.font = "500 9px 'JetBrains Mono', monospace";
        ctx.fillText(n.role, p[0], p[1] + 19);
      }
      ctx.fillStyle = "#FF8A8A"; ctx.font = "700 10px 'JetBrains Mono', monospace"; ctx.fillText("INCIDENT", cx, cy - 16);
    }
    function frame(t) { draw(t); raf = requestAnimationFrame(frame); }
    function doResize() { resize(); draw(0); }
    if ("ResizeObserver" in window) { ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(doResize, 80); }); ro.observe(canvas); }
    doResize();
    if (!reduce) raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); clearTimeout(rt); if (ro) ro.disconnect(); };
  }, []);
  return <canvas ref={ref} style={{ display: "block", width: "100%", height: 440 }} aria-label="Blast radius — a live network of one incident reaching named companies, including you" />;
}

function fmtDay(iso) {
  if (!iso) return "";
  try {
    return new Date(iso + "T00:00:00Z").toUTCString().slice(0, 16);
  } catch { return iso; }
}

// Shared button styles — now composed from the design-system recipes.
// Editorial buttons are sentence-case and square: the old uppercase +
// 0.08em-tracked pills read as generic SaaS, and the rounded corners fought
// the sharp-cornered structure the rest of the page is built on.
const goldBtn = { ...btn.base, ...btn.primary };
const ghostBtn = { ...btn.base, ...btn.ghost };

const eyebrowStyle = {
  fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700,
  color: BRAND.gold, letterSpacing: "0.22em", textTransform: "uppercase",
};

const sectionLabel = {
  fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700,
  color: BRAND.tmuted, letterSpacing: "0.18em", textTransform: "uppercase",
  textAlign: "center", marginBottom: 14,
};

export function LandingPage() {
  const { user } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  const [authIntent, setAuthIntent] = useState(null);
  // One Subscribe path for the whole page: the subscription page (/?subscribe).
  // It reads signed out; sign-in is part of its flow.
  const startSubscribe = () => { window.location.href = "/?subscribe"; };
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const intel = useLiveIntel();

  // "Attack Map" CTA: a signed-in visitor (arriving here via ?home from the
  // map's logo) goes straight to the map; an anonymous one hits the sign-in
  // wall first.
  function enterMap() {
    // Signed-in users open the live map at ?map (the bare "/" now keeps them
    // on this landing page so sign-in never dumps them straight into the map).
    // Anonymous visitors hit the sign-in wall first.
    if (user) window.location.href = "/?map";
    else setAuthOpen(true);
  }

  // Welcome overlay — once per browser. Slight delay so the page paints
  // behind it first (the overlay should feel like a concierge greeting,
  // not a roadblock).
  useEffect(() => {
    try {
      if (!localStorage.getItem("attacked_welcome_seen")) {
        const t = setTimeout(() => setWelcomeOpen(true), 900);
        return () => clearTimeout(t);
      }
    } catch { /* private mode — skip overlay */ }
  }, []);
  function dismissWelcome() {
    setWelcomeOpen(false);
    try { localStorage.setItem("attacked_welcome_seen", "1"); } catch { /* noop */ }
  }

  // The hero sample card rotates through the latest classified incidents so it
  // always feels live — newest/most-severe first, advancing every few seconds.
  // Cycle through distinct companies (rotationPool is already deduped by entity).
  const rotation = (intel.rotationPool && intel.rotationPool.length)
    ? intel.rotationPool
    : [intel.heroIncident].filter(x => x && x.headline);
  const [rotIdx, setRotIdx] = useState(0);
  useEffect(() => {
    if (rotation.length <= 1) return;
    const t = setInterval(() => setRotIdx(i => i + 1), 5000);
    return () => clearInterval(t);
  }, [rotation.length]);
  const hero = rotation.length ? rotation[rotIdx % rotation.length] : intel.heroIncident;
  const sevColor = hero ? (SEVERITY_COLOR[hero.severity] || BRAND.gold) : BRAND.gold;

  return (
    <div className="landing-root" style={{
      minHeight: "100vh", background: BRAND.deep, color: BRAND.white,
      fontFamily: "Inter, sans-serif", WebkitFontSmoothing: "antialiased",
    }}>
      <FontLoader />

      {/* Accessibility layer — keyboard focus rings, reduced-motion support
          for the marquee, and skip-link styling. Scoped global <style> so it
          applies to every interactive element on the page without threading
          focus handlers through each one. */}
      <style>{`
        .landing-skip-link {
          position: absolute; left: 12px; top: -48px; z-index: 200;
          background: ${BRAND.gold}; color: ${BRAND.obsidian};
          padding: 10px 16px; border-radius:0;
          font-family: Inter, sans-serif; font-size: 12px; font-weight: 700;
          letter-spacing: 0.06em; text-transform: uppercase; text-decoration: none;
          transition: top 160ms ease;
        }
        .landing-skip-link:focus { top: 12px; outline: 2px solid #fff; }
        .landing-root a:focus-visible,
        .landing-root button:focus-visible {
          outline: 2px solid ${BRAND.gold};
          outline-offset: 2px;
          border-radius:0;
        }
        @keyframes attacked-tick-x { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .attacked-tick { animation: attacked-tick-x 46s linear infinite; }
        .attacked-tickwrap:hover .attacked-tick { animation-play-state: paused; }
        .attacked-tickwrap {
          -webkit-mask-image: linear-gradient(90deg, transparent, #000 4%, #000 96%, transparent);
          mask-image: linear-gradient(90deg, transparent, #000 4%, #000 96%, transparent);
        }
        @media (prefers-reduced-motion: reduce) {
          .attacked-marquee-track, .attacked-tick { animation: none !important; }
        }
        /* ── Responsive fixes (2026-10-07). Inline styles hold the desktop look,
           so the overrides below need !important, as in responsive.css. ── */
        /* Phones: the hero grid drops the 48px shell rail; the section's .r-pad
           already gives the 20px gutter every other section uses. */
        @media (max-width: 768px) {
          .landing-root .r-herogrid { width: 100% !important; }
        }
        /* Phones: the GUARD ticker label goes onto two lines with tighter
           padding so the scrolling strip keeps room. Same words; the line
           break stands in for the "·" separator. */
        @media (max-width: 480px) {
          .lp-ticklabel { padding: 0 12px !important; letter-spacing: 0.08em !important; white-space: normal !important; line-height: 1.3; }
          .lp-ticktext > span { display: block; white-space: nowrap; }
          .lp-tickdot { display: none; }
        }
        /* Touch: the inbox buttons get a 44px tap height. */
        @media (pointer: coarse) {
          .landing-root .lp-cta { min-height: 44px; }
        }
        /* Beyond headlines: when the three cards fall to 2 + 1, the third fills
           its row (3-up needs 3 x 280 + 2 x 18 = 876px). */
        .lp-caps-wrap { container-type: inline-size; }
        @container (max-width: 875px) { .lp-caps > :last-child { grid-column: 1 / -1; } }
        /* Phones: the blast-radius heading no longer outsizes the hero h1. */
        @media (max-width: 600px) {
          .lp-blast-h2 { font-size: clamp(24px, 7vw, 34px) !important; }
        }
        /* Welcome overlay on short screens (landscape phones): tighter spacing
           so the card fits; the overlay itself scrolls if it still does not. */
        @media (max-height: 460px) {
          .welcome-ov { padding: 12px !important; }
          .welcome-card { padding: 20px 28px 18px !important; }
          .welcome-logo { width: 32px !important; height: 32px !important; margin-bottom: 8px !important; }
          .welcome-h { margin-top: 8px !important; }
          .welcome-p { margin-top: 10px !important; }
          .welcome-ctas { margin-top: 16px !important; }
          .welcome-jl { margin-top: -1px !important; }
        }
        /* Welcome overlay on the narrowest phones (320px and below): slimmer
           side padding gives the copy room, so the card fits a 568px screen. */
        @media (max-width: 340px) {
          .welcome-ov { padding: 12px !important; }
          .welcome-card { padding-left: 20px !important; padding-right: 20px !important; }
        }
        /* Landscape phones (two-column hero on a screen under 500px tall): the
           text column starts at the top instead of centring against the taller
           globe + card column, so the headline is on the first screen. */
        @media (min-width: 769px) and (max-height: 500px) {
          .landing-root .lp-hero { padding-top: 40px !important; }
          .landing-root .r-herotext { align-self: start; }
        }
        /* Phones (portrait, and landscape touch screens under 500px tall): no
           text under 11px. The ticker label, live-sample and feed-card tags,
           inbox labels and the welcome eyebrow go from 10-10.5px to 11px. */
        @media (max-width: 600px), (pointer: coarse) and (max-height: 500px) {
          .landing-root .lp-ticklabel, .landing-root .lp-fs11 { font-size: 11px !important; }
        }
      `}</style>
      <a href="#main-content" className="landing-skip-link">Skip to content</a>

      {/* ───────────────────────── NAV ───────────────────────── */}
      <SiteNav />

      {/* ───────────────── LIVE STRIPE — scrolling GUARD ticker (directly below nav) ───────────────── */}
      <div style={{
        borderBottom: `1px solid ${BRAND.border}`, background: BRAND.deep,
        display: "flex", alignItems: "center", overflow: "hidden",
      }}>
        <div className="lp-ticklabel" style={{
          flex: "none", display: "flex", alignItems: "center", gap: 9,
          padding: "0 22px", height: 52, borderRight: `1px solid ${BRAND.border}`,
          fontSize: 10.5, fontWeight: 700, letterSpacing: "0.13em", textTransform: "uppercase",
          color: BRAND.gold, background: BRAND.deep, zIndex: 2, whiteSpace: "nowrap",
        }}>
          <span style={{ flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: BRAND.gold, boxShadow: "0 0 10px rgba(252,189,0,0.7)" }} />
          <span className="lp-ticktext"><span>13 GUARD Categories</span>{" "}<span><span className="lp-tickdot">· </span>Live</span></span>
        </div>
        <div className="attacked-tickwrap" style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <div className="attacked-tick" style={{ display: "flex", gap: 30, whiteSpace: "nowrap", width: "max-content", paddingLeft: 30 }}>
            {[...CATS, ...CATS].map((c, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 9, height: 52, fontSize: 12, color: BRAND.t2, letterSpacing: "0.03em" }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: c[2] ? BRAND.gold : "#3a3a3a" }} />
                <span style={{ color: BRAND.gold, fontWeight: 700 }}>{c[0]}</span>
                {c[1]}
                <span style={{ color: BRAND.tmuted, fontSize: 11 }}>{c[3]}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ───────────────────────── HERO ───────────────────────── */}
      <main id="main-content" tabIndex={-1} style={{ outline: "none" }}>
      <section aria-label="Introduction" className="r-pad r-pad-y lp-hero" style={{
        position: "relative",
        background: `radial-gradient(ellipse 80% 60% at 70% 20%, rgba(252,189,0,0.07), transparent 60%), ${BRAND.black}`,
        padding: "96px 36px 84px",
      }}>
        <div className="r-herogrid" style={{
          ...shell,
          maxWidth: LAYOUT.max,
          display: "grid", gridTemplateColumns: "1.15fr 0.85fr",
          gridTemplateAreas: '"text globe" "text card"',
          columnGap: 56, rowGap: 18,
          alignItems: "center",
        }}>
          {/* Left — editorial headline. Display type is deliberately oversized
              and tightly tracked (see TYPE.hero): sub-1 line-height with heavy
              negative letter-spacing is what makes this read as a masthead
              rather than a dashboard title. */}
          <div className="r-herotext" style={{ gridArea: "text" }}>
            <div style={eyebrowStyle}>◇ Global risk intelligence · live daily</div>
            <h1 className="r-h1" style={{
              ...TYPE.hero,
              margin: "24px 0 0",
              color: BRAND.white,
            }}>
              Every incident.<br />
              Every <span style={{ color: BRAND.gold }}>blast radius</span>.<br />
              Mapped.
            </h1>
            <p style={{
              ...TYPE.standfirst,
              margin: "30px 0 0", maxWidth: 600,
              color: "#D1D5D9",
            }}>
              Cyber, supply-chain, financial, geopolitical and physical incidents —
              classified through the GUARD framework, geolocated, with the blast
              radius traced to named companies. Updated every day.
            </p>
            <div style={{ display: "flex", gap: 12, marginTop: 34, flexWrap: "wrap" }}>
              <button style={goldBtn}
                onClick={enterMap}
                onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; }}>
                View the live map →
              </button>
              <button style={ghostBtn}
                onClick={() => { if (user) window.location.href = "/?subscriptions"; else { setAuthIntent(null); setAuthOpen(true); } }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = BRAND.gold; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = BRAND.border; }}>
                {user ? "Manage your briefing" : "Get the daily brief"}
              </button>
            </div>
            <div style={{ marginTop: 18, fontSize: 12, color: BRAND.tmuted }}>
              {user ? "You're signed in — jump back in anytime" : "Free · email-only · no password"}
            </div>
          </div>

          {/* Right (top) — live rotating globe. On phones it stays on the RIGHT
              of the text (per user request); its overlay labels are hidden via
              .globe-ovl so the small sphere reads cleanly. */}
          <div style={{ gridArea: "globe", width: "100%", maxWidth: 440, margin: "0 auto" }}>
            <Globe size={380} />
          </div>

          {/* Right (bottom on desktop / full-width on mobile) — slim sample card */}
          <div className="livesample-wrap" style={{ gridArea: "card", width: "100%", maxWidth: 440, margin: "0 auto" }}>
            {/* Fixed-size card: constant height on desktop so it never resizes as
                the sample rotates. Columns clip overflow; text is line-clamped.
                On mobile the two columns stack, so height falls back to auto.
                The columns (flex-basis 240 + 180, plus the 2px border) also stack
                whenever the card is narrower than 422px — tablets and landscape
                phones on the two-column hero — so the height is released there
                too (container query on the wrapper). Wherever the height is
                auto, both columns reserve their largest clamped size (headline
                3 lines + meta 2 lines; summary 5 lines), so the card keeps one
                height as the sample rotates and the page below never jumps. */}
            <style>{`
              .livesample-wrap { container-type: inline-size; }
              .livesample { height: 210px; }
              .livesample > div { overflow: hidden; }
              /* Keep the entity · country · industry line to 2 lines at every width. */
              .livesample-meta { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
              @container (max-width: 421.98px) {
                .livesample { height: auto; }
                .livesample-body { min-height: 98px; }
                .livesample-side { min-height: calc(53px + 7.75 * 11.5px); }
              }
              @supports not (container-type: inline-size) {
                @media (min-width: 769px) and (max-width: 1199px) {
                  .livesample { height: auto; }
                  .livesample-body { min-height: 98px; }
                  .livesample-side { min-height: calc(53px + 7.75 * 11.5px); }
                }
              }
              @media (max-width: 700px) {
                .livesample { height: auto; }
                .livesample-sum { font-size: 13px !important; }
                .livesample-body { min-height: 98px; }
                .livesample-side { min-height: calc(53px + 7.75 * 13px); }
              }
              /* Narrowest phones: slightly tighter tracking keeps "Live sample ·
                 date" on one line, so the header is 2 lines, not 3. */
              @media (max-width: 300px) {
                .livesample-tag { letter-spacing: 0.06em !important; }
              }
            `}</style>
            <div
              className="livesample"
              onClick={() => { window.location.href = hero?.id != null ? `/?hub&open=${hero.id}` : "/?hub"; }}
              title="Open this briefing"
              onMouseEnter={e => { e.currentTarget.style.borderColor = BRAND.gold; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = BRAND.border; }}
              style={{
                display: "flex", flexWrap: "wrap", cursor: "pointer",
                background: BRAND.obsidian, border: `1px solid ${BRAND.border}`,
                borderRadius: 0, overflow: "hidden",
                transition: "border-color 160ms ease",
              }}>
              <div style={{ flex: "1 1 240px", minWidth: 0, padding: "16px 18px" }}>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: 10, rowGap: 4, marginBottom: 10 }}>
                  <span className="livesample-tag lp-fs11" style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: BRAND.t2 }}>
                    <span style={{ flexShrink: 0, width: 6, height: 6, borderRadius: 0, background: BRAND.gold }} />
                    {/* The date stays in one piece: if the tag must wrap (11px
                        on a 280px phone) it breaks after the "·". */}
                    <span>Live sample · <span style={{ whiteSpace: "nowrap" }}>{fmtDay(intel.latestDay) || "today"}</span></span>
                  </span>
                  <span className="lp-fs11" style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: BRAND.gold, whiteSpace: "nowrap" }}>GUARD classified</span>
                </div>
                {hero ? (
                  <>
                    <div style={{ display: "inline-flex", gap: 8, marginBottom: 9 }}>
                      <span className="lp-fs11" style={{ padding: "3px 9px", borderRadius: 0, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", background: `${sevColor}1f`, color: sevColor, border: `1px solid ${sevColor}55` }}>{SEVERITY_LABEL[hero.severity] || "—"}</span>
                      <span className="lp-fs11" style={{ padding: "3px 9px", borderRadius: 0, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", background: "rgba(255,255,255,0.06)", color: BRAND.t2, border: `1px solid ${BRAND.border}` }}>{hero.primary_category || "OPS"}</span>
                    </div>
                    <div className="livesample-body">
                      <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.28, letterSpacing: "-0.01em", marginBottom: 8, color: BRAND.white, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{hero.headline}</div>
                      <div className="livesample-meta" style={{ fontSize: 11, color: BRAND.tmuted, fontWeight: 600, letterSpacing: "0.03em" }}>
                        {[hero.entity, hero.country, hero.industry || hero.sector].filter(Boolean).join("  ·  ")}
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ padding: "18px 0", color: BRAND.tmuted, fontSize: 13 }}>Loading latest intelligence…</div>
                )}
              </div>
              <div className="livesample-side" style={{ flex: "1 1 180px", padding: "16px 18px", borderLeft: `1px solid ${BRAND.border}`, background: "rgba(252,189,0,0.04)", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <div className="lp-fs11" style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: BRAND.gold, marginBottom: 8 }}>What happened</div>
                <div className="livesample-sum" style={{ fontSize: 11.5, lineHeight: 1.55, color: BRAND.t2, display: "-webkit-box", WebkitLineClamp: 5, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {hero?.summary || "Geolocated and GUARD-classified, with the blast radius traced to the named companies in scope."}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────────────── EXPLAINER VIDEO ───────────────────────── */}
      <section aria-label="How Attacked.ai works" className="r-pad" style={{
        background: `radial-gradient(ellipse 70% 60% at 50% 0%, rgba(252,189,0,0.05), transparent 60%), ${BRAND.obsidian}`,
        borderTop: `1px solid ${BRAND.border}`,
        padding: "76px 36px 84px",
      }}>
        <div style={{ maxWidth: 960, margin: "0 auto", textAlign: "center" }}>
          <div style={{ ...eyebrowStyle }}>◇ See how it works</div>
          <h2 style={{
            margin: "16px 0 0", fontWeight: 800,
            fontSize: "clamp(28px, 3.2vw, 42px)", lineHeight: 1.1,
            letterSpacing: "-0.02em", color: BRAND.white,
          }}>
            From raw incident to <span style={{ color: BRAND.gold, fontStyle: "italic" }}>blast radius</span>, in minutes
          </h2>
          <p style={{
            margin: "18px auto 0", maxWidth: 560,
            fontSize: 15.5, lineHeight: 1.6, color: BRAND.t2,
          }}>
            Watch how the GUARD framework classifies, geolocates and traces every
            incident to the named companies in scope.
          </p>

          {/* Blank placeholder — reserved space for the explainer video (TBD). */}
          <div style={{
            position: "relative", marginTop: 40,
            aspectRatio: "16 / 9", width: "100%",
            background: BRAND.deep,
            border: `1px solid ${BRAND.border}`,
            borderRadius: 0, overflow: "hidden",
            boxShadow: "0 24px 70px rgba(0,0,0,0.5)",
          }} />
        </div>
      </section>

      {/* ───────────────── LIVE FEED — FLOWING CARDS (LIGHT band) ───────────────── */}
      <section className="r-pad" style={{
        padding: "72px 36px 80px", background: BRAND.paper, color: BRAND.ink,
        borderTop: "1px solid #E7E7E9", borderBottom: "1px solid #E7E7E9",
      }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          {/* Section header */}
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            flexWrap: "wrap", gap: 12, marginBottom: 24,
          }}>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 9,
              fontSize: 11, fontWeight: 700, color: "#8A6D00",
              letterSpacing: "0.16em", textTransform: "uppercase",
            }}>
              <span style={{
                flexShrink: 0,
                width: 7, height: 7, borderRadius: 0, background: BRAND.gold,
                boxShadow: "0 0 10px rgba(252,189,0,0.5)",
              }} />
              {/* Text and date share one wrapping row, so on phones the date
                  drops under the text instead of forming its own column. */}
              <span style={{ display: "flex", flexWrap: "wrap", columnGap: 9 }}>
                Live from the latest incidents
                <span style={{ color: "#6A6A6A", whiteSpace: "nowrap" }}>· {fmtDay(intel.latestDay)}</span>
              </span>
            </div>
            {/* Padding widens the tap area to 44px; the negative margin cancels it in the layout. */}
            <a href="/?hub" style={{
              fontSize: 11.5, fontWeight: 700, color: "#52525B", textDecoration: "none",
              letterSpacing: "0.08em", textTransform: "uppercase",
              padding: "15px 0", margin: "-15px 0",
            }}>Browse the hub →</a>
          </div>

        </div>

        {/* Single rolling row — a continuous marquee of incident cards with
            category imagery. Cards are duplicated so the strip loops seamlessly;
            the row pauses on hover. Full-bleed (outside the maxWidth wrapper) so
            the cards roll edge to edge across the viewport. */}
        <style>{`
          @keyframes attacked-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
          .attacked-marquee-track { animation: attacked-marquee 48s linear infinite; }
          .attacked-marquee-track:hover, .attacked-marquee-track:active, .attacked-marquee-track:focus-within { animation-play-state: paused; }
          .attacked-marquee-mask {
            -webkit-mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
            mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
          }
        `}</style>
        <div className="attacked-marquee-mask" role="region"
          aria-label="Latest incidents, auto-scrolling"
          style={{ overflow: "hidden", padding: "4px 0 8px" }}>
          {intel.feedCards.length ? (
            <div className="attacked-marquee-track" style={{ display: "flex", gap: 16, width: "max-content" }}>
              {[...intel.feedCards, ...intel.feedCards].map((c, i) => (
                <article key={`${c.id}-${i}`}
                  onClick={() => { if (user) window.location.href = `/?map&incident=${c.id}${c.incident_day ? `&date=${c.incident_day}` : ""}`; else setAuthOpen(true); }}
                  style={{
                    flex: "0 0 auto", width: "min(320px, 84vw)",
                    background: "#FFFFFF", border: `1px solid ${BRAND.lineDark}`,
                    borderRadius: 0, overflow: "hidden", cursor: "pointer",
                    display: "flex", flexDirection: "column",
                  }}>
                  {/* Banner image with severity + category chips overlaid */}
                  <div style={{ position: "relative" }}>
                    <CardImage article={c} height={120} />
                    <div style={{
                      position: "absolute", left: 12, bottom: 10,
                      display: "flex", gap: 6, alignItems: "center",
                    }}>
                      <span className="lp-fs11" style={{
                        padding: "2px 8px", borderRadius: 0,
                        fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                        background: `${SEVERITY_COLOR[c.severity] || BRAND.gold}26`,
                        color: SEVERITY_COLOR[c.severity] || BRAND.gold,
                        border: `1px solid ${SEVERITY_COLOR[c.severity] || BRAND.gold}66`,
                        backdropFilter: "blur(4px)",
                      }}>{SEVERITY_LABEL[c.severity] || "—"}</span>
                      <span className="lp-fs11" style={{
                        padding: "2px 7px", borderRadius: 0,
                        fontSize: 10, fontWeight: 700, color: BRAND.white,
                        letterSpacing: "0.08em", textTransform: "uppercase",
                        background: "rgba(8,8,8,0.5)", border: `1px solid ${BRAND.border}`,
                        backdropFilter: "blur(4px)",
                      }}>{c.primary_category || "OPS"}</span>
                    </div>
                  </div>
                  {/* Body */}
                  <div style={{ padding: "14px 16px 16px", display: "flex", flexDirection: "column", flex: 1 }}>
                    <h3 style={{
                      margin: 0, fontSize: 15, fontWeight: 700, lineHeight: 1.32,
                      letterSpacing: "-0.01em",
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                    }}>{c.headline}</h3>
                    <div className="lp-fs11" style={{
                      marginTop: 8, fontSize: 10.5, color: "#6A6A6A", fontWeight: 600,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {[c.entity, c.country, c.industry || c.sector].filter(Boolean).join("  ·  ")}
                    </div>
                    <div className="lp-fs11" style={{
                      marginTop: "auto", paddingTop: 12,
                      fontSize: 10, fontWeight: 700, color: "#8A6D00",
                      letterSpacing: "0.08em", textTransform: "uppercase",
                    }}>Open on the map →</div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", gap: 16, padding: "0 36px" }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} style={{
                  flex: "0 0 auto", width: "min(320px, 84vw)", height: 240,
                  background: BRAND.paper2, border: `1px solid ${BRAND.lineDark}`, borderRadius: 0,
                }} />
              ))}
            </div>
          )}
        </div>

        {/* Open map CTA */}
        <div style={{ marginTop: 28, textAlign: "center" }}>
          <button onClick={enterMap} style={{ ...goldBtn, padding: "13px 28px" }}>
            Open the live map →
          </button>
        </div>
      </section>

      {/* ───────── BEYOND HEADLINES — 01/02/03 (DARK band — editorial mix) ───────── */}
      <section id="intelligence" className="r-pad" style={{
        padding: "84px 36px 80px", background: BRAND.black, color: BRAND.text,
        borderTop: "1px solid rgba(255,255,255,0.08)", borderBottom: "1px solid rgba(255,255,255,0.08)",
      }}>
        <div className="lp-caps-wrap" style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div style={{ fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700, color: BRAND.gold, letterSpacing: "0.18em", textTransform: "uppercase", textAlign: "center", marginBottom: 14 }}>Beyond headlines</div>
          <h2 style={{
            fontFamily: "Inter, sans-serif", margin: 0, textAlign: "center", fontWeight: 800,
            fontSize: "clamp(28px, 3.2vw, 42px)", letterSpacing: "-0.02em", color: "#FFFFFF",
          }}>
            Not just news. <span style={{ color: BRAND.gold, fontStyle: "italic", fontFamily: "Inter, sans-serif" }}>Operational intelligence.</span>
          </h2>
          <p style={{
            margin: "16px auto 0", maxWidth: 560, textAlign: "center",
            fontSize: 15, lineHeight: 1.6, color: "#A8A8A8",
          }}>
            Headlines tell you what happened. We tell you who is exposed,
            how it spreads, and what to do about it.
          </p>

          <div className="lp-caps" style={{
            marginTop: 48, display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))", gap: 18,
          }}>
            {[
              {
                n: "01", t: "GUARD Classification",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <rect x="2" y="2" width="6.5" height="6.5" rx="1" stroke="#8A6D00" strokeWidth="1.4" />
                    <rect x="11.5" y="2" width="6.5" height="6.5" rx="1" stroke="#8A6D00" strokeWidth="1.4" />
                    <rect x="2" y="11.5" width="6.5" height="6.5" rx="1" stroke="#8A6D00" strokeWidth="1.4" />
                    <rect x="11.5" y="11.5" width="6.5" height="6.5" rx="1" fill="#8A6D00" />
                  </svg>
                ),
                d: "Every incident scored across thirteen GUARD risk categories — cyber, data, operations, financial, regulatory, geopolitical and more — with severity and confidence.",
              },
              {
                n: "02", t: "Named Blast Radius",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <circle cx="10" cy="10" r="8" stroke="#8A6D00" strokeWidth="1.3" />
                    <circle cx="10" cy="10" r="4.5" stroke="#8A6D00" strokeWidth="1.3" />
                    <circle cx="10" cy="10" r="1.6" fill="#8A6D00" />
                  </svg>
                ),
                d: "Not \"a vendor was affected\" — the actual companies in the blast radius, traced from supplier to customer, with the exposure channel named.",
              },
              {
                n: "03", t: "Adaptive Controls",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M3 6h14M3 14h14" stroke="#8A6D00" strokeWidth="1.4" strokeLinecap="round" />
                    <circle cx="7" cy="6" r="2.4" fill="#FFFFFF" stroke="#8A6D00" strokeWidth="1.4" />
                    <circle cx="13" cy="14" r="2.4" fill="#FFFFFF" stroke="#8A6D00" strokeWidth="1.4" />
                  </svg>
                ),
                d: "Every incident maps to GUARD controls and vendor Defence Ratings — so the next move is an action, not a meeting.",
              },
            ].map(c => (
              <div key={c.n} style={{
                position: "relative", overflow: "hidden",
                background: BRAND.black2, border: `1px solid ${BRAND.line}`,
                borderRadius: 0, padding: "30px 26px 26px",
                transition: "border-color 200ms ease, transform 200ms ease, box-shadow 200ms ease",
              }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = BRAND.gold; e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.boxShadow = "0 10px 30px rgba(0,0,0,0.45)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.10)"; e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "none"; }}
              >
                <div style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 42, height: 42, borderRadius: 0, marginBottom: 18,
                  background: "#FFF7DE", border: "1px solid rgba(252,189,0,0.5)",
                }}>{c.icon}</div>
                <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 10, color: "#FFFFFF" }}>
                  {c.t}
                </div>
                <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "#A8A8A8" }}>
                  {c.d}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───────────────── INTELLIGENCE INBOX (LIGHT band — editorial mix) ───────────────── */}
      <section className="r-pad" style={{
        padding: "72px 36px", background: BRAND.paper, color: BRAND.ink,
        borderTop: `1px solid ${BRAND.border}`, borderBottom: `1px solid ${BRAND.border}`,
      }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div style={{ ...sectionLabel, color: "#8A6D00" }}>The intelligence inbox</div>
          <h2 style={{
            fontFamily: "Inter, sans-serif", margin: 0, textAlign: "center", fontWeight: 800,
            fontSize: "clamp(26px, 3vw, 38px)", letterSpacing: "-0.02em", color: "#101010",
          }}>
            Your briefing, <span style={{ color: BRAND.gold, fontStyle: "italic", fontFamily: "Inter, sans-serif" }}>calibrated to you.</span>
          </h2>
          <div style={{
            marginTop: 44, display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))",
            gap: 18, maxWidth: 880, marginLeft: "auto", marginRight: "auto",
          }}>
            {/* Daily Brief — free */}
            <div style={{
              background: "#FFFFFF", border: `1px solid ${BRAND.lineDark}`,
              borderRadius: 0, padding: "26px 26px 24px",
            }}>
              <div className="lp-fs11" style={{
                fontSize: 10.5, fontWeight: 700, color: "#6A6A6A",
                letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8,
              }}>Free · daily</div>
              <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.01em", color: "#101010" }}>The Daily Brief</div>
              <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.6, color: "#52525B" }}>
                Every incident we catch — headline, severity, category and country.
                The full day's breadth at a glance, in your inbox.
              </div>
              <button className="lp-cta" onClick={() => { if (user) window.location.href = "/?dashboard"; else { setAuthIntent(null); setAuthOpen(true); } }} style={{
                marginTop: 18, padding: "10px 18px",
                background: "transparent", color: "#8A6D00",
                border: `1px solid ${BRAND.gold}`, borderRadius: 0, cursor: "pointer",
                fontFamily: "Inter, sans-serif", fontSize: 11.5, fontWeight: 700,
                letterSpacing: "0.08em", textTransform: "uppercase",
              }}>{/* No-break space: the arrow wraps with its word, never alone. */}
                {user ? "Open your dashboard →" : "Get the free daily brief →"}</button>
            </div>
            {/* Subscriber Brief — featured (gold-tint) */}
            <div style={{
              background: "#FFFDF5", border: `1px solid ${BRAND.gold}`,
              borderRadius: 0, padding: "26px 26px 24px",
              position: "relative", boxShadow: "0 16px 40px rgba(252,189,0,0.14)",
            }}>
              <div className="lp-fs11" style={{
                fontSize: 10.5, fontWeight: 700, color: "#8A6D00",
                letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8,
              }}>Subscriber · daily</div>
              <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.01em", color: "#101010" }}>The Subscriber Brief</div>
              <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.6, color: "#52525B" }}>
                Full operational detail — named blast radius, adaptive GUARD controls, peer watchlist, historical analogues and vendor Defence Ratings.
              </div>
              <button className="lp-cta" onClick={startSubscribe} style={{
                marginTop: 18, padding: "10px 18px",
                background: BRAND.gold, color: BRAND.obsidian,
                border: "none", borderRadius: 0, cursor: "pointer",
                fontFamily: "Inter, sans-serif", fontSize: 11.5, fontWeight: 700,
                letterSpacing: "0.08em", textTransform: "uppercase",
              }}>Subscribe →</button>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing strip removed from the landing — pricing lives on the dedicated Pricing page (?pricing). */}

      {/* ───────── THE BLAST RADIUS — cinematic network (deep black, editorial) ───────── */}
      <section className="r-pad" style={{
        position: "relative", overflow: "hidden", padding: "100px 36px 92px",
        background: "#080808",
        borderTop: `1px solid ${BRAND.border}`, borderBottom: `1px solid ${BRAND.border}`,
      }}>
        <div style={{ maxWidth: 760, margin: "0 auto", textAlign: "center", position: "relative", zIndex: 2 }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: "0.24em", textTransform: "uppercase", color: BRAND.gold, marginBottom: 22 }}>
            The blast radius
          </div>
          <h2 className="lp-blast-h2" style={{
            margin: 0, fontFamily: "Inter, system-ui, sans-serif", fontWeight: 800,
            fontSize: "clamp(40px, 5.6vw, 70px)", lineHeight: 1.03, letterSpacing: "-0.005em", color: "#fff",
          }}>
            Every incident has a<br /><span style={{ fontStyle: "italic", color: BRAND.gold }}>blast radius.</span>
          </h2>
          <p style={{ margin: "22px auto 0", maxWidth: 520, fontSize: 16, lineHeight: 1.65, color: BRAND.t2 }}>
            One breach, filing or strike ripples to every supplier, customer and peer downstream. We trace exactly who is exposed — and hand you the next move.
          </p>
          <p style={{ margin: "20px auto 0", fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, letterSpacing: "0.16em", color: "#6f6f6f" }}>
            23 COMPANIES EXPOSED · 6 EXPOSURE CHANNELS · 1 LIVE MAP
          </p>
        </div>
        <div style={{ maxWidth: 1120, margin: "20px auto 0", position: "relative", zIndex: 1 }}>
          <BlastRadiusViz />
        </div>
      </section>

      {/* ───────────────── FINAL CTA + FOOTER ───────────────── */}
      <section className="r-pad" style={{
        padding: "84px 36px",
        background: `radial-gradient(ellipse 70% 80% at 50% 100%, rgba(252,189,0,0.06), transparent 65%), ${BRAND.deep}`,
        borderTop: `1px solid ${BRAND.border}`, textAlign: "center",
      }}>
        <h2 style={{
          margin: 0, fontWeight: 800,
          fontSize: "clamp(28px, 3.4vw, 46px)", letterSpacing: "-0.02em",
        }}>
          See the latest incidents.
        </h2>
        <p style={{ margin: "14px auto 0", maxWidth: 460, fontSize: 15, color: BRAND.t2, lineHeight: 1.6 }}>
          {user
            ? `${intel.totalIncidents != null ? intel.totalIncidents.toLocaleString("en-IN") + " incidents classified and counting. " : ""}Open the live map to explore the latest incidents.`
            : (intel.totalIncidents != null
                ? `${intel.totalIncidents.toLocaleString("en-IN")} incidents classified and counting. Sign up free — thirty seconds, no password.`
                : "Sign up free — thirty seconds, no password.")}
        </p>
        <button onClick={() => { if (user) enterMap(); else setAuthOpen(true); }} style={{ ...goldBtn, marginTop: 28 }}>
          {user ? "Open the live map →" : "Sign up free →"}
        </button>
      </section>
      </main>

      <SiteFooter />

      {/* ───────────────── WELCOME OVERLAY ───────────────── */}
      {/* Shown to signed-out visitors only — its copy is a sign-up prompt.
          The overlay scrolls and the card centres with auto margins, so a card
          taller than a landscape phone is never clipped top and bottom. */}
      {welcomeOpen && !user && (
        <div
          className="welcome-ov"
          onClick={dismissWelcome}
          style={{
            position: "fixed", inset: 0, zIndex: 200,
            background: "rgba(8,8,8,0.78)", backdropFilter: "blur(6px)",
            display: "flex", justifyContent: "center",
            overflowY: "auto", overscrollBehavior: "contain",
            padding: 24,
          }}>
          <div
            className="welcome-card"
            onClick={e => e.stopPropagation()}
            style={{
              width: "100%", maxWidth: 480, margin: "auto",
              background: BRAND.obsidian, border: `1px solid ${BRAND.borderGold}`,
              borderRadius: 0, padding: "34px 34px 30px",
              boxShadow: "0 40px 100px rgba(0,0,0,0.6)",
              textAlign: "center", position: "relative",
            }}>
            {/* 44x44 tap area; the × stays where it was. */}
            <button onClick={dismissWelcome} aria-label="Close" style={{
              position: "absolute", top: 8, right: 4, width: 44, height: 44,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", color: BRAND.tmuted,
              fontSize: 20, cursor: "pointer", padding: 0,
            }}>×</button>
            <img className="welcome-logo" src="/attacked-ai-logo.svg" alt="Attacked.ai" width={52} height={52}
              style={{ display: "block", margin: "0 auto 14px" }} />
            <div className="lp-fs11" style={{ ...eyebrowStyle, fontSize: 10.5 }}>Welcome to Attacked.ai</div>
            <h3 className="welcome-h" style={{
              margin: "12px 0 0", fontSize: 26, fontWeight: 800,
              letterSpacing: "-0.015em", lineHeight: 1.2,
            }}>
              The world's corporate harm,<br />on one map.
            </h3>
            <p className="welcome-p" style={{ margin: "14px 0 0", fontSize: 13.5, lineHeight: 1.6, color: BRAND.t2 }}>
              {intel.totalIncidents != null && intel.latestDay
                ? `${intel.totalIncidents.toLocaleString("en-IN")} incidents classified to date — the latest incidents landed ${fmtDay(intel.latestDay)}. Sign up free to open the map and start your daily brief.`
                : "Incidents classified daily through the GUARD framework. Sign up free to open the map and start your daily brief."}
            </p>
            <div className="welcome-ctas" style={{ display: "flex", gap: 10, marginTop: 24, justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => { dismissWelcome(); setAuthIntent(null); setAuthOpen(true); }}
                style={{ ...goldBtn, padding: "12px 24px" }}>
                Sign up free →
              </button>
              <button
                onClick={() => { dismissWelcome(); startSubscribe(); }}
                style={{ ...ghostBtn, padding: "12px 24px" }}>
                Subscribe
              </button>
            </div>
            {/* Padding gives a ~39px tap area; the margins cancel it, so the text
                and the card height stay where they were. */}
            <button className="welcome-jl" onClick={dismissWelcome} style={{
              marginTop: 5, marginBottom: -11, padding: "12px 10px",
              background: "none", border: "none",
              color: BRAND.tmuted, fontSize: 12, cursor: "pointer",
              textDecoration: "underline",
            }}>
              Just looking — take me to the page
            </button>
          </div>
        </div>
      )}

      <AuthModal open={authOpen} intent={authIntent} onClose={() => setAuthOpen(false)} />
      <SubscribeModal open={subscribeOpen} onClose={() => setSubscribeOpen(false)} onSignIn={() => { setSubscribeOpen(false); setAuthIntent("subscribe"); setAuthOpen(true); }} />
    </div>
  );
}
