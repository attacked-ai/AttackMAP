// ─────────────────────────────────────────────────────────────────────────
// AdminDashboard — the /admin surface (admin tier only).
//
// 4-tab layout — built one section at a time (Phase 1 = Inbox today):
//   📥 Inbox    — pending partner + vendor applications, approve/reject
//   👥 Users    — list signed-in users, change tier
//   📊 Stats    — signups, tier breakdown, email health
//   💬 Feedback — partner_feedback submissions, aggregations
//
// Routing: ?admin in URL → loaded from main.jsx. Tier gate enforced there.
// ─────────────────────────────────────────────────────────────────────────
import React, { useState } from "react";
import { AdminInbox } from "./AdminInbox";
import { AdminUsers } from "./AdminUsers";
import { AdminStats } from "./AdminStats";
import { AdminFeedback } from "./AdminFeedback";
import { AdminBriefings } from "./AdminBriefings";
import { AdminReports } from "./AdminReports";
import { Logo } from "../auth/Logo";
import "./admin-responsive.css";

const BRAND = {
  gold: "#FCBD00",
  obsidianDeep: "#080808",
  obsidian: "#1A1A1A",
  obsidianCard: "#242424",
  white: "#FFFFFF",
  textSecondary: "#A8A8A8",
  textMuted: "#585858",
  borderSubtle: "#333333",
  borderGold: "rgba(252,189,0,0.3)",
};

// Clean stroke icons (Lucide-style, 1.5px stroke, currentColor) — emoji-free
// chrome reads as deliberate product design rather than a default template.
function TabIcon({ name, size = 15 }) {
  const common = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
    style: { display: "block", flexShrink: 0 },
  };
  switch (name) {
    case "inbox": return (
      <svg {...common}>
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    );
    case "users": return (
      <svg {...common}>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    );
    case "stats": return (
      <svg {...common}>
        <path d="M3 3v18h18" />
        <path d="M18 17V9" />
        <path d="M13 17V5" />
        <path d="M8 17v-3" />
      </svg>
    );
    case "feedback": return (
      <svg {...common}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    );
    case "briefings": return (
      <svg {...common}>
        <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
        <path d="M18 14h-8M15 18h-5M10 6h8v4h-8z" />
      </svg>
    );
    case "reports": return (
      <svg {...common}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="13" y2="17" />
      </svg>
    );
    default: return null;
  }
}

const TABS = [
  { id: "reports",   label: "Reports",   icon: "reports",   body: AdminReports },
  { id: "inbox",     label: "Inbox",     icon: "inbox",     body: AdminInbox },
  { id: "briefings", label: "Briefings", icon: "briefings", body: AdminBriefings },
  { id: "users",     label: "Users",     icon: "users",     body: AdminUsers },
  { id: "stats",     label: "Stats",     icon: "stats",     body: AdminStats },
  { id: "feedback",  label: "Feedback",  icon: "feedback",  body: AdminFeedback },
];

function FontLoader() {
  React.useEffect(() => {
    if (document.getElementById("attacked-fonts")) return;
    const link = document.createElement("link");
    link.id = "attacked-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";
    document.head.appendChild(link);
  }, []);
  return null;
}

export function AdminDashboard() {
  const [active, setActive] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("tab") || "reports"; } catch { return "reports"; }
  });
  const ActiveBody = TABS.find(t => t.id === active)?.body;
  return (
    <div style={{
      minHeight: "100vh",
      background: BRAND.obsidianDeep,
      color: BRAND.white,
      fontFamily: "Inter, sans-serif",
      WebkitFontSmoothing: "antialiased",
    }}>
      <FontLoader />

      {/* HEADER */}
      <header className="r-pad adm-head" style={{
        padding: "16px 32px",
        borderBottom: `1px solid ${BRAND.borderSubtle}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        background: BRAND.obsidian,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Logo size="sm" />
          {/* Divider + quiet console label — no emoji, no novelty color.
              A single gold status dot carries the "live ops surface" cue. */}
          <span className="adm-head-label" style={{ width: 1, height: 22, background: BRAND.borderSubtle }} />
          <span className="adm-head-label" style={{
            display: "inline-flex", alignItems: "center", gap: 7,
            fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
            color: BRAND.textSecondary, letterSpacing: "0.16em", textTransform: "uppercase",
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: 3, background: BRAND.gold,
              boxShadow: "0 0 8px rgba(252,189,0,0.55)",
            }} />
            Admin Console
          </span>
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <a href="/?map" className="adm-head-back" style={{
            fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
            color: BRAND.textSecondary, letterSpacing: "0.10em",
            textTransform: "uppercase", textDecoration: "none",
            padding: "6px 12px",
            border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 4,
          }}>
            ← Back to map
          </a>
        </div>
      </header>

      {/* TAB BAR */}
      <nav className="r-pad r-scrollx adm-tabs" style={{
        display: "flex", gap: 4,
        padding: "0 32px",
        borderBottom: `1px solid ${BRAND.borderSubtle}`,
        background: BRAND.obsidian,
      }}>
        {TABS.map(t => {
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = BRAND.white; }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = BRAND.textSecondary; }}
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "14px 16px",
                background: "transparent",
                color: isActive ? BRAND.gold : BRAND.textSecondary,
                border: "none",
                borderBottom: `2px solid ${isActive ? BRAND.gold : "transparent"}`,
                marginBottom: -1,
                fontFamily: "Inter, sans-serif", fontSize: 13, fontWeight: 600,
                letterSpacing: "0.02em",
                cursor: "pointer",
                transition: "color 160ms ease, border-color 160ms ease",
              }}
            >
              <TabIcon name={t.icon} />
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* BODY */}
      <main className="r-pad" style={{ padding: "28px 32px", maxWidth: 1200, margin: "0 auto" }}>
        {ActiveBody ? <ActiveBody /> : (
          <div style={{
            padding: 60, textAlign: "center", color: BRAND.textMuted,
            fontSize: 14,
          }}>
            This section is being built next.
          </div>
        )}
      </main>
    </div>
  );
}
