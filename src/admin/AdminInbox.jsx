// ─────────────────────────────────────────────────────────────────────────
// AdminInbox — Phase 1 of /admin.
//
// Single queue: vendor_applications (partner applications retired 2026-09-21)
// + sorted by submitted_at (newest first). Each card:
//   • Type badge (🤝 PARTNER · ◈ VENDOR)
//   • Name + company + role + time-ago
//   • Expand → why_interested / capability_summary
//   • Actions: [Approve]  [Reject — opens note dialog]
//
// Approve/reject call the admin_* RPCs from migration. The existing
// DB triggers handle tier flip + notify-application email automatically.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "../lib/supabaseClient";

const BRAND = {
  gold: "#FCBD00",
  obsidianDeep: "#080808",
  obsidian: "#1A1A1A",
  obsidianCard: "#242424",
  obsidianElevated: "#2E2E2E",
  white: "#FFFFFF",
  textSecondary: "#A8A8A8",
  textMuted: "#585858",
  borderSubtle: "#333333",
  borderGold: "rgba(252,189,0,0.3)",
  green: "#34C759",
  red: "#FF6B6B",
  vendorGreen: "#34C759",
};

function timeAgo(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (diff < 60)        return `${Math.floor(diff)}s ago`;
  if (diff < 3600)      return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)     return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function AdminInbox() {
  const [partnerApps, setPartnerApps] = useState([]);
  const [vendorApps,  setVendorApps]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [expanded, setExpanded] = useState(null); // `${kind}:${id}`
  const [busy,    setBusy]    = useState(null);   // same key while RPC in flight
  const [toast,   setToast]   = useState(null);
  // Status filter — default 'pending' (the inbox's primary job) but flip
  // to approved/rejected/all to browse the archive once decided.
  const [statusFilter, setStatusFilter] = useState("pending");
  // Free-text search across email, name, company, role, sector. Filters
  // client-side over the already-fetched list — instant feedback, no
  // round-trip per keystroke.
  const [searchQuery, setSearchQuery] = useState("");

  // Fetch is unfiltered — we pull every application once and slice
  // client-side. Lets the stats strip count across all statuses without
  // a second round-trip, and the status/search filters stay snappy.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Design Partner applications are retired (2026-09-21): readers subscribe
      // themselves now, so the partner_applications table no longer feeds this
      // queue. Only vendor listings still need a human decision.
      const { data: v, error: ve } = await supabase.from("vendor_applications")
        .select("id,email,company_name,contact_name,contact_role,website,linkedin_url,categories,capability_summary,target_sectors,headquarters_country,status,submitted_at,decided_at,decided_by")
        .order("submitted_at", { ascending: false });
      if (ve) throw ve;
      setPartnerApps([]);
      setVendorApps(v || []);
    } catch (e) {
      setError(e?.message || "Failed to load applications.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Aggregated counts across both kinds — drives the stats strip.
  const counts = useMemo(() => {
    const all = [...partnerApps, ...vendorApps];
    return {
      pending:  all.filter(a => a.status === "pending").length,
      approved: all.filter(a => a.status === "approved").length,
      rejected: all.filter(a => a.status === "rejected").length,
      total:    all.length,
    };
  }, [partnerApps, vendorApps]);

  async function approvePartner(id) {
    const key = `partner:${id}`;
    setBusy(key);
    try {
      const { error } = await supabase.rpc("admin_approve_partner_application", { p_application_id: id, p_notes: null });
      if (error) throw error;
      setToast({ tone: "ok", text: `Partner application #${id} approved. Tier auto-flipped to PARTNER.` });
      await load();
    } catch (e) {
      setToast({ tone: "err", text: e?.message || "Approve failed." });
    } finally {
      setBusy(null);
    }
  }

  async function rejectPartner(id) {
    const notes = prompt("Optional rejection note (visible to applicant):", "");
    if (notes === null) return; // user cancelled
    const key = `partner:${id}`;
    setBusy(key);
    try {
      const { error } = await supabase.rpc("admin_reject_partner_application", { p_application_id: id, p_notes: notes || null });
      if (error) throw error;
      setToast({ tone: "ok", text: `Partner application #${id} rejected.` });
      await load();
    } catch (e) {
      setToast({ tone: "err", text: e?.message || "Reject failed." });
    } finally {
      setBusy(null);
    }
  }

  async function approveVendor(id, tier) {
    const key = `vendor:${id}`;
    setBusy(key);
    try {
      const { error } = await supabase.rpc("admin_approve_vendor_application", { p_application_id: id, p_listing_tier: tier, p_notes: null });
      if (error) throw error;
      setToast({ tone: "ok", text: `Vendor application #${id} approved as ${tier.toUpperCase()}.` });
      await load();
    } catch (e) {
      setToast({ tone: "err", text: e?.message || "Approve failed." });
    } finally {
      setBusy(null);
    }
  }

  async function rejectVendor(id) {
    const notes = prompt("Optional rejection note (internal):", "");
    if (notes === null) return;
    const key = `vendor:${id}`;
    setBusy(key);
    try {
      const { error } = await supabase.rpc("admin_reject_vendor_application", { p_application_id: id, p_notes: notes || null });
      if (error) throw error;
      setToast({ tone: "ok", text: `Vendor application #${id} rejected.` });
      await load();
    } catch (e) {
      setToast({ tone: "err", text: e?.message || "Reject failed." });
    } finally {
      setBusy(null);
    }
  }

  // Merge + filter (status + search) + sort newest first.
  const queue = useMemo(() => {
    const merged = [
      ...partnerApps.map(a => ({ kind: "partner", ...a })),
      ...vendorApps.map(a  => ({ kind: "vendor",  ...a })),
    ];
    const byStatus = statusFilter === "all"
      ? merged
      : merged.filter(a => a.status === statusFilter);
    const q = searchQuery.trim().toLowerCase();
    const bySearch = !q ? byStatus : byStatus.filter(a => {
      const haystack = [
        a.email, a.full_name, a.contact_name,
        a.company, a.company_name, a.role, a.contact_role,
        a.sector, a.headquarters_country,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
    return bySearch.sort(
      (a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)
    );
  }, [partnerApps, vendorApps, statusFilter, searchQuery]);

  return (
    <div>
      {/* Header strip */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
        marginBottom: 18, flexWrap: "wrap", gap: 12,
      }}>
        <h1 style={{
          fontFamily: "Inter, sans-serif", fontWeight: 800, fontSize: 28,
          letterSpacing: "-0.015em", color: BRAND.white, margin: 0,
        }}>
          Inbox
          <span style={{
            marginLeft: 12, fontSize: 14, fontWeight: 600,
            color: BRAND.gold, letterSpacing: "0.06em",
          }}>{queue.length} {statusFilter === "all" ? "total" : statusFilter}</span>
        </h1>
        <button onClick={load} style={{
          padding: "7px 14px", background: "transparent", color: BRAND.textSecondary,
          border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 4,
          fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
          letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer",
          whiteSpace: "nowrap",
        }}>
          ↻ Refresh
        </button>
      </div>

      {/* Stats strip — a five-second pulse on the inbox state. Three
          status counts + total received. Background colour follows the
          status colour so the eye lands on Pending first. */}
      <div className="adm-itiles" style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
        gap: 10, marginBottom: 16,
      }}>
        {[
          { label: "Pending",  value: counts.pending,  color: BRAND.gold  },
          { label: "Approved", value: counts.approved, color: BRAND.green },
          { label: "Rejected", value: counts.rejected, color: BRAND.red   },
          { label: "Total",    value: counts.total,    color: BRAND.textSecondary },
        ].map(s => (
          <div key={s.label} style={{
            padding: "16px 18px 14px",
            background: BRAND.obsidianCard,
            border: `1px solid ${BRAND.borderSubtle}`,
            borderRadius: 8,
          }}>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              fontFamily: "Inter, sans-serif",
              fontSize: 10.5, fontWeight: 600, color: BRAND.textMuted,
              letterSpacing: "0.12em", textTransform: "uppercase",
            }}>
              <span style={{ width: 6, height: 6, borderRadius: 3, background: s.color }} />
              {s.label}
            </div>
            <div style={{
              marginTop: 8,
              fontFamily: "Inter, sans-serif", fontSize: 28, fontWeight: 700,
              color: BRAND.white, letterSpacing: "-0.02em", lineHeight: 1,
              fontVariantNumeric: "tabular-nums",
            }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Search bar — client-side filter across email, name, company,
          role, sector. Empties out when input cleared. */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search by email, name, company, role, sector…"
          style={{
            width: "100%", padding: "10px 38px 10px 14px",
            background: BRAND.obsidianDeep, color: BRAND.white,
            border: `1px solid ${BRAND.borderSubtle}`, borderRadius: 4,
            fontFamily: "Inter, sans-serif", fontSize: 13,
            outline: "none", boxSizing: "border-box",
            transition: "border-color 160ms ease",
          }}
          onFocus={(e) => (e.target.style.borderColor = BRAND.gold)}
          onBlur={(e) => (e.target.style.borderColor = BRAND.borderSubtle)}
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            aria-label="Clear search"
            style={{
              position: "absolute", right: 8, top: "50%",
              transform: "translateY(-50%)",
              background: "none", border: "none", color: BRAND.textMuted,
              cursor: "pointer", fontSize: 18, padding: "4px 8px",
              lineHeight: 1,
            }}>×</button>
        )}
      </div>

      {/* Status filter chips — let admin browse decided applications too,
          not just pending. Default 'pending' preserves the original Inbox
          job; switching to 'approved'/'rejected'/'all' opens the archive. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {["pending", "approved", "rejected", "all"].map(s => {
          const active = statusFilter === s;
          return (
            <button key={s} onClick={() => setStatusFilter(s)} style={{
              padding: "6px 14px", borderRadius: 4,
              background: active ? "rgba(252,189,0,0.12)" : "transparent",
              color: active ? BRAND.gold : BRAND.textSecondary,
              border: `1px solid ${active ? BRAND.borderGold : BRAND.borderSubtle}`,
              fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
              letterSpacing: "0.08em", textTransform: "uppercase",
              cursor: "pointer", transition: "all 160ms ease",
            }}>
              {s}
            </button>
          );
        })}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          marginBottom: 14, padding: "10px 14px", borderRadius: 4,
          background: toast.tone === "ok" ? "rgba(52,199,89,0.08)" : "rgba(255,107,107,0.08)",
          border: `1px solid ${toast.tone === "ok" ? BRAND.green : BRAND.red}55`,
          color: toast.tone === "ok" ? BRAND.green : BRAND.red,
          fontSize: 13, lineHeight: 1.5,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)} style={{
            background: "none", border: "none", color: "inherit",
            cursor: "pointer", fontSize: 16, padding: 0,
          }}>×</button>
        </div>
      )}

      {error && (
        <div style={{
          padding: 14, marginBottom: 14, borderRadius: 4,
          background: "rgba(255,107,107,0.08)", border: `1px solid ${BRAND.red}55`,
          color: BRAND.red, fontSize: 13,
        }}>{error}</div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: BRAND.textMuted, fontSize: 13 }}>
          Loading queue…
        </div>
      ) : queue.length === 0 ? (
        <div style={{
          padding: 60, textAlign: "center", color: BRAND.textMuted,
          background: BRAND.obsidianCard, border: `1px solid ${BRAND.borderSubtle}`,
          borderRadius: 8,
        }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={BRAND.textMuted}
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ margin: "0 auto 14px", display: "block", opacity: 0.7 }}>
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
            <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          </svg>
          <div style={{ fontSize: 16, fontWeight: 700, color: BRAND.white, marginBottom: 4 }}>
            {statusFilter === "pending" ? "Inbox zero." : `No ${statusFilter} applications.`}
          </div>
          <div style={{ fontSize: 13 }}>
            {statusFilter === "pending"
              ? "Nothing to action right now. New applications land here when submitted."
              : statusFilter === "all"
                ? "No applications received yet."
                : `Nothing in the ${statusFilter} list.`}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {queue.map(item => {
            const key = `${item.kind}:${item.id}`;
            const isPartner = item.kind === "partner";
            const isExpanded = expanded === key;
            const isBusy = busy === key;
            const headlineName = isPartner ? item.full_name : item.contact_name;
            const headlineCompany = isPartner ? item.company : item.company_name;
            const headlineRole = isPartner ? item.role : item.contact_role;
            const accentColor = isPartner ? BRAND.gold : BRAND.vendorGreen;
            const typeBadge = isPartner ? "PARTNER" : "VENDOR";
            const bodyText = isPartner ? item.why_interested : item.capability_summary;

            return (
              <div key={key} style={{
                padding: 16,
                background: BRAND.obsidianCard,
                border: `1px solid ${isExpanded ? accentColor + "55" : BRAND.borderSubtle}`,
                borderRadius: 8,
                transition: "border-color 160ms ease",
              }}>
                {/* Row 1 — type + identity + time */}
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  marginBottom: 6, gap: 12,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", minWidth: 0, overflowWrap: "anywhere" }}>
                    <span style={{
                      padding: "3px 9px", borderRadius: 3,
                      background: `${accentColor}22`, border: `1px solid ${accentColor}55`,
                      color: accentColor,
                      fontFamily: "Inter, sans-serif", fontSize: 10, fontWeight: 700,
                      letterSpacing: "0.10em",
                    }}>{typeBadge}</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: BRAND.white }}>
                      {headlineName}
                    </span>
                    <span className="adm-sep" style={{ color: BRAND.textMuted, fontSize: 12 }}>·</span>
                    <span style={{ fontSize: 13, color: BRAND.textSecondary }}>
                      {headlineCompany}
                    </span>
                  </div>
                  <span style={{
                    fontSize: 11, color: BRAND.textMuted,
                    whiteSpace: "nowrap",
                  }}>
                    {timeAgo(item.submitted_at)}
                  </span>
                </div>

                {/* Row 2 — role + email + sector/categories */}
                <div style={{
                  display: "flex", gap: 12, flexWrap: "wrap",
                  fontSize: 12, color: BRAND.textSecondary,
                  marginBottom: 10, minWidth: 0, overflowWrap: "anywhere",
                }}>
                  <span><b style={{ color: BRAND.textMuted, fontWeight: 600 }}>Role:</b> {headlineRole}</span>
                  <span className="adm-sep">·</span>
                  <span><b style={{ color: BRAND.textMuted, fontWeight: 600 }}>Email:</b> {item.email}</span>
                  {isPartner && item.sector && (
                    <>
                      <span className="adm-sep">·</span>
                      <span><b style={{ color: BRAND.textMuted, fontWeight: 600 }}>Sector:</b> {item.sector}</span>
                    </>
                  )}
                  {!isPartner && item.categories && item.categories.length > 0 && (
                    <>
                      <span className="adm-sep">·</span>
                      <span><b style={{ color: BRAND.textMuted, fontWeight: 600 }}>Categories:</b> {item.categories.join(", ")}</span>
                    </>
                  )}
                  {(item.linkedin_url || (isPartner && item.linkedin_url) || (!isPartner && item.website)) && (
                    <>
                      <span className="adm-sep">·</span>
                      {item.linkedin_url && (
                        <a href={item.linkedin_url} target="_blank" rel="noopener noreferrer"
                           style={{ color: BRAND.gold, textDecoration: "none", padding: "4px 0", margin: "-4px 0" }}>↗ LinkedIn</a>
                      )}
                      {!isPartner && item.website && (
                        <a href={item.website} target="_blank" rel="noopener noreferrer"
                           style={{ color: BRAND.gold, textDecoration: "none", padding: "4px 0", margin: "-4px 0 -4px 6px" }}>↗ Website</a>
                      )}
                    </>
                  )}
                </div>

                {/* Row 3 — expandable body */}
                {isExpanded && bodyText && (
                  <div style={{
                    padding: 12, marginBottom: 10,
                    background: BRAND.obsidianDeep, borderRadius: 4,
                    fontSize: 13, lineHeight: 1.55, color: BRAND.white,
                    whiteSpace: "pre-wrap",
                    borderLeft: `2px solid ${accentColor}`,
                  }}>
                    <div style={{
                      fontSize: 10, color: BRAND.textMuted, fontWeight: 700,
                      letterSpacing: "0.10em", textTransform: "uppercase", marginBottom: 6,
                    }}>
                      {isPartner ? "Why they're interested" : "Capability summary"}
                    </div>
                    {bodyText}
                  </div>
                )}

                {/* Row 4 — actions */}
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  gap: 8, flexWrap: "wrap",
                }}>
                  <button
                    onClick={() => setExpanded(isExpanded ? null : key)}
                    style={{
                      padding: "6px 12px",
                      background: "transparent",
                      color: BRAND.textSecondary,
                      border: `1px solid ${BRAND.borderSubtle}`,
                      borderRadius: 3,
                      fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
                      cursor: "pointer", letterSpacing: "0.04em",
                    }}
                  >
                    {isExpanded ? "Hide detail" : "Show detail"}
                  </button>

                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {/* Decided applications show a status badge instead of
                        action buttons — they were already actioned, no
                        re-decide flow needed. */}
                    {item.status && item.status !== "pending" && (
                      <span style={{
                        padding: "5px 10px", borderRadius: 3,
                        background: item.status === "approved" ? "rgba(52,199,89,0.12)" : "rgba(255,107,107,0.10)",
                        color: item.status === "approved" ? BRAND.green : BRAND.red,
                        border: `1px solid ${item.status === "approved" ? BRAND.green : BRAND.red}55`,
                        fontFamily: "Inter, sans-serif", fontSize: 10.5, fontWeight: 700,
                        letterSpacing: "0.10em", textTransform: "uppercase",
                      }}>
                        {item.status === "approved" ? "Approved" : "Rejected"}
                      </span>
                    )}
                    {(!item.status || item.status === "pending") && isPartner ? (
                      <>
                        <button
                          disabled={isBusy}
                          onClick={() => approvePartner(item.id)}
                          style={actionBtn(BRAND.green, isBusy)}
                        >
                          {isBusy ? "…" : "Approve"}
                        </button>
                        <button
                          disabled={isBusy}
                          onClick={() => rejectPartner(item.id)}
                          style={actionBtn(BRAND.red, isBusy, "outline")}
                        >
                          Reject
                        </button>
                      </>
                    ) : (!item.status || item.status === "pending") ? (
                      <>
                        <select
                          disabled={isBusy}
                          defaultValue="basic"
                          onChange={(e) => e.target.dataset.tier = e.target.value}
                          style={{
                            padding: "6px 8px",
                            background: BRAND.obsidian,
                            color: BRAND.white,
                            border: `1px solid ${BRAND.borderSubtle}`,
                            borderRadius: 3,
                            fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 600,
                            cursor: "pointer",
                          }}
                          id={`vendor-tier-${item.id}`}
                        >
                          <option value="basic">Basic ₹4,999</option>
                          <option value="featured">Featured ₹9,999</option>
                          <option value="premium">Premium ₹19,999</option>
                        </select>
                        <button
                          disabled={isBusy}
                          onClick={() => {
                            const sel = document.getElementById(`vendor-tier-${item.id}`);
                            const tier = sel ? sel.value : "basic";
                            approveVendor(item.id, tier);
                          }}
                          style={actionBtn(BRAND.vendorGreen, isBusy)}
                        >
                          {isBusy ? "…" : "Approve"}
                        </button>
                        <button
                          disabled={isBusy}
                          onClick={() => rejectVendor(item.id)}
                          style={actionBtn(BRAND.red, isBusy, "outline")}
                        >
                          Reject
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function actionBtn(color, busy, variant) {
  const outline = variant === "outline";
  return {
    padding: "6px 14px",
    background: outline ? "transparent" : color,
    color: outline ? color : "#1A1A1A",
    border: `1px solid ${color}`,
    borderRadius: 3,
    fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700,
    letterSpacing: "0.05em",
    cursor: busy ? "wait" : "pointer",
    opacity: busy ? 0.6 : 1,
    transition: "transform 140ms ease",
  };
}
