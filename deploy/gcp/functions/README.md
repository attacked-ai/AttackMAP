# Edge functions on Cloud Run

The Supabase edge functions in `supabase/functions/` run on Google Cloud as one
Deno container image (`Dockerfile` here) and one Cloud Run service per function,
chosen by `ENV FUNCTION`. The code is the same code Supabase runs: it reads and
writes data through `SUPABASE_URL/rest/v1` with the service_role JWT, which on
GCP is our PostgREST (the `attacked-data` service) and our own signed JWT.

| Function | What it does | Trigger on GCP | Public? |
|---|---|---|---|
| `incident-deliver` | internal sweep brief, email + WhatsApp | Cloud Scheduler, every 30 min | no |
| `daily-digest` | subscriber brief | Cloud Scheduler, 08:00 UTC | no |
| `welcome-email` | one-time welcome on onboarding | DB trigger via the outbox | no |
| `incident-images` | one picture per incident | Cloud Scheduler, every 10 min | no |
| `incident-report` | Daily Brief dashboard backend | the browser | yes |

Retired, **not ported**: `notify-application` (the partner-application flow,
retired 2026-09-21) and `guard-ingest` (ingest is the API's job now). Other
functions still deployed on Supabase and out of scope here: `stripe-webhook`,
`create-checkout` (still called by `src/auth/PricingPage.jsx` startCheckout),
`create-portal-link`, `attack-map-feed`, `guard-daily-brief`, and the stubs
`dashboard`, `debug-smtp`, `secrets-presence-probe`, `send-test-brief`.

## Build

The build context is `supabase/functions`, the way `api/` is the API's:

```sh
IMAGE="$REGION-docker.pkg.dev/$PROJECT/attacked/functions:$(git rev-parse --short HEAD)"
docker build -f deploy/gcp/functions/Dockerfile -t "$IMAGE" supabase/functions
docker push "$IMAGE"
```

As a Cloud Build step (for `deploy/gcp/cloudbuild.yaml`):

```yaml
- name: gcr.io/cloud-builders/docker
  args: ["build", "-f", "deploy/gcp/functions/Dockerfile", "-t", "$_FN_IMAGE", "supabase/functions"]
```

`deno cache` downloads every dependency during the build, so cold starts
download nothing. No `deno` was available where this was written, so the image
has not been built yet: the first build is the first real compile. If it stops
on a type error, run `deno check supabase/functions/<name>/index.ts` locally.

## Deploy pattern

```sh
gcloud run deploy fn-incident-deliver \
  --image "$IMAGE" --region "$REGION" \
  --service-account "fn-runner@$PROJECT.iam.gserviceaccount.com" \
  --no-allow-unauthenticated --port 8000 \
  --concurrency 1 --max-instances 1 --timeout 300 \
  --set-env-vars "FUNCTION=incident-deliver,SUPABASE_URL=$DATA_API_URL,MAIL_FROM=Attacked.ai <brief@attacked.ai>" \
  --set-secrets "SUPABASE_SERVICE_ROLE_KEY=service-role-key:latest,INTERNAL_TOKEN=internal-token:latest,RESEND_API_KEY=resend-api-key:latest"
```

- `FUNCTION` is the folder name. `SUPABASE_URL` is the data service's base URL
  **without** `/rest/v1` (the code appends it).
- `--port 8000`: Deno.serve's default. Every function also listens on `$PORT`,
  so a service deployed without it (Cloud Run's 8080) works too.
- Secret names on the right (`service-role-key`, ...) are suggestions; use the
  names `deploy/gcp/setup.sh` creates. The env names on the left are what the
  code reads.
- The API calls private functions with a Google ID token plus
  `x-internal-token` (`api/app/routers/gcp_jobs.py`). Give the API's service
  account `roles/run.invoker` on each private service, set the same
  `INTERNAL_TOKEN` on the API, and list the service URLs in its `FUNCTION_URLS`
  (`{"incident-deliver": "https://fn-incident-deliver-….run.app", …}`).

## Caller auth (all functions)

`supabase/functions/_shared/auth.ts`. A machine-only function answers only
when the request carries

- `x-internal-token` equal to `INTERNAL_TOKEN` (what the API sends), or
- `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (pg_cron / pg_net on
  Supabase, scripts).

Anything else gets 401. Both comparisons are constant-time. On Cloud Run,
`Authorization` already carries Google's ID token, so the internal token is
the path there. `incident-report` also accepts the public anon key.

## Mail (daily-digest, incident-deliver, welcome-email)

`supabase/functions/_shared/mail.ts`, `sendMail({to, subject, html, text?, headers?, idempotencyKey?})`:

- `RESEND_API_KEY` set: Resend's REST API, From = `MAIL_FROM` (an address on the
  domain verified in Resend). Retries 429/5xx, 3 attempts, honours Retry-After.
  Every send carries an `Idempotency-Key` hashed from the job, the recipient and
  the email itself, so a retry or a re-run cannot deliver the same email twice
  within Resend's 24 hours.
- Not set: Gmail SMTP as before (`GMAIL_USER`, `GMAIL_APP_PASSWORD`,
  `SENDER_NAME`), so a redeploy to Supabase keeps working. Not needed on GCP.

## incident-deliver

The internal sweep brief: mails the latest sweep (`fn_sweep_report`) once to
every active `report_recipients` row and WhatsApps the phone rows through
Twilio; `delivery_log` dedupes. Model-written text in the email HTML is escaped.
Its response lists recipient addresses (internal callers only).

- **Trigger:** Cloud Scheduler `*/30 * * * *` → `POST $API/api/jobs/run/incident-deliver`
  (replaces pg_cron `auto-incident-report`). The run dedupes itself, so the
  Scheduler job may retry.
- **Env:** `FUNCTION=incident-deliver`, `SUPABASE_URL`, `MAIL_FROM`, `DASHBOARD_URL`
  (default `https://attacked-daily-brief.vercel.app`), `TWILIO_WHATSAPP_FROM`.
- **Secrets:** `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_TOKEN`, `RESEND_API_KEY`,
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.
- **Flags:** `--no-allow-unauthenticated --concurrency 1 --max-instances 1 --timeout 300`
  (one run at a time: two overlapping runs could both pass the dedupe check).

## daily-digest

The subscriber brief (v18), personalised by industry, categories, severity
floor and cadence; weekly readers on Mondays. Every brief carries
`List-Unsubscribe`; a reader without an `unsubscribe_token` is skipped. The
one-click form (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) is added
only when `UNSUBSCRIBE_POST_URL` names an endpoint that unsubscribes on a POST
(the token is appended). The `/?unsubscribe=` link is a browser page: a mail
client's one-click POST to it would unsubscribe nobody. Such an endpoint does
not exist yet.

- **Trigger:** Cloud Scheduler `0 8 * * *` (UTC) → `POST $API/api/jobs/run/daily-digest`,
  body `{}` (= yesterday). Set the job's attempt deadline above the run time and
  its retries to 0. On Supabase the 08:00 cron exists but is inactive; do not
  port the DB trigger `notify_on_sweep_change`, which references a missing view
  (`vi_sweeps`).
- **Env:** `FUNCTION=daily-digest`, `SUPABASE_URL`, `APP_URL` (the site, default
  `https://attackedmap.vercel.app`), `MAIL_FROM`, optional `UNSUBSCRIBE_POST_URL`.
- **Secrets:** `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_TOKEN`, `RESEND_API_KEY`.
- **Flags:** `--no-allow-unauthenticated --concurrency 1 --max-instances 1 --timeout 600`
  (600 s is also how long the API's `/api/jobs/run` waits).
- **Test without sending:** `{"dryRun": true}` (per-reader report, addresses
  included), `{"dryRun": true, "to": "x@y"}` (+ HTML), `{"to": "x@y"}` sends one.

## welcome-email

One branded welcome, personalised to the sign-up industry, when a profile's
`onboarded_at` is first set. Body `{"user_id": "<uuid>"}`; `{"dryRun": true}`
returns the subject and HTML without sending.

- **Trigger:** DB trigger `trg_welcome_on_onboarded` calls `net.http_post`. On
  Cloud SQL that is the stand-in from `deploy/gcp/db/01_supabase_compat.sql`: it
  queues the call in `outbox.requests`, and `POST $API/api/jobs/outbox` (Cloud
  Scheduler, every minute) delivers it here. The outbox routes by the
  `/functions/v1/welcome-email` part of the trigger's URL and replaces its
  headers with the internal token, so the trigger needs no change.
- **Env:** `FUNCTION=welcome-email`, `SUPABASE_URL`, `APP_URL`, `MAIL_FROM`.
- **Secrets:** `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_TOKEN`, `RESEND_API_KEY`.
- **Flags:** `--no-allow-unauthenticated --timeout 60`.

## incident-images

Gives each incident without a picture one generated image (pollinations.ai,
seeded by the incident id), cropped to 3:2 with imagescript, stored, and written
to `incidents.image_url` / `image_source` / `image_credit` / `image_prompt`.
Body `{"limit": 12}`, `{"mod": 4, "rem": 1}` for parallel workers, `{"dryRun": true}`.

- **Storage:** with `GCS_BUCKET_MEDIA` set, it uploads `incidents/<id>.jpg` through
  the Cloud Storage JSON API as the service's own account (metadata-server
  token) and stores `<PUBLIC_MEDIA_BASE>/<bucket>/incidents/<id>.jpg?v=<ms>`
  (base default `https://storage.googleapis.com`; the same shape the API's
  uploads and the data service's old-link redirect use). Without it, Supabase
  Storage as before, which does not exist on GCP. Give the service account
  `roles/storage.objectUser` on the bucket (a redone picture overwrites its
  object). The bucket must be publicly readable.
- **Trigger:** Cloud Scheduler `*/10 * * * *` → `POST $API/api/jobs/run/incident-images`,
  body `{"limit": 12}` (on Supabase this cron was never enabled, and the function
  itself is not deployed there).
- **Env:** `FUNCTION=incident-images`, `SUPABASE_URL`, `GCS_BUCKET_MEDIA`, optional
  `PUBLIC_MEDIA_BASE`.
- **Secrets:** `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_TOKEN`.
- **Flags:** `--no-allow-unauthenticated --concurrency 1 --max-instances 1 --timeout 300`
  (the generator rate-limits parallel requests).

## incident-report

Backend of the Daily Incident Brief dashboard (`dashboard.html`, deployed from
`dashboard-deploy/`). `GET ?sweep_id=<id>` returns `{report, sweeps}`:
`fn_sweep_report` cut down to the fields the dashboard renders, plus the last 30
sweeps. It holds no reader or account data. Errors no longer echo database
messages.

- **Trigger:** the browser, with the anon key as Bearer. Keeps CORS.
- **Env:** `FUNCTION=incident-report`, `SUPABASE_URL`.
- **Secrets:** `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (the anon JWT
  signed with our secret), `INTERNAL_TOKEN`.
- **Flags:** `--allow-unauthenticated` (a browser cannot get a Google ID token;
  the function checks the anon key itself), `--timeout 60`.
- The dashboard's `ENDPOINT` and `ANON` constants still name Supabase; point
  them at this service (or a Hosting rewrite to it) at cut-over.

## Before redeploying any of these to Supabase

The auth gate also applies there. Callers that do not yet send an accepted key:

- pg_cron `auto-incident-report` and the `trg_welcome_on_onboarded` pg_net call:
  check that they send `Authorization: Bearer <service_role key>`; an anon key
  now gets 401. On Supabase, `incident-deliver` and `incident-report` keep
  `verify_jwt = true`, so the gateway refuses `x-internal-token` alone there.
- The commented-out `incident-images-10min` cron in
  `supabase/migrations/20260923_incident_images.sql` sends no key.
- `scripts/daily-check.js --send` calls incident-deliver with the anon key, and
  `scripts/backfill-incident-images.mjs` (remote mode) with no key: both get 401.
- The Gmail fallback now needs the `GMAIL_USER` secret for incident-deliver too
  (its hardcoded address fallback is gone).

## Deployed on Supabase vs this repo (checked 2026-09-30)

- `incident-deliver` v25 (2026-09-18): the repo code before the 2026-09-29 brand
  commit, which only changed #F5B800 to #FCBD00. Nothing to reconcile.
- `daily-digest` v20 (2026-06-18): the June "v16/v19 Partner" brief, older than
  the repo's v17. It selects a column dropped on 2026-07-28, so it should fail.
  Copy in `daily-digest/deployed.index.ts`.
- `welcome-email` v5 (2026-06-18): the June "Design Partner" welcome, older than
  the repo's v2. Copy in `welcome-email/deployed.index.ts`.
- `incident-report` v12 (2026-06-03): only on Supabase until now; verbatim copy in
  `incident-report/deployed.index.ts`, the port in `index.ts`.
- `incident-images`: not deployed on Supabase.
