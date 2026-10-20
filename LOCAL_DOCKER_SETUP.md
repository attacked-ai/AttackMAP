# Local Docker stack for the Attack Map — setup and runbook

Written 2026-10-20. Say **"Read LOCAL_DOCKER_SETUP.md and continue"** to pick this up.

## 0. What this is, in one minute

Today every `npm run dev` talks to the **live** Supabase project
(`ovenyjguhkgiceddzwna`). That is why local testing has hurt production: the
October egress block (automated map reloads on localhost burned the 5 GB free
quota), live sign-in rate limits, and nothing to test against when Supabase is down.

This setup runs a **complete copy of Supabase on this PC in Docker**: Postgres 17,
Auth, PostgREST, Storage, Studio, a mail catcher, and the edge functions. The
web app points at it with one command, and the live project is never touched.

| Command | Does |
|---|---|
| `npm run local:doctor` | Is this PC ready? Docker, WSL, disk, RAM, ports, baseline |
| `npm run local:start` | Start the stack; write `.env.docker` with the local keys |
| `npm run dev:docker` | The web app on http://localhost:5173 **against the local stack** |
| `npm run dev` | Unchanged: the web app against **live** |
| `npm run local:dump` | One time: copy the live schema + data into the local stack |
| `npm run local:reset` | Rebuild the local DB from `supabase/migrations` + seed |
| `npm run local:stop` | Stop (data kept). `npm run local:stop -- --wipe` deletes the data |

Local URLs once running: Studio http://127.0.0.1:54323 · Mail catcher
http://127.0.0.1:54324 · API gateway http://127.0.0.1:54321 ·
Postgres `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

Status (2026-10-20 night): **all four steps are done on this PC.** C: was freed from
0 to ~10 GB, Docker Desktop 29.9.1 is installed at `D:\Docker` with its VM disk at
`D:\DockerData\wsl`, `.wslconfig` is in place, the stack runs (nine containers), and
the live database is copied in: `supabase/roles.sql`, the baseline
`20261020150009_baseline_live.sql`, the trigger file `20261020150229_auth_triggers_live.sql`
and a 58 MB data seed. Verified: all 19 tables in the six copied schemas match live
row for row (82,976 rows), the map shows 2,307 incidents from 127.0.0.1:54321, a
local sign-up creates its profile row through the copied trigger, and the admin
dashboard's RPCs work for a locally promoted admin. The live connection string sits in
`api/.env` as `SUPABASE_DB_URL`; the password was shared in chat, so rotate it when
convenient (Database settings → Reset database password, then update that line).

## 1. This PC first: the C: drive is full

Measured 2026-10-20: **C: 100 GB, 0.0 GB free. D: 376 GB, 282 GB free. RAM 8 GB.**
Nothing installs on C: in that state, Docker included. Free at least 5 GB on C:
(Docker itself goes to D:, but WSL, the Windows feature install and the installer's
temp files need C:). Where the space is:

| Folder | Size | Safe to clear? |
|---|---|---|
| `C:\Users\mohin\AppData\Roaming\Claude\vm_bundles` | **13.9 GB** | Claude Desktop's downloaded VM images for the local-agent/Cowork mode. Quit Claude Desktop, then delete the folder; the app re-downloads a bundle if that mode is used again. Biggest win. |
| `C:\Users\mohin\.claude\projects` | 4.0 GB | Claude Code session transcripts. Old ones can be deleted (or set `cleanupPeriodDays` lower in `~/.claude/settings.json`). |
| `C:\Windows\SoftwareDistribution\Download` | 1.9 GB | Windows Update leftovers: Settings → System → Storage → Temporary files → "Windows Update Cleanup". |
| `C:\Users\mohin\Downloads` | 1.6 GB | Review by hand (xlsx/json exports from April–June). |
| `C:\$Recycle.Bin` | 0.6 GB | Empty the Recycle Bin. |
| `C:\hiberfil.sys` | 3.1 GB | Only if you never use Hibernate: `powercfg /h off` (admin). |

Target: **≥ 5 GB free on C:** before step 2. Keep it that way: Docker's images and
volumes go to D: (step 2), and `npm` already caches on `D:\npm-cache`.

## 2. Install Docker Desktop — to D:

Needs an **Administrator** PowerShell and accepts Docker's licence (free for
personal use / companies under 250 staff and $10M revenue).

```powershell
powershell -ExecutionPolicy Bypass -File docker\install-docker-desktop.ps1 -AcceptLicense
```

The script downloads the official installer to `D:\DockerSetup`, installs the
program to `D:\Docker`, and puts the WSL virtual disk (the part that grows to
many GB) under `D:\DockerData\wsl`. It enables the WSL 2 backend. Then:

1. Cap WSL's memory **before Docker's first start**, so its disks are created under
   the cap and the swap file lands on D:: `npm run local:doctor -- --fix-wsl` (copies
   `docker\wslconfig.example` to `C:\Users\mohin\.wslconfig`). If Docker already
   runs, copy it anyway and run `wsl --shutdown`; Docker Desktop restarts its engine
   and `npm run local:start` brings the containers back.
2. Reboot if asked (installer exit code 3010, or Windows prompts for the WSL 2 feature).
3. Open Docker Desktop once; accept its service agreement; wait for **"Engine
   running"**. Skip the sign-in.
4. Check: `docker version` shows a Server section, and `npm run local:doctor` is green.

Settings worth ticking in Docker Desktop → Settings → General: *Start Docker
Desktop when you sign in* **off** (RAM), *Use the WSL 2 based engine* **on**.

## 3. Start the stack

```bash
npm run local:doctor
```
```bash
npm run local:start
```

First start downloads about 2 GB of images (to D:) and takes a few minutes; later
starts take ~30 s. The script then writes **`.env.docker`** (web app) and
**`api/.env.docker`** (FastAPI container) from `supabase status` and prints the URLs.
Both files are git-ignored; the keys in them are the local stack's standard
development keys, not live ones.

What runs (from `supabase/config.toml`): Postgres 17 · Kong gateway · GoTrue
(auth) · PostgREST · Storage · Studio · Mailpit · edge runtime · pg-meta.
**Off** to fit 8 GB RAM: realtime, analytics (Logflare + Vector), image proxy.
To also skip the edge runtime: `npm run local:start -- --exclude=imgproxy,edge-runtime`
(flags after `--` work the same in PowerShell, cmd and bash).

Until step 4 is done the database is **empty**: the map shows no incidents and
`npm run local:verify` says the `incidents` table is missing. That is expected.

## 4. Copy the live database in (one time)

The repo's `supabase/migrations/` only holds the six deltas written since
September; the full schema (8 app schemas: cms, content, identity, map, ops,
public, reference, sweep; ~20 RPCs; views; RLS) exists only on live. `local:dump`
pulls it once with `pg_dump` (the CLI runs pg_dump inside Docker, which is why
Docker must be up first).

1. Supabase dashboard → project `ovenyjguhkgiceddzwna` → **Project Settings →
   Database → Connection string → "Session pooler"** (port 5432; the IPv4-safe one).
   If you do not know the database password, *Reset database password* there
   (this does not affect the app: it uses API keys, not the DB password).
2. Put it in `api/.env` (git-ignored, already holds the secret key) as
   `SUPABASE_DB_URL=postgresql://postgres.ovenyjguhkgiceddzwna:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres`
   with special characters in the password percent-encoded (`@`→`%40`, `#`→`%23`, `/`→`%2F`).
   Or pass it for one run: `npm run local:dump -- --db-url="postgresql://…"`.
3. Run:

```bash
npm run local:dump
```

What it does, in order:

- **Roles** → `supabase/roles.sql`. Live owns some objects with custom roles (for
  example `intel_globe_owner` for the `intel` schema); the baseline's `OWNER TO`
  lines fail without them. The CLI applies this file before the migrations on every
  reset. Password hashes are stripped; the file is safe to commit.
- **Schema** → `supabase/migrations/<timestamp>_baseline_live.sql` (no rows). The six
  older delta migrations already live in `supabase/migrations.live-applied/` (see its
  README: they were applied on live by hand and are inside the baseline; on an empty
  database they fail with "schema identity does not exist", which is exactly what the
  very first `local:start` hit before they were moved). `start`, `reset` and `dump`
  move any such pre-baseline file there automatically. The baseline is scanned for
  secret-looking values (JWTs, `sb_secret_`, connection strings) and warns if any;
  review before committing it.
- **Triggers on `auth.users`** → `supabase/migrations/<timestamp>_auth_triggers_live.sql`.
  `pg_dump` leaves the `auth` schema out, so the baseline has the sign-up → profile
  *function* but not the trigger that calls it. The script reads the trigger definitions
  with `psql` from the `postgres:17-alpine` image (the same step
  `deploy/gcp/db/migrate.sh` does) so new local sign-ups get their `identity.profiles` row.
- **Privileges** → `supabase/seed_live_acl.sql` (committed, local-only, ~120 lines).
  The local image pre-grants ALL on every new `public` object to `anon` and
  `authenticated`, and a schema dump cannot express the *absence* of a grant, so a
  plain restore is more open than live. The script reads live's actual grants on
  public tables, views and functions and writes them as revoke-then-grant statements,
  which the CLI applies after the migrations. Verified afterwards: live and local
  privileges for those two roles are identical.
- **Data** → `supabase/seed/live_data.sql` (git-ignored). Only six schemas are
  copied: `cms`, `content`, `map`, `public`, `reference`, `sweep`. **Not** copied:
  `identity` (accounts, profiles, applications, feedback, prefs), `ops` (deliveries,
  logs), and everything Supabase-internal (`auth` with its password hashes and
  session tokens, `storage`, `cron`, `net`, `vault`). Without that schema list the
  CLI dumps *all* of them, and the `cron.job` rows then break `db reset`. Inside
  the six, a few exact tables are skipped too (`public.newsletter_subscribers`,
  applications, feedback). Overrides: `npm run local:dump -- --seed-schemas=cms,public`
  and `-- --seed-exclude=public.a,public.b` (exact `schema.table` names; `*` is not a
  wildcard there). Accounts are created fresh locally. The file loads with FK and
  trigger checks off (`session_replication_role = replica`), because the `identity`
  and `auth` parents are absent.
- **Load** → `supabase db reset`, then prints the local incident count
  (live has ~2,300 incidents).

Egress: one read of the schema (small) plus the rows of the six schemas, in the
order of 100–200 MB as SQL (the whole live DB is ~220 MB), a few % of the 5 GB
monthly quota. Run it once, never in a loop. Afterwards the local stack never
needs live again (`local:reset` rebuilds from the files on disk). Re-run
`npm run local:dump -- --force` only when the live schema changes. The command
ends by running the same checks as `local:verify`, so the incident count is printed.

Pictures: the copied rows still point at live's public storage URLs
(`…supabase.co/storage/v1/object/public/incident-media/…`), so incident images load
from live (small egress). Uploading in the local Admin pages goes to the local
`incident-media` / `avatars` buckets, which `config.toml` creates; `supabase/seed.sql`
adds two local-only policies on `storage.objects` (public read, signed-in write for
those two buckets), because live's storage policies are not part of the dump either.

## 5. Daily use

**Web app against local:** `npm run dev:docker` (Vite `--mode docker` loads
`.env.docker`, which overrides `.env`). `npm run dev` still means live. The Claude
desktop preview has a `vite-docker` entry (port 5174) next to `vite-dev`.

**Sign in locally:** the dev-only *direct sign-in* (no code) works as before, now
using the local stack's secret from `.env.docker`. To test the real 6-digit flow,
set `VITE_DIRECT_SIGNIN=0` in `.env.docker`, sign in, and read the code in Mailpit
at http://127.0.0.1:54324. Make yourself admin: Studio → Table editor →
`identity.profiles` → set `tier` to `admin` (or `enterprise` for subscriber view).

**Look at data:** Studio http://127.0.0.1:54323 (Table editor, SQL editor), or
`docker exec -it supabase_db_attackedmap psql -U postgres` (there is no psql on this
PC; the connection string `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
is for tools that bring their own driver).

**Edge functions:** run with the stack at
`http://127.0.0.1:54321/functions/v1/<name>`; secrets from `supabase/functions/.env`
(copy `.env.example`). Mail they send lands in Mailpit. Hot reload is on.

**FastAPI layer (optional):** `docker compose --profile api up --build` →
http://localhost:8000/docs, then `VITE_API_URL=http://localhost:8000` in
`.env.docker`. It verifies local tokens with the local JWT secret
(`SUPABASE_JWT_SECRET` in `api/.env.docker`). One catch: with `VITE_API_URL` set,
sign-in codes are emailed by the API over Gmail, not by the local Auth into Mailpit.
`api/.env.docker` has no Gmail values, so the API answers 503 ("code email is not
configured") and the app shows that. Leave `VITE_API_URL` empty while testing
sign-in, or put a real `GMAIL_USER` / `GMAIL_APP_PASSWORD` in `api/.env.docker`
(codes then go to a real inbox).

**Schema changes:** make them locally (Studio or SQL), then
`npx supabase@2 db diff -f <name>` writes a migration file. Before the first push to
live, the two files `local:dump` generated (`…_baseline_live.sql`,
`…_auth_triggers_live.sql`) must be marked as already applied there, otherwise
`db push` tries to replay the whole schema onto production. `local:dump` prints the
exact command; it is the one write to live in this setup and you run it once:

```bash
npx supabase@2 migration repair --db-url "<live url>" --status applied <baseline version> <trigger version>
```

Then always dry-run first and confirm only the new file is listed:

```bash
npx supabase@2 db push --dry-run --db-url "<live url>"
```

That is the "test locally, then productionize" path this setup exists for.

**Stop:** `npm run local:stop` (volumes kept, next start is fast).
`npm run local:stop -- --wipe` deletes the local data; `local:reset` recreates it
from the files.

## 6. Safety and rollback

- Nothing here writes to live. `local:dump` reads once through the URL you give.
- Going back to exactly how things were: delete `.env.docker` and `api/.env.docker`
  (or just use `npm run dev`). `npm run local:stop -- --wipe` removes the containers'
  data; uninstalling Docker Desktop removes the rest.
- Committed: `supabase/config.toml`, `supabase/seed.sql` (placeholder),
  `docker-compose.yml`, `docker/`, `scripts/docker-local.mjs`, the npm scripts,
  `.env.docker.example`, `supabase/functions/.env.example`, this file, and later the
  schema baseline (after the secret scan). Never committed: `.env.docker`,
  `api/.env.docker`, `supabase/seed/*.sql`, `supabase/functions/.env`.
- Code change outside the new files: `scripts/dev-direct-signin.mjs` now reads
  `.env.<mode>` too and takes `SUPABASE_SECRET_KEY` from there when present. In
  `npm run dev` (mode development) its behaviour is unchanged.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Docker is not installed` / `engine is not running` | Step 2; open Docker Desktop and wait for "Engine running". |
| `port 54321 … in use` and the stack is not running | Another `supabase start` in a different folder (`npx supabase@2 stop --project-id <id>`), or `docker ps` to see what holds it. 54329 is the embedded Postgres used by `api` pytest (D:/attacked-dev/pgdata), which is why the pooler stays off. |
| Containers restart / PC freezes | WSL took the RAM: `.wslconfig` (step 2.3), then `wsl --shutdown`. Also `LOCAL_SUPABASE_EXCLUDE=imgproxy,edge-runtime`. |
| Map empty, `incidents` missing | Step 4 not done (no baseline). `npm run local:verify` says so. |
| `db reset` fails inside the seed | The dump is stale after a schema change, or a schema outside the six was pulled in with `--seed-schemas`. Re-run `npm run local:dump -- --force`; keep `--seed-schemas` to the app schemas (never `auth`, `cron`, `storage`). |
| `npm run dev:docker` stops with "--mode docker, but VITE_SUPABASE_URL is …" | `.env.docker` is missing or stale: `npm run local:start` (or `local:env`). This guard is what stops a "local" session from silently using live. |
| Sign-in code never arrives | It is in Mailpit (http://127.0.0.1:54324), never in a real inbox. |
| `vite --mode docker` still hits live | `.env.docker` missing (run `npm run local:env`), or a `.env.docker.local` overrides it. |
| Slow first `supabase start`, "pulling" | ~2 GB of images once; they live on D: if step 2 was followed. |
| OneDrive shows sync conflicts under `supabase/.temp` | Harmless; folder is git-ignored. Optionally exclude the repo folder from OneDrive sync, or move the checkout to `D:\` (the worktrees already live in `D:\attacked-dev`). |
| Bind-mount errors with `docker compose --profile web` | Docker Desktop → Settings → Resources → File sharing must include the repo path. On Windows prefer `npm run dev:docker` on the host anyway. |

## 7b. Known, accepted differences from live

- `supabase db dump` drops comment lines that start at column 0 inside function
  bodies. Three functions (`intel.publish_globe`, `intel.tg_routine_write_guard`,
  `public.fn_sweep_report`) therefore differ from live by one provenance comment
  each; behaviour is identical.
- `supabase/seed.sql` adds two storage policies that live does not have (live's
  storage policies are not part of the dump).
- Pictures in copied rows point at live's public storage (97 incident images, one
  report hero); they load from live, which is a small read.
- A fixed point in time: the data is a snapshot of 2026-10-20. `npm run local:dump
  -- --force` refreshes it.

## 7c. Found on LIVE while verifying parity (not caused by this setup)

The parity audit compared privileges on both sides and found these on live. They
are reproduced locally on purpose (local must match live); fix them **on live
first**, then re-run the dump so local follows:

1. **The public key can modify incidents.** `public.incidents` (and
   `public.recent_reports`, `public.upcoming_deadlines`) are plain auto-updatable
   views owned by `postgres` with ALL privileges granted to `anon` and
   `authenticated`, so DML through them bypasses the RLS on `sweep.incidents`.
   Same for `public.partner_feedback`. Fix in the live SQL editor, then verify the
   map still reads:
   ```sql
   revoke insert, update, delete, truncate, references, trigger
     on public.incidents, public.recent_reports, public.upcoming_deadlines
     from anon, authenticated;
   ```
2. `sweep.adaptive_controls` grants `anon` ALL (its siblings grant SELECT, INSERT).
   TRUNCATE is not covered by RLS. `revoke truncate, delete, update, references,
   trigger on sweep.adaptive_controls from anon;` once checked against the sweeper's
   write path.
3. A personal Gmail address is hard-coded as the fallback sender in three untracked
   edge-function files (`*/deployed.index.ts`); mind that before `git add supabase/`.

## 8. What stays on live / is not reproduced locally

- Vercel hosting, the Resend/Gmail senders, WorkOS (its bridge function is deployed
  only through the MCP, not from this repo), the GUARD pipeline pushes.
- `pg_cron` schedules and Vault secrets: the schema dump leaves `cron` and `vault` out,
  and the data dump is limited to the six app schemas. The 30-minute incident report
  job therefore does not run locally; call the function by hand.
- Storage **files** (avatars, incident pictures): URLs in the data keep pointing at
  live; local uploads go to local buckets.
- Live sign-in providers (Google etc.): off locally unless you add the client id/secret
  (see `[auth.external.google]` in `supabase/config.toml`).
- `create-checkout` (Stripe) is referenced by the app but exists on live only.

## 9. Owner checklist

- [x] Free ≥ 5 GB on C: (done 2026-10-20: ~10 GB free)
- [x] Docker Desktop installed to D:, engine running
- [x] `.wslconfig` in place (swap on D: applies after the next `wsl --shutdown` or reboot)
- [x] `npm run local:start`
- [x] Session-pooler connection string in `api/.env` as `SUPABASE_DB_URL`
- [x] `npm run local:dump` → 2,307 incidents locally, all 19 tables match live
- [x] `npm run dev:docker` → map, sign-up and admin verified against 127.0.0.1:54321
- [ ] Rotate the database password (it was shared in chat) and update `api/.env`
- [ ] Commit the setup: `supabase/config.toml`, `supabase/roles.sql`, the two migration
      files, `supabase/seed.sql`, `supabase/migrations.live-applied/`, `docker/`,
      `docker-compose.yml`, `scripts/docker-local.mjs`, the npm scripts, this file
      (the secret scan of the baseline and roles file is clean)
- [ ] Before any future `db push` to live, run once (see §5):
      `npx supabase@2 migration repair --db-url "<live url>" --status applied 20261020150009 20261020150229`
