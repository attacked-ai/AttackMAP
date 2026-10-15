// reportLock.js — what the host page does inside a report frame, shared by
// the dashboard's report view and the public Attacked Hub.
//
// The real paywall is server-side since 2026-10-15: a free reader is only
// ever sent the preview (header, key figures, Executive Summary — see
// src/lib/reportPreview.js and middleware.js), so the full text never reaches
// their browser. The section lock below stays as a second layer for any HTML
// that still arrives whole (the API, a CMS report without a preview).
//
// The rule is the product's rule: what happened is free; who it reaches and
// what to do about it is subscriber. Inside a report that is three sections —
//   #r-blast  Who else is exposed
//   #r-ctrl   GUARD controls against the scenario
//   #r-vend   Vendor intelligence
// For a free reader each one is capped, blurred and carries a Subscribe button.
// Everything else in the report reads in full. Subscribers see it untouched.
//
// The report is served same-origin, so the host page reaches into the frame
// after load. prepareReportFrame() is the one entry point: call it from the
// iframe's load handler (and once more if the document is already complete).

export const LOCKED_SECTIONS = ["r-blast", "r-ctrl", "r-vend"];

const LOCK_CSS = `
  .dash-locked{position:relative;max-height:260px;overflow:hidden}
  .dash-locked::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.75) 45%,#fff 100%);pointer-events:none}
  .dash-locked > *:not(.r-sec-title):not(.dash-lock){filter:blur(4px);user-select:none}
  .dash-lock{position:absolute;left:12px;right:12px;bottom:22px;margin:0 auto;width:fit-content;max-width:calc(100% - 24px);z-index:2;display:flex;align-items:center;gap:12px;background:#0f0f0f;color:#fff;border:1px solid #FCBD00;padding:12px 16px;border-radius:10px;font:600 13px/1.3 Inter,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.28);white-space:normal}
  .dash-lock b{color:#FCBD00;font-weight:700}
  .dash-lock button{flex:none;white-space:nowrap;background:#FCBD00;color:#0f0f0f;border:0;border-radius:7px;padding:8px 12px;font:700 11px/1 Inter,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
  @media (max-width:640px){.dash-lock{white-space:normal;flex-direction:column;text-align:center}}`;

export function lockReportForFreeReader(doc, onSubscribe) {
  if (!doc || !doc.body) return 0;
  if (!doc.getElementById("dash-lock-style")) {
    const st = doc.createElement("style"); st.id = "dash-lock-style"; st.textContent = LOCK_CSS;
    doc.head.appendChild(st);
  }
  let n = 0;
  for (const id of LOCKED_SECTIONS) {
    const sec = doc.getElementById(id);
    // data-locked="server": the API already replaced this section (api/app/routers/reports.py)
    if (!sec || sec.classList.contains("dash-locked") || sec.dataset.locked) continue;
    sec.classList.add("dash-locked");
    const box = doc.createElement("div"); box.className = "dash-lock";
    box.innerHTML = "<span><b>Subscriber layer.</b> Who it reaches, and what to do about it.</span>";
    const b = doc.createElement("button"); b.type = "button"; b.textContent = "Subscribe →";
    b.onclick = () => onSubscribe?.();
    box.appendChild(b); sec.appendChild(box); n++;
  }
  return n;
}

// Responsive layer for the report shell (2026-10-07 responsive sweep). One
// text, three carriers that must stay identical:
//   - the 310 baked files, as <style id="attacked-resp"> before </head>
//     (scripted, never hand-edited);
//   - renderReport() in reportTemplate.js, for new CMS reports;
//   - prepareReportFrame() below, for CMS reports saved before this and for
//     the API srcdoc shown in the Hub and the dashboard.
// It only adds rules for sizes the shell got wrong; every other size renders
// exactly as before. The baked files get it from
// scripts/apply-report-responsive.mjs (run it with --write after any change
// here, then scripts/verify-report-responsive.mjs).
export const REPORT_RESPONSIVE_CSS = [
  "/* attacked-resp v3 (2026-10-08) */",
  // 769-1080: one column, but keep the 720px reading measure; the stacked
  // document ends clear of the floating jump pill (~70px above the bottom)
  "@media(max-width:1080px){.r-doc{grid-template-columns:minmax(0,720px)}.reader .r-doc{padding-bottom:96px}}",
  // 1081-1279: narrower rails so the article is ~590-720px, not 504px
  "@media(min-width:1081px) and (max-width:1279px){.r-doc{grid-template-columns:200px minmax(0,720px) 170px;gap:32px;padding:0 28px}}",
  // short laptops: the sticky rail never runs past the screen; its Download PDF
  // stays in view, and anything still scrolling under it fades out, not sliced
  "@media(min-width:1081px){.r-rail{max-height:calc(100vh - 88px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}.r-rail-cta{position:sticky;bottom:0;z-index:1;box-shadow:0 -18px 14px -8px var(--paper,#fff)}}",
  "@media(min-width:1081px) and (max-height:860px){.r-rail{padding:28px 0 24px;gap:18px}}",
  // the CTA blurb only where the tightened rail is still taller than the screen
  "@media(min-width:1081px) and (max-height:780px),(min-width:1081px) and (max-width:1279px) and (max-height:860px){.r-rail-cta p{display:none}}",
  // phones: cause cards, control rows, small reading text, pull quote, padding
  "@media(max-width:560px){",
  ".r-cause-top{display:grid;grid-template-columns:38px minmax(0,1fr);gap:10px 12px;padding:16px}",
  ".r-cause-meta{display:contents}",
  ".r-cause-tier{grid-column:2;align-self:center;margin:0}",
  ".r-cause-hyp{grid-column:1/-1;font-size:18px}",
  ".r-cause-body{padding:0 16px 18px}",
  ".r-ctrl{grid-template-columns:minmax(0,1fr);gap:6px 0}",
  ".r-ctrl .r-code{justify-self:start}",
  ".r-ctrl-obj,.r-ctrl-lnk{grid-column:1}",
  ".r-chip,.r-stat .s,.r-assessment,.r-cat-blurb,.r-vendor-dom{font-size:12px}",
  ".r-vendor-type,.r-vendor-ctrl-ac,.r-chips-h,.r-mobnav-pill .rm-lab,.r-vendor-map{font-size:10px}",
  ".r-pull{font-size:21px;padding-left:16px;margin:28px 0}",
  ".r-takeaway{padding:20px 18px}.r-takeaway p{font-size:16px}",
  ".r-ctrlcard,.r-scenario{padding:18px 16px}",
  "}",
  // the jump pill never wider than a 280px screen; in a host frame taller than
  // the host's screen it rides up by --host-cut (set by prepareReportFrame)
  ".r-mobnav-pill{min-width:min(286px,calc(100vw - 30px))}",
  ".r-mobnav{bottom:var(--host-cut,0px)}",
  // landscape phones: thinner reader bar, pill closer to the edge, and the
  // same small-text sizes as a portrait phone (no layout change)
  "@media(orientation:landscape) and (max-height:500px){.reader-bar{height:44px}.reader-scroll{top:44px}.r-mobnav-pill{bottom:8px;padding:7px 16px}.r-mobnav-sheet{bottom:58px}" +
    ".r-chip,.r-stat .s,.r-assessment,.r-cat-blurb,.r-vendor-dom{font-size:12px}.r-vendor-type,.r-vendor-ctrl-ac,.r-chips-h,.r-mobnav-pill .rm-lab,.r-vendor-map{font-size:10px}}",
  // vendor cards: a control code never splits across lines. Cards narrower
  // than ~478px (every 2-up card, phones) put the type pill and the code chip
  // on their own row under the vendor name; wider cards keep the one-row head.
  ".r-vendor{min-width:0;container-type:inline-size}",
  ".r-vendor-map,.r-vendor-type{white-space:nowrap}",
  ".r-vendor-head{flex-wrap:wrap;row-gap:8px}",
  ".r-vendor-head>div{flex:1 1 140px;min-width:0;overflow-wrap:anywhere}",
  "@container (max-width:439px){.r-vendor-head>div{flex-basis:calc(100% - 43px)}.r-vendor-right{flex:1 1 100%;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-left:43px}.r-vendor-map{align-self:auto}}",
  "@container (max-width:255px){.r-vendor-right{margin-left:0}}",
  "@container (max-width:205px){.r-vendor-map{white-space:normal}}",
  // print / Download PDF: never the floating jump pill
  "@media print{.r-mobnav{display:none!important}.reader .r-doc{padding-bottom:0}}",
].join("\n");

// CMS reports saved before 2026-10-07 have no jump-to-section pill, and the
// shell hides their contents rail at <=1080px. Build the same pill the baked
// shell has, from the frame's own contents list (the CSS is already there).
function addMobileNav(doc) {
  if (doc.getElementById("rMobNav")) return;
  const reader = doc.getElementById("reader"), sc = doc.getElementById("readerScroll");
  const btns = Array.from(doc.querySelectorAll(".r-nav-item"));
  const secs = btns.map((b) => ({ btn: b, el: doc.getElementById(b.getAttribute("data-target")) })).filter((s) => s.el);
  if (!reader || !sc || !secs.length) return;
  const mk = (tag, cls, id) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (id) el.id = id; return el; };
  const mob = mk("div", "r-mobnav", "rMobNav"), sheet = mk("div", "r-mobnav-sheet", "rMobSheet");
  const head = mk("div", "r-mobnav-sheet-h"); head.textContent = "Jump to section";
  const list = mk("div", "", "rMobList"); sheet.append(head, list);
  const pill = mk("button", "r-mobnav-pill", "rMobPill"); pill.type = "button";
  const ic = mk("span", "rm-ic"); ic.textContent = "☰";
  const txt = mk("span", "rm-txt"), lab = mk("span", "rm-lab"), cur = mk("span", "rm-cur", "rMobCur");
  lab.textContent = "Reading now"; cur.textContent = secs[0].btn.textContent; txt.append(lab, cur);
  const chev = mk("span", "rm-chev"); chev.textContent = "⌃";
  pill.append(ic, txt, chev); mob.append(sheet, pill); reader.appendChild(mob);
  const items = secs.map((s, i) => {
    const b = mk("button", "r-mobnav-item"); b.type = "button";
    const n = mk("span", "n"); n.textContent = String(i + 1).padStart(2, "0");
    b.append(n, doc.createTextNode(s.btn.textContent));
    b.addEventListener("click", () => { sc.scrollTo({ top: s.el.offsetTop - 18, behavior: "smooth" }); mob.classList.remove("open"); });
    list.appendChild(b); return b;
  });
  pill.addEventListener("click", () => mob.classList.toggle("open"));
  sc.addEventListener("click", () => mob.classList.remove("open"), { passive: true });
  const onScroll = () => {
    let at = 0; secs.forEach((s, i) => { if (s.el.offsetTop - sc.scrollTop <= 140) at = i; });
    cur.textContent = secs[at].btn.textContent;
    items.forEach((b, i) => b.classList.toggle("active", i === at));
  };
  sc.addEventListener("scroll", onScroll, { passive: true }); onScroll();
}

// Stamp the licence line the report prints, hide any in-report navigation the
// host page owns, and gate the subscriber sections for free readers.
export function prepareReportFrame(frame, { subscriber, onSubscribe, readerName } = {}) {
  let doc; try { doc = frame.contentDocument; } catch { return false; }
  if (!doc || !doc.body || !doc.body.children.length) return false;
  try { frame.contentWindow.__ATTACKED_LICENSE__ = { name: readerName || "Registered reader", role: subscriber ? "Subscriber" : "Free reader" }; } catch { /* noop */ }
  // .r-bar-back: the frame's own "← Back" sits under the host's back button
  // (Hub, dashboard) at <=1080px; the host owns navigation, so hide it.
  doc.querySelectorAll('a[href*="?hub"], .r-back, .r-bar-back').forEach((el) => { el.style.display = "none"; });
  // Responsive layer: always the current text, after the shell stylesheet.
  let rs = doc.getElementById("attacked-resp");
  if (!rs) { rs = doc.createElement("style"); rs.id = "attacked-resp"; doc.head.appendChild(rs); }
  if (rs.textContent !== REPORT_RESPONSIVE_CSS) rs.textContent = REPORT_RESPONSIVE_CSS;
  try { addMobileNav(doc); } catch { /* noop */ }
  // The pill is fixed to the frame's own bottom. Where the frame runs past the
  // host's screen (the dashboard on a landscape phone: 136-142px), lift it by
  // the hidden part so it is on screen without scrolling the page first.
  const host = frame.ownerDocument && frame.ownerDocument.defaultView;
  if (host && !frame.__pillKeep) {
    const keep = () => {
      if (!frame.isConnected) { host.removeEventListener("scroll", keep, true); host.removeEventListener("resize", keep); return; }
      try {
        const r = frame.getBoundingClientRect();
        const cut = Math.max(0, Math.min(r.height - 80, Math.round(r.bottom - 1 - host.innerHeight)));
        frame.contentDocument.documentElement.style.setProperty("--host-cut", cut + "px");
      } catch { /* noop */ }
    };
    frame.__pillKeep = keep;
    // capture: also hears scrolling inside the host's own scroll containers
    host.addEventListener("scroll", keep, { passive: true, capture: true });
    host.addEventListener("resize", keep);
  }
  if (frame.__pillKeep) frame.__pillKeep();
  // The editorial v3 shell (the NATS briefing) ships its header Download PDF
  // hidden; a subscriber gets it (browser print → Save as PDF).
  if (subscriber && doc.querySelector(".hdr-btn#readerPrint") && !doc.getElementById("attacked-sub-pdf")) {
    const st = doc.createElement("style"); st.id = "attacked-sub-pdf";
    st.textContent = "#readerPrint{display:inline-flex!important}";
    doc.head.appendChild(st);
  }
  if (!subscriber) lockReportForFreeReader(doc, onSubscribe);
  return true;
}
