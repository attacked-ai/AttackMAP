// build-report-previews.mjs — make the free-reader copy of every report.
//
//   node scripts/build-report-previews.mjs <public dir> [--add <file>=<REF>]...
//        [--design lock|blur] [--out <folder>]
//
// Layout it maintains (both folders are gitignored and deployed as files):
//   <public>/reports-full/<ref>.html  the full report — served only through the
//                                     subscriber gate (middleware.js)
//   <public>/reports/<ref>.html       the preview: header, key figures and the
//                                     Executive Summary; everything else locked
//
// --design picks the preview design (src/lib/reportPreview.js): "lock" (A,
// the default and the live one — one Subscribe panel after the summary) or
// "blur" (B — every later section shown with its heading and a blurred
// stand-in body). --out writes somewhere other than reports/ (default for
// blur: reports-blur/, a review copy the live site never links to).
//
// Run it after any report is added or re-baked. A full report dropped into
// reports/ (the old place) is moved into reports-full/ first, so the open
// folder never keeps a full copy. --add copies a new report in under a ref.
//
// Every preview is checked before it is written: no locked paragraph (as
// text, JSON or HTML-escaped) and no 8-word run from a locked section may
// appear in it, and its page script must render. Design A must render the
// lock band and no locked section. Design B must carry no locked text of 6+
// characters in its data at all, render every section the full report has,
// and show exactly design A's page above the locked part. A file that fails
// gets a title-only stub, never the full text. Exit code 1 when anything failed.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { LAYOUT_FIELDS, LOCKED_START, NEUTRAL_FIELDS, isPreviewHtml, makeReportPreview, stubPreview } from "../src/lib/reportPreview.js";

const args = process.argv.slice(2);
const adds = []; let pub = null, design = "lock", outName = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--add") adds.push(args[++i]);
  else if (args[i] === "--design") design = args[++i];
  else if (args[i] === "--out") outName = args[++i];
  else if (!pub) pub = args[i];
}
if (!pub || !fs.existsSync(pub) || !["lock", "blur"].includes(design)) { console.error("usage: node scripts/build-report-previews.mjs <public dir> [--add <file>=<REF>] [--design lock|blur] [--out <folder>]"); process.exit(2); }
outName = outName || (design === "blur" ? "reports-blur" : "reports");
const FULL = path.join(pub, "reports-full"), PREV = path.join(pub, "reports"), OUT = path.join(pub, outName);
fs.mkdirSync(FULL, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
const isReport = (n) => /^ATK-[A-Za-z0-9-]+\.html$/.test(n);

// 1. full reports still sitting in the open folder become the source
let moved = 0;
if (fs.existsSync(PREV)) for (const n of fs.readdirSync(PREV).filter(isReport)) {
  const html = fs.readFileSync(path.join(PREV, n), "utf8");
  if (isPreviewHtml(html)) continue;
  fs.writeFileSync(path.join(FULL, n), html); moved++;
}
// 2. new reports
for (const a of adds) {
  const [file, ref] = String(a || "").split(/=(?=[^=]+$)/);
  if (!file || !/^ATK-[A-Za-z0-9-]+$/.test(ref || "")) { console.error("--add needs <file>=<ATK-REF>"); process.exit(2); }
  fs.copyFileSync(file, path.join(FULL, ref + ".html")); console.log(`added ${ref} from ${file}`);
}

// ── checks ────────────────────────────────────────────────────────────────
const BS = String.fromCharCode(92);
const escH = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const norm = (x) => String(x).replace(/\s*\[S\d+\]/g, "").trim();
const leaves = (v, acc = []) => {
  if (typeof v === "string") { if (!v.startsWith("data:") && !/^https?:/.test(v)) acc.push(norm(v)); }
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, acc));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, acc));
  return acc;
};
// [field name, text] for every string under a locked value
const keyedLeaves = (v, key, acc = []) => {
  if (typeof v === "string") acc.push([key, v]);
  else if (Array.isArray(v)) v.forEach((x) => keyedLeaves(x, key, acc));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) keyedLeaves(x, k, acc);
  return acc;
};
const words = (x) => x.toLowerCase().replace(/[^a-z0-9%$£€.\- ]+/g, " ").split(/\s+/).filter(Boolean);
const shingles = (x, n = 8) => { const w = words(x), o = []; for (let i = 0; i + n <= w.length; i++) o.push(w.slice(i, i + n).join(" ")); return o; };
const forms = (x) => [x, JSON.stringify(x).slice(1, -1), escH(x), JSON.stringify(x).slice(1, -1).replace(/</g, BS + "u003c")];
const LOCKED_IDS = ["r-chain", "r-sev", "r-fcam", "r-comp", "r-frame", "r-blast", "r-peer", "r-ctrl", "r-vend", "r-out", "r-scen", "r-verdict", "r-src"];

function render(html) {
  const out = {};
  const el = (id) => new Proxy({ id, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, dataset: {}, addEventListener() {}, setAttribute() {}, focus() {}, appendChild() {}, scrollTo() {}, contains() { return false; }, getBoundingClientRect() { return { top: 0, bottom: 0 }; } }, {
    set(t, k, v) { t[k] = v; if (k === "innerHTML") out[id] = v; return true; },
    get(t, k) { return k in t ? t[k] : (k === "textContent" || k === "innerHTML" ? "" : undefined); },
  });
  const els = {};
  const document = { getElementById: (id) => els[id] || (els[id] = el(id)), querySelectorAll: () => [], querySelector: () => null, body: el("body"), head: el("head"), documentElement: el("html"), activeElement: null, createElement: () => el("x"), addEventListener() {} };
  const win = { addEventListener() {} }; win.top = win; win.self = win;
  const sandbox = { document, window: win, console: { log() {}, warn() {}, error() {} }, Date, String, Math, JSON, Array, Object, Set, Number, parseFloat, setTimeout() {}, getComputedStyle: () => ({ top: "72px" }), innerHeight: 900, scrollY: 0, location: { origin: "http://localhost", search: "", href: "http://localhost/" }, addEventListener() {} };
  const code = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  try { vm.runInNewContext(code, sandbox, { timeout: 5000 }); } catch (e) { return { err: e.message, art: "" }; }
  return { err: null, art: out.readerArticle || "" };
}
const sectionIds = (art) => [...art.matchAll(/<section[^>]*id="([a-z-]+)"/g)].map((x) => x[1]);

// Locked paragraphs and 8-word runs anywhere in the file (both designs).
function textLeaks(res) {
  const s = res.html;
  const keepText = leaves(res.keep).join(" \n ");
  const lockedAll = [...new Set(res.locked.flatMap((v) => leaves(v)))];
  const leakLeaves = lockedAll.filter((x) => x.length >= 30 && !keepText.includes(x) && forms(x).some((f) => s.includes(f)));
  const keepSh = new Set(shingles(keepText));
  const padded = " " + words(s.replace(/data:[a-z/+]+;base64,[A-Za-z0-9+/=]+/g, " ")).join(" ") + " ";
  const leakSh = [...new Set(lockedAll.flatMap((x) => shingles(x)))].filter((x) => !keepSh.has(x) && padded.includes(" " + x + " "));
  const problems = [];
  if (leakLeaves.length) problems.push(`${leakLeaves.length} locked paragraph(s) present, e.g. "${leakLeaves[0].slice(0, 60)}"`);
  if (leakSh.length) problems.push(`${leakSh.length} locked phrase(s) present, e.g. "${leakSh[0]}"`);
  if (/window\.print\(/.test(s)) problems.push("print still wired");
  return problems;
}

function checkLock(res) {
  const problems = textLeaks(res);
  const { err, art } = render(res.html);
  if (err) problems.push("page script failed: " + err);
  else {
    if (!art.includes("r-lock")) problems.push("lock band not rendered");
    const bad = sectionIds(art).filter((x) => LOCKED_IDS.includes(x));
    if (bad.length) problems.push("locked section rendered: " + bad.join(","));
  }
  return { problems, art };
}

// What a reader sees above the locked part, with the parts that differ by
// design taken out: the contents rail (B lists every section) and the hero's
// "Severity assessment" link (A points it at the lock panel).
// Case progression sits in the free summary in design A of the standard
// reports and is locked in design B, so it is left out on both sides too.
const visiblePart = (art) => {
  const i = art.indexOf(LOCKED_START);
  if (i < 0) return null;
  let s = art.slice(0, i).replace(/<div class="toc-layer">[\s\S]*?<\/nav><\/div>/, "").replace(/<a class="hs-link"[^>]*>[\s\S]*?<\/a>/, "");
  const c = s.indexOf('<div class="r-chainwrap">');
  if (c >= 0) { const e = s.indexOf("</section>", c); s = s.slice(0, c) + (e >= 0 ? s.slice(e) : ""); }
  return s.replace(/\s+/g, " ");
};

function checkBlur(res, fullArt) {
  const problems = textLeaks(res);
  // no locked text of 6+ characters in the page's data at all
  const dataText = res.html.split(/\r?\n/).filter((l) => /^(const INCIDENT = |const MEDIA = |const LOCKMETA = |  const __lock)/.test(l)).join("\n");
  const keepText = leaves(res.keep).join(" \n ");
  const lockedKeyed = res.locked.flatMap((v) => keyedLeaves(v, ""));
  // a short value counts only as a whole JSON value ("Regulator" inside the
  // kept label "Regulatory" is not a leak); a long one anywhere
  const inData = (t) => t.length < 30 ? [JSON.stringify(t), JSON.stringify(t).replace(/</g, BS + "u003c")].some((f) => dataText.includes(f)) : forms(t).some((f) => dataText.includes(f));
  // values kept on purpose (layout fields) may also sit under another field
  const layoutValues = new Set(lockedKeyed.filter(([k]) => LAYOUT_FIELDS.has(k)).map(([, t]) => t.trim()));
  const dataLeaks = [...new Set(lockedKeyed.filter(([k, t]) => !LAYOUT_FIELDS.has(k) && !NEUTRAL_FIELDS.has(k) && !layoutValues.has(t.trim()) && t.trim().length >= 6 && !/^(data:|https?:)/.test(t) && !keepText.includes(t.trim()) && inData(t.trim())).map(([, t]) => t.trim()))];
  if (dataLeaks.length) problems.push(`${dataLeaks.length} locked value(s) in the data, e.g. "${dataLeaks[0].slice(0, 50)}"`);
  const { err, art } = render(res.html);
  if (err) { problems.push("page script failed: " + err); return { problems, art }; }
  if (!art.includes("r-lockzone")) problems.push("blurred zone not rendered");
  const want = sectionIds(fullArt).filter((x) => LOCKED_IDS.includes(x) || x === "r-board");
  const have = new Set(sectionIds(art));
  const missing = want.filter((x) => !have.has(x));
  if (missing.length) problems.push("sections missing from the blurred design: " + missing.join(","));
  const a = visiblePart(checkLock(res.preview).art), b = visiblePart(art);
  if (a == null || b == null) problems.push("locked-start marker missing");
  else if (a !== b) { let i = 0; while (i < a.length && a[i] === b[i]) i++; problems.push(`visible part differs from design A at char ${i}: A "${a.slice(i, i + 50)}" / B "${b.slice(i, i + 50)}"`); }
  return { problems, art };
}

// 3. previews
const fulls = fs.readdirSync(FULL).filter(isReport).sort();
let ok = 0, failed = 0, bytesFull = 0, bytesPrev = 0;
for (const n of fulls) {
  const full = fs.readFileSync(path.join(FULL, n), "utf8");
  let out = null, problems = [];
  try {
    const res = makeReportPreview(full, { design });
    problems = design === "blur" ? checkBlur(res, render(full).art).problems : checkLock(res).problems;
    if (!problems.length) out = res.html;
  } catch (e) { problems = [e.message]; }
  if (!out) {
    const title = (full.match(/<title>(.*?)<\/title>/s) || [])[1] || n;
    out = stubPreview({ ref: n.replace(/\.html$/, ""), title: title.replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, " ").replace(/^Attacked\.ai\s*·\s*/, "").trim() });
    console.error(`FAILED ${n}: ${problems.join("; ")} — wrote a title-only stub`); failed++;
  } else ok++;
  fs.writeFileSync(path.join(OUT, n), out);
  bytesFull += Buffer.byteLength(full); bytesPrev += Buffer.byteLength(out);
}
const mb = (b) => (b / 1048576).toFixed(1) + " MB";
console.log(`design ${design} → ${outName}/: moved ${moved} full report(s) into reports-full/; ${ok} preview(s) ok, ${failed} failed; full ${mb(bytesFull)} → previews ${mb(bytesPrev)}`);
process.exit(failed ? 1 : 0);
