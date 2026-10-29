# Attacked.ai — PODCASTS (the episode inside a report) — HANDOFF 2026-10-22

> **Naming (owner, 22 Oct):** the feature is called **Podcast** everywhere a person reads it (Admin → Podcasts, "Related podcast" bar, the report's podcast card, the PDF). The code, the table `report_broadcasts`, the bucket `broadcasts` and `api/broadcasts.mjs` keep the 21 Oct internal name "broadcast"; renaming those is not needed and would touch the live SQL.

**Say "continue" in a fresh session and point at this file.** Written 22 Oct 2026 after the owner asked for the
broadcast provision (21 Oct, HTML review only) to become a real, end-to-end feature: the admin uploads the episode,
every reader of that report can hear it, scalable to every briefing, then the whole Attack Map gets an end-to-end
check and the code goes to GCP.

## 1. What exists now (built + verified locally, NOT yet on live)

**Code:** branch `cards-only-on-live` in `D:\attacked-dev\wt-cards`, commit **"Broadcasts: upload the episode in Admin,
play it inside the report"** (3bb09e9) + **"Podcasts: the owner's word…"** (9b227b9), on top of 0f49c00. Deploy folder `D:\attacked-dev\wt-deploy` is detached at that commit
with the rebuilt NATS report files copied in (the 311 baked reports are git-ignored, they live only in wt-deploy).

### The admin side — Admin → **Broadcasts** (new tab) and Admin → Reports (compact panel under the list)
`src/admin/AdminBroadcasts.jsx`
- **+ Episode** → pick the **report** (type-ahead list: every CMS report by title and all 311 baked briefings from
  `reports/manifest.json`; the NATS ref shows as "The Millisecond That Stopped UK Departures · baked"), title, series,
  episode no.
- **Audio:** drop or choose the file (mp3 / m4a / aac / ogg / wav / flac / webm, up to 100 MB). The length is read
  from the file. Or paste the URL of a file hosted elsewhere. **Episode page** (Spotify / Apple / YouTube) is optional:
  with no audio the play button opens that page instead.
- Hosts (one per line, "Name — Role"), show notes, **Published on** date, **Published** switch.
- Save = upload to the `broadcasts` storage bucket under `<ref>/<timestamp>-<file>.mp3`, then the row. Status pills:
  **Live** (audio or page, published) · **Coming soon** (published, no audio yet) · **Draft**. Each row has an inline
  player, **Hub ↗** (opens `/?hub&report=<ref>`), Edit, delete (row first, then the file). Replacing the audio deletes
  the old file after the row has moved on; unpublishing hides it without deleting anything.

### The reader side — how someone hears it
1. **Attacked Hub, any reader** (`/?hub&open=2389`, `/?hub&report=ATK-2026-0908-NATS`): the host page loads the
   published episode (`src/lib/useReportBroadcast.js`) and hands it into the report frame
   (`reportLock.applyBroadcastToFrame` → `window.__ATTACKED_BROADCAST__` + the `attacked-broadcast` event). The v5 shell's
   **broadcast card after the Executive Summary** re-renders with a working play button, timer and the hosts
   (analyst + the hosts typed in Admin). Works for subscribers (full report via the gate) and free readers (preview
   file): the card sits in the free part of the report.
2. **Older baked reports (v4 shell, 310 files)** have no card: the Hub shows the **Related broadcast bar** at the foot
   of the frame (unchanged from 21 Oct, now fed by the same hook). The bar is hidden when the frame has its own card.
3. **Dashboard** report view: same injection into the v5 card (no bar there).
4. **A copy of the report opened by its link** (`/reports/ATK-2026-0908-NATS.html`, QR code, email): the page asks
   `GET /api/broadcasts?ref=<ref>` once after load (`api/broadcasts.mjs`, cached 60 s at the edge) and updates the card.
   Inside a host frame nothing is fetched (the host already spoke).
5. No published episode → the card keeps its baked line ("Episode coming soon").

### Data
- Table `public.report_broadcasts` (21 Oct) + 22 Oct columns `audio_path, audio_bytes, audio_type, hosts jsonb,
  sort_order`; view `report_broadcast_refs` (which refs have a broadcast). Table RLS stays **off** (owner's rule).
- Storage bucket **`broadcasts`**: public read (the player streams straight from storage), insert/update/delete only
  for `_is_admin()` (storage policies on `storage.objects`). 100 MiB bucket limit; note Supabase's Free plan caps any
  upload at 50 MB regardless.
- Admin writes go through `admin_upsert_broadcast(p jsonb)` / `admin_delete_broadcast` / `admin_list_broadcasts`
  (security definer, `_is_admin()`), readers select the table directly (anon-readable like the rest of the hub data).

### Files touched (wt-cards)
`supabase/migrations/20261022_broadcast_audio.sql` · `supabase/live-apply/2026-10-22_broadcasts.sql` (both migrations,
for the owner) · `src/lib/broadcastShape.js` (new, pure) · `src/lib/broadcasts.js` · `src/lib/useReportBroadcast.js`
(new) · `src/lib/reportLock.js` (`applyBroadcastToFrame`) · `src/admin/AdminBroadcasts.jsx` (rewritten) ·
`src/admin/AdminDashboard.jsx` (tab) · `src/admin/AdminReports.jsx` · `src/auth/AttackHub.jsx` (ReportFrame,
BroadcastBar) · `src/dashboard/Dashboard.jsx` · `api/broadcasts.mjs` (new) · `vite.config.js` · `api/README.md`.
Report shell: `D:\claude_work\nats-v2\tools\patch_v5_broadcast.py` → `src\v5.html` is now **v5.1** (backup
`backup\v5-before-broadcast-live-2026-10-22.html`); copied to wt-cards + wt-deploy `public/reports-full/` and the
preview rebuilt (`scripts/build-report-previews.mjs public`, then `apply-report-responsive.mjs --write`).

## 2. Verified (22 Oct, local Docker stack, admin account `admin.local@attacked.test` — local only)
- Migrations apply cleanly (bucket, 4 policies, columns, view).
- Admin → Broadcasts: picker resolves the NATS ref; a 25-second test mp3 is picked up with its length; Publish →
  **Live**, file in storage (200 KB, audio/mpeg, public URL answers 200), row has hosts `[Aman Sehgal — Founder]`.
- `GET /api/broadcasts?ref=ATK-2026-0908-NATS` → the episode + the card shape; bad ref → 400.
- Hub as subscriber (srcdoc frame): card shows the uploaded file, play/pause works, timer runs, Hub bar hidden.
- Hub as a signed-out reader (preview `src` frame): card live too. Standalone `/reports/ATK-…NATS.html`: card live via
  the API after ~1.5 s.
- `vite build` passes. All 311 previews rebuilt and verified (`verify-report-responsive`: 311 ok).
- Not tested: a real-size episode (tens of MB) on the live project; the dashboard view in the browser (same code path
  as the Hub); the print PDF (see §4).

## 3. OWNER STEPS to put it live (Claude is blocked from production deploys)
1. **Database (once):** Supabase → project `ovenyjguhkgiceddzwna` → SQL editor → paste and run
   `D:\attacked-dev\wt-cards\supabase\live-apply\2026-10-22_broadcasts.sql` (both broadcast migrations; idempotent).
   Check: Storage shows a public bucket **broadcasts**; Table editor shows `report_broadcasts` with `audio_path`.
2. **Deploy:**
   ```
   vercel deploy --prod --yes --cwd D:\attacked-dev\wt-deploy
   ```
3. **Verify on live:**
   - `https://attackedmap.vercel.app/api/broadcasts?ref=ATK-2026-0908-NATS` → `{"ref":…,"episodes":[],"broadcast":null}`
   - Sign in as admin → Admin → **Podcasts** (`/?admin&tab=broadcasts`) → **+ Episode** → report `ATK-2026-0908-NATS`, title, drop the real
     episode mp3 → **Publish episode** → row shows **Live** with a player.
   - Open `/?hub&open=2389` → scroll to the end of the Executive Summary → the broadcast card plays. Sign out, open the
     same link → the card still plays (free part of the report).
   - `/reports-full/ATK-2026-0908-NATS.html` without a token must still answer **302** (paywall unchanged).
4. **Rollback:** Vercel → promote the previous deployment (or `vercel rollback`). The SQL is additive; to undo it:
   `drop view public.report_broadcast_refs; drop table public.report_broadcasts cascade;` then delete the bucket in
   Storage (policies go with it: `drop policy broadcasts_public_read on storage.objects;` etc.).

## 4. Open items / follow-ups (not blockers)
- **Print PDF (done 22 Oct, later):** `build_print.py` now asks the site for the published episode
  (`GET <site>/api/broadcasts?ref=<ref>`, flag `--broadcast-api`, `--no-broadcast-api` for offline) and prints it on
  the last-page podcast card: an uploaded file prints as "Plays in the online edition · <length>", a Spotify/Apple page
  prints its URL, nothing published prints "Episode coming soon". The staged master was built against LIVE (no episode
  yet). **After the real episode is published on live, rebuild once and re-stage:**
  ```
  cd D:\claude_work\nats-v2
  python tools\build_print.py src\v5.html --incident 2389
  copy out\print\ATK-2026-0908-NATS.pdf D:\attacked-dev\wt-deploy\reports-pdf\
  copy out\print\ATK-2026-0908-NATS.stamp.json D:\attacked-dev\wt-deploy\reports-pdf\
  vercel deploy --prod --yes --cwd D:\attacked-dev\wt-deploy
  ```
- Only the first published episode (lowest sort order, newest) is shown per report; a multi-episode list is a UI task.
- Hub feed cards do not yet badge "has broadcast" (the `report_broadcast_refs` view and `listBroadcastRefs()` exist).
- The episode file is public by design (like a podcast). Subscriber-only audio would need signed URLs instead.
- The dashboard shows no bar for v4 reports (only the v5 card injection).
- Supabase Free plan: uploads over 50 MB fail at the storage layer with a size error; keep episodes as 64–96 kbps mp3.
- Local stack is still running (Docker Desktop + `supabase start`); stop with `npm run local:stop` in the main repo.
  The two migration files were also copied into the main repo's `supabase/migrations/` so a local `db reset` keeps
  them; `scripts/local-admin-session.mjs` (main repo) makes the local admin + session again; launch config
  `cards-docker` (port 5176) runs wt-cards against the local stack.
- GCP: nothing here is Supabase-specific beyond storage + PostgREST; on GCP the same table/bucket semantics are
  needed (see GCP_OWNER_CHECKLIST.md). Do the end-to-end Attack Map check first, as the owner asked.
