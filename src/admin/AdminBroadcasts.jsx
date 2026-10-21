// AdminBroadcasts — the related broadcast (podcast episode) of a report, kept
// on the Reports page of the admin console (2026-10-21).
//
// One row per episode: which briefing it belongs to (the report ref — a baked
// one like ATK-2026-0908-NATS, or a CMS report's ref), the series, the title,
// the audio file or episode page, the length. The Attacked Hub shows published
// episodes in the "Related broadcast" bar when that report is opened; an
// episode saved without an audio URL is announced as "coming soon". Data:
// public.report_broadcasts through the admin_* functions (src/lib/broadcasts.js).
import React, { useEffect, useState } from "react";
import { adminDeleteBroadcast, adminListBroadcasts, adminUpsertBroadcast, formatDuration } from "../lib/broadcasts";

const BRAND = { gold: "#FCBD00", obsidian: "#1A1A1A", card: "#242424", deep: "#080808", white: "#FFFFFF", muted: "#A8A8A8", dim: "#585858", border: "#333333" };
const inp = { width: "100%", minWidth: 0, boxSizing: "border-box", background: BRAND.deep, color: BRAND.white, border: `1px solid ${BRAND.border}`, borderRadius: 4, padding: "8px 10px", fontFamily: "Inter, sans-serif", fontSize: 13, outline: "none" };
const lbl = { display: "block", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: BRAND.muted, margin: "0 0 5px" };
const btn = (primary, extra = {}) => ({ padding: "8px 12px", borderRadius: 4, border: `1px solid ${primary ? BRAND.gold : BRAND.border}`, background: primary ? BRAND.gold : "transparent", color: primary ? BRAND.obsidian : BRAND.white, fontFamily: "Inter, sans-serif", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer", ...extra });

const empty = () => ({ id: null, report_ref: "", series: "Attacked.ai Briefing Room", episode: "", title: "", audio_url: "", page_url: "", duration_min: "", show_notes: "", published: true });

export function AdminBroadcasts({ reportRef = "" }) {
  const [list, setList] = useState([]);
  const [form, setForm] = useState(() => ({ ...empty(), report_ref: reportRef }));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const toast = (m) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  async function refresh() { try { setList((await adminListBroadcasts()) || []); } catch (e) { toast(e.message || "Could not load broadcasts."); } }
  useEffect(() => { refresh(); }, []);
  // The report being edited becomes the default ref for a new episode.
  useEffect(() => { if (reportRef && !form.id && !form.report_ref) setForm((f) => ({ ...f, report_ref: reportRef })); }, [reportRef]); // eslint-disable-line react-hooks/exhaustive-deps

  function edit(b) {
    setForm({ id: b.id, report_ref: b.report_ref, series: b.series || "", episode: b.episode || "", title: b.title || "", audio_url: b.audio_url || "", page_url: b.page_url || "",
      duration_min: b.duration_sec ? String(Math.round(b.duration_sec / 60)) : "", show_notes: b.show_notes || "", published: !!b.published });
    setOpen(true);
  }
  async function save() {
    if (!form.report_ref.trim() || !form.title.trim()) { toast("A report ref and a title are needed."); return; }
    setBusy(true);
    try {
      await adminUpsertBroadcast({ ...(form.id ? { id: form.id } : {}), report_ref: form.report_ref.trim(), series: form.series.trim() || null, episode: form.episode.trim() || null,
        title: form.title.trim(), audio_url: form.audio_url.trim() || null, page_url: form.page_url.trim() || null,
        duration_sec: form.duration_min ? Math.round(Number(form.duration_min) * 60) : null, show_notes: form.show_notes.trim() || null, published: !!form.published });
      toast(form.id ? "Episode updated." : "Episode added — it shows on the Hub when that report is opened.");
      setForm({ ...empty(), report_ref: reportRef }); setOpen(false); refresh();
    } catch (e) { toast(e.message || "Save failed."); } finally { setBusy(false); }
  }
  async function remove(b) {
    if (!window.confirm(`Delete the episode "${b.title}"?`)) return;
    setBusy(true);
    try { await adminDeleteBroadcast(b.id); toast("Deleted."); refresh(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ background: BRAND.obsidian, border: `1px solid ${BRAND.border}`, borderRadius: 8, padding: 14, marginTop: 18, fontFamily: "Inter, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800 }}>Broadcasts</div>
          <div style={{ fontSize: 11.5, color: BRAND.muted, lineHeight: 1.45 }}>The podcast episode behind a briefing. Shown on the Hub when the report is opened, and on the last page of the PDF.</div>
        </div>
        <span style={{ flex: 1 }} />
        <button style={btn(true, { padding: "7px 10px" })} onClick={() => { setForm({ ...empty(), report_ref: reportRef }); setOpen(true); }}>+ Episode</button>
      </div>
      {msg && <div style={{ background: `${BRAND.gold}22`, border: `1px solid ${BRAND.gold}`, color: BRAND.white, padding: "8px 12px", borderRadius: 4, marginBottom: 10, fontSize: 12.5 }}>{msg}</div>}

      {open && (
        <div style={{ display: "grid", gap: 10, background: BRAND.card, border: `1px solid ${BRAND.border}`, borderRadius: 6, padding: 12, marginBottom: 12 }}>
          <div><label style={lbl}>Report ref</label><input style={inp} value={form.report_ref} onChange={set("report_ref")} placeholder="ATK-2026-0908-NATS" /></div>
          <div><label style={lbl}>Episode title</label><input style={inp} value={form.title} onChange={set("title")} placeholder="The Millisecond That Stopped UK Departures" /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><label style={lbl}>Series</label><input style={inp} value={form.series} onChange={set("series")} /></div>
            <div><label style={lbl}>Episode no.</label><input style={inp} value={form.episode} onChange={set("episode")} placeholder="Episode 12" /></div>
          </div>
          <div><label style={lbl}>Audio URL (mp3 / m4a)</label><input style={inp} value={form.audio_url} onChange={set("audio_url")} placeholder="https://… .mp3 — leave empty for “coming soon”" /></div>
          <div><label style={lbl}>Episode page (Spotify, YouTube, Apple)</label><input style={inp} value={form.page_url} onChange={set("page_url")} placeholder="https://open.spotify.com/episode/…" /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "end" }}>
            <div><label style={lbl}>Length (minutes)</label><input style={inp} type="number" min="0" value={form.duration_min} onChange={set("duration_min")} /></div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: BRAND.white, paddingBottom: 9 }}><input type="checkbox" checked={form.published} onChange={set("published")} /> Published</label>
          </div>
          <div><label style={lbl}>Show notes</label><textarea style={{ ...inp, minHeight: 56 }} value={form.show_notes} onChange={set("show_notes")} placeholder="One or two lines on what the episode covers" /></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn(true)} disabled={busy} onClick={save}>{form.id ? "Save episode" : "Add episode"}</button>
            <button style={btn(false)} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {list.length === 0 ? <div style={{ fontSize: 12.5, color: BRAND.dim, padding: "6px 0" }}>No episodes yet.</div>
        : list.map((b) => (
          <div key={b.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 0", borderTop: `1px solid ${BRAND.border}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10.5, color: BRAND.dim, fontFamily: "JetBrains Mono, monospace", marginBottom: 2 }}>{b.report_ref}{b.episode ? ` · ${b.episode}` : ""}{!b.published ? " · draft" : ""}</div>
              <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}>{b.title}</div>
              <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>{[b.series, formatDuration(b.duration_sec), b.audio_url ? "audio" : b.page_url ? "page" : "coming soon"].filter(Boolean).join(" · ")}</div>
            </div>
            <button style={btn(false, { padding: "5px 8px" })} onClick={() => edit(b)}>Edit</button>
            <button style={btn(false, { padding: "5px 8px", borderColor: "#FF3B30", color: "#FF3B30" })} onClick={() => remove(b)}>×</button>
          </div>
        ))}
    </div>
  );
}
