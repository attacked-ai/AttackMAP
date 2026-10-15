// reportTemplate.js — renders a CMS-authored intelligence report into the SAME
// standalone HTML shell as the 310 baked briefings in public/reports/, so a
// report written in the admin console looks like one that came out of the
// pipeline: same stylesheet (reportShellCss.js, extracted verbatim), same
// section ids — which is also what keeps the free-reader lock working
// (src/lib/reportLock.js locks #r-blast, #r-ctrl and #r-vend).
//
// The editor writes each section in Markdown; empty sections are left out.
// Brand controls (accent colour, light/dark, typeface, heading weight) become
// CSS-variable overrides on top of the shell stylesheet, so a client-branded
// edition is a handful of variables, not a second template.

import { marked } from "marked";
import { REPORT_SHELL_CSS } from "./reportShellCss";
import { REPORT_RESPONSIVE_CSS } from "./reportLock";
import { PREVIEW_MARK, PRINT_BLOCK_CSS, SUBSCRIBE_JS } from "./reportPreview";

export const REPORT_SECTIONS = [
  { id: "r-sum",     num: "",   eyebrow: "Executive summary",                         title: "",                                     key: "summary",     hint: "The bottom line. 3–6 short paragraphs or bullets. Always shown first." },
  { id: "r-sev",     num: "01", eyebrow: "Severity assessment",                       title: "How serious, and on what axis",        key: "severity",    hint: "Which dimensions carry the weight — financial, operational, regulatory, reputational, human." },
  { id: "r-fcam",    num: "02", eyebrow: "F-CAM · Forensic Causal Analysis",          title: "What drove the outcome",               key: "causes",      hint: "Ranked causes. Say which are on the record and which are inferred." },
  { id: "r-comp",    num: "03", eyebrow: "Comparables & precedent",                   title: "Where we have seen this before",       key: "comparables", hint: "Named precedent cases, year, what happened, why it matters here." },
  { id: "r-frame",   num: "04", eyebrow: "Frameworks triggered",                      title: "The statutory machinery in play",      key: "frameworks",  hint: "Regulations, standards and statutory duties engaged." },
  { id: "r-blast",   num: "05", eyebrow: "Blast radius",                              title: "Who else is exposed",                  key: "blast",       hint: "Named organisations and how the exposure reaches them. Subscriber-only on the Hub.", locked: true },
  { id: "r-ctrl",    num: "06", eyebrow: "Control analysis · GUARD layer",            title: "GUARD controls against the scenario",  key: "controls",    hint: "The GUARD controls this incident surfaces, with owner and evidence. Subscriber-only.", locked: true },
  { id: "r-vend",    num: "07", eyebrow: "Mitigation",                                title: "Vendor intelligence",                  key: "vendors",     hint: "Products and services mapped to the controls above. Subscriber-only.", locked: true },
  { id: "r-out",     num: "08", eyebrow: "Outlook · 6–12 months",                     title: "What to watch next",                   key: "outlook",     hint: "Lanes to watch and the signal in each." },
  { id: "r-scen",    num: "09", eyebrow: "Scenario simulation · Attacked.ai wargame", title: "How this could play out",              key: "scenarios",   hint: "Forward scenarios with likelihood, horizon, trigger and how the room reacts." },
  { id: "r-verdict", num: "10", eyebrow: "Analyst commentary · Attacked.ai house view", title: "Our read",                           key: "verdict",     hint: "The house view, in the analyst's voice." },
  { id: "r-src",     num: "—",  eyebrow: "Sources",                                   title: "What this is built on",                key: "sources",     hint: "One source per line: title — publisher, or a link." },
];

export const REPORT_FONTS = [
  { id: "Inter", label: "Inter (brand)", css: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", gf: "Inter:wght@400;500;600;700;800;900" },
  { id: "Inter Tight", label: "Inter Tight", css: "'Inter Tight', Inter, sans-serif", gf: "Inter+Tight:wght@400;500;600;700;800" },
  { id: "IBM Plex Sans", label: "IBM Plex Sans", css: "'IBM Plex Sans', Inter, sans-serif", gf: "IBM+Plex+Sans:wght@400;500;600;700" },
  { id: "Source Serif 4", label: "Source Serif (editorial)", css: "'Source Serif 4', Georgia, serif", gf: "Source+Serif+4:wght@400;600;700" },
];

export const DEFAULT_BRAND = { accent: "#FCBD00", theme: "light", font: "Inter", headingWeight: 800, kicker: "Confidential Intelligence", showBrandFooter: true };

export const CATEGORY_NAME = {
  CYB: "Cyber Security", DAT: "Data & Privacy", ENV: "Environmental", FIN: "Financial", GEO: "Geopolitical",
  OPS: "Operations", PHY: "Physical Security", PPL: "People", REG: "Regulatory", REP: "Reputation",
  STR: "Strategic", TEC: "Technology", TPR: "Third Party",
};
const SEV = { 5: "Critical", 4: "High", 3: "Medium", 2: "Low", 1: "Minimal" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = (s) => (s && String(s).trim() ? marked.parse(String(s), { breaks: false, gfm: true }) : "");

function hexToRgb(hex) {
  const m = String(hex || "").trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return [252, 189, 0];   // Signal Gold, when a brand hex will not parse
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const darken = (hex, k = 0.55) => { const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v * k)); return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`; };
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };

// Words → minutes, like the baked shell's readTime.
function readTime(data) {
  const words = REPORT_SECTIONS.map((s) => String(data.sections?.[s.key] || "")).join(" ").split(/\s+/).filter(Boolean).length;
  return Math.max(3, Math.round(words / 210));
}

function brandCss(brand) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const font = REPORT_FONTS.find((f) => f.id === b.font) || REPORT_FONTS[0];
  const dark = b.theme === "dark";
  return `
:root{--gold:${b.accent};--gold-dim:${darken(b.accent, 0.62)};--gold-tint:${rgba(b.accent, 0.12)};--gold-text:${darken(b.accent, 0.56)};--border-gold:${rgba(b.accent, 0.55)};}
${dark ? `:root{--obsidian:#0F0F11;--obsidian-deep:#080808;--obsidian-card:#161618;--obsidian-elevated:#1F1F23;--white:#FFFFFF;--text-secondary:#B4B4BA;--text-muted:#7A7A80;--border-subtle:#2A2A2E;--shadow-1:0 1px 3px rgba(0,0,0,.5);--shadow-2:0 8px 24px rgba(0,0,0,.5);--gold-text:${b.accent};}` : ""}
body,.reader,.r-doc,.r-read,.r-rail{font-family:${font.css} !important;}
.r-title{font-weight:${Number(b.headingWeight) || 800} !important;}
.r-hero{display:block;width:100%;height:auto;max-height:420px;object-fit:cover;border-radius:8px;margin:18px 0 26px;border:1px solid var(--border-subtle);}
.r-md h3{font-size:16px;font-weight:700;margin:22px 0 8px;color:var(--white);}
.r-md h4{font-size:13.5px;font-weight:700;margin:18px 0 6px;color:var(--white);}
.r-md p,.r-md li{font-size:15px;line-height:1.7;color:var(--text-secondary);}
.r-md p{margin:0 0 14px;}
.r-md ul,.r-md ol{margin:0 0 16px 20px;padding:0;}
.r-md li{margin:0 0 6px;}
.r-md strong{color:var(--white);font-weight:700;}
.r-md a{color:var(--gold-text);text-decoration:underline;}
.r-md blockquote{margin:16px 0;padding:12px 18px;border-left:3px solid var(--gold);background:var(--gold-tint);color:var(--white);font-size:15px;line-height:1.6;}
.r-md table{border-collapse:collapse;width:100%;margin:0 0 16px;font-size:13.5px;}
.r-md th,.r-md td{border:1px solid var(--border-subtle);padding:8px 10px;text-align:left;vertical-align:top;color:var(--text-secondary);}
.r-md th{color:var(--white);font-weight:700;background:var(--obsidian-deep);}
.r-md hr{border:0;border-top:1px solid var(--border-subtle);margin:22px 0;}
.r-md code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12.5px;background:var(--obsidian-deep);padding:1px 5px;border-radius:3px;}
`;
}

// The reader chrome the baked shell drives with JS: progress bar, contents
// nav, Back inside the portal iframe, print. Kept tiny and dependency-free.
const SHELL_JS = `
(function(){
  var sc=document.getElementById('readerScroll'), prog=document.getElementById('rProgress');
  if(window.top!==window.self) document.body.classList.add('embedded');
  var btns=Array.prototype.slice.call(document.querySelectorAll('.r-nav-item'));
  var secs=btns.map(function(b){return {btn:b, el:document.getElementById(b.getAttribute('data-target'))};}).filter(function(x){return x.el;});
  btns.forEach(function(b){ b.addEventListener('click', function(){ var el=document.getElementById(b.getAttribute('data-target')); if(el&&sc) sc.scrollTo({top:el.offsetTop-18,behavior:'smooth'}); }); });
  var mob=document.getElementById('rMobNav'), list=document.getElementById('rMobList'), pill=document.getElementById('rMobPill'), curEl=document.getElementById('rMobCur');
  if(mob&&list&&sc){ secs.forEach(function(s,i){ var b=document.createElement('button'); b.type='button'; b.className='r-mobnav-item'; b.setAttribute('data-target', s.el.id); var n=document.createElement('span'); n.className='n'; n.textContent=String(i+1).padStart(2,'0'); b.appendChild(n); b.appendChild(document.createTextNode(s.btn.textContent)); b.addEventListener('click', function(){ sc.scrollTo({top:s.el.offsetTop-18,behavior:'smooth'}); mob.classList.remove('open'); }); list.appendChild(b); });
    if(pill) pill.addEventListener('click', function(){ mob.classList.toggle('open'); });
    sc.addEventListener('click', function(){ mob.classList.remove('open'); }, {passive:true}); }
  function onScroll(){ if(!sc) return; var max=sc.scrollHeight-sc.clientHeight; if(prog) prog.style.width=(max>0?Math.min(100,sc.scrollTop/max*100):0)+'%';
    var cur=null; secs.forEach(function(s){ if(s.el.offsetTop-40<=sc.scrollTop) cur=s; }); secs.forEach(function(s){ s.btn.classList.toggle('active', s===cur); });
    var c=cur||secs[0]; if(c&&curEl) curEl.textContent=c.btn.textContent;
    Array.prototype.slice.call(document.querySelectorAll('.r-mobnav-item')).forEach(function(b){ b.classList.toggle('active', !!c && b.getAttribute('data-target')===c.el.id); }); }
  if(sc){ sc.addEventListener('scroll', onScroll, {passive:true}); onScroll(); }
  var back=document.getElementById('rBack'); if(back) back.addEventListener('click', function(){ try{ window.top.history.back(); }catch(e){} });
  Array.prototype.slice.call(document.querySelectorAll('[data-print]')).forEach(function(b){ b.addEventListener('click', function(){ window.print(); }); });
})();`;

// data: { ref, title, subtitle, dek, author, authorTitle, assessedAt, severity, confidence,
//         industry, category, status, takeaway, heroImageUrl, sections: { summary, severity, ... } }
// { preview: true } renders the free-reader copy saved alongside (html_preview):
// the header, dossier and Executive Summary, then a Subscribe band in place of
// every other section, the takeaway and the Download PDF buttons.
export function renderReport(data = {}, brand = {}, { preview = false } = {}) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const font = REPORT_FONTS.find((f) => f.id === b.font) || REPORT_FONTS[0];
  const sev = Number(data.severity) || 3;
  const sections = data.sections || {};
  const present = REPORT_SECTIONS.filter((s) => (!preview || s.key === "summary") && String(sections[s.key] || "").trim());
  const pdfBtn = (cls) => preview
    ? `<button class="r-btn ${cls}" data-subscribe onclick="subscribe()">Subscribe · full report + PDF</button>`
    : `<button class="r-btn ${cls}" data-print>↓ Download PDF</button>`;
  const initials = String(data.author || "AI").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "AI";
  const catName = CATEGORY_NAME[data.category] || data.category || "";
  const vitals = [
    ["Industry", data.industry], ["Category", catName ? `${data.category} · ${catName}` : ""], ["Confidence", data.confidence],
    ["Reference", data.ref], ["As of", data.assessedAt], ["Status", data.status || "Assessment v1 · point-in-time"],
  ].filter(([, v]) => v).map(([k, v]) => `<div class="r-vital"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("");
  const navItems = present.map((s) => `<button class="r-nav-item" data-target="${s.id}">${esc(s.title || s.eyebrow)}</button>`).join("")
    + (preview ? `<button class="r-nav-item" data-target="r-lock">Full briefing · subscribers</button>` : "");

  const sectionHtml = present.map((s) => {
    const body = `<div class="r-body r-md">${md(sections[s.key])}</div>`;
    if (s.id === "r-sum") return `<section id="r-sum">${body}</section>`;
    return `<section class="r-sec" id="${s.id}">
      <div class="r-sec-head"><span class="r-sec-num">${esc(s.num)}</span><span class="r-sec-eyebrow">${esc(s.eyebrow)}</span></div>
      <h2 class="r-sec-title">${esc(s.title)}</h2>
      ${body}
    </section>`;
  }).join("\n") + (preview ? `
    <section class="r-sec r-lock" id="r-lock" ${PREVIEW_MARK}>
      <div class="r-sec-head"><span class="r-sec-num">01-10</span><span class="r-sec-eyebrow">Subscriber briefing</span></div>
      <h2 class="r-sec-title">The full briefing is for subscribers</h2>
      <p class="r-sec-note">Severity assessment, causal analysis, comparables, frameworks, blast radius, GUARD controls, vendor intelligence, outlook, scenarios, analyst verdict, board takeaway, sources and the Download PDF.</p>
      <button class="r-btn primary" data-subscribe onclick="subscribe()">Subscribe to read the full briefing</button>
    </section>` : "");

  const railLeft = `<aside class="r-rail r-rail-left">
    <div class="r-rail-block"><span class="r-sevpill"><span class="d"></span>SEV ${sev} · ${esc(SEV[sev] || "")}</span><span class="r-status"><span class="d"></span>${esc(data.status || "Assessment v1")}</span></div>
    <div class="r-rail-block"><div class="r-rail-h">Dossier</div><div class="r-vitals">${vitals}</div></div>
    <div class="r-rail-cta"><p>${b.showBrandFooter ? "An Attacked.ai intelligence briefing — point-in-time, subject to revision as facts emerge." : "Point-in-time intelligence briefing."}</p>${pdfBtn("primary")}</div>
  </aside>`;
  const railRight = `<aside class="r-rail r-rail-right"><div class="r-rail-block"><div class="r-rail-h">Contents</div><div class="r-nav">${navItems}</div></div></aside>`;

  const article = `<article class="r-read">
    <div class="r-eyebrow-strip"><span class="r-conf-tag">${esc(b.kicker || "Confidential Intelligence")}</span><span class="r-ref">${esc(data.ref || "")}${data.status ? " · " + esc(String(data.status).toUpperCase()) : ""}</span></div>
    ${data.kicker ? `<div class="r-kicker">${esc(String(data.kicker).toUpperCase())}</div>` : ""}
    <h1 class="r-title">${esc(data.title || "Untitled report")}</h1>
    ${data.subtitle ? `<p class="r-subtitle">${esc(data.subtitle)}</p>` : ""}
    ${data.dek ? `<p class="r-dek">${esc(data.dek)}</p>` : ""}
    <div class="r-byline">
      <div class="r-byline-l"><div class="r-avatar">${esc(initials)}</div><div><div class="r-author">${esc(data.author || "Attacked.ai Intelligence")}</div><div class="r-author-meta">${esc(data.authorTitle || "GUARD framework analysis")}</div></div></div>
      <div class="r-byline-r"><span class="r-readtime">${readTime(data)} min read</span></div>
    </div>
    <p class="r-assessment">As of ${esc(data.assessedAt || new Date().toUTCString().slice(5, 16))} · Point-in-time, subject to revision as facts emerge · Change-controlled</p>
    ${data.heroImageUrl ? `<img class="r-hero" src="${esc(data.heroImageUrl)}" alt="">` : ""}
    ${sectionHtml}
    ${data.takeaway && !preview ? `<section class="r-sec" id="r-board" style="border-top:0;padding-top:0;margin-top:44px"><div class="r-takeaway"><div class="r-takeaway-h">Board takeaway</div><p>${esc(data.takeaway)}</p></div></section>` : ""}
    <div class="r-end"><div class="r-end-eyebrow">${esc(data.ref || "")}</div><h3>${esc(b.kicker || "Confidential intelligence briefing")}</h3><p>This briefing is a point-in-time assessment. Blast radius, GUARD controls and vendor intelligence are subscriber sections on the Attacked Hub.</p>${pdfBtn("")}</div>
    ${b.showBrandFooter ? `<div class="r-foot">Attacked<span class="ai">.ai</span> — ${esc(b.kicker || "Confidential Intelligence")} · Filed by ${esc(data.author || "Attacked.ai Intelligence")} · ${esc(data.assessedAt || "")}</div>` : ""}
  </article>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Attacked.ai · Intelligence Briefing — ${esc(data.title || "")}${preview ? " · Preview" : ""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${font.gf}&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${REPORT_SHELL_CSS}</style>
<style>${brandCss(b)}</style>
<style id="attacked-resp">${REPORT_RESPONSIVE_CSS}</style>${preview ? `<style>${PRINT_BLOCK_CSS}</style>` : ""}
</head>
<body>
<div class="reader open" id="reader" aria-label="Intelligence briefing — ${esc(data.title || "")}">
  <div class="r-progress" id="rProgress"></div>
  <div class="reader-bar">
    <button class="r-bar-back" id="rBack">← Back</button>
    <div class="reader-actions">${preview ? `<button class="r-btn ghost" data-subscribe onclick="subscribe()">Subscribe for the PDF</button>` : `<button class="r-btn ghost" data-print>↓ Download PDF</button>`}</div>
  </div>
  <div class="reader-scroll" id="readerScroll">
    <div class="r-doc" id="readerArticle">${railLeft}${article}${railRight}</div>
  </div>
  <div class="r-mobnav" id="rMobNav"><div class="r-mobnav-sheet" id="rMobSheet"><div class="r-mobnav-sheet-h">Jump to section</div><div id="rMobList"></div></div><button class="r-mobnav-pill" id="rMobPill" type="button"><span class="rm-ic">&#9776;</span><span class="rm-txt"><span class="rm-lab">Reading now</span><span class="rm-cur" id="rMobCur">${esc(present[0]?.title || present[0]?.eyebrow || "Contents")}</span></span><span class="rm-chev">&#8963;</span></button></div>
</div>
<script>${SHELL_JS}${preview ? SUBSCRIBE_JS : ""}</script>
</body>
</html>`;
}

// For an UPLOADED baked report: inject the brand overrides without touching
// the file otherwise. Returns the html unchanged when it has no </head>.
// A finished report file already carries its own facts: the page script opens
// with `const INCIDENT = { … }`, a JSON object holding the reference, headline,
// standfirst, date, severity, confidence and byline. Reading it lets an upload
// fill this form instead of making the admin retype what the file already says.
//
// Deliberately NOT the <title> tag: in every one of the baked briefings it
// reads "Attacked.ai · Intelligence Briefing — Getty / Shutterstock · CMA
// Merger Remedy", a leftover from the template that was being copied into
// Title on every upload.
function incidentBlock(html) {
  const at = html.indexOf("const INCIDENT = ");
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, i = start;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) break; }
  }
  if (depth) return null;                                  // never closed
  try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
}

const trimmed = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

// What an uploaded file can tell us, keyed by this editor's own field names.
export function reportMetaFromHtml(html) {
  const o = incidentBlock(html);
  if (!o) return { found: false, fields: {} };
  const fields = {
    ref: trimmed(o.id),
    title: trimmed(o.title),
    subtitle: trimmed(o.subtitle),
    dek: trimmed(o.standfirst) || trimmed(o.dek),
    kicker: trimmed(o.kicker),
    author: trimmed(o.author),
    authorTitle: trimmed(o.authorTitle) || trimmed(o.byline),
    assessedAt: trimmed(o.asOf) || trimmed(o.assessedAt),
    confidence: trimmed(o.confidence),
    status: trimmed(o.ref),                                // "ASSESSMENT v1 · point-in-time"
    takeaway: trimmed(o.takeaway),
  };
  for (const k of Object.keys(fields)) if (!fields[k]) delete fields[k];
  if (typeof o.severity === "number" && o.severity >= 1 && o.severity <= 5) fields.severity = o.severity;
  // categoriesTouched lists the GUARD codes the incident spans, primary first
  // — the file's own classification, so no guessing from the desk name.
  const code = Array.isArray(o.categoriesTouched) ? trimmed(o.categoriesTouched[0]) : "";
  if (code && CATEGORY_NAME[code]) fields.category = code;
  return { found: true, fields };
}

// A baked briefing from the pipeline arrives with its own stylesheet, and that
// stylesheet hardcodes the brand: 51 selectors name a font outright, and the
// accent and everything derived from it are written as literals — #F5B800 and
// rgba(245,184,0,a) for the accent itself, #8A6D00 / #9A7400 / #7A5C00 for the
// darker text tones, #EBCB5B / #FEF8E3 for the tint pair, #E0A800 for the far
// end of the severity gradient. Appending overrides therefore changed almost
// nothing, which is why the Design tab looked dead on an uploaded file.
//
// So we make the file's own CSS brand-aware instead: every non-monospace
// font-family becomes var(--r-font) and every accent literal becomes the
// variable it was derived from. After that one rewrite the :root block drives
// the whole document, and the rewrite is a no-op to re-apply — which matters,
// because a saved report is re-opened from its rendered HTML and so passes
// through here again every time an admin edits it.
//
// #141414 needs more care: 17 of its 21 rules are text sitting ON the accent
// (badges, chips, the wordmark), which must flip to white when the admin picks
// a dark accent, but the other 4 are dark marks on a light surface, which must
// not. So it is only rewritten inside declaration blocks that reference the
// accent — innermost {...} blocks, which is what a declaration block is.
function brandifyCss(css) {
  return String(css)
    .replace(/font-family\s*:\s*([^;}]+)/gi, (m, decl) => (/mono|inherit|--r-font/i.test(decl) ? m : "font-family:var(--r-font)"))
    .replace(/#f5b800\b/gi, "var(--gold)")
    .replace(/rgba\(\s*245\s*,\s*184\s*,\s*0\s*,\s*([0-9.]+)\s*\)/gi, "rgba(var(--gold-rgb),$1)")
    .replace(/#e0a800\b/gi, "var(--gold-mid)")
    .replace(/#8a6d00\b|#7a5c00\b/gi, "var(--gold-text)")
    .replace(/#9a7400\b/gi, "var(--gold-dim)")
    .replace(/#ebcb5b\b/gi, "var(--yellow-edge)")
    .replace(/#fef8e3\b/gi, "var(--yellow-tint)")
    .replace(/\{([^{}]*)\}/g, (m, body) => (/var\(--gold|var\(--yellow/.test(body) ? "{" + body.replace(/#141414\b/gi, "var(--on-accent)") + "}" : m));
}

// Text that sits on the accent: near-black on a light accent, white on a dark
// one, so a badge stays readable whatever colour the admin picks. The default
// gold resolves to #141414, which is exactly what the files already ship.
const onAccent = (hex) => { const [r, g, b] = hexToRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? "#141414" : "#FFFFFF"; };

// The variables an uploaded file needs on top of brandCss: the font and the
// accent tones the rewrite above now points at.
function uploadBrandCss(b) {
  const font = REPORT_FONTS.find((f) => f.id === b.font) || REPORT_FONTS[0];
  const [r, g, bl] = hexToRgb(b.accent);
  return `
:root{--r-font:${font.css};--gold-rgb:${r},${g},${bl};--gold-mid:${darken(b.accent, 0.86)};--on-accent:${onAccent(b.accent)};--yellow:${b.accent};--yellow-tint:${rgba(b.accent, 0.1)};--yellow-edge:${rgba(b.accent, 0.45)};--shadow-gold:0 6px 24px ${rgba(b.accent, 0.2)};}
.r-title,.r-sec-title{font-weight:${Number(b.headingWeight) || 800} !important;}
`;
}

// ── on-page edits ────────────────────────────────────────────────────────
// A baked briefing ships a skeleton — about 20 elements — and its own script
// builds the other 900 from the INCIDENT object every time the page loads. So
// on-page edits cannot be saved by serialising the edited DOM: that would store
// the generated markup alongside the script that regenerates it, inflating the
// file by half and losing every edit the moment the script ran again.
//
// Instead the edits are saved as data — a selector-keyed map in a JSON block —
// with a small script that re-applies them after the report has built itself.
// The stored file stays the original plus a few hundred bytes, the edits survive
// the rebuild, and re-opening a report can read the map straight back out.
const AE_APPLY_JS = `(function(){try{
var n=document.querySelector('script[type="application/json"][data-ae-edits]');if(!n)return;
var E=JSON.parse(n.textContent||'{}');var K=Object.keys(E);
function sel(k){try{return document.querySelector(k);}catch(e){return null;}}
function go(){
K.forEach(function(k){var e=E[k],el=sel(k);if(el&&e&&e.html!=null)el.innerHTML=e.html;});
K.forEach(function(k){var e=E[k],el=sel(k);if(!el||!e||!e.style)return;
Object.keys(e.style).forEach(function(p){el.style.setProperty(p,e.style[p],'important');});});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();
setTimeout(go,0);
}catch(err){}})();`;

const AE_JSON_RE = /<script type="application\/json" data-ae-edits>[\s\S]*?<\/script>/gi;
const AE_APPLY_RE = /<script data-ae-apply>[\s\S]*?<\/script>/gi;

// The edits already saved in a report, so re-opening one shows what was done.
export function readEdits(html) {
  const m = String(html || "").match(/<script type="application\/json" data-ae-edits>([\s\S]*?)<\/script>/i);
  if (!m) return {};
  try { const o = JSON.parse(m[1].replace(/<\\\//g, "</")); return o && typeof o === "object" ? o : {}; } catch { return {}; }
}

// Replace the saved edits with this set. Passing an empty set removes them, so
// "reset everything" needs no special case.
export function injectEdits(html, edits) {
  let doc = String(html || "").replace(AE_JSON_RE, "").replace(AE_APPLY_RE, "");
  const keys = Object.keys(edits || {});
  if (!keys.length || !doc) return doc;
  const json = JSON.stringify(edits).replace(/<\//g, "<\\/");
  const head = doc.lastIndexOf("</head>");
  if (head < 0) return doc;
  doc = doc.slice(0, head) + `<script type="application/json" data-ae-edits>${json}</script>` + doc.slice(head);
  const body = doc.lastIndexOf("</body>");
  const apply = `<script data-ae-apply>${AE_APPLY_JS}</script>`;
  return body < 0 ? doc + apply : doc.slice(0, body) + apply + doc.slice(body);
}

export function brandFontHref(brand = {}) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const font = REPORT_FONTS.find((f) => f.id === b.font) || REPORT_FONTS[0];
  return `https://fonts.googleapis.com/css2?family=${font.gf}&display=swap`;
}

export function brandStyleCss(brand = {}) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  return brandCss({ ...b, theme: "light" }) + uploadBrandCss(b);
}

export function applyBrandToHtml(html, brand = {}) {
  let doc = String(html || "");
  if (!doc) return doc;
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  // Theme is deliberately not forwarded: a baked briefing hardcodes its own
  // light palette in 45 further literals (surfaces, borders, the good/fail
  // semantics, near-black text on chips), so flipping only the handful of
  // variables brandCss knows about produced a half-dark, unreadable page.
  // The Design tab says as much for an uploaded file.
  // Clear what an earlier pass injected, so re-editing re-brands instead of stacking.
  doc = doc.replace(/<link[^>]*data-cms-brand[^>]*>/gi, "").replace(/<style data-cms-brand>[\s\S]*?<\/style>/gi, "");
  // …except the admin's own per-element block, whose font and colour choices
  // are deliberate and must not be folded back into the brand variables.
  doc = doc.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) => (/data-ae-edits/i.test(attrs) ? m : `<style${attrs}>${brandifyCss(css)}</style>`));
  const i = doc.lastIndexOf("</head>");
  if (i < 0) return doc;
  const inject = `<link data-cms-brand href="${brandFontHref(b)}" rel="stylesheet"><style data-cms-brand>${brandStyleCss(b)}</style>`;
  return doc.slice(0, i) + inject + doc.slice(i);
}
