# Handoff: Supabase egress block + free-plan fix (2026-10-12)

Paste this to the new account: **"Read SUPABASE_EGRESS_HANDOFF.md in the repo root and continue."**

## 1. The problem (in one line)
The live site https://attackedmap.vercel.app is **down** (Attack Map data, sign-in, emails) because Supabase blocked
the project for using too much data ("egress") on the **Free plan**.

| Fact | Value |
|---|---|
| Supabase project (live) | `ovenyjguhkgiceddzwna` |
| Organization | "Vanisher's Org" (`wbcamzdvaslqnaqwddtf`) |
| Plan | **Free** (checked 2026-10-12 via Supabase MCP) — owner does **NOT** want Pro |
| Error | HTTP **402** `exceed_egress_quota` on every endpoint (still 402 on 2026-10-12) |
| Usage this cycle | ~9.0 GB of 5 GB (180%), almost all PostgREST (database API) |
| Billing cycle | 14th → 14th, **monthly** |
| **Block lifts** | **October 14, 2026** (automatic; can lag a few hours) |

**Can it be cleared early for free? No.** Usage already counted cannot be deleted. Clearing the browser cache,
deleting data, pausing or deleting the project — none of it lowers the number. Only options: wait for the 14th,
or upgrade (rejected). Project transfer to a new org is also blocked while restricted.

**Warning:** the one-time grace period is used up. If usage goes over 5 GB again, the block is **immediate**.
Safe pace = ~165 MB/day. Check Supabase → Organization → Usage → Egress weekly.

## 2. Cause
- Automated responsiveness tests (6–8 Oct) reloaded the Attack Map on localhost against the **live** database.
  Each load pulled the full incident list (~2,300 rows, ~6.8 MB uncompressed). 7 Oct alone ≈ 4.2 GB.
- Bug found 2026-10-12: **every visit downloaded the full incident list twice** — `loadIncidentsFast()` and
  `loadFromSupabase()` in `src/GlobalAttackMap.jsx` each fetched the same rows.

## 3. Fix done (NOT deployed)
- Branch **`egress-fix`**, commit **`c4394ee`**, worktree **`D:/attacked-dev/wt-egress`**
  (based on `dc7953a` = the commit currently live on Vercel).
- Change (only `src/GlobalAttackMap.jsx`):
  - New `_fetchIncidentRows()` — one shared download per page load used by both loaders (≈ half the data per visit).
  - Signed-out loads saved for **15 minutes** in browser Cache Storage (`attacked-incidents-v1`) → reloads cost 0.
  - Failed / partial downloads are never cached. Column list is now one constant `INCIDENT_LIST_COLS`.
- Verified: file compiles (esbuild). **Not verified:** full `vite build` (timed out — PC low on RAM) and a live
  map check (impossible while Supabase is 402).
- `D:/attacked-dev/wt-egress/node_modules` is a junction to `wt-deploy/node_modules` (not committed).

## 4. Next steps (in order)
1. **On/after Oct 14:** confirm unblock:
   `curl -s -o /dev/null -w "%{http_code}" https://ovenyjguhkgiceddzwna.supabase.co/auth/v1/health -H "apikey: <anon key from .env>"` → expect 200.
2. Get the **owner's OK** to deploy, then bring the fix onto the deploy line. `cards-only-on-live` (69e5adb) has
   4 extra WorkOS/nav commits on top of the live code — cherry-pick `c4394ee` onto it (or merge), then
   `npm run build` + `vercel --prod --yes` from a clean worktree (see `D:/attacked-dev/wt-deploy`).
3. After deploy: open the map **once** (not in a loop), check pins load, DevTools Network shows only **one**
   `rest/v1/incidents?select=id,headline…` request, and a reload within 15 min shows none.
4. Optional further savings: drop `summary` / `severity_rationale` from the bulk list and load them when an
   incident is opened.

## 5. Rules so this never happens again
- **Never** run test loops / screenshot sweeps against the live Supabase project.
  `D:/attacked-dev/rtools/sweep.mjs` blocks `*.supabase.co` — never set `SWEEP_ALLOW_SUPABASE=1`.
- Owner is non-technical, writes Hinglish — **reply in plain English**.
- Owner chose (2026-10-10) to eventually move production to Google Cloud (branch `gcp-production`,
  checklist `GCP_OWNER_CHECKLIST.md`). That is **not live**; production is still Supabase. The data copy to GCP
  also needs Supabase unblocked.
