# Deploy handoff — 21 Oct 2026: licensed PDF, v5 NATS report, related broadcast

Prepared by Claude; **the owner runs the deploy** (Claude is blocked from production deploys and from the live database).

## What is in this deploy (branch `cards-only-on-live`, commit **0f49c00**, folder `D:\attacked-dev\wt-deploy`)

| Piece | What it does |
|---|---|
| `api/report-pdf.mjs` + `api/_lib/reportPdf.mjs` | New Vercel function. A subscriber POSTs `{ref}` with their access token; the server reads **their own profile** (full name, job title, company, account email: what sign-up collected, nothing typed) and returns the A4 print edition stamped for them: name, title · company, account email, licence id and date in the licence box on page 2, "Licensed to …" in every footer, licensee in the metadata. Same subscriber check as `/reports-full/`. |
| `reports-pdf/` (files, not in git) | The print masters: `ATK-2026-0908-NATS.pdf` + `ATK-2026-0908-NATS.stamp.json`. The master's licence box is blank on purpose; the stamper fills it per reader and draws the one QR code of the document there (opens the live edition, carrying that copy's number). Only the NATS briefing has a master so far; other reports fall back to the browser print dialog. Never served directly (the gate answers 404). |
| `vercel.json` | Bundles `reports-pdf/**` into the function, 10 s limit. |
| `public/reports-full/ATK-2026-0908-NATS.html` | The NATS briefing is now **v5**: broadcast card after the summary, Attack Map band, and a **licence card** built from the reader's profile (no form): name, title · company, email, what prints on every page, one button → the stamped PDF. |
| `public/reports/…` | All 311 free previews rebuilt (the NATS preview shows the broadcast card, then the subscriber lock). |
| Hub (commit d925806, earlier today) | Related-broadcast bar at the foot of an open report; Broadcasts panel on Admin → Reports; `?hub&report=<ref>` opens baked reports too. Shows nothing until the SQL below is run. |
| `.vercelignore` | `api/` is no longer ignored wholesale: only the FastAPI files under it are. |

Previous live commit: **7ba9e7d** (rollback target).

## Owner steps

1. **(Optional, any time) Related broadcast table.** Supabase → SQL editor → paste and run `C:\Users\mohin\Downloads\Broadcasts - run once in Supabase SQL editor.sql` (creates `public.report_broadcasts` + three admin functions, seeds the NATS episode as "coming soon"). The site works without it; the broadcast bar just stays hidden.

2. **Deploy.**
   ```
   cd D:\attacked-dev\wt-deploy
   vercel.cmd deploy --prod --yes
   ```

3. **Verify (PowerShell, after the deploy).**
   ```
   curl.exe -s -o NUL -w "%{http_code}`n" https://attackedmap.vercel.app/reports-full/ATK-EV-067.html
   ```
   must print **302** (never 200 without a token).
   ```
   curl.exe -s -o NUL -w "%{http_code}`n" https://attackedmap.vercel.app/reports-pdf/ATK-2026-0908-NATS.pdf
   ```
   must print **404** (the master is never a public file).
   ```
   curl.exe -s -w " %{http_code}`n" -X POST https://attackedmap.vercel.app/api/report-pdf -H "Content-Type: application/json" -d "{\"ref\":\"ATK-2026-0908-NATS\"}"
   ```
   must print `{"error":"sign_in"} 401`.
   Then the real test: sign in as a subscriber, open the Hub → NATS briefing → scroll to "Your licensed copy of this briefing". The card must show YOUR name, job title · company and email from your profile (if the job title or company is missing it says so with a link to the profile page). Click **Download your licensed PDF**. A 42-page PDF named `ATK-2026-0908-NATS.pdf` should download, with the same name, title · company and email in the licence box on page 2, a QR code beside them (scan it with a phone: it opens the NATS briefing on the site), and the name in every footer. (If the function is not reachable the button falls back to the browser's print dialog, which also carries the name in the footer.)

4. **Rollback** if anything is wrong:
   ```
   cd D:\attacked-dev\wt-deploy
   vercel.cmd rollback --yes
   ```

## Not tested end to end
- A real subscriber download on the live site (needs a subscriber login; locally the endpoint's refusals were tested: 401 no token, 403 non-subscriber, 405 GET, 404 unknown ref, and the stamper itself was run directly: 42 pages, ~3 s).
- The Vercel build of the new function (first deploy of a function in this project). If the deploy log shows a bundling error, send it to Claude.

## Making print masters for more reports (later)
`D:\claude_work\nats-v2\tools\build_print.py <report.html> --incident <hub id>` → `out\print\<ref>.pdf` + `<ref>.stamp.json`; copy both into `wt-deploy\reports-pdf\` and redeploy. 6–11 s per report; all 310 baked reports share the record format.
