# Attacked.ai — HANDOFF · 15 Oct 2026 · say "continue"

**For the next Claude session (any account):** read this whole file first, then the
memory index at `C:\Users\mohin\.claude\projects\C--Users-mohin-OneDrive-Documents-Desktop-ATTACKEDMAP\memory\MEMORY.md`
(topic files linked there; the newest is `report-paywall.md`). Everything below was
checked on 15 Oct 2026 at the end of the session.

**About the owner:** Mohini (worldofspecs@gmail.com) is the non-technical founder.
She writes in Hinglish or Hindi but wants **every reply in English**, in plain words,
with the work done for her. She likes to **see it on localhost first, then deploy**.

---

## 1. Status at a glance

| Item | State |
|---|---|
| Live site | https://attackedmap.vercel.app runs commit **7ba9e7d** (WorkOS sign-in, logo goes to landing page, navbar fix, egress fixes). |
| **Report lock (paywall)** | **Built and tested on localhost, NOT deployed.** The live site still sends the FULL report to everyone at `/reports/<ref>.html`. |
| Report design | **Decision pending from the owner:** Design 1 (summary + one Subscribe panel) or Design 2 (every section blurred). |
| Database (Supabase) | Report-preview migration **is live** (admin-written reports already restricted). |
| Sign-in | WorkOS **Staging** (hosted page), live since 15 Oct. Production WorkOS not set up. |
| Supabase egress | Fine again (it was locked 8–15 Oct). Avoid repeated test loops against live data. |
| Drive C: | **Almost full (~300 MB free).** Build and keep work on D:. |

---

## 2. What was done in this conversation (newest last)

1. **WorkOS sign-in made live.** The Supabase edge function `workos-auth` (v4) bridges WorkOS to a normal Supabase session. The Sign in button goes straight to the WorkOS-hosted page. The page offers Google and Microsoft, an email code, and a password with "Forgot password". MFA is optional, and passkeys are on in Staging. A per-tab nonce protects against login CSRF.
2. **Navbar underline removed and logo → landing page** (`/?home`). The map buttons go to `/?map`; `/` is the dashboard for signed-in users. The owner deployed this.
3. **Report lock built.** This is the owner's request: "free users see only the Executive Summary; Download PDF only for subscribers; every report".
   - **Free readers** get a preview copy: header, key figures and Executive Summary, then one Subscribe panel. Download PDF and Ctrl+P show a "subscribers only" notice.
   - **Subscribers** (tier `enterprise` or `admin`) get the full report and **Download PDF** (browser "Save as PDF").
   - **Enforced on the server, not just hidden.** Full files live in `public/reports-full/` and are served only through `middleware.js`, which checks the reader's token against the database.
   - **NATS Outage Briefing v3** was added as `ATK-2026-0908-NATS` and attached to incidents **2389 and 2385**.
   - Commit **fe3eea1**.
4. **Two provisional designs plus a comparison panel**, at the owner's request, for review before finalising. Commits **581c59a** and **7b1fa15**.
   - **Design 1 · Current:** as above.
   - **Design 2 · Blurred sections:** the same free part, then every later section with its real heading and a one-line "what you get". Below that sits one short blurred preview with a lock label showing a real count (e.g. "19 organisations exposed"). There is also a "full briefing continues" card, a Subscribe bar that shows after the card, and locks in the contents list.
     - **The blurred text is filler, not the report.** Identifying values are neutral, codes are zeroed, map pins are decoys, and logos and links are removed.
     - **Audits:** three independent agent audits across all 311 reports found no paid content.
   - **Case progression (incident timeline):** free in Design 1 for the standard reports, blurred in Design 2. In NATS it is locked in both.
5. **Offline review pack** in Downloads (see §6).

---

## 3. Where everything is

**Repo:** GitHub `mohiawrai2609/attacked-map-`. **This repo is PUBLIC**, so never rely on secret paths and never commit secrets.

| Folder | Branch / state | Use |
|---|---|---|
| `D:\attacked-dev\wt-cards` | `cards-only-on-live` @ **7b1fa15** (pushed) | **The working copy.** All new work goes here. |
| `D:\attacked-dev\wt-deploy` | detached @ **fe3eea1** | **The deploy folder.** It holds the gitignored report files (`public/reports` = Design 1 previews, `public/reports-full` = full). The owner deploys from here. |
| `C:\Users\mohin\OneDrive\Documents\Desktop\ATTACKEDMAP` | `responsive-wip` | Main checkout; the `node_modules` junction source. Do not deploy from here. |
| `D:\attacked-dev\wt-live-resp` | `cards-responsive` | Peer "Responsive" session's line. It should merge `cards-only-on-live` before its next deploy. |
| `D:\attacked-dev\wt-workos`, `wt-workos-live`, `wt-gcp-prod`, `wt-egress`, `wt-live-base` | older lines | Day-1 WorkOS demo, GCP version (never deployed), etc. |
| `D:\attacked-dev\backups\reports-full-2026-10-15\` | — | **Pristine backup** of the 310 full reports, plus `..\NATS-v3-source-2026-10-15.html`. |

**Local site (one only): http://localhost:5173**, served from `wt-cards`.
- If it is down, start it with launch config **`cards-5173`** (preview_start in the Claude app). Or the owner can double-click `D:\attacked-dev\workos-test\start-localhost-5173.cmd`, which opens its own window.
- Useful URLs:
  - Hub: `http://localhost:5173/?hub`
  - NATS report: `/?hub&open=2389`
  - **Design 2 in the Hub (localhost only):** `/?hub&open=2389&design=blur`
  - **Comparison tool (all 311 reports):** `http://localhost:5173/review/report-designs.html`
  - Direct files: `/reports/<REF>.html` (Design 1), `/reports-blur/<REF>.html` (Design 2)

**Backend facts (not secret):**
- **Supabase** project `ovenyjguhkgiceddzwna`, Free plan, 5 GB egress per month. The cycle resets on the 14th.
- **WorkOS Staging:** client `client_01M4APWJ40K0B75B3ZYZJ6B0DW`, environment `environment_01M4APWHQ6DNZ79KMWG79P9ST8`, hosted page `progressive-camp-95-staging.authkit.app`. The owner's role in WorkOS Production is read-only.
- **Vercel:** project `attackedmap` (`prj_unWeiu0IaeOv84qgYHvNWJfAJciO`), team `team_08KqvCcKlRAQysX2X8H5cTs1`, Hobby plan. The CLI is logged in as `mohiawrai2609`.

---

## 4. Report lock: how it works (key files in `wt-cards`)

- **`src/lib/reportPreview.js`:** makes the free copy from a full report.
  - `makeReportPreview(html, { design: "lock" | "blur" })`. "lock" is Design 1, "blur" is Design 2.
  - Two report shells are handled: the "baked" shell (310 files) and the "editorial v3" shell (NATS).
  - `stubPreview()` is a title-only fallback.
- **`scripts/build-report-previews.mjs`:** builds and checks every preview.
  - Design 1: `node scripts/build-report-previews.mjs public`
  - Design 2: `node scripts/build-report-previews.mjs public --design blur` (writes `public/reports-blur/`, review only).
  - Add a new report: `--add "<file>=ATK-REF"`.
  - Any full report dropped into `public/reports/` is moved into `public/reports-full/` first.
  - Every file is checked for leaked text and rendered; anything that fails gets a title-only stub (exit code 1).
- **`src/lib/reportGate.js` + `middleware.js`** (Vercel Routing Middleware), plus the same gate in `vite.config.js` for localhost.
  - `/reports-full/<ref>.html` is served only with `Authorization: Bearer <Supabase access token>` of a subscriber; the database decides via `rpc is_subscriber`.
  - No token: 302 to `/reports/<ref>.html`. Non-subscriber token: 403.
  - Encoded or tricky spellings of the path are gated too.
- **App:** `src/lib/reports.js` `fetchFullReport()`, plus `ReportFrame` in `src/auth/AttackHub.jsx` and `src/dashboard/Dashboard.jsx`.
  - Subscribers fetch the full file with their token and render it via srcdoc; everyone else gets the preview.
  - `src/lib/reportLock.js` shows the NATS Download PDF button to subscribers.
- **CMS (admin-written reports), already live in the database:**
  - Migrations `supabase/migrations/20261015_report_previews.sql` and `_backfill.sql` are APPLIED.
  - `hub_reports.html_preview` column; `report_html()` returns the full HTML to subscribers and `html_preview` (or a title-only stub) to everyone else. `admin_upsert_report` stores `html_preview`.
  - YAN and EUF are backfilled. **GCH shows the stub until an admin opens it in Admin → Reports and presses Save once.**
- `public/reports/manifest.json` maps incident to report; NATS is mapped to 2389 and 2385.
- `public/reports*` folders are gitignored. `public/reports-blur/` and `review/` are also in `.vercelignore` (never deployed).

---

## 5. NEXT STEPS (in order)

### A. Get the owner's two decisions
1. **Design 1 or Design 2?**
2. **Case progression (the timeline): free, or for subscribers?** It currently differs between the designs for the standard reports.

### B. If Design 2 is chosen (otherwise skip)
- In `wt-cards`, write Design 2 into the live preview folder: `node scripts/build-report-previews.mjs public --design blur --out reports`. The builder already supports `--out`. Then check a few files in `public/reports/` have the `r-lockzone` marker.
- If the timeline is meant to be free in Design 2, keep `chain` in the summary. If locked in Design 1, remove `chain` from `BAKED_KEEP`.
- **CMS:** Design 2 for admin-written reports is **not built yet**.
  - Add a "blur" variant to `renderReport(..., { preview })` in `src/lib/reportTemplate.js` and use it in `src/admin/AdminReports.jsx` `payload()`.
  - Backfill YAN and EUF by SQL or by re-saving them, and have GCH re-saved.
- Re-run the build checks and test on localhost: signed out, free and subscriber views, phone layout, the comparison tool.

### C. Deploy (the OWNER runs it; Claude is blocked from production deploys)
1. Move the deploy folder to the latest commit and copy the report files from `wt-cards` (Claude can do this part):
   ```
   cd D:\attacked-dev\wt-deploy
   git checkout --detach cards-only-on-live
   ```
   Then replace `public\reports` and `public\reports-full` in `wt-deploy` with the ones from `wt-cards\public` (the chosen design in `reports`). Do **not** copy `reports-blur`.
   - `wt-deploy` already has a correct, tested Design 1 set at **fe3eea1**. It can be deployed as-is if the owner wants Design 1 live immediately.
2. The owner runs this in PowerShell:
   ```
   cd D:\attacked-dev\wt-deploy; vercel.cmd deploy --prod --yes
   ```
3. **Verify straight away** (Claude, with curl). Each must give the result shown:
   - `https://attackedmap.vercel.app/reports-full/ATK-EV-067.html` → **302** to `/reports/ATK-EV-067.html`. **Never 200 without a token.**
   - The same with `/reports%2Dfull/…`, `/%72eports-full/…`, `/x/../reports-full/…` → 302 or 404, never the full file.
   - `…/reports-full/ATK-EV-067.html` with header `Authorization: Bearer a.b.c` → **403**.
   - `…/reports/ATK-EV-067.html` → 200 and contains `data-locked="preview"`.
   - Hub signed out: NATS opens as a preview. Owner signed in (admin = subscriber): full report with Download PDF.
4. **Rollback if anything is wrong:**
   ```
   cd D:\attacked-dev\wt-deploy; vercel.cmd rollback --yes
   ```
   That returns to the previous production deployment (7ba9e7d, no report lock).

### D. After that
- **Payment (Stripe).** `set_own_subscription` currently lets ANY signed-in user become a subscriber for free by pressing Subscribe. The paywall only protects revenue once payment replaces this.
- **Return after subscribing:** take the reader back to the report they were reading (not done).
- **WorkOS Production:** needs a WorkOS admin, the company's own Google and Microsoft apps, and a custom domain before passkeys. Also **rotate the WorkOS Staging API key** (it was pasted in a chat). The owner has not yet confirmed a real sign-in on the live site.
- Tell the "Responsive" peer session to merge `cards-only-on-live` before its next deploy.
- Known data quirk: every baked full report has the same stale `<title>` ("Getty / Shutterstock · CMA Merger Remedy"). The previews now use the real headline; the full files still have it.

---

## 6. Review pack in Downloads (for the owner and team)

`C:\Users\mohin\Downloads\Attacked.ai report designs 2026-10-15\` and the `.zip` (8.5 MB):
- `Open me - Design comparison.html`: works offline, 5 featured reports embedded.
- `Design 1 …`, `Design 2 …` and `Full report …` folders: the 5 reports each.
- `Screenshots\`: 15 PNGs.
- `READ ME - Report designs.txt`.
- The "Full report" folder contains paid reports: **internal sharing only**.

---

## 7. Hard rules (learned the hard way)

- **Claude must not deploy to production or change Vercel env vars.** Auto-mode blocks it (even `vercel --version` inside `wt-deploy` was blocked). Prepare everything; the **owner runs the deploy command**. Do not try workarounds, and do not ask other sessions to deploy instead.
- **Never print or repeat secrets** (the WorkOS API key etc.). Never type passwords or keys for the owner.
- **Supabase egress:** no polling or test loops against the live project. **Never GET `functions/v1/incident-deliver`**: a GET runs real delivery. Use `auth/v1/health` to check liveness.
- **Never edit the `const INCIDENT =` data in the NATS source file.** Only generated copies change.
- Keep work on **D:**. Give new versions new file names. **C: is full**: build into D: (`npx vite build --outDir D:/attacked-dev/build-check`) and delete it after.
- Database changes go through Supabase MCP `apply_migration`. They are live immediately, because localhost and production share the same database.
- Localhost first, then deploy. Explain in plain English and keep replies short.

## 8. Tools that work on this machine

- **Screenshots:** headless Chrome over CDP with Node 24 (no puppeteer needed). Script: `D:\attacked-dev\tmp-shots\shots.mjs`, which captures 1440×900 at 1.5× and the phone size. The Claude browser pane captures only about 800 px, cannot open `file://`, and pauses rendering when hidden: set `scrollBehavior='auto'` and take a screenshot to force a frame.
- Chrome: `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- Report pages use smooth scrolling. Standard reports scroll inside `#readerScroll`; NATS scrolls the window.
- The Vite dev server answers missing `.html` files with the app page and a 200, not a 404 (the app code guards for this).

---

## UPDATE 17 Oct 2026 (later session)

- **NATS in the Hub:** a "Featured briefing" banner now sits above Top Stories, and NATS is first in the Reports section (`manifest.json` → `featured`). Commit dca08ae. Live only after a deploy, as before.
- **Two-step verification + passkeys:** Profile → Security, bridge routes and the admin reminder are built (commit 250e246). **The bridge and its migration are NOT deployed:** the user switched off the Supabase connector tools. Full guide: `wt-cards/docs/MFA-PASSKEYS.md`, which covers switch-on steps, the owner test plan, the WorkOS Production checklist, the Supabase direct sign-in gap and the runbook. Memory: `mfa-passkeys.md`.
- **GitHub repo `mohiawrai2609/attacked-map-` is ARCHIVED (read-only):** pushes fail, so commits dca08ae and 250e246 are only local in `D:\attacked-dev\wt-cards`. Ask the owner to unarchive it, or to name a new repository.
- **C: has ~100 MB free:** keep everything on D:.
