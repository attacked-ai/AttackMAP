// ─────────────────────────────────────────────────────────────────────────
// AdminBriefings — the "Briefings" admin tab.
//
// Lets an admin attach editorial media to any incident shown on the Attacked
// Hub: a custom news image (paste a URL or upload a file to Supabase Storage)
// and a full article body that replaces the GUARD summary in the hub reader.
//
// Writes go through the admin_set_incident_media() RPC (security-definer,
// _is_admin() gated). Image uploads land in the public `incident-media`
// storage bucket. Both require the one-time SQL setup in
// admin_briefings_setup.sql — if that hasn't been run, saves surface a clear
// "run the setup" error instead of failing silently.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { GCP } from "../lib/backend";
import { uploadMedia } from "../lib/gcpAuth";

const BRAND = {
  gold: "#FCBD00",
  obsidian: "#1A1A1A",
  card: "#242424",
  white: "#FFFFFF",
  t2: "#A8A8A8",
  tmuted: "#585858",
  border: "#333333",
  borderGold: "rgba(252,189,0,0.3)",
  danger: "#FF3B30",
  ok: "#34C759",
};

const SEVERITY_LABEL = { 5: "CRITICAL", 4: "HIGH", 3: "MEDIUM", 2: "LOW", 1: "MINIMAL" };

const input = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 4,
  background: BRAND.obsidian, border: `1px solid ${BRAND.border}`, color: BRAND.white,
  fontFamily: "Inter, sans-serif", fontSize: 13, outline: "none",
};
const label = {
  fontSize: 10, fontWeight: 700, color: BRAND.tmuted,
  letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8, display: "block",
};

export function AdminBriefings() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null);       // selected incident
  const [imageUrl, setImageUrl] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState(null);        // { type: 'ok'|'err', text }

  // At 768px and below the list and the editor stack (.r-grid), and the editor
  // opens under a 70vh list: picking an incident scrolls it into view. Keyed on
  // the id, so save() (a new object, same id) does not scroll again.
  const editorRef = useRef(null);
  useEffect(() => {
    if (sel && window.matchMedia("(max-width: 768px)").matches) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [sel?._source, sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load incidents (both regular + vendor-intel) so any hub card can be edited.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // image_url/article_body only exist after admin_briefings_setup.sql.
        // Retry without them so the list still loads pre-setup.
        const fetchTable = async (table, baseCols, orderCol) => {
          const full = await supabase.from(table)
            .select(`${baseCols},image_url,article_body`)
            .order(orderCol, { ascending: false }).limit(2000);
          if (!full.error) return full.data || [];
          const base = await supabase.from(table)
            .select(baseCols).order(orderCol, { ascending: false }).limit(2000);
          return base.data || [];
        };
        // vi_incidents was dropped from the database on 2026-07-28. The call
        // 404'd on every load of this page and contributed nothing, since the
        // error path just yields an empty list.
        const regData = await fetchTable(
          "incidents", "id,headline,entity,country,severity,primary_category,incident_day", "incident_day");
        const r = regData.map(x => ({ ...x, _source: "incident", _day: x.incident_day }));
        if (!cancelled) setRows(r);
      } catch { /* leave empty */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  function pick(row) {
    setSel(row);
    setImageUrl(row.image_url || "");
    setBody(row.article_body || "");
    setMsg(null);
  }

  async function handleUpload(file) {
    if (!file || !sel) return;
    setUploading(true);
    setMsg(null);
    try {
      // GCP backend: through the API into Cloud Storage (admin checked there).
      if (GCP) {
        setImageUrl(await uploadMedia("incident", String(sel.id), file));
        setMsg({ type: "ok", text: "Image uploaded — remember to Save." });
        return;
      }
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${sel._source}-${sel.id}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from("incident-media")
        .upload(path, file, { upsert: true, cacheControl: "3600", contentType: file.type });
      if (error) throw error;
      const { data } = supabase.storage.from("incident-media").getPublicUrl(path);
      setImageUrl(data.publicUrl);
      setMsg({ type: "ok", text: "Image uploaded — remember to Save." });
    } catch (e) {
      setMsg({ type: "err", text: `Upload failed: ${e.message || e}. Has the storage bucket been created? Run admin_briefings_setup.sql.` });
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!sel) return;
    setBusy(true);
    setMsg(null);
    try {
      const { error } = await supabase.rpc("admin_set_incident_media", {
        p_source: sel._source,
        p_incident_id: sel.id,
        p_image_url: imageUrl.trim() || null,
        p_article_body: body.trim() || null,
      });
      if (error) throw error;
      // Reflect locally so the list shows the saved state without a refetch.
      setRows(rs => rs.map(r =>
        r._source === sel._source && r.id === sel.id
          ? { ...r, image_url: imageUrl.trim() || null, article_body: body.trim() || null }
          : r));
      setSel(s => ({ ...s, image_url: imageUrl.trim() || null, article_body: body.trim() || null }));
      setMsg({ type: "ok", text: "Saved. The hub will show it on next load." });
    } catch (e) {
      setMsg({ type: "err", text: `Save failed: ${e.message || e}. Has admin_set_incident_media() been created? Run admin_briefings_setup.sql.` });
    } finally {
      setBusy(false);
    }
  }

  const needle = q.trim().toLowerCase();
  const filtered = !needle ? rows.slice(0, 60) : rows.filter(r =>
    (r.headline || "").toLowerCase().includes(needle) ||
    (r.entity || "").toLowerCase().includes(needle) ||
    (r.country || "").toLowerCase().includes(needle)
  ).slice(0, 60);

  return (
    <div className="r-grid" style={{ display: "grid", gridTemplateColumns: "minmax(320px, 420px) 1fr", gap: 24 }}>
      {/* LEFT — search + list */}
      <div>
        <input
          value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search incidents by headline, entity, country…"
          style={{ ...input, marginBottom: 12 }}
        />
        {loading ? (
          <div style={{ color: BRAND.tmuted, fontSize: 13, padding: 20 }}>Loading incidents…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "70vh", overflowY: "auto" }}>
            {filtered.map(r => {
              const active = sel && sel._source === r._source && sel.id === r.id;
              return (
                <button key={`${r._source}-${r.id}`} onClick={() => pick(r)} style={{
                  textAlign: "left", padding: "11px 13px", borderRadius: 6, cursor: "pointer",
                  background: active ? "rgba(252,189,0,0.10)" : BRAND.obsidian,
                  border: `1px solid ${active ? BRAND.borderGold : BRAND.border}`,
                  color: BRAND.white, fontFamily: "Inter, sans-serif",
                }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 5 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: BRAND.gold, letterSpacing: "0.08em" }}>
                      {SEVERITY_LABEL[r.severity] || "—"}
                    </span>
                    <span style={{ fontSize: 10.5, color: BRAND.tmuted }}>{r._day || ""}</span>
                    {r._source === "vi" && (
                      <span style={{ fontSize: 8.5, color: BRAND.tmuted, border: `1px solid ${BRAND.border}`, borderRadius: 3, padding: "1px 5px" }}>VI</span>
                    )}
                    {(r.image_url || r.article_body) && (
                      <span title="Has custom media" style={{ marginLeft: "auto", fontSize: 11, color: BRAND.ok }}>●</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35 }}>{r.headline}</div>
                  <div style={{ fontSize: 10.5, color: BRAND.tmuted, marginTop: 3 }}>
                    {[r.entity, r.country].filter(Boolean).join(" · ")}
                  </div>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ color: BRAND.tmuted, fontSize: 13, padding: 20 }}>No matching incidents.</div>
            )}
          </div>
        )}
      </div>

      {/* RIGHT — editor */}
      <div ref={editorRef} style={{ scrollMarginTop: 12 }}>
        {!sel ? (
          <div style={{
            padding: 50, textAlign: "center", color: BRAND.tmuted, fontSize: 13,
            border: `1px dashed ${BRAND.border}`, borderRadius: 10,
          }}>
            Pick an incident on the left to add a news image and article.
          </div>
        ) : (
          <div style={{ background: BRAND.card, border: `1px solid ${BRAND.border}`, borderRadius: 10, padding: 22 }}>
            <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.3, marginBottom: 4 }}>{sel.headline}</div>
            <div style={{ fontSize: 11.5, color: BRAND.tmuted, marginBottom: 22 }}>
              {[sel.entity, sel.country, sel._day].filter(Boolean).join(" · ")}
              {sel._source === "vi" ? "  ·  vendor-intel" : ""}
            </div>

            {/* IMAGE */}
            <label style={label}>News image</label>
            <input
              value={imageUrl} onChange={e => setImageUrl(e.target.value)}
              placeholder="Paste an image URL — or upload below"
              style={{ ...input, marginBottom: 10 }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{
                display: "inline-flex", alignItems: "center", gap: 8, cursor: uploading ? "default" : "pointer",
                padding: "8px 14px", borderRadius: 4, background: BRAND.obsidian,
                border: `1px solid ${BRAND.border}`, color: BRAND.white,
                fontSize: 11.5, fontWeight: 600, letterSpacing: "0.04em",
              }}>
                {uploading ? "Uploading…" : "Upload image file"}
                <input type="file" accept="image/*" disabled={uploading}
                  onChange={e => handleUpload(e.target.files?.[0])}
                  style={{ display: "none" }} />
              </label>
              {imageUrl && (
                <button onClick={() => setImageUrl("")} style={{
                  padding: "8px 12px", borderRadius: 4, cursor: "pointer",
                  background: "transparent", border: `1px solid ${BRAND.border}`,
                  color: BRAND.t2, fontSize: 11, fontWeight: 600,
                }}>Remove image</button>
              )}
            </div>
            {imageUrl && (
              <div style={{ marginTop: 12, borderRadius: 8, overflow: "hidden", border: `1px solid ${BRAND.border}`, maxWidth: 360 }}>
                <img src={imageUrl} alt="" style={{ width: "100%", height: 180, objectFit: "cover", display: "block" }}
                  onError={e => { e.currentTarget.style.opacity = "0.3"; }} />
              </div>
            )}

            {/* ARTICLE */}
            <label style={{ ...label, marginTop: 26 }}>Full article (shown in the hub reader)</label>
            <textarea
              value={body} onChange={e => setBody(e.target.value)}
              placeholder="Write or paste the full article here. Leave blank to keep using the GUARD summary."
              rows={12}
              style={{ ...input, resize: "vertical", lineHeight: 1.6, fontFamily: "Inter, sans-serif" }}
            />
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
              <label style={{
                display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer",
                padding: "8px 14px", borderRadius: 4, background: BRAND.obsidian,
                border: `1px solid ${BRAND.border}`, color: BRAND.t2,
                fontSize: 11, fontWeight: 600,
              }}>
                Load from .txt / .md
                <input type="file" accept=".txt,.md,text/plain,text/markdown"
                  onChange={async e => {
                    const f = e.target.files?.[0];
                    if (f) setBody(await f.text());
                  }}
                  style={{ display: "none" }} />
              </label>
              <span style={{ fontSize: 10.5, color: BRAND.tmuted }}>{body.length} chars</span>
            </div>

            {/* ACTIONS */}
            <div style={{ display: "flex", gap: 12, rowGap: 8, alignItems: "center", marginTop: 22, flexWrap: "wrap" }}>
              <button onClick={save} disabled={busy} style={{
                padding: "11px 24px", borderRadius: 4, cursor: busy ? "default" : "pointer",
                background: BRAND.gold, color: BRAND.obsidian, border: "none",
                fontFamily: "Inter, sans-serif", fontSize: 12.5, fontWeight: 700,
                letterSpacing: "0.06em", textTransform: "uppercase", opacity: busy ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}>{busy ? "Saving…" : "Save briefing"}</button>
              {msg && (
                <span style={{ fontSize: 12, color: msg.type === "ok" ? BRAND.ok : BRAND.danger }}>
                  {msg.text}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
