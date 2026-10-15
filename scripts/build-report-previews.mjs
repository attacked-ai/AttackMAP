// build-report-previews.mjs — make the free-reader copy of every report.
//
//   node scripts/build-report-previews.mjs <public dir> [--add <file>=<REF>]...
//
// Layout it maintains (both folders are gitignored and deployed as files):
//   <public>/reports-full/<ref>.html  the full report — served only through the
//                                     subscriber gate (middleware.js)
//   <public>/reports/<ref>.html       the preview: header, key figures and the
//                                     Executive Summary; everything else locked
//
// Run it after any report is added or re-baked. A full report dropped into
// reports/ (the old place) is moved into reports-full/ first, so the open
// folder never keeps a full copy. --add copies a new report in under a ref.
//
// Every preview is checked before it is written: no locked paragraph (as
// text, JSON or HTML-escaped) and no 8-word run from a locked section may
// appear in it, and its page script must render with the lock band and
// without any locked section. A file that fails gets a title-only stub, never
// the full text. Exit code 1 when anything failed.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { isPreviewHtml, makeReportPreview, stubPreview } from "../src/lib/reportPreview.js";

const args = process.argv.slice(2);
const adds = []; let pub = null;
for (let i = 0; i < args.length; i++) { if (args[i] === "--add") adds.push(args[++i]); else if (!pub) pub = args[i]; }
if (!pub || !fs.existsSync(pub)) { console.error("usage: node scripts/build-report-previews.mjs <public dir> [--add <file>=<REF>]"); process.exit(2); }
const FULL = path.join(pub, "reports-full"), PREV = path.join(pub, "reports");
fs.mkdirSync(FULL, { recursive: true }); fs.mkdirSync(PREV, { recursive: true });
const isReport = (n) => /^ATK-[A-Za-z0-9-]+\.html$/.test(n);

// 1. full reports still sitting in the open folder become the source
let moved = 0;
for (const n of fs.readdirSync(PREV).filter(isReport)) {
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
const words = (x) => x.toLowerCase().replace(/[^a-z0-9%$£€.\- ]+/g, " ").split(/\s+/).filter(Boolean);
const shingles = (x, n = 8) => { const w = words(x), o = []; for (let i = 0; i + n <= w.length; i++) o.push(w.slice(i, i + n).join(" ")); return o; };
const LOCKED_IDS = ["r-sev", "r-fcam", "r-comp", "r-frame", "r-blast", "r-peer", "r-ctrl", "r-vend", "r-out", "r-scen", "r-verdict", "r-src"];

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

function check(res) {
  const s = res.html;
  const keepText = leaves(res.keep).join(" \n ");
  const lockedAll = [...new Set(res.locked.flatMap((v) => leaves(v)))];
  const forms = (x) => [x, JSON.stringify(x).slice(1, -1), escH(x), JSON.stringify(x).slice(1, -1).replace(/</g, BS + "u003c")];
  const leakLeaves = lockedAll.filter((x) => x.length >= 30 && !keepText.includes(x) && forms(x).some((f) => s.includes(f)));
  const keepSh = new Set(shingles(keepText));
  const padded = " " + words(s.replace(/data:[a-z/+]+;base64,[A-Za-z0-9+/=]+/g, " ")).join(" ") + " ";
  const leakSh = [...new Set(lockedAll.flatMap((x) => shingles(x)))].filter((x) => !keepSh.has(x) && padded.includes(" " + x + " "));
  const { err, art } = render(s);
  const secs = [...art.matchAll(/<section[^>]*id="([a-z-]+)"/g)].map((x) => x[1]);
  const problems = [];
  if (leakLeaves.length) problems.push(`${leakLeaves.length} locked paragraph(s) present, e.g. "${leakLeaves[0].slice(0, 60)}"`);
  if (leakSh.length) problems.push(`${leakSh.length} locked phrase(s) present, e.g. "${leakSh[0]}"`);
  if (err) problems.push("page script failed: " + err);
  else {
    if (!art.includes("r-lock")) problems.push("lock band not rendered");
    const bad = secs.filter((x) => LOCKED_IDS.includes(x));
    if (bad.length) problems.push("locked section rendered: " + bad.join(","));
  }
  if (/window\.print\(/.test(s)) problems.push("print still wired");
  return problems;
}

// 3. previews
const fulls = fs.readdirSync(FULL).filter(isReport).sort();
let ok = 0, failed = 0, bytesFull = 0, bytesPrev = 0;
for (const n of fulls) {
  const full = fs.readFileSync(path.join(FULL, n), "utf8");
  let out = null, problems = [];
  try { const res = makeReportPreview(full); problems = check(res); if (!problems.length) out = res.html; }
  catch (e) { problems = [e.message]; }
  if (!out) {
    const title = (full.match(/<title>(.*?)<\/title>/s) || [])[1] || n;
    out = stubPreview({ ref: n.replace(/\.html$/, ""), title: title.replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, " ").replace(/^Attacked\.ai\s*·\s*/, "").trim() });
    console.error(`FAILED ${n}: ${problems.join("; ")} — wrote a title-only stub`); failed++;
  } else ok++;
  fs.writeFileSync(path.join(PREV, n), out);
  bytesFull += Buffer.byteLength(full); bytesPrev += Buffer.byteLength(out);
}
const mb = (b) => (b / 1048576).toFixed(1) + " MB";
console.log(`moved ${moved} full report(s) into reports-full/; ${ok} preview(s) ok, ${failed} failed; full ${mb(bytesFull)} → previews ${mb(bytesPrev)}`);
process.exit(failed ? 1 : 0);
