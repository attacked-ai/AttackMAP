// Dashboard — the signed-in home. Personalised to profiles.industry.
//
// Ported from dashboard-industry/template.html (the approved prototype). Three
// views inside one shell: Your Industry, an article reader, and (removed
// profile fields), and an article view. The Attack Hub and the Attack Map
// elements were removed from the dashboard on 2026-09-22 (owner's call: the
// dashboard is the industry page only for now; both stay in git history).
//
// Tiering: free readers see every incident in their industry, classified, plus
// the COUNT of blast-radius entities / GUARD controls / peers per incident.
// Subscribers (profiles.tier = 'enterprise' | 'admin') see the rows. There is
// no application step any more — "Subscribe" flips the tier through
// set_own_subscription() (supabase/migrations/20260921_set_own_subscription.sql)
// on the subscription page (/?subscribe) — every Subscribe control in the
// dashboard opens that full page.
//
// ?preview=free|subscriber renders it without an account (industry defaults to
// Automotive & EV) so QA can click through.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { SiteNav } from "../auth/SiteNav";
import { CATEGORY_NAME, INDUSTRIES, ROLES, SECTORS, SEVERITY, isSubscriber, tierLabel } from "../lib/taxonomy";
import { loadCounts, loadIncidentDetail, loadIndustry, loadIndustryExtras, loadReportIndex, reportRefFor } from "./data";
import { incidentImage, incidentPhoto, industryPhoto } from "../lib/images";
import { prepareReportFrame } from "../lib/reportLock";
import { reportHtml } from "../lib/api";
import { fetchReportHtml } from "../lib/reports";
import "./dashboard.css";

const DEFAULT_INDUSTRY = "Automotive & EV";
const SEV_ORDER = [5, 4, 3, 2, 1];
const fmtDay = (iso) => iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
const shortDay = (iso) => iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "";
// Deep link to the same incident on the live map. The map renders ONE day at a
// time, so the day travels with the id (the map's deep-link effect also
// searches every live day as a fallback).
const mapHref = (i) => `/?map&incident=${i.id}${i.day ? `&date=${i.day}` : ""}`;
// The same incident on the Attacked Hub page, opened there.
const hubHref = (i) => "/?hub&open=" + i.id;
const previewParam = () => { try { return new URLSearchParams(window.location.search).get("preview"); } catch { return null; } };

// ── icons ──────────────────────────────────────────────────────────────────
const ICONS = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.5V21h13V9.5" /><path d="M9.5 21v-6h5v6" /></>,
  pulse: <path d="M3 12h4l2.2-6 4.2 12 2.4-6H21" />,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></>,
  ext: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>,
  radar: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 12l6-6" /></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17" cy="9" r="2.5" /><path d="M15.5 14.5a5 5 0 0 1 6 5" /></>,
  file: <><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v5h5" /><path d="M9 12h6M9 16h5" /></>,
  bars: <path d="M4 20V10M10 20V4M16 20v-7M22 20V7" />,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  industry: <><path d="M3 21V9l6 4V9l6 4V4h6v17z" /><path d="M7 17h2M11 17h2M15 17h2" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  pin: <><path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12Z" /><circle cx="12" cy="10" r="2.5" /></>,
  book: <><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v18H7.5A3.5 3.5 0 0 0 4 23z" /><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H13v18h3.5A3.5 3.5 0 0 1 20 23z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
};
const Icon = ({ name, style }) => <span className="icon" style={style}><svg viewBox="0 0 24 24">{ICONS[name]}</svg></span>;

// ── small pieces ───────────────────────────────────────────────────────────
const Sev = ({ i, small }) => <span className={`sev s${i.severity}`} style={small ? { padding: "2px 6px" } : undefined}><i />S{i.severity} {i.sevLabel || SEVERITY[i.severity]}</span>;
// The card follows the approved free-dashboard design: the incident's real
// picture on top, severity and date, headline, a readable three-line summary,
// topic chips, the sector-level signals, the source line, two actions —
// "Open in Attack Hub" opens the incident on the Attacked Hub page (/?hub&open=,
// where the full baked report shows when one exists) and "View on Map" opens
// the same incident on the live map — and, for free readers, the Premium
// strip that opens the subscription page. The Hub and the Map left the SIDEBAR on 2026-09-22; the card keeps
// its links to both (owner's call).
function IncidentCard({ i, onOpen, onSubscribe, subscriber }) {
  const report = !!reportRefFor(i.id);
  const topics = [...new Set([i.entity, i.subcat || i.catName, ...i.secondary.map((s) => s.name)].filter(Boolean))].slice(0, 3);
  return (
    <article className="incident" onClick={() => { window.location.href = hubHref(i); }}>
      <div className="inc-img" style={{ backgroundImage: `url(${incidentImage(i)})` }}>
        <img className="incident-photo" src={incidentPhoto(i)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />
      </div>
      <div className="inc-body">
      <div className="inc-top"><Sev i={i} /><span className="inc-date">{fmtDay(i.day)}</span><span className="inc-chev">›</span></div>
      <h3>{i.headline}</h3>
      <p className="inc-sum">{i.summary}</p>
      <div className="inc-chips">{topics.map((t) => <span key={t} title={t}>{t}</span>)}</div>
      <div className="inc-sig-label">Sector signals</div>
      <div className="inc-chips">
        {/* Criticality carries the severity level as a class so it takes the
            brand RAG scale; the GUARD chip is filled with its own category
            colour from the token set (--gc-CYB, --gc-OPS, …). */}
        <span className={`crit c${i.severity || 3}`}>Criticality: {i.sevLabel}</span>
        <span className="gchip" data-guard={i.cat} style={{ background: `var(--gc-${i.cat})` }}>
          <span className="code">{i.cat}</span>{i.catName}
        </span>
        {i.country ? <span>{i.country}</span> : null}
      </div>
      <div className="inc-src"><Icon name="link" />Attacked.ai intelligence{i.n && i.n.sources ? ` · ${i.n.sources} sources` : ""}</div>
      <div className="inc-actions">
        <a className="btn btn-dark" href={hubHref(i)} onClick={(e) => e.stopPropagation()}>Open in Attack Hub →</a>
        <a className="btn" href={mapHref(i)} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}><Icon name="pin" style={{ width: 13, height: 13, flexBasis: 13 }} /> View on Map</a>
      </div>
      {!subscriber && (
        <button className="inc-premium" onClick={(e) => { e.stopPropagation(); onSubscribe(); }}><span className="lk"><Icon name="lock" /></span><span>What could this mean for us?</span><span className="end">Premium →</span></button>
      )}
      </div>
    </article>
  );
}

// Deterministic scatter of incidents on a faint graticule (masthead + map card).
function ArtCanvas({ points, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const draw = () => {
      const r = c.getBoundingClientRect(); if (r.width < 16 || r.height < 16) return;
      const dpr = window.devicePixelRatio || 1; c.width = r.width * dpr; c.height = r.height * dpr;
      const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, r.width, r.height);
      g.strokeStyle = "rgba(255,255,255,.07)"; g.lineWidth = 1;
      for (let k = 0; k <= 8; k++) { const x = k * r.width / 8; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, r.height); g.stroke(); }
      for (let k = 0; k <= 4; k++) { const y = k * r.height / 4; g.beginPath(); g.moveTo(0, y); g.lineTo(r.width, y); g.stroke(); }
      for (const i of points.slice(0, 60)) {
        const s = Math.sin(i.id * 12.9898) * 43758.5453, t = Math.sin(i.id * 78.233) * 43758.5453;
        const x = 20 + (s - Math.floor(s)) * (r.width - 40), y = 20 + (t - Math.floor(t)) * (r.height - 40);
        const rad = 1.5 + i.severity * 0.7;
        g.fillStyle = i.severity >= 4 ? "rgba(252,189,0,.95)" : "rgba(252,189,0,.45)";
        g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
        if (i.severity >= 4) { g.strokeStyle = "rgba(252,189,0,.25)"; g.beginPath(); g.arc(x, y, rad + 6, 0, Math.PI * 2); g.stroke(); }
      }
    };
    draw(); window.addEventListener("resize", draw); return () => window.removeEventListener("resize", draw);
  }, [points]);
  return <canvas ref={ref} className={className} />;
}

// ── views ──────────────────────────────────────────────────────────────────
function YourIndustry({ P, name, subscriber, query, onOpen, onSubscribe, go }) {
  const [filter, setFilter] = useState("all");
  useEffect(() => { setFilter("all"); }, [P.industry]);
  const h = new Date().getHours();
  const greeting = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const top = P.cats[0];
  const q = query.trim().toLowerCase();
  const cards = P.incidents.filter((i) => (filter === "all" || i.cat === filter) && (!q || `${i.headline} ${i.summary} ${i.entity} ${i.country}`.toLowerCase().includes(q)));
  const latest = P.latest.filter((i) => i.industry !== P.industry).slice(0, 6);
  const max = Math.max(...P.cats.map((c) => c.n), 1);
  const gridRef = useRef(null);
  // Width of the longest word of the industry name, in ems of the masthead
  // headline (Inter 800, measured: at most .58em per letter for 11+ letter
  // words, .63em for shorter ones). dashboard.css scales the headline down to
  // fit its column only when that word would not fit, so "Telecommunications"
  // stays whole on phones instead of breaking mid-word.
  const longest = Math.max(...P.industry.split(/\s+/).map((w) => w.length));
  const fitEm = (longest * (longest >= 11 ? 0.58 : 0.63)).toFixed(2);
  return (
    <div className="content">
      <section className="masthead no-band">
        <div className="mast-copy">
          <div className="mast-eyebrow">
            <span className="live" />
            <span>Your industry</span>
            <span className="sep">·</span>
            <span>{P.industry}</span>
            <span className="sep">·</span>
            <span className="mono">Updated {fmtDay(P.latestDay)}</span>
          </div>
          <h1>{greeting}, {name}<strong style={{ "--fit": fitEm }}>{P.industry}</strong></h1>
          <p><b>{P.total} incidents</b> in {P.industry} sit in the Attacked.ai corpus, <b>{P.week} of them this week</b> and <b>{P.critical} rated High or Critical</b>. {top ? <>The category landing hardest on your industry right now is <b>{top.name}</b> ({top.n}).</> : null} Every one is classified through the GUARD framework, geolocated, and traced to the companies in its blast radius.</p>
          <div className="mast-actions">
            <div className="mast-meta">
              <b>{subscriber ? "Subscriber plan" : "Free plan"}</b>
              <span>·</span>
              <span>{subscriber ? "Blast radius, GUARD controls and peer watchlist unlocked" : "Every incident in your industry, classified"}</span>
            </div>
          </div>
        </div>
        <div className="mast-art" aria-hidden="true"
             style={{ backgroundImage: `url(${incidentImage({ cat: P.cats?.[0]?.cat })})`, backgroundSize: "cover", backgroundPosition: "58% 55%" }}>
          <img className="mast-photo" src={industryPhoto(P.incidents, P.cats?.[0]?.cat)}
               alt="" width="1220" height="860" decoding="async" fetchpriority="high"
               onError={(e) => { e.currentTarget.style.display = "none"; }} />
        </div>
      </section>

      <div className="grid">
        <section className="panel">
          <div className="panel-head">
            <div><h2>Latest in {P.industry}</h2><p>Every incident in your industry, classified through the 13 GUARD categories. Newest first.</p></div>
            <div className="section-actions"><span className="archive-link"><b>{P.total}</b> in archive</span></div>
          </div>
          <div className="filter-row">
            <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All <span className="n">{P.total}</span></button>
            {P.cats.map((c) => (
              <button key={c.code} className={`chip ${filter === c.code ? "active" : ""}`} title={c.name} onClick={() => setFilter(c.code)}>
                <span className="gdot" style={{ background: `var(--g-${c.code})` }} />{c.name} <span className="n">{c.n}</span>
              </button>
            ))}
          </div>
          <div className="incident-grid" ref={gridRef}>
            {cards.length ? cards.map((i) => <IncidentCard key={i.id} i={i} onOpen={onOpen} onSubscribe={onSubscribe} subscriber={subscriber} />)
              : <div className="empty">No {filter === "all" ? "" : filter + " "}incidents match{q ? ` “${q}”` : ""}.</div>}
          </div>
        </section>

        <aside className="right">
          <section className="panel today">
            <h2>Latest across all sectors</h2>
            <p>The most recent high-severity incidents beyond your industry.</p>
            <div>{latest.map((i) => <div key={i.id} className="feed-item" onClick={() => onOpen(i)}><Sev i={i} /><div className="feed-title">{i.headline}<small>{i.industry || i.sector || ""} · {i.country || ""}</small></div></div>)}</div>
          </section>

          {!subscriber && (
          <section className="panel tiers">
              <h3>What free shows. What subscribing adds.</h3>
              <p>Free keeps you current at industry level. Subscribing opens the operational layer behind every incident.</p>
              <div className="split">
                <div className="mini-tier"><b>Free</b><ul><li>Every incident, GUARD-classified</li><li>Severity and rationale</li><li>Daily brief to your inbox</li><li>Live map and Attack Hub</li></ul></div>
                <div className="mini-tier sub"><b>Subscriber</b><ul><li>Named blast radius</li><li>Adaptive GUARD controls</li><li>Peer watchlist</li><li>Historical analogues</li><li>Vendor defence ratings</li></ul></div>
              </div>
            </section>
          )}
        </aside>
      </div>

      <section className="panel sector">
        <div className="panel-head">
          <div><h2>Your industry through the GUARD lens</h2><p>{P.total} incidents across {P.cats.length} of the 13 GUARD categories.</p></div>
        </div>
        <div className="sector-wrap">
          <div className="cat-bars"><h3>Where the risk is landing</h3><p>Incidents in your industry by primary GUARD category. Click a bar to filter the cards above.</p>
            <div>{P.cats.map((c) => <div key={c.code} className="bar" style={{ "--bar-c": `var(--g-${c.code})`, "--bar-fill": `var(--gc-${c.code})` }} onClick={() => { setFilter(c.code); gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}><span className="code">{c.code}</span><div className="track"><div className="fill" style={{ width: `${Math.max(3, c.n / max * 100)}%` }} /><span className="lbl">{c.name}</span></div><span className="n">{c.n}</span></div>)}</div>
          </div>
          <section className="briefs">
            <div className="briefs-head"><div><h3>Latest long-form briefings</h3><p>Full analyst write-ups for incidents in your industry.</p></div><span className="briefs-count">{P.briefings} available</span></div>
            <div>{P.briefs.length ? P.briefs.slice(0, 5).map((i) => <button key={i.id} className="brief-row" onClick={() => onOpen(i)}><Icon name="book" style={{ color: "#6A6A6A" }} /><span><b>{i.headline}</b><span>{i.entity || ""} · {i.catName}</span></span><span className="brief-date">{shortDay(i.day)} →</span></button>)
              : <div className="empty" style={{ textAlign: "center" }}>No long-form briefings yet for this industry. The incident cards above are live.</div>}</div>
          </section>
        </div>
        <div className="sector-note">Everything on this page is live data from the Attacked.ai corpus, filtered to the industry you gave us at sign-up. Tell us if it should change and we will move it.</div>
      </section>
    </div>
  );
}

// "Your plan" — the one place a signed-in reader sees their tier and switches
// it. The nav's "Manage subscription" lands here (?subscriptions → alerts).
function ReportFrame({ i, reportRef, subscriber, onSubscribe, readerName }) {
  const ref = useRef(null);
  // The report scrolls inside its own .reader wrapper (body overflow hidden),
  // so the frame fills the viewport below the bar and the report scrolls
  // within it — the same framing the ?hub page uses.
  const [h, setH] = useState(800);
  // With the API on, the report arrives with the lock already applied by the
  // server and is shown through srcdoc (same-origin, so the frame can still be
  // reached). Off, or unreachable: the static file plus the client-side lock.
  const [doc, setDoc] = useState(undefined);
  useEffect(() => {
    let dead = false; setDoc(undefined);
    // CMS report (hub_reports, via src/lib/reports.js) → API → static file.
    fetchReportHtml(reportRef)
      .then((cms) => cms || reportHtml(reportRef))
      .then((html) => { if (!dead) setDoc(html || null); })
      .catch(() => { if (!dead) setDoc(null); });
    return () => { dead = true; };
  }, [reportRef]);
  // Frame height: the room under the report bar at the top of the page, so
  // the whole report view fits the screen and only the frame scrolls. Where
  // that room is too short to read in (landscape phones), the frame instead
  // fills the screen under the pinned bars, one page scroll down.
  // The same goes for narrow, short phones (Fold cover 280px, SE 1st gen
  // 320px), where the back row and the wrapped meta line leave the frame less
  // than 60% of the screen (every other size leaves 62% or more): there the
  // frame takes the whole screen under the pinned bars and the page scrolls
  // that header block away.
  // `doc` re-runs this once the iframe has mounted (it renders only after the
  // report HTML has arrived); measured from the page top, so a scrolled page
  // gives the same height.
  useEffect(() => {
    const fit = () => {
      const fr = ref.current; if (!fr) return;
      const top = fr.getBoundingClientRect().top + window.scrollY;
      const nav = document.querySelector(".dash > header[role='banner']");
      const tb = document.querySelector(".dash .topbar");
      const pinned = (nav ? nav.offsetHeight : 64) + (tb && getComputedStyle(tb).position === "sticky" ? tb.offsetHeight : 0);
      const room = Math.round(window.innerHeight - top - 6);
      const cap = window.innerHeight - pinned - 8;
      if (room >= 300 && room < window.innerHeight * 0.6) setH(Math.max(room, cap));
      else setH(room >= 300 ? room : Math.max(room, Math.min(480, cap)));
    };
    fit(); window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [reportRef, doc]);
  useEffect(() => {
    const fr = ref.current; if (!fr) return;
    const onLoad = () => { prepareReportFrame(fr, { subscriber, onSubscribe, readerName }); };
    fr.addEventListener("load", onLoad);
    if (fr.contentDocument?.readyState === "complete" && fr.contentDocument.body?.children.length) onLoad();
    return () => { fr.removeEventListener("load", onLoad); };
  }, [reportRef, subscriber, onSubscribe, readerName, doc]); // doc: the frame mounts only once the API answered
  if (doc === undefined) return <div className="panel empty mono" style={{ margin: 22 }}>Loading the report…</div>;
  return doc
    ? <iframe ref={ref} className="report-frame" srcDoc={doc} title={i.headline} style={{ height: h }} />
    : <iframe ref={ref} className="report-frame" src={`/reports/${encodeURIComponent(reportRef)}.html`} title={i.headline} style={{ height: h }} />;
}

function ArticleView({ i: incoming, subscriber, back, backLabel, onSubscribe, readerName }) {
  const reportRef = reportRefFor(incoming.id);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  // Rows from the Hub / cross-sector lists arrive without counts; fetch them
  // on open so the locked panel and the info strip are real, never zero.
  const [counts, setCounts] = useState(incoming.n);
  useEffect(() => { let dead = false; setCounts(incoming.n); if (!incoming.n) loadCounts(incoming.id).then((n) => { if (!dead) setCounts(n); }).catch(() => {}); return () => { dead = true; }; }, [incoming.id]); // eslint-disable-line
  const i = useMemo(() => ({ ...incoming, n: counts || { sources: 0, blast: 0, peers: 0, controls: 0, analogues: 0 } }), [incoming, counts]);
  useEffect(() => {
    let dead = false; setDetail(null); setErr(null);
    if (!subscriber) return;
    // The technical error goes to the console; readers get plain words.
    loadIncidentDetail(i.id).then((d) => { if (!dead) setDetail(d); }).catch((e) => { console.error("[dashboard] subscriber layer failed to load:", e); if (!dead) setErr("Could not load the subscriber layer right now. Please try again in a few minutes."); });
    return () => { dead = true; };
  }, [i.id, subscriber]);
  const paras = (i.body || "").split(/\n{2,}|\r?\n(?=\S)/).map((p) => p.trim()).filter(Boolean);
  const facts = [["Entity", i.entity], ["Where", i.place || i.country], ["Industry", i.industry], ["Sector", i.sector], ["Confidence", i.confidence], ["Sources", i.n.sources]].filter(([, v]) => v);
  if (reportRef) {
    return (
      <div className="content subpage article-wrap report-wrap">
        <div className="report-bar">
          <button className="back" onClick={back}>← {backLabel}</button>
          <div className="report-bar-meta"><Sev i={i} /><span className="cat">{i.cat} · {i.subcat || i.catName}</span><span className="mono" style={{ fontSize: 11, color: "var(--muted-light)" }}>{fmtDay(i.day)}</span><span className="mono" style={{ fontSize: 11, color: "var(--gold-text, #8A6D00)" }}>Full report · {reportRef}</span></div>
          <a className="btn" href={mapHref(i)} target="_blank" rel="noopener"><Icon name="pin" style={{ width: 13, height: 13, flexBasis: 13 }} /> On map</a>
        </div>
        <ReportFrame i={i} reportRef={reportRef} subscriber={subscriber} onSubscribe={onSubscribe} readerName={readerName} />
      </div>
    );
  }
  return (
    <div className="content subpage article-wrap">
      <button className="back" onClick={back}>← {backLabel}</button>
      <article className="panel article">
        <div className="article-meta"><Sev i={i} /><span className="cat">{i.cat} · {i.subcat || i.catName}</span><span className="mono" style={{ fontSize: 11, color: "var(--muted-light)" }}>{fmtDay(i.day)}</span><a className="btn" style={{ marginLeft: "auto", height: 32 }} href={mapHref(i)} target="_blank" rel="noopener"><Icon name="pin" style={{ width: 12, height: 12, flexBasis: 12 }} /> On map</a></div>
        <h1>{i.headline}</h1>
        <p className="dek">{i.summary}</p>
        <div className="article-info">{facts.map(([k, v]) => <span key={k}>{k} <b>{v}</b></span>)}</div>
        <div className="article-body">
          <div className="copy">
            {paras.length ? <><h2>The briefing</h2>{paras.map((p, k) => <p key={k}>{p}</p>)}</> : <><h2>What happened</h2><p>{i.summary}</p></>}
            {i.rationale ? <><h2>Why it is rated S{i.severity}</h2><p className="rationale">{i.rationale}</p></> : null}
            {/* Chip size and spacing live in dashboard.css (.article-body .copy .chip), where a label wider than the column wraps inside its chip. */}
            {i.secondary.length ? <><h2>Secondary GUARD mappings</h2><p>{i.secondary.map((s, k) => <span key={k} className="chip"><span className="n">{s.cat}</span>{s.name}</span>)}</p></> : null}
            {subscriber && detail && (
              <>
                <h2>Named blast radius <span className="mono" style={{ fontSize: 12, color: "var(--gold-text, #8A6D00)" }}>{detail.blast.length}</span></h2>
                {detail.blast.length ? detail.blast.map((b) => <p key={b.id}><b>{b.name}</b>{b.country ? ` · ${b.country}` : ""}{b.exposure_group ? ` · ${b.exposure_group}` : ""}{b.reason ? <><br />{b.reason}</> : null}{b.recommended_action_for_them ? <><br /><span className="rationale" style={{ display: "inline-block", marginTop: 6 }}>{b.recommended_action_for_them}</span></> : null}</p>) : <p>No named entities recorded for this incident.</p>}
                <h2>Adaptive GUARD controls <span className="mono" style={{ fontSize: 12, color: "var(--gold-text, #8A6D00)" }}>{detail.controls.length}</span></h2>
                {detail.controls.length ? detail.controls.map((c) => <p key={c.id}><b className="mono" style={{ fontSize: 12 }}>{c.control_id}</b> {c.statement}{c.rationale ? <><br /><span style={{ color: "var(--muted-light)" }}>{c.rationale}</span></> : null}</p>) : <p>No controls mapped.</p>}
                <h2>Peer watchlist <span className="mono" style={{ fontSize: 12, color: "var(--gold-text, #8A6D00)" }}>{detail.peers.length}</span></h2>
                {detail.peers.length ? detail.peers.map((p) => <p key={p.id}><b>{p.name}</b>{p.country ? ` · ${p.country}` : ""}{p.exposure_reason ? <><br />{p.exposure_reason}</> : null}</p>) : <p>No peers flagged.</p>}
                <h2>Historical analogues <span className="mono" style={{ fontSize: 12, color: "var(--gold-text, #8A6D00)" }}>{detail.analogues.length}</span></h2>
                {detail.analogues.length ? detail.analogues.map((a) => <p key={a.id}><b>{a.event_name}</b>{a.entity ? ` · ${a.entity}` : ""}{a.year ? ` · ${a.year}` : ""}{a.summary ? <><br />{a.summary}</> : null}{a.outcome ? <><br /><span style={{ color: "var(--muted-light)" }}>Outcome: {a.outcome}</span></> : null}</p>) : <p>No analogues matched.</p>}
                {detail.sources.length ? <><h2>Sources</h2>{detail.sources.map((s) => <p key={s.id}><a href={s.url} target="_blank" rel="noopener" style={{ textDecoration: "underline" }}>{s.title || s.url}</a>{s.publisher ? <span style={{ color: "var(--muted-light)" }}> · {s.publisher}</span> : null}</p>)}</> : null}
              </>
            )}
            {subscriber && !detail && !err && <p className="mono" style={{ color: "var(--muted-light)" }}>Loading the subscriber layer…</p>}
            {err && <p style={{ color: "#B21F31" }}>{err}</p>}
          </div>
          <aside>
            <div className="facts"><h3>GUARD classification</h3><div className="fact"><span>Primary category</span><b>{i.cat} · {i.catName}</b></div><div className="fact"><span>Subcategory</span><b>{i.subcat || "—"}{i.subcode ? <> <span className="mono" style={{ fontSize: 11, color: "var(--muted-light)" }}>{i.subcode}</span></> : null}</b></div><div className="fact"><span>Severity</span><b>S{i.severity} · {i.sevLabel}</b></div><div className="fact"><span>Access</span><b>{subscriber ? "Subscriber · full view" : "Free · industry view"}</b></div></div>
            {!subscriber && (
              <div className="locked"><div className="lk-head">Subscriber layer · locked</div>
                <div className="row"><span>Named blast radius</span><b>{i.n.blast}</b></div>
                {i.n.blast ? <div className="row"><span className="blur">{Array.from({ length: Math.min(i.n.blast, 3) }, () => "Exposed company · exposure channel").join(" · ")}</span><span /></div> : null}
                <div className="row"><span>Adaptive GUARD controls</span><b>{i.n.controls}</b></div>
                <div className="row"><span>Peer watchlist</span><b>{i.n.peers}</b></div>
                <div className="row"><span>Historical analogues</span><b>{i.n.analogues}</b></div>
                <button onClick={onSubscribe}>See who is exposed →</button>
              </div>
            )}
          </aside>
        </div>
      </article>
    </div>
  );
}

// ── shell ──────────────────────────────────────────────────────────────────
// Every Subscribe control in the dashboard opens the full subscription page.
const openSubscribe = () => { window.location.href = "/?subscribe"; };

export function Dashboard({ initialPage = "dashboard" }) {
  const { user, tier, profile, loading: authLoading, signOut, setSubscribed, saveProfileBasics } = useAuth();
  const preview = previewParam();
  const subscriber = isSubscriber(tier);
  // The industry comes from the profile row, or — before that row has been
  // read, or if the write after sign-up failed — from the sign-up details kept
  // on the session (user_metadata). So a reader who chose an industry at
  // sign-up is never asked again; the picker below is only for accounts that
  // genuinely have none (older accounts, social sign-ins).
  const metaIndustry = user?.user_metadata?.industry || null;
  const [industry, setIndustry] = useState(() => profile?.industry || metaIndustry || (preview ? DEFAULT_INDUSTRY : null));
  useEffect(() => { const want = profile?.industry || metaIndustry; if (want && want !== industry) setIndustry(want); }, [profile?.industry, metaIndustry]); // eslint-disable-line
  // Profile row without an industry but sign-up details with one: repair the row once.
  useEffect(() => { if (user && profile && !profile.industry && metaIndustry) saveProfileBasics({ industry: metaIndustry }); }, [user, profile?.industry, metaIndustry]); // eslint-disable-line
  const [page, setPage] = useState(initialPage);
  const [lastPage, setLastPage] = useState("dashboard");
  const [article, setArticle] = useState(null);
  const [query, setQuery] = useState("");
  const [P, setP] = useState(null);
  const [err, setErr] = useState(null);
  const [reportsReady, setReportsReady] = useState(false);
  useEffect(() => { loadReportIndex().then(() => setReportsReady(true)); }, []);
  // The shared navbar sits above the app shell and the sidebar is fixed, so the
  // sidebar has to start below it. Measured rather than hard-coded, because the
  // navbar grows a second row on narrow screens.
  const [navH, setNavH] = useState(73);
  useEffect(() => {
    const el = document.querySelector(".dash > header[role='banner']");
    if (!el) return;
    const set = () => setNavH(el.offsetHeight || 73);
    set();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(set); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [menu, setMenu] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const toast = useCallback((m) => { setToastMsg(m); setTimeout(() => setToastMsg(null), 2400); }, []);
  // The open profile menu also closes on Escape, and once the page has
  // scrolled away from it (on landscape phones the topbar scrolls off while
  // the fixed menu would stay). A tap outside closes it via .profile-backdrop.
  useEffect(() => {
    if (!menu) return;
    const y0 = window.scrollY;
    const onKey = (e) => { if (e.key === "Escape") setMenu(false); };
    const onScroll = () => { if (Math.abs(window.scrollY - y0) > 40) setMenu(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onScroll); };
  }, [menu]);

  useEffect(() => {
    if (!industry) return;
    let dead = false; setP(null); setErr(null);
    loadIndustry(industry)
      .then((d) => { if (dead) return; setP(d); return loadIndustryExtras(industry).then((x) => { if (!dead) setP((p) => p && p.industry === industry ? { ...p, ...x } : p); }); })
      // Backend errors (e.g. the service being restricted) are technical text:
      // logged for us, a short plain message for the reader.
      .catch((e) => { console.error("[dashboard] industry failed to load:", e); if (!dead) setErr("Could not load your industry right now. Please refresh the page or try again in a few minutes."); });
    return () => { dead = true; };
  }, [industry]);
  const go = useCallback((p) => { setPage(p); setSideOpen(false); setMenu(false); window.scrollTo({ top: 0, behavior: "smooth" }); }, []);
  const openArticle = useCallback((i) => { setLastPage(page); setArticle(i); go("article"); }, [page, go]);
  const name = useMemo(() => {
    const full = profile?.full_name || user?.user_metadata?.full_name || user?.user_metadata?.first_name || "";
    if (full) return full.split(" ")[0];
    return user?.email ? user.email.split("@")[0] : "there";
  }, [profile, user]);
  const initials = useMemo(() => (profile?.full_name || user?.email || "AI").split(/[\s@]/).slice(0, 2).map((s) => s[0]?.toUpperCase() || "").join("") || "AI", [profile, user]);


  // First-run: an account with no industry yet (older sign-ups) picks one here.
  if (!industry) {
    return (
      <div className="dash"><SiteNav /><div className="content" style={{ maxWidth: 620, paddingTop: 60 }}>
        <section className="panel settings-card">
          <h2>Which industry should your dashboard lead with?</h2>
          <p>Your account has no industry on file yet. Pick one and we will build your view around it. Tell us if it should change later.</p>
          <div className="field"><label>Primary industry</label>
            <select defaultValue="" onChange={async (e) => { const v = e.target.value; if (!v) return; await saveProfileBasics({ industry: v }); setIndustry(v); }}>
              <option value="" disabled>Select your industry</option>
              {SECTORS.map(([s, list]) => <optgroup key={s} label={s}>{list.map((i) => <option key={i} value={i}>{i}</option>)}</optgroup>)}
            </select>
          </div>
          {authLoading ? <p className="mono" style={{ color: "var(--muted-light)" }}>Loading your profile…</p> : null}
        </section>
      </div></div>
    );
  }

  return (
    <div className="dash">
      <SiteNav />
      <div className="app" style={{ minHeight: `calc(100vh - ${navH}px)` }}>
        <aside className={`sidebar ${sideOpen ? "open" : ""}`} style={{ top: navH }}>
          <div className="side-label">Intelligence</div>
          <nav className="nav">
            <button className={`nav-btn ${page === "dashboard" || (page === "article" && lastPage === "dashboard") ? "active" : ""}`} onClick={() => go("dashboard")}><Icon name="home" />Your Industry</button>
          </nav>
          <div className="side-label">Subscriber</div>
          <nav className="nav">
            {[["radar", "Blast Radius"], ["shield", "GUARD Controls"], ["users", "Peer Watchlist"]].map(([ic, lbl]) => (
              <button key={lbl} className="nav-btn" onClick={() => subscriber ? go("dashboard") : openSubscribe()}><Icon name={ic} />{lbl}<span className="tag" style={subscriber ? { background: "rgba(52,199,89,.18)", color: "#34C759" } : undefined}>{subscriber ? "ON" : "LOCKED"}</span></button>
            ))}
            <a className="nav-btn" href="/?subscribe"><Icon name="file" />Subscription</a>
          </nav>
          <div className="side-spacer" />
          {!subscriber && (
            <div className="upgrade-card">
              <div className="eyebrow">Subscribe</div>
              <h4>See who is exposed, not just what happened.</h4>
              <p>Named blast radius, adaptive GUARD controls and the peer watchlist on every incident in your industry.</p>
              <button onClick={() => openSubscribe()}>Subscribe →</button>
            </div>
          )}
          <div className="side-footer">Free: every incident in your industry, classified.<br />Subscriber: who it reaches and what to do.</div>
        </aside>
        {/* Phone drawer backdrop (CSS shows it only at <=760px): dims the page and closes the drawer on tap. */}
        <div className={`side-backdrop ${sideOpen ? "open" : ""}`} style={{ top: navH }} onClick={() => setSideOpen(false)} aria-hidden="true" />

        <main className="main">
          <header className="topbar">
            <button className="mobile-menu" aria-label="Dashboard sections" aria-expanded={sideOpen} onClick={() => setSideOpen(!sideOpen)}><Icon name="sidebar" /></button>
            <div className="search"><svg viewBox="0 0 24 24">{ICONS.search}</svg><input type="search" placeholder="Search incidents, companies or countries…" value={query} onChange={(e) => setQuery(e.target.value)} /><span className="shortcut">⌘ K</span></div>
            <div className="top-spacer" />
            {preview && <div className="persona"><span>Preview as</span><select value={industry} onChange={(e) => setIndustry(e.target.value)}>{INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}</select></div>}
            <button type="button" className="profile" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <div className="avatar">{initials}</div>
              <div className="profile-copy"><strong>{profile?.full_name || user?.email || "Preview"}</strong><span>{tierLabel(tier).toUpperCase()} · {industry}</span></div>
              <svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5" /></svg>
            </button>
          </header>

          {err && <div className="content"><div className="panel empty" style={{ color: "#B21F31" }}>{err}</div></div>}
          {!P && !err && <div className="content"><div className="panel empty mono">Loading {industry}…</div></div>}
          {P && page === "dashboard" && <YourIndustry P={P} name={name} subscriber={subscriber} query={query} onOpen={openArticle} onSubscribe={() => openSubscribe()} go={go} />}
          {P && page === "article" && article && <ArticleView key={`${article.id}-${reportsReady}`} readerName={profile?.full_name || user?.email || ""} i={article} subscriber={subscriber} back={() => go(lastPage)} backLabel="Back to your industry" onSubscribe={() => openSubscribe()} />}
        </main>
      </div>

      {menu && <div className="profile-backdrop" onClick={() => setMenu(false)} aria-hidden="true" />}
      {menu && (
        <div className="profile-menu open" style={{ top: navH + 54 }}>
          <a href="/?profile">Profile</a>
          {subscriber && user && tier !== "admin" && <button onClick={async () => { try { await setSubscribed(false); toast("Subscription switched off."); } catch (e) { console.error("[dashboard] switching off the subscription failed:", e); toast("Could not switch off the subscription. Please try again."); } setMenu(false); }}>Switch off subscription</button>}
          {!subscriber && <button onClick={() => { setMenu(false); openSubscribe(); }}>Subscribe</button>}
          <a href="/?home">Landing page</a>
          <button onClick={() => { setMenu(false); user ? signOut() : (window.location.href = "/?home"); }}>{user ? "Sign out" : "Exit preview"}</button>
        </div>
      )}
      <div className={`toast ${toastMsg ? "show" : ""}`}><div className="tick">✓</div><span>{toastMsg || ""}</span></div>
    </div>
  );
}
