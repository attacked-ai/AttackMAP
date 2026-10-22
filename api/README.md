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

Any small host that runs a Python process: Render / Railway / Fly.io
(`uvicorn app.main:app --host 0.0.0.0 --port $PORT`), or Vercel serverless.
Set the variables from `.env.example`; add the production origin to
`ALLOWED_ORIGINS`. Give the API `REPORTS_DIR` with the 310 report files (they
are not in git).

## Phases

1. **Beside Supabase** (this) — subscriber layer, reports, subscription, ingest through the API.
2. **Lock the DB** — revoke anon `SELECT` on `blast_radius`, `adaptive_controls`, `peer_watchlist`, `historical_analogues`, `sources`; the API needs `SUPABASE_SERVICE_ROLE_KEY` from then on. Retire `guard-ingest` and rotate the ingest token.
3. **Money and mail** — Stripe checkout + webhooks on `/subscription`, email sends here instead of the Deno functions.

## Vercel functions beside it (not FastAPI)

Two small Node handlers in this folder ARE deployed by Vercel (the rest of
`api/` is ignored there, see `.vercelignore`); the Vite dev server mounts the
same handlers, so localhost behaves like the live site:

| Route | Who | What |
|---|---|---|
| `POST /api/report-pdf` `{"ref"}` | subscriber | the print edition of a briefing, stamped with the reader's own profile (`api/_lib/reportPdf.mjs`) |
| `GET /api/broadcasts?ref=` | anyone | the published broadcast episodes of a briefing, for a copy of the report opened without a host page (`src/lib/broadcastShape.js` shapes it; the Hub itself reads the table directly) |
