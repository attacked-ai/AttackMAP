// AdminReports — the reports CMS inside the admin console (2026-09-28).
//
// An admin writes an intelligence report (title, dossier fields, Markdown per
// section, hero picture, brand controls) and sees it rendered live in the
// exact shell of the baked briefings; Save keeps a draft, Publish makes it
// appear on the Attacked Hub (and, when linked to an incident, turns that
// incident's card into a "Full report"). A finished HTML file (a baked report
// from the pipeline) can be uploaded instead of authored.
//
// Data lives in public.hub_reports through the admin_* RPCs (src/lib/reports.js);
// the rendered HTML is stored with the row, so readers never render Markdown.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { adminDeleteReport, adminGetReport, adminListReports, adminSetReportStatus, adminUpsertReport, makeReportRef, uploadReportHero } from "../lib/reports";
import { DEFAULT_BRAND, REPORT_FONTS, REPORT_SECTIONS, applyBrandToHtml, renderReport, reportMetaFromHtml } from "../lib/reportTemplate";
import { makeReportPreview, stubPreview } from "../lib/reportPreview";
import { CATEGORIES, INDUSTRIES } from "../lib/taxonomy";
import { ReportPageEditor } from "./ReportPageEditor";
import { AdminBroadcasts } from "./AdminBroadcasts";

const BRAND = { gold: "#FCBD00", obsidian: "#1A1A1A", card: "#242424", deep: "#080808", white: "#FFFFFF", muted: "#A8A8A8", dim: "#585858", border: "#333333" };
const SEVS = [[5, "Critical"], [4, "High"], [3, "Medium"], [2, "Low"], [1, "Minimal"]];

const inp = { width: "100%", minWidth: 0, boxSizing: "border-box", background: BRAND.deep, color: BRAND.white, border: `1px solid ${BRAND.border}`, borderRadius: 4, padding: "9px 11px", fontFamily: "Inter, sans-serif", fontSize: 13, outline: "none" };
const lbl = { display: "block", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: BRAND.muted, margin: "0 0 6px" };
const btn = (primary, extra = {}) => ({ padding: "9px 14px", borderRadius: 4, border: `1px solid ${primary ? BRAND.gold : BRAND.border}`, background: primary ? BRAND.gold : "transparent", color: primary ? BRAND.obsidian : BRAND.white, fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer", ...extra });
const pill = (on, color = BRAND.gold) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", background: on ? `${color}22` : "transparent", border: `1px solid ${on ? color : BRAND.border}`, color: on ? color : BRAND.muted });

const emptyData = () => ({
  ref: "", title: "", subtitle: "", dek: "", kicker: "", author: "Attacked.ai Intelligence", authorTitle: "GUARD framework analysis",
  assessedAt: new Date().toUTCString().slice(5, 16), severity: 3, confidence: "Medium", industry: "", category: "", status: "Assessment v1 · point-in-time",
  takeaway: "", heroImageUrl: "", incidentId: "", tags: "", mode: "author", uploadedHtml: "",
  sections: Object.fromEntries(REPORT_SECTIONS.map((s) => [s.key, ""])),
});

// DB row → editor state; the editor state is what `data` jsonb stores.
function fromRow(r) {
  const d = r.data && typeof r.data === "object" ? r.data : {};
  return {
    ...emptyData(), ...d,
    ref: r.ref || d.ref || "", title: r.title || d.title || "", subtitle: r.subtitle ?? d.subtitle ?? "", industry: r.industry ?? d.industry ?? "",
    category: r.primary_category ?? d.category ?? "", severity: r.severity ?? d.severity ?? 3, heroImageUrl: r.hero_image_url ?? d.heroImageUrl ?? "",
    incidentId: r.incident_id != null ? String(r.incident_id) : "", author: r.author ?? d.author ?? "Attacked.ai Intelligence",
    tags: Array.isArray(r.tags) ? r.tags.join(", ") : (d.tags || ""), mode: d.mode || (r.html && !r.data ? "html" : "author"),
    uploadedHtml: d.mode === "html" ? (r.html || "") : "", sections: { ...emptyData().sections, ...(d.sections || {}) },
  };
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function AdminReports() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(null);          // { id, status } | null
  const [data, setData] = useState(emptyData);
  const [brand, setBrand] = useState({ ...DEFAULT_BRAND });
  const [tab, setTab] = useState("content");             // content | design | upload
  const [busy, setBusy] = useState(false);
  const [incident, setIncident] = useState(null);        // { id, headline } once looked up
  const [preview, setPreview] = useState(true);
  const fileRef = useRef(null);
  // Below 1200px the editor stacks under the report list (admin-responsive.css),
  // so opening or starting a report scrolls it into view. A counter, not a
  // flag: open() sets its state after an await, and each open should scroll.
  const editorRef = useRef(null);
  const [reveal, setReveal] = useState(0);
  useEffect(() => {
    if (reveal && window.matchMedia("(max-width: 1199px)").matches) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [reveal]);

  const toast = (m) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  async function refresh() {
    setLoading(true); setErr(null);
    try { setList(await adminListReports() || []); } catch (e) { setErr(e.message || "Could not load reports."); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  // Live preview, debounced so typing stays smooth.
  const slow = useDebounced({ data, brand }, 350);
  const previewHtml = useMemo(() => {
    if (slow.data.mode === "html") return slow.data.uploadedHtml ? applyBrandToHtml(slow.data.uploadedHtml, slow.brand) : "";
    return renderReport(slow.data, slow.brand);
  }, [slow]);

  function startNew() {
    setEditing({ id: null, status: "draft" }); setData(emptyData()); setBrand({ ...DEFAULT_BRAND }); setIncident(null); setTab("content");
    setReveal((n) => n + 1);
  }
  async function open(row) {
    setBusy(true);
    try {
      const r = await adminGetReport(row.id);
      if (!r) throw new Error("Report not found");
      setEditing({ id: r.id, status: r.status }); setData(fromRow(r)); setBrand({ ...DEFAULT_BRAND, ...(r.brand || {}) }); setIncident(null); setTab("content");
      setReveal((n) => n + 1);
      if (r.incident_id != null) lookupIncident(String(r.incident_id));
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  async function lookupIncident(id) {
    const n = Number(id);
    if (!n) { setIncident(null); return; }
    const { data: rows } = await supabase.from("incidents").select("id,headline,industry,primary_category,severity,incident_day").eq("id", n).limit(1);
    const r = rows && rows[0];
    setIncident(r || { id: n, missing: true });
    if (r) setData((d) => ({ ...d, industry: d.industry || r.industry || "", category: d.category || r.primary_category || "", severity: d.severity || r.severity || 3, title: d.title || r.headline || "" }));
  }

  function payload() {
    const ref = data.ref.trim() || makeReportRef(data.title);
    const html = data.mode === "html" ? applyBrandToHtml(data.uploadedHtml, brand) : renderReport({ ...data, ref }, brand);
    // The free-reader copy (header + Executive Summary), saved next to the full
    // HTML: report_html hands it to anyone who is not a subscriber. An upload
    // in a shell the cutter does not know gets the title-only stub.
    let html_preview;
    if (data.mode === "html") {
      try { html_preview = makeReportPreview(html).html; }
      catch { html_preview = stubPreview({ ref, title: data.title, subtitle: data.subtitle, summary: data.dek }); }
    } else html_preview = renderReport({ ...data, ref }, brand, { preview: true });
    return {
      ...(editing?.id ? { id: editing.id } : {}),
      ref, title: data.title.trim() || "Untitled report", subtitle: data.subtitle || null, summary: (data.sections.summary || "").slice(0, 600) || data.dek || null,
      industry: data.industry || null, primary_category: data.category || null, severity: Number(data.severity) || null,
      incident_id: data.incidentId ? Number(data.incidentId) : null, hero_image_url: data.heroImageUrl || null, author: data.author || null,
      tags: data.tags.split(",").map((t) => t.trim()).filter(Boolean),
      data: { ...data, ref, uploadedHtml: undefined }, brand, html, html_preview,
    };
  }
  async function save(publish = null) {
    if (!data.title.trim()) { toast("Give the report a title first."); return; }
    if (data.mode === "html" && !data.uploadedHtml) { toast("Upload an HTML file, or switch to Author."); return; }
    setBusy(true);
    try {
      let r = await adminUpsertReport(payload());
      if (publish !== null && r) r = await adminSetReportStatus(r.id, publish ? "published" : "draft");
      if (r) { setEditing({ id: r.id, status: r.status }); setData((d) => ({ ...d, ref: r.ref })); }
      toast(publish === true ? "Published — live on the Attacked Hub." : publish === false ? "Unpublished." : "Draft saved.");
      refresh();
    } catch (e) { toast(e.message || "Save failed."); } finally { setBusy(false); }
  }
  async function remove() {
    if (!editing?.id) return;
    if (!window.confirm("Delete this report? This cannot be undone.")) return;
    setBusy(true);
    try { await adminDeleteReport(editing.id); setEditing(null); toast("Deleted."); refresh(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  async function onHero(e) {
    const f = e.target.files?.[0]; if (!f) return;
    setBusy(true);
    try { const url = await uploadReportHero(data.ref.trim() || makeReportRef(data.title), f); setData((d) => ({ ...d, heroImageUrl: url })); toast("Picture uploaded."); }
    catch (er) { toast(er.message || "Upload failed."); } finally { setBusy(false); e.target.value = ""; }
  }
  // Uploading a finished report keeps the file as-is for rendering AND reads
  // its own metadata into the form, so the admin edits rather than retypes.
  // Anything already typed is left alone; a field still empty or still on the
  // editor's default takes the file's value. Every field stays editable after,
  // and the toast names what the file could not supply.
  function onHtmlFile(e) {
    const f = e.target.files?.[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const html = String(rd.result || "");
      const meta = reportMetaFromHtml(html);
      let filled = 0, blank = [];
      setData((d) => {
        const base = emptyData();
        const next = { ...d, mode: "html", uploadedHtml: html };
        for (const [k, v] of Object.entries(meta.fields)) {
          const mine = next[k];
          if (mine === "" || mine == null || mine === base[k]) { next[k] = v; filled++; }
        }
        if (!next.title) next.title = f.name.replace(/\.html?$/i, "");
        blank = [["heroImageUrl", "hero image"], ["industry", "industry"], ["category", "category"], ["incidentId", "incident link"], ["tags", "tags"]]
          .filter(([k]) => !String(next[k] || "").trim()).map(([, name]) => name);
        return next;
      });
      const kb = Math.round(html.length / 1024);
      toast(meta.found
        ? `${f.name} — ${kb} KB, ${filled} field${filled === 1 ? "" : "s"} read from the file.${blank.length ? " Still to add: " + blank.join(", ") + "." : ""}`
        : `${f.name} — ${kb} KB. No metadata block in this file; fill the fields in by hand.`);
    };
    rd.readAsText(f);
    e.target.value = "";
  }

  const set = (k) => (e) => setData((d) => ({ ...d, [k]: e.target.value }));
  const setSec = (k) => (e) => setData((d) => ({ ...d, sections: { ...d.sections, [k]: e.target.value } }));
  const published = list.filter((r) => r.status === "published").length;

  return (
    <div style={{ fontFamily: "Inter, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Reports</h1>
        <span style={{ color: BRAND.gold, fontWeight: 700, fontSize: 14 }}>{published} live · {list.length - published} draft</span>
        <span style={{ flex: 1 }} />
        <button style={btn(false)} onClick={refresh}>↻ Refresh</button>
        <button style={btn(true)} onClick={startNew}>+ New report</button>
      </div>
      {msg && <div style={{ background: `${BRAND.gold}22`, border: `1px solid ${BRAND.gold}`, color: BRAND.white, padding: "10px 14px", borderRadius: 4, marginBottom: 14, fontSize: 13 }}>{msg}</div>}
      {err && <div style={{ background: "#3a1a1a", border: "1px solid #FF3B30", padding: "10px 14px", borderRadius: 4, marginBottom: 14, fontSize: 13 }}>{err}</div>}

      <div className="adm-rep-grid" style={{ display: "grid", gridTemplateColumns: editing ? "300px 1fr" : "1fr", gap: 18, alignItems: "start" }}>
        {/* LIST, with the broadcasts (podcast episodes) under it */}
        <div>
        <div style={{ background: BRAND.obsidian, border: `1px solid ${BRAND.border}`, borderRadius: 8, overflow: "hidden" }}>
          {loading ? <div style={{ padding: 40, textAlign: "center", color: BRAND.dim }}>Loading…</div>
            : list.length === 0 ? <div style={{ padding: 40, textAlign: "center", color: BRAND.dim }}>No reports yet. Create the first one.</div>
            : list.map((r) => (
              <div key={r.id} onClick={() => open(r)} style={{ padding: "12px 14px", borderBottom: `1px solid ${BRAND.border}`, cursor: "pointer", background: editing?.id === r.id ? BRAND.card : "transparent" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                  <span style={pill(r.status === "published", r.status === "published" ? "#34C759" : BRAND.gold)}>{r.status}</span>
                  <span style={{ fontSize: 10.5, color: BRAND.dim, fontFamily: "JetBrains Mono, monospace" }}>{r.ref}</span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{r.title}</div>
                <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>{[r.industry, r.primary_category, r.severity ? `S${r.severity}` : null, r.incident_id ? `incident #${r.incident_id}` : "standalone"].filter(Boolean).join(" · ")}</div>
              </div>
            ))}
        </div>
        <AdminBroadcasts reportRef={editing ? data.ref : ""} compact reports={list} />
        </div>

        {/* EDITOR */}
        {editing && (
          <div ref={editorRef} className="adm-rep-editor" style={{ display: "grid", gridTemplateColumns: preview ? "minmax(380px, 1fr) minmax(420px, 1.2fr)" : "1fr", gap: 18, alignItems: "start", scrollMarginTop: 12 }}>
            <div style={{ background: BRAND.obsidian, border: `1px solid ${BRAND.border}`, borderRadius: 8, padding: 18 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
                {[["content", "Content"], ["design", "Design & brand"], ["upload", "Upload HTML"]].map(([id, t]) => (
                  <button key={id} onClick={() => setTab(id)} style={btn(tab === id, { padding: "7px 12px" })}>{t}</button>
                ))}
                <span style={{ flex: 1 }} />
                <button onClick={() => setPreview(!preview)} style={btn(false, { padding: "7px 12px" })}>{preview ? "Hide preview" : "Show preview"}</button>
              </div>

              {tab === "content" && (
                <div style={{ display: "grid", gap: 12 }}>
                  <div><label style={lbl}>Title</label><input style={inp} value={data.title} onChange={set("title")} placeholder="The headline of the report" /></div>
                  <div><label style={lbl}>Subtitle</label><input style={inp} value={data.subtitle} onChange={set("subtitle")} placeholder="One sentence under the title" /></div>
                  <div><label style={lbl}>Dek (standfirst)</label><textarea style={{ ...inp, minHeight: 60 }} value={data.dek} onChange={set("dek")} placeholder="Two or three sentences that set up the piece" /></div>
                  <div className="adm-rep-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div><label style={lbl}>Industry</label><select style={inp} value={data.industry} onChange={set("industry")}><option value="">Select</option>{INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}</select></div>
                    <div><label style={lbl}>GUARD category</label><select style={inp} value={data.category} onChange={set("category")}><option value="">Select</option>{CATEGORIES.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}</select></div>
                    <div><label style={lbl}>Severity</label><select style={inp} value={data.severity} onChange={set("severity")}>{SEVS.map(([v, n]) => <option key={v} value={v}>S{v} · {n}</option>)}</select></div>
                    <div><label style={lbl}>Confidence</label><select style={inp} value={data.confidence} onChange={set("confidence")}>{["High", "Medium", "Low"].map((c) => <option key={c}>{c}</option>)}</select></div>
                    <div><label style={lbl}>Reference</label><input style={inp} value={data.ref} onChange={set("ref")} placeholder={makeReportRef(data.title || "report")} /></div>
                    <div><label style={lbl}>As of</label><input style={inp} value={data.assessedAt} onChange={set("assessedAt")} /></div>
                    <div><label style={lbl}>Author</label><input style={inp} value={data.author} onChange={set("author")} /></div>
                    <div><label style={lbl}>Author title</label><input style={inp} value={data.authorTitle} onChange={set("authorTitle")} /></div>
                  </div>
                  <div>
                    <label style={lbl}>Linked incident (optional)</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input style={inp} value={data.incidentId} onChange={set("incidentId")} onBlur={(e) => lookupIncident(e.target.value)} placeholder="Incident id, e.g. 2443 — the incident's card becomes a Full report" />
                      <button style={btn(false)} onClick={() => lookupIncident(data.incidentId)}>Find</button>
                    </div>
                    {incident && <div style={{ fontSize: 12, color: incident.missing ? "#FF3B30" : BRAND.muted, marginTop: 6 }}>{incident.missing ? `No incident #${incident.id}` : `#${incident.id} · ${incident.headline} · ${incident.incident_day}`}</div>}
                  </div>
                  <div>
                    <label style={lbl}>Hero picture</label>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input style={inp} value={data.heroImageUrl} onChange={set("heroImageUrl")} placeholder="https://… or upload" />
                      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onHero} />
                      <button style={btn(false)} onClick={() => fileRef.current?.click()}>Upload</button>
                    </div>
                    {data.heroImageUrl && <img src={data.heroImageUrl} alt="" style={{ marginTop: 8, width: "100%", maxHeight: 140, objectFit: "cover", borderRadius: 4, border: `1px solid ${BRAND.border}` }} />}
                  </div>
                  <div><label style={lbl}>Tags</label><input style={inp} value={data.tags} onChange={set("tags")} placeholder="comma, separated" /></div>
                  <div style={{ borderTop: `1px solid ${BRAND.border}`, paddingTop: 12, fontSize: 11, color: BRAND.muted, lineHeight: 1.6 }}>Sections take Markdown: paragraphs, <b>**bold**</b>, lists with <b>-</b>, headings with <b>###</b>, tables, links. Empty sections are left out of the report.</div>
                  {REPORT_SECTIONS.map((s) => (
                    <div key={s.key}>
                      <label style={lbl}>{s.num ? `${s.num} · ` : ""}{s.title || s.eyebrow}{s.locked ? <span style={{ ...pill(true), marginLeft: 8 }}>subscriber</span> : null}</label>
                      <textarea style={{ ...inp, minHeight: s.key === "summary" ? 120 : 90, fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 12.5, lineHeight: 1.55 }} value={data.sections[s.key]} onChange={setSec(s.key)} placeholder={s.hint} />
                    </div>
                  ))}
                  <div><label style={lbl}>Board takeaway</label><textarea style={{ ...inp, minHeight: 60 }} value={data.takeaway} onChange={set("takeaway")} placeholder="One paragraph a director can act on" /></div>
                </div>
              )}

              {tab === "design" && (
                <div style={{ display: "grid", gap: 14 }}>
                  <div className="adm-rep-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div><label style={lbl}>Accent colour</label><div style={{ display: "flex", gap: 8 }}><input type="color" value={brand.accent} onChange={(e) => setBrand({ ...brand, accent: e.target.value })} style={{ width: 44, height: 36, border: "none", background: "none", padding: 0 }} /><input style={inp} value={brand.accent} onChange={(e) => setBrand({ ...brand, accent: e.target.value })} /></div></div>
                    <div><label style={lbl}>Theme</label><select style={inp} value={brand.theme} onChange={(e) => setBrand({ ...brand, theme: e.target.value })}><option value="light">Light (paper)</option><option value="dark">Dark (obsidian)</option></select></div>
                    <div><label style={lbl}>Typeface</label><select style={inp} value={brand.font} onChange={(e) => setBrand({ ...brand, font: e.target.value })}>{REPORT_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></div>
                    <div><label style={lbl}>Heading weight</label><select style={inp} value={brand.headingWeight} onChange={(e) => setBrand({ ...brand, headingWeight: Number(e.target.value) })}>{[600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}</select></div>
                    <div><label style={lbl}>Classification kicker</label><input style={inp} value={brand.kicker} onChange={(e) => setBrand({ ...brand, kicker: e.target.value })} /></div>
                    <div><label style={lbl}>Brand footer</label><select style={inp} value={brand.showBrandFooter ? "1" : "0"} onChange={(e) => setBrand({ ...brand, showBrandFooter: e.target.value === "1" })}><option value="1">Attacked.ai footer on</option><option value="0">Off (white-label)</option></select></div>
                  </div>
                  <button style={btn(false)} onClick={() => setBrand({ ...DEFAULT_BRAND })}>Reset to brand defaults</button>
                  <div style={{ fontSize: 11, color: BRAND.muted, lineHeight: 1.6 }}>
                    Defaults are the Attacked.ai brand: gold {DEFAULT_BRAND.accent}, Inter, light paper.
                    {data.mode === "html"
                      ? " On an uploaded file, accent, typeface and heading weight are applied by rewriting the file's own stylesheet, so they take effect everywhere in it. Theme, classification kicker and brand footer belong to the authored layout — a baked briefing keeps the palette and footer it shipped with."
                      : " Everything here applies to the rendered report."}
                  </div>
                </div>
              )}

              {tab === "upload" && (
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
                  <div style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.6 }}>Upload a finished report file (a baked briefing from the pipeline, or any standalone HTML). It is stored as-is; the Design tab's brand settings are layered on top. Switching back to Author keeps your sections.</div>
                  <input type="file" accept=".html,.htm,text/html" onChange={onHtmlFile} style={{ color: BRAND.white, maxWidth: "100%", minHeight: 24 }} />
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={pill(data.mode === "html")}>{data.mode === "html" ? `HTML file · ${Math.round((data.uploadedHtml || "").length / 1024)} KB` : "Author mode"}</span>
                    {data.mode === "html" && <button style={btn(false, { padding: "6px 10px" })} onClick={() => setData((d) => ({ ...d, mode: "author" }))}>Switch to Author</button>}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap", alignItems: "center" }}>
                <button style={btn(false)} disabled={busy} onClick={() => save(null)}>Save draft</button>
                {editing.status === "published"
                  ? <button style={btn(false)} disabled={busy} onClick={() => save(false)}>Unpublish</button>
                  : <button style={btn(true)} disabled={busy} onClick={() => save(true)}>Publish to Hub</button>}
                {editing.status === "published" && <button style={btn(true)} disabled={busy} onClick={() => save(true)}>Save & republish</button>}
                <span style={{ flex: 1 }} />
                {editing.id && data.ref && <a href={data.incidentId ? `/?hub&open=${data.incidentId}` : `/?hub&report=${encodeURIComponent(data.ref)}`} target="_blank" rel="noopener" style={{ ...btn(false, { textDecoration: "none" }) }}>Open on Hub ↗</a>}
                {editing.id && <button style={btn(false, { borderColor: "#FF3B30", color: "#FF3B30" })} disabled={busy} onClick={remove}>Delete</button>}
              </div>
            </div>

            {preview && (
              <div style={{ position: "sticky", top: 16 }}>
                {data.mode === "html" && data.uploadedHtml ? (
                  // An uploaded briefing is a finished page, so it can be edited
                  // where it is read: click an element, restyle it, and the
                  // edited document becomes what Save stores.
                  <ReportPageEditor html={previewHtml} brand={brand} onChange={(h) => setData((d) => ({ ...d, uploadedHtml: h }))} />
                ) : (
                  <>
                    <div style={{ ...lbl, marginBottom: 8 }}>Live preview · exactly what readers see</div>
                    <iframe title="Report preview" srcDoc={previewHtml} style={{ width: "100%", height: "78vh", border: `1px solid ${BRAND.border}`, borderRadius: 8, background: "#fff" }} />
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
