"""Attacked.ai API — FastAPI in front of the database.

BACKEND=supabase (today): beside Supabase. Supabase Auth issues the tokens;
this service owns what must not be decided in the browser: who may read the
subscriber layer, the report lock, subscription switching, the sweeper's write
path and the sign-in code email.

BACKEND=gcp: on Google Cloud (deploy/gcp/README.md). Everything is served under
/api, because Firebase Hosting forwards https://<site>/api/** to this service.
On top of the routes above it signs people in (Google, emailed code), holds
their sessions, takes uploads to Cloud Storage and runs the scheduled jobs.

Run locally:   uvicorn app.main:app --reload --port 8000   (from api/)
Docs:          http://localhost:8000/docs  (local only; off in production)
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import incidents, ingest, me, reports, subscription


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    from . import db
    if db._client is not None:
        await db._client.aclose()
    if settings.gcp:
        from .gcp import pg
        await pg.close()


local = settings.env == "local"
app = FastAPI(title="Attacked.ai API", version="0.2.0", lifespan=lifespan,
              docs_url="/docs" if local else None, redoc_url=None, openapi_url="/openapi.json" if local else None)

# Browsers only need CORS in local development (Vite on :5173 calling :8000).
# On GCP the site and the API share an origin, so production needs none.
if local or not settings.gcp:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.origins,
        allow_credentials=settings.gcp,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
    )

api = APIRouter(prefix="/api" if settings.gcp else "")
for r in (me.router, incidents.router, subscription.router, reports.router, ingest.router):
    api.include_router(r)

if settings.gcp:
    from .routers import gcp_auth, gcp_jobs, gcp_uploads
    api.include_router(gcp_auth.router)
    api.include_router(gcp_jobs.router)
    api.include_router(gcp_uploads.router)
else:
    from .routers import auth_code
    api.include_router(auth_code.router)


@api.get("/health", tags=["ops"])
async def health():
    """Liveness only. Configuration is not reported to the public."""
    return {"ok": True, "backend": settings.backend}


app.include_router(api)
