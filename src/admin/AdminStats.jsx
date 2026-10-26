// ─────────────────────────────────────────────────────────────────────────
// AdminStats — Phase 3 of /admin.
//
// At-a-glance metrics in one screen. Single RPC call returns aggregated
// counts so the page paints fast and doesn't slam the DB.
//
// Sections:
//   • TODAY — fresh signups, last digest, latest sweep
//   • USERS — total + by tier breakdown + email-subscribed count
//   • APPLICATIONS — partner/vendor queue health
//   • CONTENT — incidents (total/7d/tagged) + sweeps
//   • EMAIL — last digest timestamp + de-dup log count
//   • FEEDBACK — partner feedback submission count
// ─────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const BRAND = {
  gold: "#FCBD00",
  obsidian: "#1A1A1A",
  obsidianDeep: "#080808",
  obsidianCard: "#242424",
  white: "#FFFFFF",
  textSecondary: "#A8A8A8",
  textMuted: "#585858",
  borderSubtle: "#333333",
  borderGold: "rgba(252,189,0,0.3)",
  green: "#34C759",
  red: "#FF6B6B",
  cyan: "#4FC3D7",
  violet: "#9D7BEC",
  orange: "#FF8C5A",
};

const TIER_COLOR = {
  free: BRAND.cyan,
  enterprise: BRAND.gold,
  vendor: BRAND.green,
  admin: BRAND.violet,
};
const TIER_LABEL = {
  free: "Free",
  enterprise: "Subscriber",
  vendor: "Vendor",
  admin: "Admin",
};

const SEV_COLOR = { "5": "#FF3B30", "4": BRAND.orange, "3": BRAND.gold, "2": BRAND.green, "1": "#8E8E93" };
const SEV_LABEL = { "5": "Critical", "4": "High", "3": "Medium", "2": "Low", "1": "Minimal" };

function fmtNum(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-IN");
}
function fmtRel(iso) {
  if (!iso) return "never";
  const diff = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)        return "just now";
  if (diff < 3600)      return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)     return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

export function AdminStats() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc("admin_dashboard_stats");
      if (error) throw error;
      setStats(data);
    } catch (e) {
      setError(e?.message || "Failed to load stats.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: BRAND.textMuted }}>Loading stats…</div>;
  }
  if (error) {
    return (
      <div style={{
        padding: 14, borderRadius: 4,
        background: "rgba(255,107,107,0.08)", border: `1px solid ${BRAND.red}55`,
        color: BRAND.red, fontSize: 13,
      }}>{error}</div>
    );
  }
  if (!stats) return null;

  const u = stats.users || {};
  const a = stats.applications || {};
  const inc = stats.incidents || {};
  const sw = stats.sweeps || {};
  const em = stats.email || {};
  const fb = stats.feedback || {};
  const byTier = u.by_tier || {};
  const bySev = inc.by_severity || {};

  return (
    <div>
      {/* Header */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
        marginBottom: 18, flexWrap: "wrap", gap: 12,
      }}>
        <h1 style={{
          fontFamily: "Inter, sans-serif", fontWeight: 800, fontSize: 28,
          letterSpacing: "-0.015em", color: BRAND.white, margin: 0,
        }}>
          Stats
          <span style={{
            marginLeft: 12, fontSize: 12, fontWeight: 500,
            color: BRAND.textMuted, letterSpacing: "0.04em",
            // One unit that moves under the title when it does not fit (an
            // inline-block gives the line a break point after "Stats").
            display: "inline-block", whiteSpace: "nowrap",
          }}>
            as of {fmtDate(stats.computed_at)}
          </span>
        </h1>
        <button onClick={load} style={{
          padding: "7px 14px", background: "transparent", color: BRAND.textSecondary,
          border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 4,
          fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
          letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer",
          whiteSpace: "nowrap",
        }}>↻ Refresh</button>
      </div>

      {/* ── HERO ROW — Today + new + active ───────────────────────────── */}
      <SectionTitle>Today's Pulse</SectionTitle>
      <div className="adm-tiles4" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 28 }}>
        <Tile big label="New signups today" value={fmtNum(u.new_today)} color={BRAND.gold} hint={`+${u.new_7d || 0} in last 7d`} />
        <Tile big label="Active users (7d)" value={fmtNum(u.active_7d)} color={BRAND.green} hint={`of ${u.total} total`} />
        <Tile big label="Last digest" value={fmtRel(em.last_digest_sent_at)} color={BRAND.cyan} hint={em.last_digest_date ? `for ${em.last_digest_date}` : "no digest yet"} />
        <Tile big label="Last sweep" value={fmtRel(sw.last_upload)} color={BRAND.violet} hint={`${sw.last_7d || 0} in last 7d`} />
      </div>

      {/* ── USERS ──────────────────────────────────────────────────────── */}
      <SectionTitle>Users — {fmtNum(u.total)} total</SectionTitle>
      <div className="adm-tiles4" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 14 }}>
        {Object.entries(TIER_LABEL).map(([tierKey, label]) => (
          <Tile key={tierKey} label={label} value={fmtNum(byTier[tierKey] || 0)} color={TIER_COLOR[tierKey]} />
        ))}
      </div>
      <div className="adm-tiles3" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 28 }}>
        <Tile label="Email subscribed" value={fmtNum(u.subscribed)} color={BRAND.gold} hint={`${Math.round(((u.subscribed || 0) / Math.max(u.total, 1)) * 100)}% of users`} />
        <Tile label="New in 30 days" value={fmtNum(u.new_30d)} color={BRAND.green} />
        <Tile label="Active in 7 days" value={fmtNum(u.active_7d)} color={BRAND.cyan} />
      </div>

      {/* ── APPLICATIONS ───────────────────────────────────────────────── */}
      <SectionTitle>Applications</SectionTitle>
      <div className="r-grid" style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14, marginBottom: 28 }}>
        <Card title="Vendor" color={BRAND.green}>
          <Row k="Pending" v={fmtNum(a.vendor_pending)} highlight={a.vendor_pending > 0} />
          <Row k="Approved" v={fmtNum(a.vendor_approved)} />
          <Row k="Rejected" v={fmtNum(a.vendor_rejected)} />
          <Row k="Total received" v={fmtNum(a.vendor_total)} muted />
        </Card>
      </div>

      {/* ── CONTENT (incidents + sweeps) ───────────────────────────────── */}
      <SectionTitle>Content</SectionTitle>
      <div className="adm-tiles6" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
        <Tile label="Total incidents" value={fmtNum(inc.total)} color={BRAND.gold} />
        <Tile label="Last 7 days" value={fmtNum(inc.last_7d)} color={BRAND.cyan} />
        <Tile label="Last 30 days" value={fmtNum(inc.last_30d)} color={BRAND.green} />
        <Tile label="Industry-tagged" value={fmtNum(inc.tagged_industry)} color={BRAND.gold} hint={`${Math.round(((inc.tagged_industry || 0) / Math.max(inc.total, 1)) * 100)}% of total`} />
        <Tile label="Untagged" value={fmtNum(inc.untagged)} color={inc.untagged > 0 ? BRAND.orange : BRAND.textMuted} hint="Govt / civil society" />
        <Tile label="Total sweeps" value={fmtNum(sw.total)} color={BRAND.violet} />
      </div>

      {/* Severity breakdown */}
      <Card title="Severity distribution" color={BRAND.textMuted}>
        <div className="adm-sev" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
          {["5","4","3","2","1"].map(sev => (
            <div key={sev} style={{ textAlign: "center" }}>
              <div style={{
                fontSize: 22, fontWeight: 700, color: BRAND.white,
                fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em",
              }}>{fmtNum(bySev[sev] || 0)}</div>
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                fontSize: 10, fontWeight: 600, letterSpacing: "0.08em",
                color: BRAND.textMuted, textTransform: "uppercase", marginTop: 5,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: 3, background: SEV_COLOR[sev], flexShrink: 0 }} />
                {SEV_LABEL[sev]}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── EMAIL HEALTH ───────────────────────────────────────────────── */}
      <SectionTitle style={{ marginTop: 28 }}>Email Health</SectionTitle>
      <Card title="Daily digest pipeline" color={BRAND.cyan}>
        <Row k="Last digest sent at" v={fmtDate(em.last_digest_sent_at)} />
        <Row k="Last digest sweep date" v={em.last_digest_date || "—"} />
        <Row k="Notify-log entries (de-dup)" v={fmtNum(em.notify_log_count)} muted />
        <Row k="Sweep last uploaded" v={fmtDate(sw.last_upload)} />
        <div style={{
          marginTop: 12, padding: "10px 12px",
          background: "rgba(255,255,255,0.03)", border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 6,
          fontSize: 11.5, color: BRAND.textSecondary, lineHeight: 1.55,
        }}>
          Event-driven: new sweep upload → automatic digest. De-dup log prevents repeat sends per sweep date.
        </div>
      </Card>

      {/* ── FEEDBACK ──────────────────────────────────────────────────── */}
      <SectionTitle style={{ marginTop: 28 }}>Feedback</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 8 }}>
        <Tile label="Feedback submissions" value={fmtNum(fb.total_submissions)} color={BRAND.gold} hint="Open Feedback tab for breakdown" />
      </div>
    </div>
  );
}

function SectionTitle({ children, style = {} }) {
  return (
    <div style={{
      fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700,
      color: BRAND.textMuted, letterSpacing: "0.14em", textTransform: "uppercase",
      marginBottom: 10, marginTop: 0,
      ...style,
    }}>
      {children}
    </div>
  );
}

// Monochrome metric tile — Stripe/Linear pattern. The number is always
// white; colour appears only as a 6px meaning dot beside the label (tier
// colour, severity colour). Rainbow borders and coloured numerals are the
// fastest way for a dashboard to read as template output — avoided.
function Tile({ label, value, color, hint, big }) {
  return (
    <div style={{
      padding: big ? "16px 18px 14px" : "14px 16px 12px",
      background: BRAND.obsidianCard,
      border: `1px solid ${BRAND.borderSubtle}`,
      borderRadius: 8,
    }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        fontFamily: "Inter, sans-serif", fontSize: 10.5, fontWeight: 600,
        color: BRAND.textMuted, letterSpacing: "0.12em", textTransform: "uppercase",
      }}>
        {color && <span style={{ width: 6, height: 6, borderRadius: 3, background: color, flexShrink: 0 }} />}
        {label}
      </div>
      <div style={{
        marginTop: 8, fontFamily: "Inter, sans-serif", fontWeight: 700,
        fontSize: big ? 28 : 24, color: BRAND.white, lineHeight: 1,
        letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums",
      }}>{value}</div>
      {hint && (
        <div style={{
          fontSize: 11, color: BRAND.textMuted, marginTop: 6, fontWeight: 500,
        }}>{hint}</div>
      )}
    </div>
  );
}

function Card({ title, color, children }) {
  return (
    <div style={{
      padding: "16px 18px",
      background: BRAND.obsidianCard,
      border: `1px solid ${BRAND.borderSubtle}`,
      borderRadius: 8,
    }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
        color: BRAND.textSecondary, letterSpacing: "0.10em", textTransform: "uppercase",
        marginBottom: 10,
      }}>
        {color && <span style={{ width: 6, height: 6, borderRadius: 3, background: color, flexShrink: 0 }} />}
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ k, v, highlight, muted }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12,
      padding: "6px 0",
      borderBottom: `1px solid rgba(255,255,255,0.04)`,
      fontSize: 12.5,
    }}>
      <span style={{ color: muted ? BRAND.textMuted : BRAND.textSecondary }}>{k}</span>
      <span style={{
        fontWeight: 700, textAlign: "right",
        color: highlight ? BRAND.gold : (muted ? BRAND.textMuted : BRAND.white),
      }}>{v}</span>
    </div>
  );
}
