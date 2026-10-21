// reportPdf.mjs — stamp the print edition of a briefing for one reader.
//
// The print masters are built offline (D:/claude_work/nats-v2/tools/build_print.py):
// an A4 PDF per report with a BLANK licence box on page 2 and no licence line in
// the footer, plus <ref>.stamp.json saying where those go (measured from the
// render: the four box fields as rectangles in PDF points, origin top-left, and
// the footer baseline with the gap between the left and right footer texts).
// Both live in reports-pdf/ (gitignored; deployed as files, bundled into the
// function with vercel.json "includeFiles"). This module writes the reader's
// name, organisation, a licence id and the date into the box, and
// "Licensed to <name> · <organisation>" into the footer of every page but the
// cover, and records the licensee in the PDF metadata. Same output as
// tools/stamp_pdf.py in the print project. Under 300 ms for a 42-page master.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const PDF_DIR = process.env.REPORT_PDF_DIR || path.join(process.cwd(), "reports-pdf");
export const REF = /^ATK-[A-Za-z0-9-]+$/;

const INK = rgb(14 / 255, 17 / 255, 22 / 255);
const GREY = rgb(0.36, 0.37, 0.4);
const FONTS = { "Helvetica": StandardFonts.Helvetica, "Helvetica-Bold": StandardFonts.HelveticaBold, "Courier": StandardFonts.Courier };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The standard PDF fonts cover Latin-1 only; anything else becomes "?" rather than a crash.
export const latin = (s, max) => String(s || "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?").replace(/\s+/g, " ").trim().slice(0, max);

export class ReportPdfError extends Error { constructor(status, message) { super(message); this.status = status; } }

export async function stampReportPdf({ ref, name, role, email = "", userId = "", now = new Date() }) {
  email = latin(email, 60);
  email = latin(email, 60);
  if (!REF.test(String(ref || ""))) throw new ReportPdfError(400, "bad_ref");
  let master, map;
  try {
    [master, map] = await Promise.all([
      readFile(path.join(PDF_DIR, ref + ".pdf")),
      readFile(path.join(PDF_DIR, ref + ".stamp.json"), "utf8").then(JSON.parse),
    ]);
  } catch { throw new ReportPdfError(404, "no_print_edition"); }

  name = latin(name, 48) || latin(email, 48) || "Licensed reader";
  role = latin(role, 40) || "Subscriber";
  const issued = `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  const stamp = `${issued}, ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  // Stable per reader and day; the account id makes it traceable to the login, not just the typed name.
  const lid = `${ref} / L-${createHash("sha1").update(`${ref}|${name}|${role}|${userId}|${issued}`).digest("hex").slice(0, 8).toUpperCase()}`;
  const values = { name, role, email, id: lid, issued };

  const doc = await PDFDocument.load(master, { updateMetadata: false });
  const fonts = {};
  for (const f of Object.keys(FONTS)) fonts[f] = await doc.embedFont(FONTS[f]);
  const pages = doc.getPages();
  if (pages.length < 2) throw new ReportPdfError(500, "master_too_short");

  // 1. the licence box on page 2
  const p2 = pages[1], H2 = p2.getHeight();
  for (const [k, rect] of Object.entries(map.box)) {
    if (values[k] == null) continue;   // an older map without the email row
    const [fontName, size] = map.fonts[k];
    p2.drawText(values[k], { x: rect[0], y: H2 - (rect[3] - size * 0.24), size, font: fonts[fontName], color: INK });
  }
  // 2. the footer line, every page but the cover
  const line = `Licensed to ${name} \u00b7 ${role}`;
  const size = map.footer.size || 7.5, helv = fonts["Helvetica"];
  const tw = helv.widthOfTextAtSize(line, size);
  let x = (map.footer.left_end + map.footer.right_start) / 2 - tw / 2;
  if (x < map.footer.left_end + 6) x = map.footer.left_end + 6;
  for (let i = 1; i < pages.length; i++) {
    const pg = pages[i];
    pg.drawText(line, { x, y: pg.getHeight() - map.footer.baseline, size, font: helv, color: GREY });
  }
  // 3. metadata
  const kw = [...(doc.getKeywords() ? [doc.getKeywords()] : []), `licensed to ${name} (${role}${email ? ", " + latin(email, 80) : ""}) on ${stamp}`, lid];
  doc.setKeywords(kw);
  doc.setModificationDate(now);
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, licenceId: lid, pages: pages.length, name, role, issued };
}
