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
  e.set(e.get().replace(/<title>(.*?)<\/title>/s, (all, t) => "<title>" + t.trim() + " · Preview</title>"));
  e.set(e.get().replace(/aria-label="Intelligence briefing[^"]*"/, 'aria-label="Intelligence briefing preview"'));
  e.set(e.get().replace(/\/\* ---- INCIDENT:.*?\*\//, "/* ---- INCIDENT: summary-only preview ---- */"));
  // Cut every section after the executive summary, and the closing Download
  // PDF block, down to the footer.
  const s = e.get();
  const a = s.indexOf('    <section class="r-sec" id="r-sev">'), b = s.indexOf('    <div class="r-foot">');
  if (a < 0 || b < 0 || b < a) throw new Error("section cut anchors");
  const lock = [
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
  const lockJs = "  const lockBand=`<section class=\"band\" id=\"r-lock\" " + PREVIEW_MARK + "><div class=\"shell\">${head('01-11','Subscriber briefing','The full briefing is for subscribers','Case progression, severity assessment, causal analysis, comparables, frameworks, blast radius, peer watchlist, GUARD controls, vendor intelligence, outlook, scenarios, analyst verdict, board takeaway, sources and the Download PDF.')}<button class=\"hdr-btn\" style=\"margin-top:22px;background:var(--gold,#FCBD00);border-color:var(--gold,#FCBD00);color:#0f0f0f\" data-subscribe onclick=\"subscribe()\">Subscribe to read the full briefing</button></div></section>`;\n";
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

// Which shell a file is, from markers only that shell carries.
export function reportShell(html) {
  if (typeof html !== "string") return null;
  if (html.includes("const NAV=[['sum','Executive summary']") && /^const MEDIA = /m.test(html)) return "editorial";
  if (html.includes("const navItems=[['sum','Executive summary']") && /^const INCIDENT = /m.test(html)) return "baked";
  return null;
}

// The free-reader copy of a finished report file. Throws when the file is not
// a shell this module knows; callers fall back to a title-only stub.
export function makeReportPreview(html) {
  const shell = reportShell(html);
  if (shell === "editorial") return editorialPreview(html);
  if (shell === "baked") return bakedPreview(html);
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
