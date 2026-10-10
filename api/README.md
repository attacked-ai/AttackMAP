# Attacked.ai API (FastAPI)

The backend in front of the Supabase database. Supabase Auth stays the
identity provider; this service verifies its tokens (ES256 JWKS, no shared
secret) and owns what must not be decided in the browser.

| Route | Who | What |
|---|---|---|
| `GET /health` | anyone | liveness + which secrets are configured |
| `GET /me` | signed in | id, email, tier, industry, name, company, role |
| `GET /incidents/{id}/subscriber-layer` | subscriber | blast radius, GUARD controls, peers, analogues, sources |
| `POST /subscription` `{"on": true}` | signed in | flips the tier through `set_own_subscription()` as the reader |
| `GET /reports/{ref}` | anyone | a baked report; the three subscriber sections are locked server-side for free/anonymous readers |
| `POST /ingest` `{"table","rows"}` | sweeper (`x-ingest-token`) | writes with the service role; allow-listed tables |
| `GET /docs` | anyone | OpenAPI UI |

## Run locally

```bash
cd api
pip install -r requirements.txt
cp .env.example .env          # optional — with no api/.env it reads VITE_* from ../.env
uvicorn app.main:app --reload --port 8000
```

The web app talks to it when `VITE_API_URL=http://localhost:8000` is set in the
repo `.env`; without it the frontend keeps using PostgREST directly, so nothing
breaks before the API is deployed.

## Deploy

Google Cloud Run, with `BACKEND=gcp`: `Dockerfile` here, the rest in
`deploy/gcp/` (setup.sh, cloudbuild.yaml, README.md). On GCP this service also
signs people in (Google + emailed code via Resend), holds the 30-day HttpOnly
sessions, takes uploads to Cloud Storage and runs the scheduled jobs. The
report files come from a private Cloud Storage bucket mounted at `REPORTS_DIR`.

Tests (GCP backend, against a local PostgreSQL 17): `python -m pytest -q`.

## Phases

1. **Beside Supabase** (this) — subscriber layer, reports, subscription, ingest through the API.
2. **Lock the DB** — revoke anon `SELECT` on `blast_radius`, `adaptive_controls`, `peer_watchlist`, `historical_analogues`, `sources`; the API needs `SUPABASE_SERVICE_ROLE_KEY` from then on. Retire `guard-ingest` and rotate the ingest token.
3. **Money and mail** — Stripe checkout + webhooks on `/subscription`, email sends here instead of the Deno functions.
