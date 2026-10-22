// AdminBroadcasts — the broadcast (podcast episode) behind a briefing, as a
// product feature (2026-10-22). The admin uploads the episode file here and
// picks the report it belongs to; from then on
//   • the Attacked Hub plays it inside the report — the v5 shell's broadcast
//     card after the Executive Summary (reportLock.applyBroadcastToFrame), or
//     the Related-broadcast bar under older shells;
//   • a copy of the report opened on its own asks /api/broadcasts for it;
//   • the print build reads it for the PDF's broadcast card (rebuild needed).
//
// Two places: Admin → Broadcasts (this component on its own: every episode,
// search, upload) and Admin → Reports (compact: the episodes of the report
// being edited, under the list). Data: public.report_broadcasts through the
// admin_* functions; files in the public `broadcasts` bucket, admin-only
// write (src/lib/broadcasts.js, migration 20261022_broadcast_audio.sql).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ACCEPT_AUDIO, MAX_AUDIO_BYTES, adminDeleteBroadcast, adminListBroadcasts, adminUpsertBroadcast, formatBytes, formatDuration, hostsText, isAudioFile, isAudioUpload, parseHosts, readAudioDuration, removeBroadcastAudio, uploadBroadcastAudio } from "../lib/broadcasts";
import { adminListReports } from "../lib/reports";

const BRAND = { gold: "#FCBD00", obsidian: "#1A1A1A", card: "#242424", deep: "#080808", white: "#FFFFFF", muted: "#A8A8A8", dim: "#585858", border: "#333333", green: "#34C759", red: "#FF3B30" };
const inp = { width: "100%", minWidth: 0, boxSizing: "border-box", background: BRAND.deep, color: BRAND.white, border: `1px solid ${BRAND.border}`, borderRadius: 4, padding: "9px 11px", fontFamily: "Inter, sans-serif", fontSize: 13, outline: "none" };
const lbl = { display: "block", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: BRAND.muted, margin: "0 0 6px" };
const hint = { fontSize: 11, color: BRAND.dim, marginTop: 5, lineHeight: 1.45 };
const btn = (primary, extra = {}) => ({ padding: "9px 14px", borderRadius: 4, border: `1px solid ${primary ? BRAND.gold : BRAND.border}`, background: primary ? BRAND.gold : "transparent", color: primary ? BRAND.obsidian : BRAND.white, fontFamily: "Inter, sans-serif", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer", whiteSpace: "nowrap", ...extra });
const pill = (color) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", background: `${color}22`, border: `1px solid ${color}`, color });
const mono = { fontFamily: "JetBrains Mono, ui-monospace, monospace" };

const SERIES_DEFAULT = "Attacked.ai Briefing Room";
const today = () => new Date().toISOString().slice(0, 10);
const empty = (ref = "") => ({ id: null, report_ref: ref, series: SERIES_DEFAULT, episode: "", title: "", audio_url: "", audio_url_saved: "", audio_path: "", audio_bytes: null, audio_type: "", page_url: "", duration_min: "", show_notes: "", hosts_text: "", published: true, published_at: today(), published_at_saved: "" });
const fromRow = (b) => ({
  id: b.id, report_ref: b.report_ref || "", series: b.series || SERIES_DEFAULT, episode: b.episode || "", title: b.title || "",
  audio_url: b.audio_url || "", audio_url_saved: b.audio_url || "", audio_path: b.audio_path || "", audio_bytes: b.audio_bytes || null, audio_type: b.audio_type || "",
  page_url: b.page_url || "", duration_min: b.duration_sec ? String(Math.max(1, Math.round(b.duration_sec / 60))) : "", show_notes: b.show_notes || "",
  hosts_text: hostsText(b.hosts), published: !!b.published, published_at: (b.published_at || "").slice(0, 10) || today(), published_at_saved: (b.published_at || "").slice(0, 10),
});

// Live = readers can play or open it · Coming soon = announced, no audio yet · Draft = unpublished
export function episodeStatus(b) {
  if (!b.published) return ["Draft", BRAND.muted];
  if (b.audio_url || b.page_url) return ["Live", BRAND.green];
  return ["Coming soon", BRAND.gold];
}

// The report picker's choices: CMS reports (ref + title, from the Reports page
// when it passes its list) and the baked briefings from /reports/manifest.json
// (the featured ones carry titles).
function useReportChoices(reports) {
  const [cms, setCms] = useState(reports || []);
  const [baked, setBaked] = useState([]);
  useEffect(() => {
    if (reports) { setCms(reports); return; }
    adminListReports().then((r) => setCms(r || [])).catch(() => { /* no CMS list: the baked refs still work */ });
  }, [reports]);
  useEffect(() => {
    fetch("/reports/manifest.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((m) => {
      if (!m) return;
      const titles = new Map((m.featured || []).map((f) => [f.ref, f.title]));
      setBaked((m.refs || []).map((ref) => ({ ref, title: titles.get(ref) || "" })));
    }).catch(() => { /* no manifest on this build */ });
  }, []);
  return useMemo(() => {
    const seen = new Set(); const out = [];
    for (const r of [...cms.map((r) => ({ ref: r.ref, title: r.title || "", kind: r.status === "published" ? "CMS" : "CMS draft" })), ...baked.map((b) => ({ ...b, kind: "baked" }))]) {
      if (!r.ref || seen.has(r.ref)) continue; seen.add(r.ref); out.push(r);
    }
    return out;
  }, [cms, baked]);
}

export function AdminBroadcasts({ reportRef = "", compact = false, reports = null }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);            // null = the form is closed
  const [file, setFile] = useState(null);            // a chosen file, not uploaded until Save
  const [fileDur, setFileDur] = useState(undefined); // undefined = reading, null = unknown
  const [autoMin, setAutoMin] = useState("");        // the minutes we filled in from the file
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);
  const choices = useReportChoices(reports);

  const toast = (m) => { setMsg(m); setErr(null); setTimeout(() => setMsg(null), 4500); };
  const fail = (e) => {
    const m = e?.message || String(e || "Something went wrong.");
    const missing = /admin_list_broadcasts|admin_upsert_broadcast|report_broadcasts/.test(m) && /not exist|not find|404|schema cache/i.test(m);
    setErr(missing ? "The broadcasts table is not on this database yet. Run supabase/migrations/20261021_report_broadcasts.sql and 20261022_broadcast_audio.sql, then reload." : m);
  };
  async function refresh() { setLoading(true); try { setList(await adminListBroadcasts()); setErr(null); } catch (e) { fail(e); } finally { setLoading(false); } }
  useEffect(() => { refresh(); }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  function startNew() { setForm(empty(reportRef)); setFile(null); setFileDur(undefined); setAutoMin(""); setErr(null); }
  function edit(b) { setForm(fromRow(b)); setFile(null); setFileDur(undefined); setAutoMin(""); setErr(null); }
  function close() { setForm(null); setFile(null); }

  async function pick(f) {
    if (!f) return;
    if (!isAudioUpload(f)) { fail(new Error("That is not an audio file. Use mp3, m4a, aac, ogg, wav, flac or webm.")); return; }
    if (f.size > MAX_AUDIO_BYTES) { fail(new Error(`${f.name} is ${formatBytes(f.size)}; the limit is ${MAX_AUDIO_BYTES / 1048576} MB.`)); return; }
    setErr(null); setFile(f); setFileDur(undefined);
    const d = await readAudioDuration(f);
    setFileDur(d);
    if (d) { const m = String(Math.max(1, Math.round(d / 60))); setAutoMin(m); setForm((x) => (x ? { ...x, duration_min: m } : x)); }
  }
  const onDrop = (e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer?.files?.[0]); };

  async function save() {
    if (!form) return;
    const ref = form.report_ref.trim(), title = form.title.trim();
    if (!ref || !title) { fail(new Error("Choose the report and give the episode a title.")); return; }
    const urlTyped = form.audio_url.trim();
    const keepsUpload = !file && !!urlTyped && urlTyped === form.audio_url_saved;   // the uploaded file stays as it is
    const prevPath = form.audio_path;
    try {
      let audio = { audio_url: urlTyped, audio_path: keepsUpload ? form.audio_path : "", audio_bytes: keepsUpload ? form.audio_bytes : null, audio_type: keepsUpload ? form.audio_type : "" };
      if (file) { setBusy(`Uploading ${formatBytes(file.size)}…`); audio = await uploadBroadcastAudio(ref, file); }
      setBusy("Saving…");
      const mins = Number(form.duration_min);
      const payload = {
        ...(form.id ? { id: form.id } : {}), report_ref: ref, title, series: form.series.trim() || SERIES_DEFAULT, episode: form.episode.trim(),
        ...audio, page_url: form.page_url.trim(),
        // the file's exact length, unless the admin typed a different number of minutes
        duration_sec: file && fileDur && (!form.duration_min || form.duration_min === autoMin) ? fileDur : mins > 0 ? Math.round(mins * 60) : null,
        show_notes: form.show_notes.trim(), hosts: parseHosts(form.hosts_text), published: !!form.published,
        ...(form.published_at && form.published_at !== form.published_at_saved ? { published_at: new Date(`${form.published_at}T09:00:00Z`).toISOString() } : {}),
      };
      const saved = await adminUpsertBroadcast(payload);
      if (prevPath && saved && saved.audio_path !== prevPath) removeBroadcastAudio(prevPath);   // the file the row no longer points at
      const [st] = episodeStatus(saved || payload);
      toast(st === "Live" ? `${form.id ? "Updated" : "Published"}: the episode now plays inside ${ref} on the Hub.` : st === "Draft" ? "Saved as a draft — readers do not see it yet." : "Saved — announced as “Episode coming soon” until it has audio or a page.");
      close(); refresh();
    } catch (e) { fail(e); } finally { setBusy(""); }
  }
  async function remove(b) {
    if (!window.confirm(`Delete the episode “${b.title}”${b.audio_path ? " and its uploaded file" : ""}?`)) return;
    setBusy("Deleting…");
    try { await adminDeleteBroadcast(b); toast("Deleted."); refresh(); } catch (e) { fail(e); } finally { setBusy(""); }
  }

  // The list: the report being edited (compact), or everything, filtered.
  const rows = useMemo(() => {
    let r = list;
    if (compact && reportRef && !showAll) r = r.filter((b) => b.report_ref === reportRef);
    const s = q.trim().toLowerCase();
    if (s) r = r.filter((b) => [b.report_ref, b.title, b.series, b.episode].join(" ").toLowerCase().includes(s));
    return r;
  }, [list, compact, reportRef, showAll, q]);
  const counts = useMemo(() => list.reduce((c, b) => { const [s] = episodeStatus(b); c[s] = (c[s] || 0) + 1; return c; }, {}), [list]);
  const chosen = form ? choices.find((c) => c.ref === form.report_ref.trim()) : null;
  const two = compact ? "1fr" : "1fr 1fr";

  const audioState = (() => {
    if (!form) return null;
    if (file) return { kind: "pending", line: `${file.name} · ${formatBytes(file.size)}${fileDur === undefined ? " · reading length…" : fileDur ? ` · ${formatDuration(fileDur)}` : ""}`, sub: "Uploads when you save." };
    const url = form.audio_url.trim();
    if (url && url === form.audio_url_saved && form.audio_path) return { kind: "uploaded", line: `Uploaded file · ${formatBytes(form.audio_bytes) || form.audio_type || "audio"}`, sub: form.audio_path, preview: url };
    if (url) return { kind: "external", line: isAudioFile(url) ? "External audio file" : "External link (opens in a new tab)", sub: url, preview: isAudioFile(url) ? url : null };
    return { kind: "none", line: "No audio yet", sub: "Readers see “Episode coming soon” until a file or a link is here." };
  })();

  return (
    <div style={{ fontFamily: "Inter, sans-serif", ...(compact ? { background: BRAND.obsidian, border: `1px solid ${BRAND.border}`, borderRadius: 8, padding: 14, marginTop: 18 } : {}) }}>
      {/* HEAD */}
      <div style={{ display: "flex", alignItems: compact ? "center" : "baseline", gap: compact ? 10 : 14, marginBottom: compact ? 10 : 18, flexWrap: "wrap" }}>
        {compact ? (
          <div>
            <div style={{ fontSize: 15, fontWeight: 800 }}>Broadcasts{reportRef ? <span style={{ ...mono, fontSize: 11, color: BRAND.dim, marginLeft: 8 }}>{reportRef}</span> : null}</div>
            <div style={{ fontSize: 11.5, color: BRAND.muted, lineHeight: 1.45 }}>The episode behind this briefing. Plays inside the report once published. Full manager: Admin → Broadcasts.</div>
          </div>
        ) : (
          <>
            <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Broadcasts</h1>
            <span style={{ color: BRAND.gold, fontWeight: 700, fontSize: 14 }}>{counts.Live || 0} live · {counts["Coming soon"] || 0} coming soon · {counts.Draft || 0} draft</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {!compact && <input style={{ ...inp, width: 240 }} placeholder="Search ref, title, series…" value={q} onChange={(e) => setQ(e.target.value)} />}
        <button style={btn(false, compact ? { padding: "7px 10px" } : {})} onClick={refresh} title="Refresh">↻</button>
        <button style={btn(true, compact ? { padding: "7px 10px" } : {})} onClick={startNew}>+ Episode</button>
      </div>
      {!compact && (
        <p style={{ margin: "-6px 0 16px", fontSize: 12.5, color: BRAND.muted, lineHeight: 1.55, maxWidth: 760 }}>
          Upload the episode and pick the briefing it belongs to. A published episode with audio plays inside that report on the Attacked Hub (the broadcast card after the Executive Summary, or the bar under older reports), on the dashboard, and on a copy of the report opened by its link. The print PDF's broadcast card picks it up at the next print build.
        </p>
      )}
      {msg && <div style={{ background: `${BRAND.gold}22`, border: `1px solid ${BRAND.gold}`, color: BRAND.white, padding: "9px 12px", borderRadius: 4, marginBottom: 12, fontSize: 12.5 }}>{msg}</div>}
      {err && <div style={{ background: "#3a1a1a", border: `1px solid ${BRAND.red}`, color: BRAND.white, padding: "9px 12px", borderRadius: 4, marginBottom: 12, fontSize: 12.5 }}>{err}</div>}

      {/* FORM */}
      {form && (
        <div style={{ display: "grid", gap: 12, background: BRAND.card, border: `1px solid ${BRAND.gold}55`, borderRadius: 6, padding: compact ? 12 : 16, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{form.id ? "Edit episode" : "New episode"}</div>
          <div>
            <label style={lbl}>Report</label>
            <input style={{ ...inp, ...mono }} list="bc-report-choices" value={form.report_ref} onChange={set("report_ref")} placeholder="ATK-2026-0908-NATS" autoComplete="off" spellCheck={false} />
            <datalist id="bc-report-choices">{choices.map((c) => <option key={c.ref} value={c.ref} label={c.title ? `${c.title} (${c.kind})` : c.kind} />)}</datalist>
            <div style={hint}>{chosen ? <>{chosen.title || "Baked briefing"} · <span style={{ color: BRAND.muted }}>{chosen.kind}</span></> : form.report_ref.trim() ? "Not a known report ref — the episode will show only when a report with this ref exists." : "Start typing the ref or pick from the list: CMS reports and the baked briefings."}</div>
          </div>
          <div><label style={lbl}>Episode title</label><input style={inp} value={form.title} onChange={set("title")} placeholder="The Millisecond That Stopped UK Departures" /></div>
          <div style={{ display: "grid", gridTemplateColumns: two, gap: 10 }}>
            <div><label style={lbl}>Series</label><input style={inp} value={form.series} onChange={set("series")} /></div>
            <div><label style={lbl}>Episode no.</label><input style={inp} value={form.episode} onChange={set("episode")} placeholder="Episode 1" /></div>
          </div>

          {/* AUDIO */}
          <div>
            <label style={lbl}>Audio</label>
            <div
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
              onClick={() => fileRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current?.click(); }}
              data-testid="bc-dropzone"
              style={{ border: `1px dashed ${drag ? BRAND.gold : BRAND.border}`, background: drag ? `${BRAND.gold}11` : BRAND.deep, borderRadius: 6, padding: "14px 14px", cursor: "pointer", display: "flex", gap: 12, alignItems: "center" }}>
              <span aria-hidden="true" style={{ flex: "none", width: 38, height: 38, borderRadius: 8, background: audioState.kind === "none" ? BRAND.card : BRAND.gold, display: "grid", placeItems: "center" }}>
                <i style={{ display: "block", width: 0, height: 0, borderLeft: `12px solid ${audioState.kind === "none" ? BRAND.dim : BRAND.obsidian}`, borderTop: "7px solid transparent", borderBottom: "7px solid transparent", marginLeft: 3 }} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{audioState.line}</div>
                <div style={{ fontSize: 11, color: BRAND.dim, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{audioState.sub}</div>
              </div>
              <span style={btn(false, { padding: "7px 10px" })}>{audioState.kind === "none" ? "Choose file" : "Replace"}</span>
            </div>
            <input ref={fileRef} type="file" accept={ACCEPT_AUDIO} data-testid="bc-file" style={{ display: "none" }} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
            {audioState.preview && !file && <audio controls preload="none" src={audioState.preview} style={{ width: "100%", height: 34, marginTop: 8 }} />}
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <input style={{ ...inp, fontSize: 12 }} value={form.audio_url} onChange={set("audio_url")} placeholder="…or paste the URL of an mp3 / m4a hosted elsewhere" spellCheck={false} />
              </div>
              {(file || form.audio_url) && <button type="button" style={btn(false, { padding: "7px 10px", borderColor: BRAND.red, color: BRAND.red })} onClick={() => { setFile(null); setFileDur(undefined); setForm((f) => ({ ...f, audio_url: "" })); }}>Remove audio</button>}
            </div>
            <div style={hint}>Drop the file or choose it: mp3, m4a, aac, ogg, wav, flac or webm, up to {MAX_AUDIO_BYTES / 1048576} MB. It is stored in the public broadcasts bucket and streams straight to the player. The length is read from the file.</div>
          </div>

          <div><label style={lbl}>Episode page (optional)</label><input style={inp} value={form.page_url} onChange={set("page_url")} placeholder="https://open.spotify.com/episode/… — Spotify, Apple Podcasts, YouTube" spellCheck={false} /><div style={hint}>Without audio, the play button opens this page instead.</div></div>
          <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr 1fr" : "1fr 1fr 1fr", gap: 10, alignItems: "end" }}>
            <div><label style={lbl}>Length (minutes)</label><input style={inp} type="number" min="0" step="1" value={form.duration_min} onChange={set("duration_min")} /></div>
            <div><label style={lbl}>Published on</label><input style={inp} type="date" value={form.published_at} onChange={set("published_at")} /></div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: BRAND.white, paddingBottom: 9, gridColumn: compact ? "1 / -1" : "auto" }}><input type="checkbox" checked={form.published} onChange={set("published")} /> Published (visible to readers)</label>
          </div>
          <div><label style={lbl}>Hosts (optional)</label><textarea style={{ ...inp, minHeight: 52 }} value={form.hosts_text} onChange={set("hosts_text")} placeholder={"One per line: Name — Role\nAman Sehgal — Founder, Attacked.ai"} /><div style={hint}>Shown on the report's broadcast card after the briefing's own analyst.</div></div>
          <div><label style={lbl}>Show notes</label><textarea style={{ ...inp, minHeight: 60 }} value={form.show_notes} onChange={set("show_notes")} placeholder="One or two lines on what the episode covers" /></div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button style={btn(true)} disabled={!!busy} onClick={save}>{busy || (form.id ? "Save episode" : (form.published ? "Publish episode" : "Save draft"))}</button>
            <button style={btn(false)} disabled={!!busy} onClick={close}>Cancel</button>
            {form.id && <a href={`/?hub&report=${encodeURIComponent(form.report_ref.trim())}`} target="_blank" rel="noopener" style={{ marginLeft: "auto", fontSize: 12, color: BRAND.gold }}>Open the report on the Hub ↗</a>}
          </div>
        </div>
      )}

      {/* LIST */}
      {compact && reportRef && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: BRAND.muted, marginBottom: 4 }}>
          <span>{showAll ? "All episodes" : `Episodes for ${reportRef}`}</span>
          <button type="button" onClick={() => setShowAll((v) => !v)} style={{ background: "none", border: "none", color: BRAND.gold, cursor: "pointer", fontSize: 11.5, padding: 0 }}>{showAll ? "only this report" : "show all"}</button>
        </div>
      )}
      <div style={compact ? {} : { background: BRAND.obsidian, border: `1px solid ${BRAND.border}`, borderRadius: 8, overflow: "hidden" }}>
        {loading ? <div style={{ padding: compact ? "8px 0" : 36, textAlign: compact ? "left" : "center", color: BRAND.dim, fontSize: 12.5 }}>Loading…</div>
          : rows.length === 0 ? <div style={{ padding: compact ? "8px 0" : 36, textAlign: compact ? "left" : "center", color: BRAND.dim, fontSize: 12.5 }}>{list.length === 0 ? "No episodes yet. Add the first one." : "No episodes match."}</div>
          : rows.map((b) => {
            const [st, color] = episodeStatus(b);
            const file = b.audio_url && isAudioFile(b.audio_url) ? b.audio_url : null;
            const link = b.page_url || (b.audio_url && !file ? b.audio_url : null);
            return (
              <div key={b.id} style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "minmax(0,1fr) auto", gap: compact ? 8 : 16, alignItems: "start", padding: compact ? "10px 0" : "13px 16px", borderTop: `1px solid ${BRAND.border}` }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                    <span style={pill(color)}>{st}</span>
                    <span style={{ ...mono, fontSize: 10.5, color: BRAND.dim }}>{b.report_ref}{b.episode ? ` · ${b.episode}` : ""}</span>
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{b.title}</div>
                  <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 3 }}>{[b.series, formatDuration(b.duration_sec), b.audio_path ? `uploaded · ${formatBytes(b.audio_bytes)}` : file ? "external audio" : link ? "page link" : null, b.published_at ? new Date(b.published_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null].filter(Boolean).join(" · ")}</div>
                  {file && <audio controls preload="none" src={file} style={{ width: "100%", maxWidth: 420, height: 32, marginTop: 8 }} />}
                  {!file && link && <a href={link} target="_blank" rel="noopener" style={{ display: "inline-block", marginTop: 6, fontSize: 12, color: BRAND.gold }}>{link} ↗</a>}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <a href={`/?hub&report=${encodeURIComponent(b.report_ref)}`} target="_blank" rel="noopener" style={btn(false, { padding: "6px 9px", textDecoration: "none", display: "inline-block" })}>Hub ↗</a>
                  <button style={btn(false, { padding: "6px 9px" })} onClick={() => edit(b)}>Edit</button>
                  <button style={btn(false, { padding: "6px 9px", borderColor: BRAND.red, color: BRAND.red })} disabled={!!busy} onClick={() => remove(b)} aria-label="Delete">×</button>
                </div>
              </div>
            );
          })}
      </div>

      {!compact && (
        <div style={{ marginTop: 16, padding: "12px 14px", background: BRAND.obsidian, border: `1px solid ${BRAND.border}`, borderRadius: 8, fontSize: 12, color: BRAND.muted, lineHeight: 1.6 }}>
          <b style={{ color: BRAND.white }}>How a reader hears it.</b> Open the report on the Hub: the v5 shell (NATS and later briefings) shows the broadcast card after the Executive Summary with a working play button; older baked reports get the Related-broadcast bar under the frame. One published episode per report is shown (the one with the lowest sort order, then the newest). Unpublish to take it down without deleting the file.
        </div>
      )}
    </div>
  );
}
