# Responsiveness pass — handoff (2026-10-08 17:15: DEPLOYED — live version + responsive fixes + picture fix in production)

## Production now (read first)

- 2026-10-21 OWNER SAID "deploy". Deploy folder READY: D:/attacked-dev/wt-deploy-resp (detached 2cde5a5, .vercel linked, public/reports =
  backups/reports-full-2026-10-15 + report patch v4, 310/310 verified). Pre-deploy: production build OK; alive check on the built site
  (6 pages x 4 devices) = 0 JS errors and equal/better than live on every row (D:/attacked-dev/resp/deploy-check vs deploy-before-live).
  Vercel env unchanged since Oct 15. First `vercel deploy --prod` died on a Vercel upload 500 (nothing deployed; live still
  lnbxxqrh0 = 7ba9e7d, bundle index-DzM0NFeC.js); the retry was blocked by auto mode -> OWNER runs:
  vercel deploy --prod --yes --cwd D:attacked-devwt-deploy-resp   (rollback: vercel promote attackedmap-lnbxxqrh0-mohiawrai2609s-projects.vercel.app --yes --cwd D:attacked-devwt-deploy-resp)
  After it: re-run the alive check against https://attackedmap.vercel.app and compare with deploy-before-live.
- 2026-10-20 READY TO DEPLOY (needs owner OK): cards-responsive @2cde5a5 = live 7ba9e7d + all responsive fixes. Whole-site check
  PASSED (432 visits) and Attack Map check PASSED (all critical/major gone, alive on 19 devices; last minor = 11px phone text, fixed
  and re-checked). NOT deployed, NOT merged into cards-only-on-live (which also carries the unapproved paywall + 2-step).
  Deploy from a NEW clean worktree at 2cde5a5 (not wt-deploy: it holds the paywall preview reports) with the FULL baked reports
  (D:/attacked-dev/backups/reports-full-2026-10-15) + apply/verify-report-responsive. C: drive is at ~0 MB free.
- 2026-10-19 STATUS FOR THE OWNER: round-2 responsive fixes (cards-responsive 9106cd8) are NOT merged into cards-only-on-live and
  NOT deployed. Whole-site check after the merge PASSED (wf_b3ab2e38-13d, results D:/attacked-dev/resp/final_verify_results.json
  once saved). Attack Map check re-run as wf_48a25405-873 (D:/attacked-dev/resp/map_check_wf.js). Live = 7ba9e7d (Oct 15).
  cards-only-on-live (ea96f93) now also has the paywall + two-step verification, neither approved for live: deploy
  cards-responsive (live + fixes) only, with the owner's OK; merge cards-responsive into cards-only-on-live later.
- 2026-10-17: Supabase is back (200). Production = 7ba9e7d (live line; paywall built on cards-only-on-live 7b1fa15 but NOT deployed,
  owner choosing Design 1/2). Merged 7ba9e7d (NOT the paywall commits) into cards-responsive -> 9106cd8 (one SiteNav conflict,
  kept both: acct-open class + logo to /?home); builds clean. Final verification run wf_b3ab2e38-13d (restarted 10-17 16:00; wf_487c4640-7c6 died with the session) (D:/attacked-dev/resp/final_verify_wf.js):
  Attack Map check + whole-site regression check, one refix each. If the PC stops: start a NEW run of that script.
  Deploying cards-responsive later = responsive fixes on top of exactly what is live (no paywall). Owner wants localhost first.
- 2026-10-12 PAUSED BY THE OWNER ("continue tomorrow"). TO RESUME: (1) start the local server: preview config `live-resp` in
  .claude/launch.json (serves D:/attacked-dev/wt-live-resp on :5175); (2) start a NEW run of D:/attacked-dev/resp/map_check_wf.js
  (Attack Map independent check, refix once if needed); (3) when it passes: merge the latest cards-only-on-live (69e5adb or newer,
  owned by the WorkOS/GCP sessions) into cards-responsive, re-run the 6-page alive check (D:/attacked-dev/resp/hotfix/pages-alive-all.mjs),
  ask the owner before any deploy; (4) coordinate getting the fixes onto gcp-production. Everything is committed (7312c0f); the
  sweep tool blocks Supabase. Supabase was still 402 on 10-12.
- 2026-10-12 16:05: every device-test fix group PASSED its independent check (globe, nav, admin, dashboard, report, pages) and
  is saved in commit 7312c0f on cards-responsive (NOT deployed). Only the Attack Map check remains: run wf_b68915fe-a64
  (script copy D:/attacked-dev/resp/map_check_wf.js; earlier results D:/attacked-dev/resp/fix3_cont_results.json). If the PC
  stops again: start a NEW run of map_check_wf.js (do not resume the big fix workflow: its cache re-runs finished agents).
- 2026-10-12: the fix run never completed (session ended). All in-progress fixes are saved as WIP commit 76b5de4 on
  cards-responsive (NOT deployed, NOT yet checked; alive check passed on 6 pages). Resumed as wf_16ff1a35-bca (fix3_cont_wf.js,
  doneGroups admin/globe/nav). Supabase still 402 on 10-12 11:00 IST. Owner chose GCP (branch gcp-production from
  cards-only-on-live): once these fixes pass, they must reach cards-only-on-live / gcp-production too (coordinate with that session).
- 2026-10-10 RULE: our sweep loops (each map load ~6.8 MB from live Supabase) caused the egress lockout. The sweep tool now blocks
  every *.supabase.co request (guardSupabase in rtools/sweep.mjs). Never bypass it. Fix workflow continuation wf_f4561e21-a24
  (script D:/attacked-dev/resp/fix3_cont_wf.js, args doneGroups admin/globe/nav) running; earlier runs died on network outages.
- 2026-10-09 PEER (WorkOS session): cards-only-on-live is now 5ad2e14 = 25bf26a (owner's nav/footer no-underline CSS) + WorkOS
  sign-in, dormant unless the build sets VITE_AUTH_PROVIDER=workos (Vercel prod does not). Merge 5ad2e14 (not just 25bf26a) into
  cards-responsive before our next deploy; verify the sign-in modal is unchanged without the env var. The peer owns
  localhost:5173 and D:/attacked-dev/wt-cards now: do not touch them. Do not deploy the peer's work on its behalf.
- 2026-10-09 final device test (fold covers 280/344, unfolded folds 512/882, Surface Duo, iPad mini, monitors) -> confirmed
  findings `D:/attacked-dev/resp/final2/_confirmed.json` (9 critical incl. crash+Supabase, 7 major, 26 minor). Fix workflow wf_130d0070-95f
  (script `D:/attacked-dev/resp/fix3_wf.js`) running on cards-responsive (wt-live-resp, :5175). Deploy only with the owner's OK.
- 2026-10-09 INCIDENT: dc7953a (deployed 10-08 17:15) crashed the Attack Map to a blank page (incidentImage not imported in the
  live GlobalAttackMap.jsx). Fixed by cdd9b38, deployed 10-09 as attackedmap-c6o1kcplu (verified: map stays up on fold-280,
  iphone-390, fold5-open, lap-1366). cards-only-on-live fast-forwarded to cdd9b38. Lesson: after any map change, check the map
  is still on screen 8 s after load (D:/attacked-dev/resp/hotfix/pages.mjs), not only the layout numbers.
- 2026-10-09 BLOCKER (owner action): Supabase project answers 402 exceed_egress_quota on Auth/REST/Storage: nobody can sign in,
  the map shows archived data. Upgrade the plan / lift the spend cap, or wait for the quota reset. Our sweeps added egress.
- https://attackedmap.vercel.app = branch `cards-responsive` @dc7953a (live design + responsive fixes + Hub picture fix + no more
  broken AI-generator pictures), deployment `attackedmap-cdwkvd778`, from the clean worktree `D:/attacked-dev/wt-deploy`.
  Previous: `attackedmap-r5miv34z9` (responsive only, 16:45).
- Rollback target (previous production, Sep 29): `attackedmap-q4yarip86-mohiawrai2609s-projects.vercel.app` (`vercel promote` / `vercel rollback`).
- Checked on the real site after deploy: 9 pages x 8 sizes, no sideways scroll, no cut text; report pages carry attacked-resp v3; map OK.
- `main` has all the responsive work (+ restyle etc.), NOT deployed. `cards-only-on-live` was fast-forwarded to `cards-responsive`
  (dc7953a), so deploying from wt-cards or wt-deploy gives the same production build.
- FIXED 17:15: dashboard/map pictures no longer use image.pollinations.ai (it answers 402); stored picture, else the
  category photo. Verified live: no failing requests on the dashboard.


## Status (read this first)

- Branch `responsive-wip` (local commits, NOT pushed; `main` untouched). Backup patch: `D:/attacked-dev/resp/responsive-wip.patch`.
- Every area fixed and independently checked: chrome (nav/menu/footer/sign-in), landing, hub, reports, account/legal,
  dashboard (+ Subscribe modal), admin (6 tabs), Attack Map (phones + tablets/desktops).
- Final sweep, all 29 page states x 23 sizes (`D:/attacked-dev/resp/final/`, comparison `final/_compare.txt`) vs main-base:
  sideways 31 -> 0, cut text 63 -> 0, overlaps 246 -> 18 (all = the floating report "Reading now" pill over text),
  tap targets <24px 2626 -> 32 (all = the two sign-in checkboxes inside full-width labels). No page worse anywhere.
- Owner test list: `RESPONSIVE_TEST_CHECKLIST.md`.
- Owner decisions still open: (1) Attack Map guided tour no longer auto-starts on screens <=500px tall in the desktop
  layout (it covered both panels); (2) dashboard filter-chip wall on phones and duplicated article summary left as is.
- 2026-10-08 12:40 PORT TO LIVE (owner chose it): worktree `D:/attacked-dev/wt-live-resp`, new branch `cards-responsive`
  (from cards-only-on-live; wt-cards untouched). Diff `D:/attacked-dev/resp/port.diff` applied with git apply -3: 21 conflicts in 14 files.
  Baseline copy `D:/attacked-dev/wt-live-base` (detached, unchanged live code) on :5174, port on :5175, main on :5173.
  Both test copies have a LOCAL-ONLY vite.config.js + scripts/dev-direct-signin.local.mjs (test sign-in): never commit those.
  Live baseline sweep -> `D:/attacked-dev/resp/live-base` (pages file `rtools/pages-live.mjs`). Port workflow wf_5ddf2786-7e6
  (script copy `D:/attacked-dev/resp/port_live_wf.js`). Temporary entries live-base/live-resp were added to .claude/launch.json
  in the main checkout: remove them when done. `main` was NOT moved (the git safety check blocked it; ask the owner).
- 2026-10-08 16:20 LIVE PORT DONE AND MEASURED: branch `cards-responsive` (commits 4e17a6c + dee9b2e, local, not pushed),
  worktree `D:/attacked-dev/wt-live-resp` (dev server :5175). Live before -> after, 29 states x 23 sizes: sideways 31 -> 0,
  cut text 53 -> 0, overlaps 50 -> 20 (report pill), tap<24 2656 -> 32 (sign-in checkboxes). Laptop/desktop keep the live
  design (no restyle). Notes + deploy steps: RESPONSIVE_LIVE_PORT.md on that branch. Live baseline copy `D:/attacked-dev/wt-live-base` (:5174)
  can be removed after the owner tests (git worktree remove). The temporary launch.json entries were removed again.
  Separate pre-existing live issue: dashboard pictures from image.pollinations.ai now return 402 (main uses stored pictures).
- NOT done yet (needs the owner): merge to main, port to `cards-only-on-live` (D:/attacked-dev/wt-cards), deploy.
  Deploy only when the owner says "deploy". Before any deploy/bake: `node scripts/apply-report-responsive.mjs --write`
  then `node scripts/verify-report-responsive.mjs` (public/reports is gitignored).

---

## History (older notes)


## Latest state (4th resume, 2026-10-07 afternoon) — read this first

- Re-measure (step 3 below) WAS done by the VS Code session: `D:/attacked-dev/resp/wip-check/` (13:07-13:39).
  Versus main-base: sideways scroll 31 -> 12 (all 12 on admin pages), cut text 63 -> 12, tap targets <24px 2626 -> 82.
  Attack Map shows a few more text overlaps (guided-tour card over the top-right panel); not yet judged.
- Commit 90b3844 (local, not pushed) adds three Attack Map tap-target edits made in the VS Code session.
- IMPORTANT: `public/reports/` is gitignored. The reports fixer already injected a `<style id="attacked-resp">`
  block into all 310 baked reports (script: `D:/attacked-dev/resp/fix/reports/apply-baked.mjs`). Untouched
  originals: `D:/attacked-dev/dist-check/reports/` (only difference = that block).
- New: `D:/attacked-dev/rtools/sweep-q.mjs` = queue wrapper for sweep.mjs (max 2 sweeps at once; this PC has
  <1 GB free RAM and C: is full). Agents must use it instead of sweep.mjs.
- Running now: read-only workflow wf_d58c8c80-e17 (script copy `D:/attacked-dev/resp/resp_triage_wf.js`):
  per-area triage of every finding -> `D:/attacked-dev/resp/triage/<area>.json`, and the first Attack Map
  review (phones / tablets+desktops, then a verifier) -> `D:/attacked-dev/resp/findings/map.json`.
- DONE (17:31): triage of all 7 areas -> `D:/attacked-dev/resp/triage/<area>.json` (+ `_workflow_result.json`).
  chrome 10/11 fixed, landing 15/16, hub 13/16, reports 9/13, account-legal 10/10, dashboard 16/17 (+13 new minor/1 critical:
  SubscribeModal unstyled), admin 0/13. The dev server died at ~15:50 (VS Code session), so the map review was code-only:
  `D:/attacked-dev/resp/mapreview/_first_attempt_code_only.json` (19 findings, unverified).
- Dev server now runs from the Claude desktop app (preview "attackedmap-dev", port 5173).
- RUNNING (from ~17:50): fix workflow wf_f710a4b6-176, script copy `D:/attacked-dev/resp/resp_fix2_wf.js` (args = the
  8 areas, see the script's call in this session). Map: live verify -> `findings/map-small.json`, `map-large.json`, then
  2 fix passes. Every area: fix -> independent check -> up to 2 refixes; reports in `D:/attacked-dev/resp/fix2/<area>/report.json`
  and `check2/<area>-rN/report.json`. Then cross-area integrator.
- 2026-10-08 00:50: that run was STOPPED (a hung sweep had blocked a queue slot for 3 h; owner asked to go fast).
  Fixes of 7 areas were done and are in commit 8eaa3c9 (local). Landing check passed. Map tablet/desktop findings
  saved to `findings/map-large.json`; map phone verifier was cut off (use code-only findings + `mapreview/small-live`).
  sweep-q.mjs now: 3 slots, kills any sweep running > 9 min.
- RUNNING (from 00:55): FAST workflow wf_a891a328-9dd, script `D:/attacked-dev/resp/resp_fast_wf.js`, args
  `D:/attacked-dev/resp/fast_args_compact.json` (rebuild with `node D:/attacked-dev/resp/build_fast_args.mjs`).
  9 key devices, 1 refix round, outputs in `D:/attacked-dev/resp/fast/`. Then a full 23-device sweep and hand-off.
- 2026-10-08 01:53: the session closed and the fast run stopped. Done by then (reports in `D:/attacked-dev/resp/fast/`): checks PASSED for account-legal, admin, chrome, reports (+landing earlier); dashboard refix done; hub needs a refix; map phone pass was mid-edit.
- 01:58: RESUMED the same run (wf_a891a328-9dd) with the exact launch args `D:/attacked-dev/resp/fast_args_launched.json` + a map resume note (`fast_args_resume.json`). Finished agents replay from cache.
- Baked reports: `public/reports` is gitignored. After any re-bake / before a deploy run
  `node scripts/apply-report-responsive.mjs --write` then `node scripts/verify-report-responsive.mjs`.

Owner's request (2026-10-06): before deploying, check EVERY page and section on every
phone, tablet and laptop size, and fix responsiveness properly (landing, Attack Hub,
reports, dashboard, Attack Map, pricing, legal, profile, admin — everything).

## Where things are

| What | Where |
|---|---|
| Work in progress (partial fixes, NOT verified) | git branch `responsive-wip` in this repo (commit "WIP responsiveness"), also pushed to GitHub. `main` = 49be760, untouched. |
| Same changes as a patch file | `D:/attacked-dev/resp/responsive-wip.patch` |
| Sweep tool (headless Chrome, 23 devices x 29 page states) | `D:/attacked-dev/rtools/` — `sweep.mjs`, `audit-in-page.js`, `pages-main.mjs` |
| Baseline measurements + screenshots BEFORE any fix (main @49be760) | `D:/attacked-dev/resp/main-base/<page>/<device>.json` and `<device>_NN.jpg`, `summary.json` |
| Problems found by the review (96: 22 critical, 32 major, 42 minor) | `D:/attacked-dev/resp/findings/<area>.json` — areas: chrome (nav/menu/footer/sign-in modal), landing, hub, reports, account-legal, dashboard, admin |
| Attack Map | NOT reviewed yet (review was cut off) |
| Fix workflow script (for a new session to re-run) | `D:/attacked-dev/resp/resp_fix_wf.js` (copy of the scratchpad script) |
| Card-only version waiting to go live (live site 6c98277 + Hub card fix) | branch `cards-only-on-live`, worktree `D:/attacked-dev/wt-cards` (commits bcb80be, c0013eb) |

## Latest state (2nd stop)

The fix step was re-run once (workflow wf_8f473606-fdb) and stopped again by the owner. Six fixers had started (chrome, landing, hub, reports, account-legal, dashboard), none finished or was checked; their extra edits are in the second WIP commit. Admin and Map were never started. Every change on responsive-wip is UNVERIFIED: step 3 below (re-measure) comes first.

## What was done

1. Hub card pictures fixed and verified (main 9f88794, 2d84bf5, 49be760; also on cards-only-on-live).
2. Sweep tool built; full baseline run on main (660 measurements, all 29 page states, 23 sizes).
3. Review of 7 of 8 areas -> findings files above (only the landing findings were independently double-checked: 11/11 real).
4. Fix step started (one agent per area, each editing only its own files) and was STOPPED mid-way.
   Files it had changed (now on branch responsive-wip): AttackHub.jsx, AuthModal.jsx, Globe.jsx,
   LandingPage.jsx, ProfilePage.jsx, SiteFooter.jsx, SubscribePage.jsx, UnsubscribePage.jsx,
   Dashboard.jsx, dashboard.css, reportLock.js, reportTemplate.js, responsive.css, site-nav.css
   (+ possibly some public/reports/*.html). No area was finished or checked. Admin and Map fixes never started.

## How to continue (new session)

1. `cd C:/Users/mohin/OneDrive/Documents/Desktop/ATTACKEDMAP && git checkout responsive-wip`
2. Start the dev server (`npm run dev`, port 5173).
3. Re-measure what the partial fixes already achieved:
   `cd D:/attacked-dev/rtools && node sweep.mjs --base http://localhost:5173 --out D:/attacked-dev/resp/wip-check --conc 3 --resume`
   and compare `D:/attacked-dev/resp/wip-check/summary.json` with `D:/attacked-dev/resp/main-base/summary.json`.
4. Finish each area from its findings file (critical + major first), re-run the sweep on that area's pages
   (`--only <page ids>`), look at the screenshots (320, 390, 844 landscape, 768, 1024, 1366, 1920).
   Or re-run the fix workflow: `D:/attacked-dev/resp/resp_fix_wf.js` with the same `areas` args
   (each area: key, findingsFile, files it owns, pages). The map area needs a review first.
5. Full sweep again on all pages; nothing may be worse than main-base at any size. Commit to main.
6. Port the fixes to `cards-only-on-live` (worktree D:/attacked-dev/wt-cards; dev server on port 5174 via
   launch config `attackedmap-live-dev`), re-sweep it, then ask the owner before deploying.

## Rules to keep

- Do NOT deploy until the owner says "deploy". A full `vercel --prod` from main would also ship the
  brand restyle and the cookie-policy rewrite the owner objected to; deploy the card-only branch instead.
- Legal page WORDING is the owner's: layout fixes only.
- The app reads a live Supabase project with an egress quota: keep sweeps small (`--only`, `--devices`).
- Admin pages in the sweep use the dev-server testing sign-in (scripts/dev-direct-signin.mjs) for
  mohiniawari201@gmail.com; the sweep signs that test session out (scope local) at the end.
- Page ids: landing, hub, hub-article, hub-report, report-static, subscribe, legal-privacy, legal-terms,
  legal-cookies, legal-accessibility, legal-scam, legal-faq, subscriptions, unsubscribe, dashboard-free,
  dashboard-sub, map, nav-menu, signin-modal, landing-signed-in, dashboard-real, map-real, profile,
  admin-reports, admin-inbox, admin-briefings, admin-users, admin-stats, admin-feedback.
