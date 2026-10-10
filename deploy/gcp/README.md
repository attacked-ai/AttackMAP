# Attacked.ai on Google Cloud: runbook

Everything the product needs, on Google Cloud only. No Supabase service is used
after the move. This file is the operator's checklist; the "why" behind each
choice is in the production guide the team received with it.

## What runs where

| Piece | Google Cloud product | Name | Code |
|---|---|---|---|
| Website | Firebase Hosting (Google's CDN, free SSL) | `<project>.web.app` or your domain | `dist/` built by Vite, `firebase.json` |
| Data API (`/rest/v1`) | Cloud Run | `attacked-data` | `deploy/gcp/data/` (PostgREST 12 + nginx) |
| Backend API (`/api`) | Cloud Run | `attacked-api` | `api/` (FastAPI, `BACKEND=gcp`) |
| Email + scheduled functions | Cloud Run (private) | `fn-daily-digest`, `fn-incident-deliver`, `fn-welcome-email`, `fn-incident-images`, `fn-incident-report` | `supabase/functions/*`, `deploy/gcp/functions/` |
| Database | Cloud SQL, PostgreSQL 17 | `attacked-db`, database `attacked` | `deploy/gcp/db/` |
| Files | Cloud Storage | `<project>-avatars`, `-incident-media` (public read), `-reports`, `-sweep-archive` (private) | |
| Timers | Cloud Scheduler | `attacked-outbox`, `-incident-deliver`, `-cleanup`, `-daily-digest`, `-incident-images` | `api/app/routers/gcp_jobs.py` |
| Secrets | Secret Manager | see the table below | |
| Build + deploy | Cloud Build + Artifact Registry | repo `attacked` | `deploy/gcp/cloudbuild.yaml` |
| Sign-in | Our API: Google (OpenID Connect) + emailed code | | `api/app/routers/gcp_auth.py` |
| Email delivery | Resend (the only non-Google service) | | `api/app/gcp/mailer.py`, `supabase/functions/_shared/mail.ts` |

Firebase Hosting forwards three paths to Cloud Run, so the site, the data API
and the backend share one origin (no CORS, and the sign-in cookie is
first-party):

    /api/**         -> attacked-api
    /rest/v1/**     -> attacked-data  (PostgREST)
    /storage/v1/**  -> attacked-data  (old picture links redirect to Cloud Storage)

## Before you start (one time, in a browser)

1. **Google Cloud project with billing** at console.cloud.google.com. Note the project id.
2. **Resend account** (resend.com): Domains → Add `attacked.ai` → add the DNS records it shows (SPF, DKIM) plus a DMARC record `_dmarc TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@attacked.ai"` → wait for Verified → API Keys → create one with **Sending access** only.
3. **Google sign-in** (in the same Google Cloud project): APIs & Services → OAuth consent screen → External; app name Attacked.ai, support email, logo, home page, **privacy policy URL and terms URL** (must be live, final pages on your domain), authorised domain. Then Credentials → Create credentials → OAuth client ID → Web application → Authorised redirect URI `https://<SITE>/api/auth/google/callback` (add `http://localhost:5173/api/auth/google/callback` for local testing). Copy the client id and secret. Publishing the consent screen for everyone needs Google's brand verification (a few days).
4. **Firebase**: console.firebase.google.com → Add project → pick the existing Google Cloud project → Hosting → Get started.
5. **Make the GitHub repo private** before connecting Cloud Build to it (the old ingest token is in its history).

## Set up (Cloud Shell, from the repo root)

    cp deploy/gcp/config.env.example deploy/gcp/config.env    # fill it in
    bash deploy/gcp/setup.sh --dry-run                         # read what it will do
    bash deploy/gcp/setup.sh apis registry accounts secrets sql buckets

Add the three secrets only a person can supply (setup prints the commands):

    printf '%s' '<client id>'     | gcloud secrets versions add google-client-id --data-file=-
    printf '%s' '<client secret>' | gcloud secrets versions add google-client-secret --data-file=-
    printf '%s' 're_…'            | gcloud secrets versions add resend-api-key --data-file=-

Upload the reports (they are on the owner's PC, not in git):

    gcloud storage cp public/reports/*.html public/reports/manifest.json gs://<project>-reports/

Then:

    bash deploy/gcp/setup.sh build          # images
    bash deploy/gcp/setup.sh migrate        # rehearsal copy of the database (see below)
    bash deploy/gcp/setup.sh deploy scheduler hosting monitoring

## Secrets

| Secret | What it is | Made by | Read by |
|---|---|---|---|
| `jwt-secret` | signs every access token; shared with PostgREST | setup.sh | api, data |
| `anon-key` | public JWT, role anon (like Supabase's anon key) | setup.sh | api, build (baked into the site) |
| `service-role-key` | JWT that bypasses row-level security | setup.sh | api, functions, GUARD pipeline |
| `pgrst-db-uri` | PostgREST's database login (`authenticator`) | setup.sh | data |
| `database-url` | the API's database login (`attacked_api`) | setup.sh | api |
| `db-admin-password` | Cloud SQL `postgres` user | setup.sh | migrate job |
| `db-authenticator-password`, `db-api-password` | the two logins above | setup.sh | migrate job |
| `internal-token` | API → functions, and manual job runs | setup.sh | api, functions |
| `ingest-token` | `/api/ingest` for the sweeper | setup.sh | api |
| `google-client-id`, `google-client-secret` | Google sign-in | **you** | api |
| `resend-api-key` | sending email | **you** | api, functions |
| `supabase-db-url`, `supabase-service-key` | only for the move | **you** | migrate job, copy_storage.sh |
| `twilio-*` | WhatsApp in incident-deliver (optional) | **you** | functions |

Rotate one: add a new version (`gcloud secrets versions add <name> …`), then
redeploy the services that read it (`gcloud run services update <svc> --region=<r>`
picks up `:latest`). Rotating `jwt-secret` signs everyone out and needs new
`anon-key` / `service-role-key` values (delete their versions and rerun
`setup.sh secrets`), then a site rebuild (the anon key is in the bundle).

## Database migration

The move is a rehearsal first, then the real copy.

1. Supabase dashboard → Project Settings → Database → Connection string → **Session pooler** (port 5432). Store it:
   `printf '%s' 'postgresql://postgres.<ref>:<db password>@<host>:5432/postgres' | gcloud secrets versions add supabase-db-url --data-file=-`
2. `bash deploy/gcp/setup.sh migrate` restores into a scratch database `attacked_rehearsal`, applies the fixes, and prints every table's row count, source vs target. Read the "unexpected errors" list and the counts in the job's log (Cloud Run → Jobs → attacked-migrate → Logs).
3. Real move: stop the GUARD pipeline pushes, then `MIGRATE_MODE=apply bash deploy/gcp/setup.sh migrate`.
4. Files: `bash deploy/gcp/db/copy_storage.sh` (see its header for the three env vars). Old picture links in rows were already rewritten by the migration; `/storage/v1/object/public/…` links in old emails redirect.
5. Everyone signs in again once (sessions are not copied). Accounts, tiers, profiles and ids are.

What the move keeps working, unchanged: every table, view, SQL function, trigger
and row-level-security policy (`deploy/gcp/db/01_supabase_compat.sql` recreates
Supabase's roles, `auth.uid()`, and replaces pg_net with an outbox that
`attacked-outbox` drains every minute). Tested on PostgreSQL 17 locally.

## Point the GUARD pipeline at Google Cloud

No code change: the pipeline speaks PostgREST, and so does `attacked-data`. In
`GUARD_Pipeline/scraper/.env`:

    GUARD_SUPABASE_URL=https://attacked-data-<hash>.a.run.app     # the data service URL
    GUARD_SUPABASE_KEY=<anon-key>                                  # gcloud secrets versions access latest --secret=anon-key
    GUARD_UPLOAD_KEY=<unchanged>                                   # copied into Cloud SQL's vault by the migration

Run `node scraper/smoke-test.js` before the next push.

## Cutover checklist

- [ ] Rehearsal counts all match; the unexpected-errors list is empty or understood
- [ ] Site works on `<project>.web.app`: sign in by code, by Google; map, hub, dashboard, admin, reports (locked for free readers), profile picture upload
- [ ] Freeze pipeline pushes → `MIGRATE_MODE=apply` → copy_storage.sh → repoint the pipeline
- [ ] Connect the custom domain in Firebase Hosting; update `SITE_URL` in config.env; rerun `setup.sh deploy`; add the domain's redirect URI to the Google OAuth client
- [ ] Resume `attacked-daily-digest` only when you want the subscriber brief to go out (`gcloud scheduler jobs resume attacked-daily-digest --location=<region>`)
- [ ] Keep Supabase read-only for two weeks as a fallback, then pause the project

## Every day

| Task | How |
|---|---|
| Deploy | push to `main` (Cloud Build trigger: Cloud Build → Triggers → Connect repository → config `deploy/gcp/cloudbuild.yaml`, service account `attacked-build`, substitution `_SITE_URL`) |
| Roll back | Cloud Run → service → Revisions → pick the previous one → Manage traffic 100% (or `gcloud run services update-traffic <svc> --to-revisions=<rev>=100`). Site: Firebase Hosting → Release history → Roll back |
| Logs | Cloud Logging, filter `resource.labels.service_name="attacked-api"` |
| Run a job now | `curl -X POST -H "x-internal-token: $(gcloud secrets versions access latest --secret=internal-token)" https://<api-url>/api/jobs/run/incident-deliver` |
| Backups | automatic daily + point-in-time (7 days of logs, 14 backups). Restore: Cloud SQL → Backups → Restore, or clone to a time |
| Sign someone out everywhere | `update auth.sessions set revoked_at = now() where user_id = '<id>'` (Cloud SQL Studio) |
| Make someone admin | Admin dashboard → Users → tier `admin` (or `update identity.profiles set tier = 'admin' where email = …`) |

## Local development against the GCP backend

    cd api && python -m pytest -q        # 17 tests; needs a local PostgreSQL 17 (tests/conftest.py)
    BACKEND=gcp ENV=local DEV_DIRECT_SIGNIN=true … uvicorn app.main:app --port 8000
    VITE_BACKEND=gcp npm run dev         # Vite forwards /api and /rest/v1 (vite.config.js)
