# Pre-GCP readiness review — 26 Oct 2026

Read-only review (4 investigators + synthesis + skeptic). Section "Reviewer corrections" at the end overrides the list where they differ.

## Verdict
The Supabase side is finished and live. Sign-in through WorkOS, two-step, the one-page sign-up, the report paywall, the licensed PDF, podcasts and the phone fixes all work today, and the owner tested two-step on 26 Oct. Only two small items are not deployed: a57abd1 (sign-up loop guard), and probably cb332f0 (the PDF QR change). The GCP side is not finished. Nothing has ever been deployed to Google Cloud, and the GCP branch (gcp-production, ddb2752, 14 Oct) is 32 commits behind live. That branch also turns WorkOS off and uses its own Google + emailed-code sign-in. Three things block starting: the code cannot be pushed to GitHub, the owner has not yet confirmed that WorkOS stays, and no Google Cloud project exists.

## 1. Finish before starting GCP

| # | What | Why it blocks | Who | Effort |
|---|---|---|---|---|
| 1 | **Make the code pushable.** Origin `https://github.com/mohiawrai2609/attacked-map-.git` gives a 404 to anyone not signed in, so it is private. The notes say it is also archived, which makes pushes fail with 403. GitHub's `cards-only-on-live` stops at 7b1fa15 (15 Oct). Everything after that, and all of `gcp-production`, exists only on this PC. | Cloud Build deploys when code is pushed. Right now this PC is also the only copy of 3 weeks of work. | Owner: unarchive the repo and keep it private, or name a new private repo. Claude then pushes both branches. | 10 min |
| 2 | **Decide: keep WorkOS on GCP?** (Recommended: yes.) Live sign-in is the Supabase function `workos-auth` (1,030 lines). It creates Supabase sessions through `/auth/v1/admin/*`, and that part of Supabase (GoTrue) does not exist on GCP. | The biggest porting job depends on this answer. It also decides whether checklist step 3 (the Google sign-in screen) is needed at all. | Owner | Decision |
| 3 | **Decide when WorkOS moves from Staging to Production.** Live runs on Staging (`client_01M4APWJ40K0B75B3ZYZJ6B0DW`). Its Google sign-in uses WorkOS demo keys, which only work in Staging. Production is empty, and only Samarth (the WorkOS admin) can change it. Option A: switch the Supabase bridge to Production now, so it is proven before the move. Option B: switch at the GCP cutover. Option C: keep Staging for the move and switch later. | It decides which callback address the GCP code registers, and when everyone has to set up two-step again (TOTP codes and passkeys do not carry over between environments). | Owner, plus Samarth | Decision |
| 4 | **Choose the web address.** https://attacked.ai is currently a separate Next.js site on Vercel, so pointing it at GCP would replace that site. Options: start on `attacked-ai-prod.web.app`, or use `app.attacked.ai` / `map.attacked.ai`. | SITE_URL, the Firebase domain, the WorkOS sign-in/sign-up/logout URLs, email image links and the PDF QR links all depend on it. | Owner | Decision |
| 5 | **Replace the keys GCP will reuse, before they go into Secret Manager.** The Resend "gcp-production" key was pasted in chat (12 Oct). The Supabase DB password was pasted in chat (20 Oct) and is used by `migrate.sh`. The WorkOS Staging key `key_01M4APWJ9J2G5YBJZRETRDC50C` was created 7 Oct, never replaced, and pasted in chat. | If they are pasted into Secret Manager first, they must be replaced again later. | Owner | 20 min |
| 6 | **Answer: why has the incident feed stopped?** The newest incident on live is dated 24 Sep (highest id 2647), and the row count has been 2,307 since 9 Oct. | The cutover plan is: pause the feed, do the final copy, point the feed at GCP. That only works if we know whether the feed is paused on purpose, and whether to restart it now or only on GCP. | Owner | Answer |

## 2. The GCP move itself
Total: about 15–19 developer days before the first practice data copy. All work starts from the merged branch in WP1.

| WP | Work | Effort |
|---|---|---|
| **WP1 Merge** | Merge `cards-only-on-live` (a57abd1) into `gcp-production` (ddb2752). The merge base is 69e5adb. A practice merge shows 4 conflicts: `AuthProvider.jsx`, `lib/reports.js`, `lib/workos.js`, `vite.config.js`. Build the site twice, once normally and once with `VITE_BACKEND=gcp`. Do not merge `main` (the restyle the owner turned down). | 0.5–1 d |
| **WP2 WorkOS sign-in in the GCP API** | Copy the FastAPI WorkOS code from branch `workos-auth` (830c862, 29ecea9, 9–10 Oct, marked work in progress, built on main): `api/app/gcp/workos.py`, the start/callback routes, `gcp_webhooks.py`, the `AUTH_PROVIDER=workos` setting, and the WORKOS secrets in `setup.sh`. Remove `&& !GCP` from `src/lib/workos.js:17`. Drop `VITE_AUTH_PROVIDERS=google` from `cloudbuild.yaml` / `setup.sh:281`. | 2–3 d |
| **WP3 Port bridge v8 features** | Rebuild these in FastAPI on the GCP session cookie: the `/?signup` routes (`/email/start`, `/email/verify`, and the start route with the two-step check), `/security`, two-step setup and removal (`totp/start|confirm|remove`), password change, and the signed-in devices list with sign-out. Rewrite `_sessions_for` / `_end_session` (from `20261022_sessions.sql`). They read Supabase-only columns (`auth.sessions.refreshed_at`, `not_after`) and the table `auth.refresh_tokens`, which the GCP compatibility schema does not have. Replace the frontend calls to `verifyOtp` / `updateUser`. Send security emails through Resend instead of Gmail. Turn the 218-check bridge test (`scripts/bridge-harness.mjs`) into pytest. | 4–6 d |
| **WP4 Reports on GCP** | Today's paywall gate is `middleware.js` + `src/lib/reportGate.js`, which only run on Vercel. Firebase Hosting has nothing equivalent. **As coded today, GCP would expose most of every report:** `api/app/routers/reports.py` hides only 3 sections, and the Hub calls it first. `reportGate` also only accepts Supabase tokens (it checks `iss`), so every subscriber would be refused. Port the gate and `/api/report-pdf` (Node: pdf-lib + qrcode), either into FastAPI or into a small Node Cloud Run service. Add Firebase rewrites for both, placed above `/api/**`. Upload `public/reports` (314 files), `public/reports-full` (311) and the `reports-pdf` masters. These exist only in `D:/attacked-dev/wt-deploy` and are kept out of git. | 2–3 d |
| **WP5 Podcasts** | Add a `<project>-broadcasts` bucket that anyone can read. Admin uploads need a signed-URL route, because audio can be up to 100 MiB and Cloud Run accepts at most 32 MiB per request. Add a GCP path in `src/lib/broadcasts.js`, port `GET /api/broadcasts`, and add `broadcasts` to `copy_storage.sh`. The `report_broadcasts` table moves with the database copy. No episodes exist yet. | 1–1.5 d |
| **WP6 Email and timed jobs** | Build the Deno functions image for the first time (it has never been compiled). Put the owner-approved white email layouts (`supabase_email_templates/latest-white-2026-10-17/`) in place of the dark ones. Fix `setup.sh:226` `--max-instances=3` on the email functions to concurrency 1 / max 1, otherwise emails go out twice. Size the database connection pools under the Cloud SQL limit (`PGRST_DB_POOL=10` × 10 instances + api pool). Compare the Cloud Scheduler list against live pg_cron. Point the Netlify incident dashboard at `fn-incident-report`. | 1.5–2.5 d |
| **WP7 Scope and copy script** | Leave behind the Stripe functions (create-checkout, stripe-webhook, create-portal-link), notify-application, guard-ingest and the debug stubs. Check that `trg_notify_application` does not keep queueing calls to a function that no longer exists. Port attack-map-feed and guard-daily-brief only if something still calls them. Optional, about 1 hour: add REVOKE lines to `deploy/gcp/db/02_after_restore.sql` so today's open permissions are not copied (anon can edit `public.incidents`; anon can run `record_development` / `trigger_daily_digest_now`). This copies nothing new; it just avoids carrying an existing hole over. | 0.5–1 d |
| **WP8 Deploy, practice, cut over** | Run `setup.sh` for the first time in Cloud Shell, plus pytest on PostgreSQL 17. Do a practice data copy (`MIGRATE_MODE=rehearsal`); the owner checks the row-count table. Make the practice copy testable: today the services read `attacked`, not `attacked_rehearsal`. Test everything on `<project>.web.app`, including sign-up, two-step, devices, paywall, PDF and podcasts. This is also the right place for the owner's end-to-end Attack Map check. Then pause the feed, do the final copy and `copy_storage.sh`, point the GUARD `.env` and `uploader.html` at GCP (`/api/ingest` + new ingest-token), add the GCP callback and URLs to WorkOS, switch DNS, and keep Supabase read-only for 2 weeks. | 2–3 d elapsed |

## 3. Owner-only steps
- **GitHub:** unarchive the repo (keep it private), or create a new private repo.
- **Decisions:** keep WorkOS; Staging→Production timing (A, B or C above); the web address; leave the Stripe functions behind; whether attack-map-feed and guard-daily-brief are still used; the reason for the incident feed pause.
- **Google Cloud:** create the project (`attacked-ai-prod` or another name; send Claude the ID), link billing, and add Firebase with Hosting turned on (checklist steps 2 and 4).
- **Keys:** create a fresh Resend sending-only key for attacked.ai and delete the exposed "gcp-production" key and both "Onboarding" keys. Reset the Supabase DB password. Create a new WorkOS key. Paste them only into Secret Manager from Cloud Shell, never into chat. Secrets needed: `resend-api-key`, `workos-api-key`, `supabase-db-url`, `supabase-service-key`. The Google client ID and secret are needed only if WorkOS is dropped.
- **Samarth (WorkOS admin)**, at whichever point Production is chosen: set up WorkOS Production, or make mohini.awari@attacked.ai an Admin. Production's team status is "Inactive". The setup needs: our own Google and Microsoft OAuth apps (redirect to WorkOS, not to our API), a custom sign-in domain (e.g. `auth.attacked.ai`) before passkeys are turned on, Magic Auth + password, MFA set to **Optional**, branding copied from Staging, a Production API key, and the app URLs on the new domain.
- **Checklist step 3** (Google sign-in screen) now belongs to the WorkOS Production Google app. If the move stays on Staging, skip it.
- **DNS:** records for the chosen app domain, and later the auth domain.
- **Sign-offs:** the practice-copy row counts and error list; the end-to-end test on web.app before the address switch.

## 4. Can wait until after GCP
- Deploy a57abd1 / cb332f0 to Vercel. Both come along with the merge anyway.
- Upload the first podcast episode, then rebuild the NATS PDF master.
- One real subscriber download of the licensed PDF on live.
- Supabase "allow new sign-ups" is still on (`disable_signup:false`). This stops mattering at cutover.
- Do not build the Supabase sign-in hooks planned in docs/MFA-PASSKEYS.md §3.
- Revoke the Gmail app password and set DMARC to quarantine, once all mail goes through Resend.
- Revoke the exposed Supabase personal access token, change the admin password stored in the notes, and remove plain-text secrets from the notes.
- WorkOS Radar Enforce, CSP/headers, DOMPurify, captcha, required two-step for admins (the guardrails the owner deferred).
- Payments: the Stripe port, and closing `set_own_subscription` (anyone can make themselves a subscriber for free).
- WorkOS webhooks, removing the localhost entries from Staging, and dropping GitHub from the bridge provider list.
- Legal pages: new domain, current processors, the 30-day session length. Needed when WorkOS Production's Google app is set up.
- Remaining hardening in the GCP kit (H-09, M-09, M-11 to M-13).
- Small leftovers: `newsletter_subscribers` and `vendor_applications`, stale report titles, the landing explainer, the filter drawer, WhatsApp delivery.
- Two weeks after cutover: pause Supabase, delete the spare projects (`zyefdklfspvayvjwttek`, `wfnvwtmpvzuxjmebqffq`), keep vercel.app only as a redirect.

## Evidence notes
- **Checked again in this session:** origin is `https://github.com/mohiawrai2609/attacked-map-.git`. `gcp-production..cards-only-on-live` = 32 commits, the reverse = 3, merge base 69e5adb. `wt-deploy` HEAD = cb332f0. `workos-auth` last commit is 29ecea9 (10 Oct).
- **From the four reports (read-only checks):** https://attacked-ai-prod.web.app shows "Site Not Found". The live bundle `index-QKX99bWl.js` talks only to Supabase. `workos-auth/providers` answers `configured:true, signup_form:true`. `/reports-full/*` redirects with 302. `/api/report-pdf` answers 401 without a token. `/api/broadcasts` answers 200 with no episodes. WorkOS Staging and Production settings came from read-only MCP queries.
- **Unverified (needs owner):**
  - Whether the repo is archived. It is private (anonymous 404); "archived" comes from the 15/17 Oct notes.
  - Whether a Google Cloud project exists.
  - Whether the old Resend keys were deleted.
  - The live pg_cron list (no SQL was run).
  - Which email-function versions Supabase actually runs.
  - Who calls attack-map-feed and guard-daily-brief.
  - Why the incident feed stopped, and whether INGEST_TOKEN was set.
  - What WorkOS Production's "Inactive" status needs before it can go live.
  - Whether cb332f0 is live. Probably not: live index.html has been cached since 22 Oct.
  - Whether the `auth.users` profile and welcome triggers work on GCP. This shows only in the practice copy.
- **Disagreements between the reports:** the bridge version is reported as v8 (task) and v9 (WorkOS report). The paywall design is reported as "Design 1 live" (no `r-lockzone` marker on live previews) in one report and still undecided in another. Treat Design 1 as chosen unless the owner says otherwise.
- Supabase is still on the Free plan (5 GB egress cap; it was blocked 8–15 Oct). Avoid heavy test loops against live during the data copy.

---

# Reviewer corrections (skeptic pass)

**Pre-GCP list review (read-only checks, 26 Oct)**

**Verdict:** The list mostly holds. Most facts in sections 1 and 3 check out. There are three real problems:
- Item 1 gives the wrong reason for pushing to GitHub.
- Items 2–6 are not needed to start GCP. They are needed before the cutover (WP8), and item 2 is already answered.
- Two blockers are missing: nobody can run `gcloud` today, and the owner's own checklist is out of date.

### Section 1, item by item

1. **Make the code pushable. The facts are right, and "archived" is now confirmed. The reason given is wrong.**
   - A dry run of `git push` (it sends nothing) returned `remote: This repository was archived so it is read-only` and a 403.
   - Anonymous `curl` and the GitHub API both return 404, so the repo is private. That means checklist step 5 is already done.
   - `git ls-remote` shows GitHub's `cards-only-on-live` at 7b1fa15. **GitHub has no `gcp-production` branch at all.**
   - Wrong reason: the list says "Cloud Build deploys when code is pushed." It doesn't. `deploy/gcp/setup.sh:181` runs `gcloud builds submit "$ROOT"`, which uploads the folder Cloud Shell is in, and `deploy/gcp` has no GitHub trigger. GitHub is just the easiest way to get the code into Cloud Shell; uploading a `git bundle` also works.
   - The backup reason is real and bigger than stated. These are also unpushed: local `main` (12 commits ahead), `responsive-wip` (11 ahead), `cards-responsive` (local 2cde5a5, GitHub cdd9b38), `egress-fix` and `daily-brief-updates`. Push everything, not just two branches. The report files in `D:/attacked-dev/wt-deploy/public/reports` (314) and `reports-full` (311) are in no git copy anywhere.

2. **Keep WorkOS on GCP? Already answered; it only needs a one-line yes.**
   - The facts are right: `supabase/functions/workos-auth/index.ts` is 1,030 lines and calls `/auth/v1/admin/*` at lines 169, 193, 207 and 265.
   - The owner chose the WorkOS hosted page on 10 Oct and "wants the same in Production" (14 Oct, `memory/workos-live-signin.md`). WorkOS has been live since 15 Oct, and branch `workos-auth` is the GCP-mode WorkOS version that was demoed on 14 Oct.

3. **Staging → Production timing: facts confirmed through WorkOS (read-only). Not needed to start; needed before WP8.**
   - Live uses Staging (`client_01M4APWJ40K0B75B3ZYZJ6B0DW`). The Staging Google login has no client ID of its own, which matches WorkOS demo keys.
   - Production has no API keys, no redirect or logout URIs, no Google credentials and no app URLs. Its status is `productionState: "Inactive"`.
   - Samarth is the only Admin (last WorkOS login 13 Oct). Mohini is `MEMBER_SANDBOX`, which is read-only in Production.
   - The list understates the switch. Every WorkOS **account** is per environment (passwords too, not just two-step codes and passkeys), so people sign up again or are imported. The bridge also stores Staging user IDs in `app_metadata.workos_user_id` (index.ts:287, 332). Until each person signs in again, the strict security routes (index.ts:338) return nothing.
   - If Production is chosen, Google reviews the sign-in screen, which takes a few days (checklist step 3). Start that early.

4. **Web address: the fact is right. Not needed to start.**
   - attacked.ai is a Next.js site on Vercel (`Server: Vercel`, `Vary: RSC, Next-Router-State-Tree`, `_next` assets).
   - `deploy/gcp/config.env.example` already sets `SITE_URL=https://attacked-ai-prod.web.app`. The address is needed only for the cutover.

5. **Replace exposed keys: the WorkOS fact is confirmed. Not blocking.**
   - `key_01M4APWJ9J2G5YBJZRETRDC50C` is the only Staging key: created 2026-10-07T08:15Z, never expired or replaced.
   - Not blocking: the early setup steps (apis, registry, accounts, secrets, sql, buckets, build) need none of the owner's secrets. Replacing a secret later is one `gcloud secrets versions add` plus a redeploy.
   - Gotcha: the live bridge uses this same key (`WORKOS_API_KEY`, index.ts:133). Update the Supabase function secret before deleting the old key, or live sign-in breaks.
   - A Production key can only be created by Samarth.

6. **Incident feed stopped: facts confirmed. Not needed to start.**
   - I used the landing page's own public queries: count 2,307 (`Content-Range 0-999/2307`), newest `incident_day` 2026-09-24, highest id 2647 (dated 2026-09-23).
   - The practice copy works either way. The answer is needed before the cutover.

### Missing from section 1 (these do block)

- **A. Nobody can run `gcloud`.**
  - There is no `gcloud` or `firebase` CLI on this PC (`which` finds neither, and no Cloud SDK folder exists).
  - `setup.sh` is written for Cloud Shell only, and auto mode blocks Claude from production deploys (`memory/workos-live-signin.md`, MEMORY.md responsive entry).
  - So `GCP_OWNER_CHECKLIST.md:51` ("Claude runs the setup") can't happen as things stand. The owner must choose: she runs each step in Cloud Shell, or she installs the Cloud SDK on D:, signs in and allows Claude to use it.
- **B. Room in the Supabase data allowance for the copies.**
  - The plan is Free (`SUPABASE_EGRESS_HANDOFF.md:13`). Live was locked 8–15 Oct at the 5 GB cap, and the cycle resets on the 14th.
  - The practice copy and the final copy each download about 220 MB of database, plus `copy_storage.sh` copies three buckets each time.
  - The owner should check Supabase usage before the practice copy. Supabase is unlocked today (REST answers 206, `/providers` answers).
- **C. `GCP_OWNER_CHECKLIST.md` is out of date, and section 3 sends the owner to it.**
  - Step 1 names the new Resend key "gcp-production", which is the key now exposed.
  - Step 3 (Google sign-in screen) is pointless if WorkOS stays.
  - Step 5 (make the repo private) is already done.
  - Line 59 says Supabase was "upgraded to Pro" and is "still locked". Both are wrong: it is on Free and unlocked.
  - Rewrite it before the owner follows it.

### Section 3 corrections

- **GitHub:** "archived" moves from unverified to verified (see item 1).
- **"Google client ID and secret only needed if WorkOS is dropped":** true only after WP2 copies the switch from branch `workos-auth`'s `deploy/gcp/setup.sh` (lines 56–64 and 248–252). On `gcp-production` today:
  - `setup.sh:56` lists `google-client-id` and `google-client-secret` as owner secrets.
  - The deploy step stops at lines 205–206 without them.
  - Line 240 attaches them to the API.
- **Keys:** add "update the Supabase `WORKOS_API_KEY` first" to the WorkOS key step.
- **Samarth:** the roles and the "Inactive" status are confirmed. A custom sign-in domain may be a paid WorkOS add-on (the API reports custom-domain charges); the price is unverified (needs owner).
- **Steps 2 and 4** match the checklist numbering. The DNS and sign-off steps are fine.

### Other factual errors

- **Verdict says "no Google Cloud project exists" as a fact.** Only the Firebase site is confirmed missing (attacked-ai-prod.web.app and .firebaseapp.com both 404 "Site Not Found"). Whether a project exists is unverified (needs owner); the evidence notes already say so.
- **"Probably cb332f0" is now near certain.**
  - The live `index.html` has `Last-Modified: 22 Oct 14:53 GMT` and `Age: 332999` (about 3.9 days on the cache). cb332f0 was committed 23 Oct 08:53 UTC, after that deploy.
  - The live bundle `index-QKX99bWl.js` contains `/devices` and `/devices/signout`, so 8746164 is live.
  - It does not contain `signupHostedAt`, so a57abd1 is not live. The undeployed work is exactly a57abd1 and cb332f0.
- **Two-step test date doesn't match WorkOS.** WorkOS reports the only Staging key was last used 2026-10-23T06:16Z, yet the owner "verified two-step on 26 Oct". Either WorkOS updates that time late, or the test didn't go through the live bridge. Unverified (needs owner).
- **WP4, minor:** `/api/report-pdf` already falls under the existing `/api/**` rewrite in `firebase.json`. Only `/reports-full/**` needs a new rewrite, unless the PDF moves to a separate service.
- **Evidence notes, minor:**
  - `/api/report-pdf` gives 401 only on POST; GET gives 405.
  - `/api/broadcasts` gives 200 only with `?ref=`; without it, 400 `bad_ref`.
  - The bundle also points at `wfnvwtmpvzuxjmebqffq.supabase.co` (`supabaseHub` in `src/lib/supabaseClient.js:38`), but nothing uses it, so deleting that spare project is safe.

### Confirmed with no change

- Origin URL, the 32/3 commit counts, merge base 69e5adb, `wt-deploy` at cb332f0, `workos-auth` at 29ecea9 (10 Oct).
- The practice merge gives exactly 4 conflicts: `AuthProvider.jsx`, `lib/reports.js`, `lib/workos.js`, `vite.config.js` (via `git merge-tree`).
- The GCP branch turns WorkOS off: `src/lib/workos.js:17` has `&& !GCP`, and `cloudbuild.yaml:36` and `setup.sh:281` set `VITE_AUTH_PROVIDERS=google`.
- `setup.sh:226` sets `--max-instances=3` on the email functions.
- `/providers` answers `configured:true, signup_form:true`, and `/reports-full/*` redirects with 302.
- Staging `signUpUrl` is `https://attackedmap.vercel.app/?signup`.

Files referred to: `D:/attacked-dev/wt-gcp-prod/deploy/gcp/setup.sh`, `D:/attacked-dev/wt-gcp-prod/deploy/gcp/config.env.example`, `D:/attacked-dev/wt-gcp-prod/firebase.json`, `D:/attacked-dev/wt-cards/supabase/functions/workos-auth/index.ts`, `C:/Users/mohin/OneDrive/Documents/Desktop/ATTACKEDMAP/GCP_OWNER_CHECKLIST.md`, `C:/Users/mohin/OneDrive/Documents/Desktop/ATTACKEDMAP/SUPABASE_EGRESS_HANDOFF.md`.
