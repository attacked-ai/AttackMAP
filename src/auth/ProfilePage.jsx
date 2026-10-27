// ─────────────────────────────────────────────────────────────────────────
// ProfilePage — the signed-in user's account profile (?profile).
//
// Redesigned 2026-10-27 (owner: "properly sectionize all things"). Dark
// header band (photo, name, email, plan, industry) → light body in two
// columns: a sticky section menu with an account checklist on the left, and
// the sections on the right:
//   Personal details   name, country, photo
//   Work and industry  job title, company, industry (the industry leads the
//                      dashboard and the daily brief; nobody is asked for it
//                      after sign-in any more, so it is set here)
//   Email briefings    the daily brief on or off (profiles.email_subscribed)
//   Plan               tier, member since, manage subscription
//   Login and security SecurityPanel (login card + two-step card)
//   Sign out
// On phones the menu becomes a row of chips above the sections.
//
// Saves go through saveProfileBasics() (own-row update on public.profiles).
// The first save that gives the profile an industry stamps onboarded_at, which
// sends the welcome email (trg_welcome_on_onboarded), as the sign-up page does.
// Anonymous visitors bounce home.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { SiteNav } from "./SiteNav";
import { SiteFooter } from "./SiteFooter";
import { SecurityPanel } from "./SecurityPanel";
import { ROLES, SECTORS, tierLabel, isSubscriber } from "../lib/taxonomy";
import { WORKOS } from "../lib/workos";
import "../styles/profile.css";

const COUNTRIES = [
  "India", "United States", "United Kingdom", "United Arab Emirates",
  "Singapore", "Australia", "Canada", "Germany", "France", "Japan",
  "Saudi Arabia", "South Africa", "Brazil", "Other",
];

const SECTIONS = [
  ["details", "Personal details"],
  ["work", "Work and industry"],
  ["email", "Email briefings"],
  ["plan", "Plan"],
  ...(WORKOS ? [["security", "Login and security"]] : []),
  ["signout", "Sign out"],
];

const ICON = {
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  briefcase: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6 8.5-6" /></>,
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />,
  shield: <><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></>,
  out: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5M5 12h11" /></>,
  camera: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
};
const Glyph = ({ name, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[name]}</svg>
);
const SECTION_ICON = { details: "user", work: "briefcase", email: "mail", plan: "star", security: "shield", signout: "out" };

function Section({ id, title, text, children, aside }) {
  return (
    <section id={id} className="pf-section" aria-labelledby={`${id}-h`}>
      <header className="pf-section-head">
        <span className="pf-section-icon"><Glyph name={SECTION_ICON[id]} /></span>
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
          <h2 id={`${id}-h`}>{title}</h2>
          {text && <p>{text}</p>}
        </div>
        {aside}
      </header>
      <div className="pf-section-body">{children}</div>
    </section>
  );
}

function SaveRow({ busy, state, label = "Save changes" }) {
  return (
    <div className="pf-save">
      <button type="submit" className="pf-btn pf-btn-gold" disabled={busy}>{busy ? "Saving…" : label}</button>
      <span role="status" aria-live="polite" className={state === "error" ? "pf-msg err" : "pf-msg"}>
        {state === "saved" ? "✓ Saved" : state === "error" ? "Could not save. Please try again." : ""}
      </span>
    </div>
  );
}

export function ProfilePage() {
  const { user, profile, tier, loading, saveProfileBasics, uploadAvatar, signOut } = useAuth();
  const meta = user?.user_metadata || {};

  const [fullName, setFullName] = useState("");
  const [country, setCountry] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [company, setCompany] = useState("");
  const [industry, setIndustry] = useState("");
  const [busy, setBusy] = useState(null);            // details | work | email
  const [state, setState] = useState({});             // { [section]: "saved" | "error" }
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarErr, setAvatarErr] = useState(null);
  const [active, setActive] = useState("details");
  const fileRef = useRef(null);

  // Hydrate the forms from the profile / the sign-up answers once they resolve.
  useEffect(() => {
    if (!user) return;
    setFullName(profile?.full_name || meta.full_name || [meta.first_name, meta.last_name].filter(Boolean).join(" ") || "");
    setCountry(profile?.country || meta.country || "");
    setJobTitle(profile?.role || meta.job_title || "");
    setCompany(profile?.company || meta.company || "");
    setIndustry(profile?.industry || meta.industry || "");
  }, [profile, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Anonymous visitors don't have a profile — send them home once auth resolves.
  useEffect(() => {
    if (!loading && !user && typeof window !== "undefined") window.location.href = "/";
  }, [loading, user]);

  // The section menu follows the scroll.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = SECTIONS.map(([id]) => document.getElementById(id)).filter(Boolean);
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setActive(vis[0].target.id);
    }, { rootMargin: "-90px 0px -60% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [loading, user]);

  const checklist = useMemo(() => [
    ["Your name", !!(profile?.full_name)],
    ["Job title", !!(profile?.role)],
    ["Company", !!(profile?.company)],
    ["Industry", !!(profile?.industry)],
    ["Profile photo", !!(profile?.avatar_url)],
  ], [profile]);
  const done = checklist.filter(([, ok]) => ok).length;

  if (loading || !user) return null;

  async function persist(section, fields) {
    setBusy(section); setState((s) => ({ ...s, [section]: null }));
    const stamp = fields.industry && !profile?.onboarded_at ? { onboarded_at: new Date().toISOString() } : {};
    const r = await saveProfileBasics({ ...fields, ...stamp });
    setBusy(null);
    setState((s) => ({ ...s, [section]: r?.error ? "error" : "saved" }));
    if (!r?.error) setTimeout(() => setState((s) => ({ ...s, [section]: null })), 2600);
  }
  const saveDetails = (e) => { e.preventDefault(); persist("details", { full_name: fullName.trim() || null, country: country || null }); };
  const saveWork = (e) => { e.preventDefault(); persist("work", { role: jobTitle || null, company: company.trim() || null, ...(industry ? { industry } : {}) }); };
  const subscribed = profile?.email_subscribed !== false;
  const toggleEmail = () => persist("email", { email_subscribed: !subscribed });

  async function onPickAvatar(e) {
    const file = e.target.files && e.target.files[0];
    if (e.target) e.target.value = "";
    if (!file) return;
    setAvatarErr(null); setAvatarBusy(true);
    const res = await uploadAvatar(file);
    setAvatarBusy(false);
    if (res && res.error) setAvatarErr(res.error);
  }

  const avatarUrl = profile?.avatar_url || null;
  const initial = (fullName || user.email || "?").charAt(0).toUpperCase();
  const fmt = (iso) => { try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch { return null; } };
  const memberSince = fmt(user.created_at);
  const subscriber = isSubscriber(tier);
  const jump = (id) => (e) => { e.preventDefault(); setActive(id); document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); };

  const Photo = ({ size }) => (
    <button type="button" className="pf-avatar" style={{ width: size, height: size }} onClick={() => fileRef.current && fileRef.current.click()} disabled={avatarBusy} title="Change photo" aria-label="Change profile photo">
      {avatarUrl ? <img src={avatarUrl} alt="" /> : <span style={{ fontSize: size * 0.42 }}>{initial}</span>}
      {avatarBusy && <span className="pf-avatar-busy">…</span>}
      <span className="pf-avatar-cam"><Glyph name="camera" size={14} /></span>
    </button>
  );

  return (
    <div className="pf">
      <SiteNav />
      <input ref={fileRef} type="file" accept="image/*" onChange={onPickAvatar} style={{ display: "none" }} />

      {/* Header — dark band */}
      <section className="pf-hero">
        <div className="pf-wrap pf-hero-in">
          <Photo size={88} />
          <div className="pf-hero-copy">
            <div className="pf-eyebrow">Your profile</div>
            <h1>{fullName || "Your account"}</h1>
            <div className="pf-hero-meta">
              <span>{user.email}</span>
              <span className="pf-tag gold">{tierLabel(tier)} plan</span>
              {profile?.industry && <span className="pf-tag">{profile.industry}</span>}
              {memberSince && <span className="pf-muted">Member since {memberSince}</span>}
            </div>
            {avatarErr && <div className="pf-hero-err">{avatarErr}</div>}
          </div>
          <div className="pf-hero-actions">
            <a className="pf-btn pf-btn-gold" href="/?dashboard">Open my dashboard</a>
            <a className="pf-btn pf-btn-ghost" href="/?map">Live map</a>
          </div>
        </div>
      </section>

      <div className="pf-wrap pf-body">
        {/* Section menu + checklist */}
        <aside className="pf-side">
          <nav className="pf-menu" aria-label="Profile sections">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`} onClick={jump(id)} className={active === id ? "on" : ""} aria-current={active === id ? "true" : undefined}>
                <Glyph name={SECTION_ICON[id]} />{label}
              </a>
            ))}
          </nav>
          <div className="pf-check">
            <div className="pf-check-head"><b>Account checklist</b><span>{done} of {checklist.length}</span></div>
            <div className="pf-meter"><i style={{ width: `${(done / checklist.length) * 100}%` }} /></div>
            <ul>
              {checklist.map(([label, ok]) => (
                <li key={label} className={ok ? "ok" : ""}><span className="pf-tick">{ok ? <Glyph name="check" size={12} /> : null}</span>{label}</li>
              ))}
            </ul>
            {WORKOS && <a href="#security" onClick={jump("security")} className="pf-check-link">Add two-step verification →</a>}
          </div>
        </aside>

        <main className="pf-main">
          <Section id="details" title="Personal details" text="How you appear on Attacked.ai and on your licensed reports.">
            <form onSubmit={saveDetails}>
              <div className="pf-photo-row">
                <Photo size={56} />
                <div>
                  <b>Profile photo</b>
                  <span>JPG or PNG, under 5 MB.</span>
                  <button type="button" className="pf-link" onClick={() => fileRef.current && fileRef.current.click()} disabled={avatarBusy}>{avatarBusy ? "Uploading…" : avatarUrl ? "Change photo" : "Add a photo"}</button>
                </div>
              </div>
              <div className="pf-grid">
                <label className="pf-field"><span>Full name</span>
                  <input type="text" value={fullName} placeholder="Your name" autoComplete="name" onChange={(e) => setFullName(e.target.value)} />
                </label>
                <label className="pf-field"><span>Country</span>
                  <select value={country} onChange={(e) => setCountry(e.target.value)} className={country ? "" : "empty"}>
                    <option value="">Select country</option>
                    {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label className="pf-field pf-span"><span>Email</span>
                  <input type="email" value={user.email || ""} readOnly aria-readonly="true" className="ro" />
                  <small>Change it under Login and security.</small>
                </label>
              </div>
              <SaveRow busy={busy === "details"} state={state.details} />
            </form>
          </Section>

          <Section id="work" title="Work and industry" text="Your industry decides what your dashboard and daily brief lead with.">
            <form onSubmit={saveWork}>
              <div className="pf-grid">
                <label className="pf-field"><span>Job title</span>
                  <select value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} className={jobTitle ? "" : "empty"}>
                    <option value="">Select your job title</option>
                    {[...new Set([...(jobTitle && !ROLES.includes(jobTitle) ? [jobTitle] : []), ...ROLES])].map((j) => <option key={j} value={j}>{j}</option>)}
                  </select>
                </label>
                <label className="pf-field"><span>Company</span>
                  <input type="text" value={company} placeholder="Your organisation" autoComplete="organization" onChange={(e) => setCompany(e.target.value)} />
                </label>
                <label className="pf-field pf-span"><span>Industry</span>
                  <select value={industry} onChange={(e) => setIndustry(e.target.value)} className={industry ? "" : "empty"}>
                    <option value="">Select your industry</option>
                    {SECTORS.map(([s, list]) => <optgroup key={s} label={s}>{list.map((i) => <option key={i} value={i}>{i}</option>)}</optgroup>)}
                  </select>
                  <small>Changing it changes the incidents your dashboard opens with.</small>
                </label>
              </div>
              <SaveRow busy={busy === "work"} state={state.work} />
            </form>
          </Section>

          <Section id="email" title="Email briefings" text={`Sent to ${user.email}.`}>
            <div className="pf-toggle-row">
              <div>
                <b>Daily intelligence brief</b>
                <span>The day's incidents in {profile?.industry || "your industry"}, classified through GUARD.</span>
              </div>
              <button type="button" role="switch" aria-checked={subscribed} aria-label="Daily intelligence brief" className={`pf-switch ${subscribed ? "on" : ""}`} onClick={toggleEmail} disabled={busy === "email"}><i /></button>
            </div>
            <div role="status" aria-live="polite" className={state.email === "error" ? "pf-msg err" : "pf-msg"} style={{ marginTop: 8 }}>
              {state.email === "saved" ? (subscribed ? "✓ You'll get the daily brief." : "✓ Daily brief switched off.") : state.email === "error" ? "Could not save. Please try again." : ""}
            </div>
          </Section>

          <Section id="plan" title="Plan" text={subscriber ? "Blast radius, GUARD controls and the peer watchlist are unlocked." : "Every incident in your industry, classified. Subscribe to see who it reaches and what to do."}
            aside={<span className={`pf-tag ${subscriber ? "ok" : "gold"}`}>{tierLabel(tier)}</span>}>
            <div className="pf-facts">
              <div><span>Access</span><b>{tierLabel(tier)}</b></div>
              {memberSince && <div><span>Member since</span><b>{memberSince}</b></div>}
              <div><span>Industry</span><b>{profile?.industry || "Not set"}</b></div>
            </div>
            <div className="pf-actions">
              <a className="pf-btn pf-btn-dark" href={subscriber ? "/?subscriptions" : "/?subscribe"}>{subscriber ? "Manage subscription →" : "Subscribe →"}</a>
              <a className="pf-btn pf-btn-ghost-dark" href="/?pricing">Compare plans</a>
            </div>
          </Section>

          {WORKOS && (
            <div className="pf-security">
              <SecurityPanel />
            </div>
          )}

          <Section id="signout" title="Sign out" text="Sign out of Attacked.ai on this device.">
            <button type="button" className="pf-btn pf-btn-danger" onClick={async () => { await signOut(); window.location.href = "/"; }}>Sign out</button>
          </Section>
        </main>
      </div>

      <SiteFooter />
    </div>
  );
}
