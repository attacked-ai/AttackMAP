// reportPreview.js — the free-reader copy of a finished report.
//
// Free readers get the header, the key figures and the Executive Summary;
// everything after it (severity onwards, sources, Download PDF) is for
// subscribers. The full file never reaches a free reader's browser: it lives
// at /reports-full/<ref>.html behind the server gate (middleware.js), and
// /reports/<ref>.html is the copy this module makes from it.
//
// Pure string work, no DOM and no Node APIs, so the same code runs in
// scripts/build-report-previews.mjs (the 310 baked files + uploads) and in
// the admin console (CMS reports uploaded as HTML).
//
// The cut is made on the DATA, not just the markup: the shells render from a
// `const INCIDENT = {…}` line, so a copy that only hid sections would still
// ship every locked paragraph in that JSON. Here the JSON is rebuilt with the
// preview keys only. Every anchor must match exactly once or the build stops,
// so a changed shell can never produce a half-cut preview.

export const PREVIEW_MARK = 'data-locked="preview"';
// Where the locked part of a preview begins, in both designs — the build
// checks that everything before it is identical between them.
export const LOCKED_START = "<!--r-locked-start-->";
export const isPreviewHtml = (html) => typeof html === "string" && html.includes(PREVIEW_MARK);

const BS = String.fromCharCode(92), LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
// JSON that is safe inside a <script>: no "</script>", no raw line separators.
const jsonSafe = (o) => JSON.stringify(o).replace(/</g, BS + "u003c").split(LS).join(BS + "u2028").split(PS).join(BS + "u2029");
const escH = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The subscribe action inside a preview. The frame is always same-origin (a
// /reports/ file or a srcdoc in the Hub), so it sends the whole tab to the
// subscription page; opened on its own, it navigates itself.
export const SUBSCRIBE_JS = "function subscribe(){ try{ window.top.location.href='/?subscribe'; }catch(e){ location.href='/?subscribe'; } }\nwindow.subscribe=subscribe;";
// Ctrl+P on a preview prints a notice, never the summary as a PDF.
export const PRINT_BLOCK_CSS = '@media print{body>*{display:none!important}body::before{content:"Download PDF is available to Attacked.ai subscribers.";display:block;padding:40px;font:600 16px Inter,sans-serif}}';

function editor(src) {
  let s = src;
  return {
    get: () => s,
    set: (v) => { s = v; },
    once(needle, repl, label) {
      const n = s.split(needle).length - 1;
      if (n !== 1) throw new Error(`${label}: expected 1 match, got ${n}`);
      s = s.replace(needle, () => repl);
    },
    line(name) {
      const m = s.match(new RegExp("^const " + name + " = (.*);\\r?$", "m"));
      if (!m) throw new Error("no " + name + " line");
      return m;
    },
    blockPrint() {
      const re = /<\/style>(\r?\n)<\/head>/;
      if (re.test(s)) { s = s.replace(re, (all, nl) => PRINT_BLOCK_CSS + "</style>" + nl + "</head>"); return; }
      // a file whose head was touched since (an uploaded, re-branded copy)
      if (s.split("</head>").length - 1 !== 1) throw new Error("head anchor");
      s = s.replace("</head>", () => "<style>" + PRINT_BLOCK_CSS + "</style></head>");
    },
  };
}

// ── The baked briefing shell (the 310 files in public/reports) ───────────
export const BAKED_KEEP = ["id", "ref", "asOf", "assessedAt", "title", "subtitle", "kicker", "standfirst", "dekTail", "author", "authorTitle", "authorOutlet", "authorPhoto", "byline", "reporterCode", "severity", "confidence", "status", "metrics", "dossier", "execBullets", "narrative", "pullQuote", "chain", "categoriesTouched"];

function bakedPreview(src) {
  const e = editor(src);
  const m = e.get().match(/^const INCIDENT = (\{.*\});\r?$/m);
  if (!m) throw new Error("no INCIDENT line");
  const I = JSON.parse(m[1]);
  // Read time of the FULL report (the shell's readTime formula), so the
  // preview still says how long the whole briefing is.
  const parts = []; (I.narrative || []).forEach((p) => parts.push(p)); parts.push(I.standfirst || "", I.dekTail || "", I.takeaway || "");
  (I.causes || []).forEach((c) => { parts.push(c.rat || "", c.why || ""); (c.guard || []).forEach((g) => parts.push(g.lnk || "")); });
  (I.guardMap || []).forEach((g) => parts.push(g.fail || "", g.good || "")); (I.vendors || []).forEach((v) => parts.push(v.rat || ""));
  const P = {}; BAKED_KEEP.forEach((k) => { if (k in I) P[k] = I[k]; });
  if ("footnote" in I) P.footnote = "";   // the footer prints it; absent would read "undefined"
  P.readMin = Math.max(3, Math.round(parts.join(" ").trim().split(/\s+/).length / 200));
  P.preview = true;
  e.once(m[0], "const INCIDENT = " + jsonSafe(P) + ";", "INCIDENT");
  // the baked files share one stale <title>; the report's own headline instead
  e.set(e.get().replace(/<title>(.*?)<\/title>/s, () => "<title>Attacked.ai · " + escH(I.title || "Intelligence briefing") + " · Preview</title>"));
  e.set(e.get().replace(/aria-label="Intelligence briefing[^"]*"/, 'aria-label="Intelligence briefing preview"'));
  e.set(e.get().replace(/\/\* ---- INCIDENT:.*?\*\//, "/* ---- INCIDENT: summary-only preview ---- */"));
  // Cut every section after the executive summary, and the closing Download
  // PDF block, down to the footer.
  const s = e.get();
  const a = s.indexOf('    <section class="r-sec" id="r-sev">'), b = s.indexOf('    <div class="r-foot">');
  if (a < 0 || b < 0 || b < a) throw new Error("section cut anchors");
  const lock = [
    "    " + LOCKED_START,
    `    <section class="r-sec r-lock" id="r-lock" ${PREVIEW_MARK}>`,
    '      <div class="r-sec-head"><span class="r-sec-num">01-10</span><span class="r-sec-eyebrow">Subscriber briefing</span></div>',
    '      <h2 class="r-sec-title">The full briefing is for subscribers</h2>',
    '      <p class="r-sec-note">Severity assessment, causal analysis, comparables, frameworks, blast radius, GUARD controls, vendor intelligence, outlook, scenarios, analyst verdict, board takeaway, sources and the Download PDF.</p>',
    '      <button class="r-btn primary" data-subscribe onclick="subscribe()">Subscribe to read the full briefing</button>',
    "    </section>",
    "",
  ].join("\n");
  e.set(s.slice(0, a) + lock + s.slice(b));
  e.once("const navItems=[['sum','Executive summary'],['sev','Severity assessment'],['fcam','Causal analysis'],['comp','Comparables & precedent'],['frame','Frameworks'],['blast','Blast radius'],['ctrl','Control analysis'],['vend','Vendor intelligence'],['out','Outlook'],['scen','Scenario simulation'],['verdict','Analyst verdict'],['board','Board takeaway'],['src','Sources']]",
    "const navItems=[['sum','Executive summary'],['lock','Full briefing · subscribers']]", "navItems");
  e.once('<button class="r-btn primary" onclick="downloadPDF()">↓ Download PDF</button>', '<button class="r-btn primary" data-subscribe onclick="subscribe()">Subscribe · full report + PDF</button>', "rail PDF");
  e.once('<button class="r-btn ghost" id="readerPrint">↓ Download PDF</button>', '<button class="r-btn ghost" id="readerPrint" data-subscribe>Subscribe for the PDF</button>', "top PDF");
  e.once("function downloadPDF(){ window.print(); }", SUBSCRIBE_JS + "\nfunction downloadPDF(){ subscribe(); }", "downloadPDF");
  e.once("const rt=readTime(I);", "const rt=I.readMin||readTime(I);", "readTime");
  // dead legacy hero image in the CSS (the reader DOM never uses it)
  e.set(e.get().replace(/url\("data:image\/webp;base64,[A-Za-z0-9+/=]+"\) center\/cover no-repeat,/, ""));
  e.blockPrint();
  return { html: e.get(), kind: "baked", keep: P, locked: Object.keys(I).filter((k) => !BAKED_KEEP.includes(k)).map((k) => I[k]) };
}

// ── The editorial v3 shell (NATS Outage Briefing - Redesigned v3) ────────
export const EDITORIAL_KEEP = ["id", "ref", "kicker", "title", "subtitle", "standfirst", "dekTail", "reporterCode", "pullQuote", "severity", "confidence", "status", "author", "authorTitle", "authorOutlet", "byline", "authorPhoto", "asOf", "assessedAt", "revision", "eventDate", "eventStart", "eventEnd", "metrics", "dossier", "execBullets", "narrative", "categoriesTouched", "reportStatus"];

// [S1]-style citations point into the Sources list, which is locked.
const stripCites = (v) => typeof v === "string" ? v.replace(/\s*\[S\d+\]/g, "")
  : Array.isArray(v) ? v.map(stripCites)
  : (v && typeof v === "object") ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripCites(x)])) : v;

function editorialPreview(src) {
  const e = editor(src);
  const mI = e.line("INCIDENT"), mM = e.line("MEDIA"), mG = e.line("GEO");
  const I = JSON.parse(mI[1]), M = JSON.parse(mM[1]);
  let w = 0;
  const walk = (v) => {
    if (typeof v === "string") { if (!v.startsWith("data:") && !v.startsWith("http")) w += v.replace(/\[S\d+\]/g, "").split(/\s+/).filter(Boolean).length; }
    else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  ["narrative", "execBullets", "analystVerdict", "causes", "comparables", "frameworks", "outlook", "scenarios", "takeaway", "chain", "standfirst", "subtitle"].forEach((k) => walk(I[k]));
  const P = {}; EDITORIAL_KEEP.forEach((k) => { if (k in I) P[k] = stripCites(I[k]); });
  P.readMin = Math.max(1, Math.round(w / 230)); P.preview = true;
  // hero severity minis: dimension name + score only (the notes are analysis)
  if (I.severityDims) P.severityDims = { overall: I.severityDims.overall, confidence: I.severityDims.confidence, dims: (I.severityDims.dims || []).map((d) => ({ dim: d.dim, score: d.score })) };
  e.once(mI[0], "const INCIDENT = " + jsonSafe(P) + ";", "INCIDENT");
  e.once(mM[0], "const MEDIA = " + jsonSafe({ titleAccent: M.titleAccent, note: M.note, hero: M.hero }) + ";", "MEDIA");
  e.once(mG[0], "const GEO = null;", "GEO");
  e.once("const rt=readTime(I);", "const rt=I.readMin||readTime(I);", "readTime");
  e.once("const NAV=[['sum','Executive summary'],['sev','Severity assessment'],['fcam','Causal analysis'],['comp','Comparables & precedent'],['frame','Frameworks'],['blast','Blast radius'],['peer','Peer watchlist'],['ctrl','Control analysis'],['vend','Vendor intelligence'],['out','Outlook'],['scen','Scenario simulation'],['verdict','Analyst verdict'],['board','Board takeaway'],['src','Sources']];",
    "const NAV=[['sum','Executive summary'],['lock','Full briefing · subscribers']];", "NAV");
  // drop every section builder after the pull quote (case progression … sources)
  const s = e.get();
  const a = s.indexOf("  /* ---- case progression ---- */"), b = s.indexOf("  /* ---- end ---- */");
  if (a < 0 || b < 0 || b < a) throw new Error("builder cut anchors");
  const lockJs = "  const lockBand=`" + LOCKED_START + "<section class=\"band\" id=\"r-lock\" " + PREVIEW_MARK + "><div class=\"shell\">${head('01-11','Subscriber briefing','The full briefing is for subscribers','Case progression, severity assessment, causal analysis, comparables, frameworks, blast radius, peer watchlist, GUARD controls, vendor intelligence, outlook, scenarios, analyst verdict, board takeaway, sources and the Download PDF.')}<button class=\"hdr-btn\" style=\"margin-top:22px;background:var(--gold,#FCBD00);border-color:var(--gold,#FCBD00);color:#0f0f0f\" data-subscribe onclick=\"subscribe()\">Subscribe to read the full briefing</button></div></section>`;\n";
  e.set(s.slice(0, a) + lockJs + s.slice(b));
  e.once("return cover+toc+[summary,quote,chain,severity,fcam,comparables,frameworks,blast,peer,control,vend,outlook,scen,verdict,board,sources].join('')+end;",
    "return cover+toc+[summary,quote,lockBand].join('')+end;", "return");
  e.once('<a class="hs-link" href="#r-sev">Severity assessment &darr;</a>', '<a class="hs-link" href="#r-lock">Full severity assessment &darr;</a>', "hs-link");
  e.once('<button class="hdr-btn" id="readerPrint">&darr; Download PDF</button>', '<button class="hdr-btn" data-subscribe onclick="subscribe()">Subscribe for the PDF</button>', "header PDF");
  {
    const re = /function downloadPDF\(\)\{[^}]*\{[^}]*\}\s*window\.print\(\);\s*\}/g;
    const hits = e.get().match(re) || [];
    if (hits.length !== 1) throw new Error("downloadPDF: expected 1 match, got " + hits.length);
    e.set(e.get().replace(re, () => SUBSCRIBE_JS + "\nfunction downloadPDF(){ subscribe(); }"));
  }
  e.once("$('readerPrint').addEventListener('click',downloadPDF);", "", "readerPrint listener");
  e.blockPrint();
  e.set(e.get().replace(/<title>(.*?)<\/title>/s, (all, t) => "<title>" + t.trim() + " · Preview</title>"));
  const locked = Object.keys(I).filter((k) => !EDITORIAL_KEEP.includes(k)).map((k) => I[k]);
  if (I.severityDims) locked.push((I.severityDims.dims || []).map((d) => d.note));
  return { html: e.get(), kind: "editorial", keep: P, locked };
}

// ── Design B: every section shown, the locked ones blurred ────────────────
//
// The free reader sees the same header, key figures and Executive Summary as
// design A, then EVERY later section with its real heading, a one-line "what
// you get", a short blurred preview of its body and a lock label carrying a
// real count ("6 organisations exposed").
// Nothing under the blur is the report:
//   • every locked text is lorem-style filler, its length only bucketed and
//     picked by the text's position, never by its content (so it cannot be
//     reversed or used to confirm a guess);
//   • anything that could single out an organisation, a cause's standing or a
//     source gets one neutral value (severity, level, tier, country, type,
//     tickers) or is dropped (logos, links, parent companies);
//   • control and framework codes keep their shape with the digits zeroed;
//   • map pins are decoys placed inside the map, not moved real positions;
//   • the standard reports' severity scores are a fixed pattern (design A
//     does not show them there; the NATS report shows them in both designs).
// The real report still reaches subscribers only, through the server gate.

// Fields whose values steer the layout — kept (codes with their digits zeroed).
export const LAYOUT_FIELDS = new Set(["cats", "cat", "code", "ac", "dim", "score", "overall", "confidence", "subcat", "co", "mc", "parents", "id"]);
const CODE_FIELDS = new Set(["code", "ac", "id", "co", "mc", "parents"]);
const NEUTRAL = { sev: 3, level: "medium", tier: "moderate", country: "", countries: [], type: "company", group: "", partC: false, ticker: null, cik: null, as: "AS-REF", kind: "product", vtype: "Horizontal", capability: "Prevent", mcCapability: "Prevent", for: "operators" };
export const NEUTRAL_FIELDS = new Set(Object.keys(NEUTRAL));
const DROP_FIELDS = new Set(["logo", "u", "url", "urls", "alt", "parent", "idNote", "new_entry"]);
const SCORE_PATTERN = [7, 6, 5, 4, 3];
const PLACEHOLDER_IMG = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a2e35"/><stop offset="1" stop-color="#0f1114"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>');
const FILLER = ("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud "
  + "exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint "
  + "occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum praesent sagittis massa vitae turpis integer posuere feugiat nibh").split(" ");
const cap = (w) => w[0].toUpperCase() + w.slice(1);

function seeded(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  let x = (h >>> 0) || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}

// Filler shaped like the real text only coarsely: a short label becomes two
// or three Title-Case words; prose one of four lengths.
function fillerFor(text, seed) {
  const r = seeded(seed);
  const s = String(text).replace(/\[[A-Z]{2,12}\]|\[S\d+\]/g, "").trim();
  const label = s.length <= 60 && !/[.!?]\s*$/.test(s);
  const pick = () => FILLER[Math.floor(r() * FILLER.length)];
  if (label) { const n = 2 + Math.floor(r() * 2); return Array.from({ length: n }, () => cap(pick())).join(" "); }
  const target = [90, 180, 360, 620][s.length < 120 ? 0 : s.length < 260 ? 1 : s.length < 500 ? 2 : 3] * (0.9 + r() * 0.2);
  let out = "";
  while (out.length < target) out += (out ? " " : "") + pick();
  return cap(out) + ".";
}

// A decoy map position inside the map's frame (bbox = [w, s, e, n]).
function decoy(key, path, bbox) {
  const [w, s, e, n] = bbox || [-10, 36, 28, 60];
  const r = seeded(path), t = 0.15 + 0.7 * r();
  return Math.round((key === "lat" ? s + t * (n - s) : w + t * (e - w)) * 1e5) / 1e5;
}

// A locked value, rebuilt with the same shape. `path` seeds the filler.
function standIn(v, key, path, bbox) {
  if (key in NEUTRAL) return NEUTRAL[key];
  if (v == null || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (key === "lat" || key === "lng") return decoy(key, path, bbox);
    if (key === "score" || key === "overall") return v;          // handled per shell below
    return key === "year" ? fillerFor("Year", path) : 0;         // no other real number survives
  }
  if (Array.isArray(v)) return v.map((x, i) => standIn(x, key, path + "." + i, bbox));
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) { if (!DROP_FIELDS.has(k)) o[k] = standIn(x, k, path + "." + k, bbox); }
    return o;
  }
  // codes keep their prefix and category only: AC-TEC-01 → AC-TEC-00, IAC-TEC-INF-0001 → IAC-TEC-XXX-0000
  if (CODE_FIELDS.has(key)) return v.split("-").map((g, i) => i < 2 ? g.replace(/\d/g, "0") : g.replace(/[A-Z]/g, "X").replace(/\d/g, "0")).join("-");
  if (key === "subcat") return v.split("-")[0] + "-XXX";
  if (LAYOUT_FIELDS.has(key)) return v;
  if (/^(data:|https?:)/.test(v)) return "";
  if (!v.trim()) return v;
  return fillerFor(v, path);
}

const plural = (a, one, many) => { const n = Array.isArray(a) ? a.length : 0; return n ? `${n} ${n === 1 ? one : many}` : ""; };
// The sections each shell blurs, in page order: id, name, teaser, what you get.
const SEC = {
  chain: ["r-chain", "Case progression", (I) => plural(I.chain, "step in the timeline", "steps in the timeline"), "The step-by-step timeline of how the incident unfolded."],
  sev: ["r-sev", "Severity assessment", (I) => plural(I.severityDims && I.severityDims.dims, "dimension scored", "dimensions scored"), "How serious it is, scored dimension by dimension, and what drives each score."],
  fcam: ["r-fcam", "Causal analysis", (I) => plural(I.causes, "ranked cause", "ranked causes"), "The causes ranked by probability, the evidence for each, and the controls that would have broken the chain."],
  comp: ["r-comp", "Comparables & precedent", (I) => plural(I.comparables, "precedent case", "precedent cases"), "Named precedent cases, what happened in each, and why they matter here."],
  frame: ["r-frame", "Frameworks", (I) => plural(I.frameworks, "framework triggered", "frameworks triggered"), "The regulations and statutory duties this incident engages."],
  blast: ["r-blast", "Blast radius", (I) => plural(I.blast, "organisation exposed", "organisations exposed"), "Every organisation hit or exposed, and how the impact reached it."],
  peer: ["r-peer", "Peer watchlist", (I) => plural(I.peers, "peer to watch", "peers to watch"), "Organisations with the same exposure that should check themselves next."],
  ctrl: ["r-ctrl", "GUARD controls", (I) => plural(I.guardMap, "GUARD control", "GUARD controls"), "The GUARD controls this incident surfaces, who owns them and what good looks like."],
  vend: ["r-vend", "Vendor intelligence", (I) => plural(I.vendors, "vendor mapped", "vendors mapped"), "Products and services mapped to those controls, and why each one fits."],
  out: ["r-out", "Outlook", (I) => plural(I.outlook, "signal to watch", "signals to watch"), "What to watch over the next six to twelve months."],
  scen: ["r-scen", "Scenario simulation", (I) => plural(I.scenarios, "scenario modelled", "scenarios modelled"), "Forward scenarios with likelihood, horizon, trigger and how each stakeholder reacts."],
  verdict: ["r-verdict", "Analyst verdict", () => "The Attacked.ai house view", "What this incident really means, in the analyst's own words."],
  board: ["r-board", "Board takeaway", () => "What the board should do", ""],
  src: ["r-src", "Sources", (I) => plural(I.sources, "source", "sources"), "Every source behind the briefing, with links."],
};
const controlCount = (I) => { let n = 0; ((I.controlAnalysis && I.controlAnalysis.categories) || []).forEach((c) => (c.objectives || []).forEach((o) => { n += (o.controls || []).length; })); return n; };
const BAKED_LOCKED = ["chain", "sev", "fcam", "comp", "frame", "blast", "ctrl", "vend", "out", "scen", "verdict", "board", "src"].map((k) => SEC[k]);
const EDITORIAL_LOCKED = ["chain", "sev", "fcam", "comp", "frame", "blast", "peer", "ctrl", "vend", "out", "scen", "verdict", "board", "src"].map((k) => k !== "ctrl" ? SEC[k]
  : ["r-ctrl", "Control analysis", (I) => { const n = controlCount(I); return n ? `${n} controls mapped` : plural(I.guardMap, "GUARD control", "GUARD controls"); }, SEC.ctrl[3]]);
const lockMeta = (I, list) => list.filter(([id]) => id !== "r-chain" || (I.chain && I.chain.length))
  .map(([id, name, teaser, what]) => ({ id, name, teaser: teaser(I) || "Subscriber section", what }));

const LOCK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const NAV_LOCK_IMG = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#B38600" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>');

// The "full briefing continues" card right after the summary, and the slim
// bar that shows once the reader has scrolled past it. Static per report; no
// backticks or ${ (they sit in a template string).
function lockCta(meta, readMin) {
  const chips = meta.map((m) => `<span class="r-lockchip">${escH(m.name)}<i>${escH(m.teaser)}</i></span>`).join("")
    + (meta.length > 6 ? `<span class="r-lockchip r-lockmore">+${meta.length - 6} more<i>sections</i></span>` : "");
  return `<div class="r-lockcta" id="r-lockcta"><div class="r-lockcta-k">${LOCK_ICON}<span>Subscriber briefing</span></div>`
    + `<h3>The full briefing continues below</h3>`
    + `<p>You have read the free Executive Summary. Subscribers read every section of this briefing and can download it as a PDF.</p>`
    + `<div class="r-lockchips">${chips}</div>`
    + `<div class="r-lockcta-row"><button type="button" class="r-lockcta-btn" data-subscribe onclick="subscribe()">Subscribe to unlock the full briefing</button>`
    + `<span class="r-lockcta-meta">${meta.length} sections · ${readMin} min read · PDF</span></div></div>`;
}
const lockBar = (n) => `<div class="r-lockbar" role="region" aria-label="Subscription"><span>${LOCK_ICON}<b>${n} sections locked</b> <em>Subscribe to read them all and download the PDF.</em></span><button type="button" data-subscribe onclick="subscribe()">Subscribe</button></div>`;

// Shared look for the card, labels and bar; per-shell rules follow.
const LOCK_UI_CSS = [
  ".r-lockcta{margin:44px 0 8px;padding:28px 28px 24px;background:#0F0F11;color:#fff;border:1px solid #2A2A2E;border-top:3px solid #FCBD00;border-radius:10px;font-family:Inter,system-ui,sans-serif}",
  ".r-lockcta-k{display:flex;align-items:center;gap:8px;color:#FCBD00;font:600 11px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase}",
  ".r-lockcta h3{margin:12px 0 8px;font-size:24px;line-height:1.2;letter-spacing:-.02em;font-weight:800;color:#fff}",
  ".r-lockcta p{margin:0 0 18px;font-size:14.5px;line-height:1.6;color:#B4B4BA;max-width:60ch}",
  ".r-lockchips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px}",
  ".r-lockchip{display:inline-flex;flex-direction:column;gap:2px;padding:8px 11px;border:1px solid #2E2E33;border-radius:8px;background:#17171A;font-size:12.5px;font-weight:600;color:#fff}",
  ".r-lockchip i{font-style:normal;font-weight:500;font-size:11px;color:#8E8E96}.r-lockmore{display:none}",
  ".r-lockcta-row{display:flex;flex-wrap:wrap;align-items:center;gap:14px}",
  ".r-lockcta-btn,.r-lockbar button,.r-lockpill{cursor:pointer;font-family:Inter,system-ui,sans-serif}",
  ".r-lockcta-btn{background:#FCBD00;color:#0F0F0F;border:0;border-radius:7px;padding:13px 20px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}",
  ".r-lockcta-btn:hover,.r-lockbar button:hover{filter:brightness(1.06)}",
  ".r-lockcta-meta{font:500 12px/1.4 'JetBrains Mono',ui-monospace,monospace;color:#8E8E96}",
  ".r-lockwhat{margin:2px 0 14px;font-size:15px;line-height:1.55;font-weight:500;color:var(--fg-2,var(--text-secondary,#4A463E));max-width:64ch}",
  ".r-lockarea{position:relative;min-height:150px}",
  ".r-lockbody{filter:blur(6px);-webkit-user-select:none;user-select:none;pointer-events:none;max-height:320px;overflow:hidden;-webkit-mask-image:linear-gradient(to bottom,#000 40%,transparent);mask-image:linear-gradient(to bottom,#000 40%,transparent)}",
  ".r-lockpill{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;display:flex;align-items:center;gap:10px;max-width:calc(100% - 24px);padding:11px 16px;background:#0F0F11;color:#fff;border:1px solid #FCBD00;border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.28);text-align:left}",
  ".r-lockpill svg{flex:none;color:#FCBD00}",
  ".r-lockpill .t{display:flex;flex-direction:column;gap:1px;font-size:12px;line-height:1.3;color:#C9C9CF}",
  ".r-lockpill .t b{font-size:13px;font-weight:700;color:#fff}",
  ".r-lockpill:focus-visible,.r-lockcta-btn:focus-visible,.r-lockbar button:focus-visible{outline:2px solid #FCBD00;outline-offset:3px;box-shadow:0 0 0 5px #0F0F11}",
  ".r-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",
  `.r-navlock::after{content:"";display:inline-block;width:10px;height:10px;margin-left:6px;vertical-align:-1px;background:url("${NAV_LOCK_IMG}") center/contain no-repeat;opacity:.8}`,
  ".r-navfree::after{content:\"Free\";display:inline-block;margin-left:6px;padding:1px 5px;border-radius:4px;background:rgba(252,189,0,.2);color:#8A6D00;font:700 9px/1.4 Inter,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;vertical-align:1px}",
  ".r-lockbar{position:sticky;bottom:14px;z-index:30;display:flex;align-items:center;gap:14px;width:fit-content;max-width:calc(100% - 24px);margin:28px auto 0;padding:10px 10px 10px 16px;background:#0F0F11;color:#fff;border:1px solid #2E2E33;border-top:2px solid #FCBD00;border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.35);font:500 13px/1.4 Inter,system-ui,sans-serif;opacity:0;transform:translateY(10px);visibility:hidden;transition:opacity .2s,transform .2s,visibility 0s .2s}",
  ".r-lockbar.on{opacity:1;transform:none;visibility:visible;transition:opacity .2s,transform .2s}",
  ".r-lockbar span{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.r-lockbar svg{color:#FCBD00;flex:none}.r-lockbar em{font-style:normal;color:#B4B4BA}",
  ".r-lockbar button{flex:none;background:#FCBD00;color:#0F0F0F;border:0;border-radius:8px;padding:10px 16px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}",
  "@media(max-width:640px){.r-lockcta{display:flex;flex-direction:column;padding:22px 18px 20px}.r-lockcta h3{font-size:20px}.r-lockcta-row{order:4;margin:0 0 16px}"
    + ".r-lockchips{order:5;display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0}.r-lockchip{padding:7px 9px;font-size:12px}.r-lockchip:nth-child(n+7){display:none}.r-lockchips .r-lockmore{display:inline-flex}"
    + ".r-lockbar{padding:8px 8px 8px 12px;gap:10px}.r-lockbar span{flex-wrap:nowrap}.r-lockbar em{display:none}.r-lockwhat{font-size:14px}}",
  "@media print{.r-lockcta,.r-lockbar,.r-lockpill{display:none!important}}",
].join("\n");
const BAKED_BLUR_CSS = LOCK_UI_CSS + "\n@media(max-width:1080px){.r-lockbar{bottom:78px}}";
const EDITORIAL_BLUR_CSS = LOCK_UI_CSS + "\n"
  + ".r-lockzone .sec-head .sec-note,.r-lockzone .chain-head .fig,.r-lockzone .peer-head .fig{filter:blur(5px);-webkit-user-select:none;user-select:none}\n"
  + ".r-lockcta-band{padding:8px 0 56px;background:var(--paper,#F5F3ED)}.r-lockcta-band .r-lockcta{margin:0}\n"
  + "@media(min-width:1180px){.r-lockcta-band>.shell{width:calc(var(--group) - var(--toc-w) - var(--toc-gap));margin-left:calc((100% - var(--group))/2);margin-right:0}}\n"
  + ".r-lockzone>.r-lockbar{margin:-72px auto 12px}\n"
  + "@media(max-width:1179.98px){.r-lockzone>.r-lockbar{bottom:88px}}";

// Runs in the page once the shell has rendered (and again if it re-renders):
// gathers each locked section's body into one capped, blurred, inert block
// with a lock label over it and a plain "what you get" line above it, marks
// the locked items in the contents list, and shows the bar only between the
// "continues" card and the end of the report. Shipped as source text, so it
// may use only its arguments and page globals (document, subscribe).
function lockDecor(META, ICON) {
  var HEAD = ".r-sec-head,.r-sec-title,header,.chain-head,.peer-head,.board-label,.r-takeaway-h,.r-lockwrap";
  function lock(s, m) {
    if (s.querySelector(".r-lockwrap")) return;
    var host = s.querySelector(":scope > .r-takeaway") || s.querySelector(":scope > .shell") || s;
    var kids = Array.prototype.filter.call(host.children, function (c) { return !c.matches(HEAD); });
    if (!kids.length) return;
    var wrap = document.createElement("div"); wrap.className = "r-lockwrap";
    host.insertBefore(wrap, kids[0]);
    if (m[2]) { var w = document.createElement("p"); w.className = "r-lockwhat"; w.textContent = m[2]; wrap.appendChild(w); }
    var sr = document.createElement("p"); sr.className = "r-sr"; sr.textContent = "Subscriber section: " + m[1] + ".";
    var area = document.createElement("div"); area.className = "r-lockarea";
    var body = document.createElement("div"); body.className = "r-lockbody"; body.setAttribute("aria-hidden", "true"); body.inert = true;
    kids.forEach(function (k) { body.appendChild(k); });
    var b = document.createElement("button"); b.type = "button"; b.className = "r-lockpill"; b.setAttribute("data-subscribe", "");
    b.setAttribute("aria-label", m[1] + ". Subscribe to read this section.");
    b.innerHTML = ICON + '<span class="t"><b></b> <span>Subscriber section</span></span>';
    b.querySelector("b").textContent = m[1];
    b.addEventListener("click", function () { subscribe(); });
    area.appendChild(body); area.appendChild(b);
    wrap.appendChild(sr); wrap.appendChild(area);
    Array.prototype.forEach.call(s.querySelectorAll(".sec-note,.chain-head .fig,.peer-head .fig"), function (n) { n.setAttribute("aria-hidden", "true"); });
    s.classList.add("r-blurred");
  }
  var ids = {}; META.forEach(function (m) { ids[m[0]] = 1; });
  function nav() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-target]"), function (el) {
      var t = el.getAttribute("data-target");
      if (ids[t]) el.classList.add("r-navlock"); else if (t === "r-sum") el.classList.add("r-navfree");
    });
  }
  function bar() {
    var b = document.querySelector(".r-lockbar"), cta = document.getElementById("r-lockcta"), end = document.querySelector(".r-end, footer.end");
    if (!b || b.__on) return; b.__on = 1;
    if (!cta || !window.IntersectionObserver) { b.classList.add("on"); return; }
    var past = false, atEnd = false;
    function upd() { b.classList.toggle("on", past && !atEnd); }
    new IntersectionObserver(function (es) { es.forEach(function (e) { past = !e.isIntersecting && e.boundingClientRect.top < 0; }); upd(); }).observe(cta);
    if (end) new IntersectionObserver(function (es) { es.forEach(function (e) { atEnd = e.isIntersecting; }); upd(); }).observe(end);
  }
  function deco() {
    var z = document.querySelector(".r-lockzone"); if (!z) return;
    META.forEach(function (m) { var s = document.getElementById(m[0]); if (s && z.contains(s)) lock(s, m); });
    nav(); bar();
  }
  deco();
  if (window.MutationObserver) new MutationObserver(deco).observe(document.body || document.documentElement, { childList: true, subtree: true });
}
const lockDecorJs = (meta) => "const LOCKMETA = " + jsonSafe(meta.map((m) => [m.id, m.teaser, m.what])) + ";\n"
  + "(" + lockDecor.toString() + ")(LOCKMETA, " + JSON.stringify(LOCK_ICON) + ");\n";

function injectBeforeLastScriptEnd(e, code) {
  const s = e.get(), i = s.lastIndexOf("</script>");
  if (i < 0) throw new Error("script anchor");
  e.set(s.slice(0, i) + code + s.slice(i));
}
function injectCss(e, css) {
  const s = e.get(), re = /<\/style>(\r?\n)<\/head>/;
  if (!re.test(s)) throw new Error("head anchor");
  e.set(s.replace(re, (all, nl) => css + "\n</style>" + nl + "</head>"));
}

function bakedBlurPreview(src) {
  const e = editor(src);
  const m = e.get().match(/^const INCIDENT = (\{.*\});\r?$/m);
  if (!m) throw new Error("no INCIDENT line");
  const I = JSON.parse(m[1]);
  const A = bakedPreview(src);                       // same visible part as design A…
  const P = { ...A.keep };
  delete P.chain;                                    // …except case progression, which is locked here
  for (const k of Object.keys(I)) if (!(k in P) && k !== "footnote") P[k] = standIn(I[k], k, I.id + ":" + k);
  // a fixed pattern, assigned by dimension name (not by the real order, which can follow the scores)
  if (P.severityDims && Array.isArray(P.severityDims.dims)) {
    const names = P.severityDims.dims.map((d) => String(d.dim)).sort();
    P.severityDims.dims = P.severityDims.dims.map((d) => ({ ...d, score: SCORE_PATTERN[names.indexOf(String(d.dim)) % SCORE_PATTERN.length] }));
  }
  const meta = lockMeta(I, BAKED_LOCKED);
  const hasChain = meta.some((x) => x.id === "r-chain");
  e.once(m[0], "const INCIDENT = " + jsonSafe(P) + ";", "INCIDENT");
  e.set(e.get().replace(/<title>(.*?)<\/title>/s, () => "<title>Attacked.ai · " + escH(I.title || "Intelligence briefing") + " · Preview</title>"));
  e.set(e.get().replace(/aria-label="Intelligence briefing[^"]*"/, 'aria-label="Intelligence briefing preview"'));
  e.set(e.get().replace(/\/\* ---- INCIDENT:.*?\*\//, "/* ---- INCIDENT: preview — locked sections hold stand-in text ---- */"));
  // case progression leaves the summary and becomes the first locked section
  const chainRe = /\$\{chainHtml\?`<div class="r-chainwrap">[\s\S]*?`:''\}/;
  const cm = e.get().match(chainRe);
  if (!cm || e.get().split(cm[0]).length !== 2) throw new Error("chain anchor");
  e.set(e.get().replace(cm[0], () => ""));
  const chainSec = hasChain ? '    <section class="r-sec" id="r-chain"><div class="r-sec-head"><span class="r-sec-num">00</span><span class="r-sec-eyebrow">Case progression</span></div><h2 class="r-sec-title">How it unfolded</h2>' + cm[0] + "</section>\n\n" : "";
  {
    const s = e.get();
    const a = s.indexOf('    <section class="r-sec" id="r-sev">'), b = s.indexOf('    <div class="r-end">');
    if (a < 0 || b < 0 || b < a || s.split('    <div class="r-end">').length !== 2) throw new Error("lock zone anchors");
    e.set(s.slice(0, a) + "    " + LOCKED_START + lockCta(meta, P.readMin) + `\n    <div class="r-lockzone" ${PREVIEW_MARK}>\n` + chainSec + s.slice(a, b) + "    " + lockBar(meta.length) + "\n    </div>\n" + s.slice(b));
  }
  if (hasChain) e.once("const navItems=[['sum','Executive summary'],", "const navItems=[['sum','Executive summary'],['chain','Case progression'],", "navItems");
  e.once('<button class="r-btn primary" onclick="downloadPDF()">↓ Download PDF</button>', '<button class="r-btn primary" data-subscribe onclick="subscribe()">Subscribe · full report + PDF</button>', "rail PDF");
  e.once('<button class="r-btn ghost" id="readerPrint">↓ Download PDF</button>', '<button class="r-btn ghost" id="readerPrint" data-subscribe>Subscribe for the PDF</button>', "top PDF");
  e.once('<button class="r-btn" onclick="downloadPDF()">↓ Download PDF</button>', '<button class="r-btn primary" data-subscribe onclick="subscribe()">Subscribe for the full briefing + PDF</button>', "end PDF");
  e.once("function downloadPDF(){ window.print(); }", SUBSCRIBE_JS + "\nfunction downloadPDF(){ subscribe(); }", "downloadPDF");
  e.once("const rt=readTime(I);", "const rt=I.readMin||readTime(I);", "readTime");
  e.set(e.get().replace(/url\("data:image\/webp;base64,[A-Za-z0-9+/=]+"\) center\/cover no-repeat,/, ""));
  injectCss(e, BAKED_BLUR_CSS);
  e.blockPrint();
  injectBeforeLastScriptEnd(e, lockDecorJs(meta));
  const keep = { ...A.keep }; delete keep.chain;
  return { html: e.get(), kind: "baked", design: "blur", keep, locked: [...A.locked, I.chain], data: P, meta, preview: A };
}

function editorialBlurPreview(src) {
  const e = editor(src);
  const mI = e.line("INCIDENT"), mM = e.line("MEDIA"), mG = e.line("GEO");
  const I = JSON.parse(mI[1]), M = JSON.parse(mM[1]);
  let bbox = null; try { bbox = (JSON.parse(mG[1]) || {}).bbox || null; } catch { /* no map frame: default decoys */ }
  const A = editorialPreview(src);
  const P = { ...A.keep };
  for (const k of Object.keys(I)) if (!(k in P) && k !== "footnote" && k !== "severityDims") P[k] = standIn(I[k], k, I.id + ":" + k, bbox);
  // design A shows the dimension scores in the hero here, so they stay real
  if (I.severityDims) P.severityDims = standIn(I.severityDims, "severityDims", I.id + ":severityDims", bbox);
  const meta = lockMeta(I, EDITORIAL_LOCKED);
  // the visible images exactly as design A; the section illustrations become plain placeholders
  const Mb = { ...M };
  for (const [k, v] of Object.entries(M)) if (!["titleAccent", "note", "hero"].includes(k) && v && typeof v === "object" && !Array.isArray(v)) Mb[k] = { ...v, alt: "", ...(v.src ? { src: PLACEHOLDER_IMG } : {}) };
  e.once(mI[0], "const INCIDENT = " + jsonSafe(P) + ";", "INCIDENT");
  e.once(mM[0], "const MEDIA = " + jsonSafe(Mb) + ";", "MEDIA");
  e.once("const rt=readTime(I);", "const rt=I.readMin||readTime(I);", "readTime");
  {
    const s = e.get(), b = s.indexOf("  /* ---- end ---- */");
    if (b < 0) throw new Error("end anchor");
    const consts = "  const __lockCta=" + jsonSafe(LOCKED_START + '<section class="r-lockcta-band"><div class="shell">' + lockCta(meta, P.readMin) + "</div></section>") + ";\n"
      + "  const __lockZone=" + jsonSafe(`<div class="r-lockzone" ${PREVIEW_MARK}>`) + ", __lockEnd=" + jsonSafe(lockBar(meta.length) + "</div>") + ";\n";
    e.set(s.slice(0, b) + consts + s.slice(b));
  }
  e.once("return cover+toc+[summary,quote,chain,severity,fcam,comparables,frameworks,blast,peer,control,vend,outlook,scen,verdict,board,sources].join('')+end;",
    "return cover+toc+[summary,quote].join('')+__lockCta+__lockZone+[chain,severity,fcam,comparables,frameworks,blast,peer,control,vend,outlook,scen,verdict,board,sources].join('')+__lockEnd+end;", "return");
  e.once('<button class="hdr-btn" id="readerPrint">&darr; Download PDF</button>', '<button class="hdr-btn" data-subscribe onclick="subscribe()">Subscribe for the PDF</button>', "header PDF");
  {
    const re = /function downloadPDF\(\)\{[^}]*\{[^}]*\}\s*window\.print\(\);\s*\}/g;
    const hits = e.get().match(re) || [];
    if (hits.length !== 1) throw new Error("downloadPDF: expected 1 match, got " + hits.length);
    e.set(e.get().replace(re, () => SUBSCRIBE_JS + "\nfunction downloadPDF(){ subscribe(); }"));
  }
  e.once("$('readerPrint').addEventListener('click',downloadPDF);", "", "readerPrint listener");
  injectCss(e, EDITORIAL_BLUR_CSS);
  e.blockPrint();
  injectBeforeLastScriptEnd(e, lockDecorJs(meta));
  e.set(e.get().replace(/<title>(.*?)<\/title>/s, (all, t) => "<title>" + t.trim() + " · Preview</title>"));
  return { html: e.get(), kind: "editorial", design: "blur", keep: A.keep, locked: A.locked, data: P, meta, preview: A };
}

// Which shell a file is, from markers only that shell carries.
export function reportShell(html) {
  if (typeof html !== "string") return null;
  if (html.includes("const NAV=[['sum','Executive summary']") && /^const MEDIA = /m.test(html)) return "editorial";
  if (html.includes("const navItems=[['sum','Executive summary']") && /^const INCIDENT = /m.test(html)) return "baked";
  return null;
}

// The free-reader copy of a finished report file. Throws when the file is not
// a shell this module knows; callers fall back to a title-only stub.
//   design "lock" (A, live): summary, then one Subscribe panel;
//   design "blur" (B, under review): summary, then every section blurred.
export function makeReportPreview(html, { design = "lock" } = {}) {
  const shell = reportShell(html);
  const blur = design === "blur";
  if (shell === "editorial") return blur ? editorialBlurPreview(html) : editorialPreview(html);
  if (shell === "baked") return blur ? bakedBlurPreview(html) : bakedPreview(html);
  throw new Error("unknown report shell");
}

// Last resort when no proper preview can be made: title, summary line and the
// Subscribe button. Never any of the report body.
export function stubPreview({ ref = "", title = "", subtitle = "", summary = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escH(title || "Attacked.ai briefing")} · Preview</title>
<style>body{margin:0;background:#fff;color:#1A1A1A;font:16px/1.6 Inter,system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:72px 22px}
.k{font:600 11px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#8A6D00}h1{font-size:34px;line-height:1.15;letter-spacing:-.02em;margin:14px 0 10px}
.s{color:#4A463E;font-size:18px}.lock{margin-top:36px;border-top:1px solid #E6E2D8;padding-top:28px}.lock h2{font-size:20px;margin:0 0 8px}
button{margin-top:16px;background:#FCBD00;color:#0f0f0f;border:0;padding:12px 20px;font:700 12px/1 Inter,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
${PRINT_BLOCK_CSS}</style></head><body><main ${PREVIEW_MARK}><div class="k">${escH(ref)}</div><h1>${escH(title)}</h1>${subtitle ? `<p class="s">${escH(subtitle)}</p>` : ""}${summary ? `<p>${escH(summary)}</p>` : ""}
<section class="lock" id="r-lock"><h2>The full briefing is for subscribers</h2><p>The complete analysis, sources and the Download PDF are part of an Attacked.ai subscription.</p><button type="button" data-subscribe onclick="subscribe()">Subscribe to read the full briefing</button></section></main>
<script>${SUBSCRIBE_JS}</script></body></html>`;
}
