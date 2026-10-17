// ─────────────────────────────────────────────────────────────────────────
// ProfilePage — the signed-in user's account profile (?profile).
//
// Replaces the old onboarding wizard as the "Profile" destination from the
// SiteNav account dropdown. McKinsey-style: dark header band (avatar + name +
// tier) → light body with an editable details card + quick links.
//
// Editable basics persist via saveProfileBasics() (full_name, role=job title,
// country). Email + tier are read-only. Anonymous visitors bounce home.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { SiteNav } from "./SiteNav";
import { SiteFooter } from "./SiteFooter";
import { SecurityPanel } from "./SecurityPanel";

const C = {
  paper: "#FFFFFF", paper2: "#FAFAFA", ink: "#101010", ink2: "#52525B", ink3: "#6A6A6A",
  ink4: "#9A9A98", line: "#E7E7E9", line2: "#CFCDC4",
  gold: "#FCBD00", goldDeep: "#8A6D00", obsidian: "#1A1A1A", deep: "#080808",
  err: "#C0341D", ok: "#1E7A3D",
};
const FONT = "Inter, sans-serif";

const JOB_TITLES = [
  "CEO / Founder", "CISO / Head of Security", "CIO / CTO",
  "Risk / Compliance Lead", "Security Analyst", "IT Manager",
  "Consultant / Advisor", "Board Member / Director", "Student", "Other",
];
const COUNTRIES = [
  "India", "United States", "United Kingdom", "United Arab Emirates",
  "Singapore", "Australia", "Canada", "Germany", "France", "Japan",
  "Saudi Arabia", "South Africa", "Brazil", "Other",
];

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

export function ProfilePage() {
  const { user, profile, tier, loading, saveProfileBasics, uploadAvatar, signOut } = useAuth();
  const meta = user?.user_metadata || {};

  const [fullName, setFullName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarErr, setAvatarErr] = useState(null);
  const fileRef = useRef(null);

  // Hydrate the form from profile / user metadata once they resolve.
  useEffect(() => {
    if (!user) return;
    setFullName(profile?.full_name || meta.full_name ||
      [meta.first_name, meta.last_name].filter(Boolean).join(" ") || "");
    setJobTitle(profile?.role || meta.job_title || "");
    setCountry(profile?.country || meta.country || "");
  }, [profile, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Anonymous visitors don't have a profile — send them home once auth resolves.
  useEffect(() => {
    if (!loading && !user && typeof window !== "undefined") window.location.href = "/";
  }, [loading, user]);

  if (loading || !user) return null;

  async function save(e) {
    e?.preventDefault();
    setBusy(true); setSaved(false);
    await saveProfileBasics({
      full_name: fullName.trim() || null,
      role: jobTitle || null,
      country: country || null,
    });
    setBusy(false); setSaved(true);
    setTimeout(() => setSaved(false), 2600);
  }

  // Profile picture upload — opens a file picker, uploads, shows the new photo.
  async function onPickAvatar(e) {
    const file = e.target.files && e.target.files[0];
    if (e.target) e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setAvatarErr(null); setAvatarBusy(true);
    const res = await uploadAvatar(file);
    setAvatarBusy(false);
    if (res && res.error) setAvatarErr(res.error);
  }

  const avatarUrl = profile?.avatar_url || null;
  const initial = (fullName || user.email || "?").charAt(0).toUpperCase();
  const memberSince = (() => {
    try { return new Date(user.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
    catch { return null; }
  })();

  const label = { display: "block", fontFamily: FONT, fontSize: 12, color: C.ink, fontWeight: 600, marginBottom: 6 };
  const field = {
    width: "100%", padding: "11px 13px", background: C.paper, color: C.ink,
    border: `1px solid ${C.line2}`, borderRadius: 4, boxSizing: "border-box",
    fontFamily: FONT, fontSize: 14, outline: "none",
  };
  const sel = { ...field, appearance: "none", cursor: "pointer" };
  const onFocus = (e) => (e.target.style.borderColor = C.gold);
  const onBlur = (e) => (e.target.style.borderColor = C.line2);

  const ReadRow = ({ k, v }) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "10px 0", borderTop: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 12.5, color: C.ink3, fontWeight: 600 }}>{k}</span>
      <span style={{ fontSize: 13, color: C.ink, fontWeight: 600, textAlign: "right", wordBreak: "break-word" }}>{v || "—"}</span>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: FONT, WebkitFontSmoothing: "antialiased" }}>
      <FontLoader />
      <SiteNav />
      <div style={{ height: 3, background: C.gold }} />

      {/* Header — dark band */}
      <section style={{ background: C.deep, color: "#FFFFFF", borderBottom: `1px solid #333` }}>
        <div className="r-pad" style={{ maxWidth: 720, margin: "0 auto", padding: "40px 28px 36px", display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
          {/* Avatar — click to upload a profile picture */}
          <div style={{ position: "relative", flex: "0 0 auto" }}>
            <input ref={fileRef} type="file" accept="image/*" onChange={onPickAvatar} style={{ display: "none" }} />
            <button
              type="button"
              onClick={() => fileRef.current && fileRef.current.click()}
              disabled={avatarBusy}
              title="Change photo"
              style={{
                width: 78, height: 78, borderRadius: "50%", padding: 0, overflow: "hidden",
                cursor: avatarBusy ? "default" : "pointer", position: "relative",
                border: `2px solid ${C.gold}`, background: C.gold,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}>
              {avatarUrl ? (
                <img src={avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              ) : (
                <span style={{ color: C.obsidian, fontSize: 32, fontWeight: 800 }}>{initial}</span>
              )}
              {avatarBusy && (
                <span style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>…</span>
              )}
              <span style={{
                position: "absolute", right: -2, bottom: -2, width: 28, height: 28, borderRadius: "50%",
                background: C.ink, border: "2px solid #FFFFFF", display: "inline-flex",
                alignItems: "center", justifyContent: "center", fontSize: 13,
              }}>📷</span>
            </button>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10.5, color: C.gold, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase" }}>Your profile</div>
            <h1 style={{ margin: "6px 0 0", fontSize: "clamp(24px,3vw,32px)", fontWeight: 800, letterSpacing: "-0.02em", color: "#FFFFFF" }}>
              {fullName || "Your account"}
            </h1>
            <div style={{ marginTop: 6, fontSize: 13, color: "#A8A8A8", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span>{user.email}</span>
              <span style={{
                padding: "3px 9px", borderRadius: 3, fontSize: 10, fontWeight: 700,
                letterSpacing: "0.08em", textTransform: "uppercase",
                background: "rgba(252,189,0,0.12)", color: C.gold, border: "1px solid rgba(252,189,0,0.35)",
              }}>{tier || "free"} tier</span>
            </div>
            <button type="button" onClick={() => fileRef.current && fileRef.current.click()} disabled={avatarBusy} style={{
              margin: "5px 0 -5px", background: "none", border: "none", padding: "5px 0", minHeight: 24,
              cursor: avatarBusy ? "default" : "pointer",
              color: C.gold, fontFamily: FONT, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
            }}>{avatarBusy ? "Uploading…" : (avatarUrl ? "Change photo" : "＋ Add a photo")}</button>
            {avatarErr && <div style={{ marginTop: 6, fontSize: 11.5, color: "#FF8C5A" }}>{avatarErr}</div>}
          </div>
        </div>
      </section>

      {/* Body — light */}
      <main className="r-pad" style={{ maxWidth: 720, margin: "0 auto", padding: "40px 28px 72px" }}>
        {/* Editable details */}
        <form onSubmit={save} style={{ background: C.paper2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "26px 24px" }}>
          <h2 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 800, color: C.ink, letterSpacing: "-0.01em" }}>Your details</h2>
          <p style={{ margin: "0 0 20px", fontSize: 12.5, color: C.ink3 }}>Keep this current — it personalises your briefing.</p>

          <div style={{ marginBottom: 16 }}>
            <label style={label}>Full name</label>
            <input type="text" value={fullName} placeholder="Your name"
              onChange={(e) => setFullName(e.target.value)} style={field} onFocus={onFocus} onBlur={onBlur} />
          </div>

          <div style={{ display: "flex", columnGap: 14, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 240px", marginBottom: 16 }}>
              <label style={label}>Job title</label>
              <select value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} style={{ ...sel, color: jobTitle ? C.ink : C.ink4 }} onFocus={onFocus} onBlur={onBlur}>
                <option value="">Select your job title</option>
                {JOB_TITLES.map((j) => <option key={j} value={j}>{j}</option>)}
              </select>
            </div>
            <div style={{ flex: "1 1 240px", marginBottom: 16 }}>
              <label style={label}>Country</label>
              <select value={country} onChange={(e) => setCountry(e.target.value)} style={{ ...sel, color: country ? C.ink : C.ink4 }} onFocus={onFocus} onBlur={onBlur}>
                <option value="">Select country</option>
                {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 14, rowGap: 8, marginTop: 6 }}>
            <button type="submit" disabled={busy} style={{
              padding: "11px 22px", background: busy ? "rgba(252,189,0,0.55)" : C.gold, color: C.obsidian,
              border: "none", borderRadius: 4, cursor: busy ? "default" : "pointer",
              fontFamily: FONT, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
            }}>{busy ? "Saving…" : "Save changes"}</button>
            {saved && <span style={{ fontSize: 12.5, color: C.ok, fontWeight: 600 }}>✓ Saved</span>}
          </div>
        </form>

        {/* Account info (read-only) */}
        <div style={{ marginTop: 22, background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: "20px 24px" }}>
          <h2 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 800, color: C.ink }}>Account</h2>
          <ReadRow k="Email" v={user.email} />
          <ReadRow k="Access tier" v={`${tier || "free"}`} />
          <ReadRow k="Function" v={meta.job_function} />
          {memberSince && <ReadRow k="Member since" v={memberSince} />}
        </div>

        <SecurityPanel />

        {/* Quick links */}
        <div style={{ marginTop: 22, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <a href="/?subscriptions" style={{
            padding: "12px 22px", background: C.ink, color: "#FFFFFF", textDecoration: "none",
            borderRadius: 4, fontFamily: FONT, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
          }}>Manage subscription →</a>
          <a href="/?map" style={{
            padding: "12px 22px", background: "transparent", color: C.ink, textDecoration: "none",
            border: `1px solid ${C.line2}`, borderRadius: 4, fontFamily: FONT, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
          }}>Open the live map</a>
          <button onClick={async () => { await signOut(); window.location.href = "/"; }} style={{
            marginLeft: "auto", padding: "12px 16px", background: "none", border: "none", cursor: "pointer",
            color: C.err, fontFamily: FONT, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
          }}>Sign out</button>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
