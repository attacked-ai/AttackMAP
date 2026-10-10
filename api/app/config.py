"""Settings for the Attacked.ai API.

Two backends, chosen with BACKEND:

  supabase (default, today) — the API sits beside Supabase: Supabase Auth issues
      the tokens, PostgREST is Supabase's. For local development the two public
      values fall back to the web app's ../.env (VITE_SUPABASE_URL /
      VITE_SUPABASE_ANON_KEY), so `uvicorn app.main:app` works with no api/.env.

  gcp — everything on Google Cloud (deploy/gcp/README.md):
      Cloud SQL holds the data, our own PostgREST (the attacked-data Cloud Run
      service) serves /rest/v1 exactly as Supabase did, and THIS service signs
      people in (Google + emailed code), holds their sessions, sends mail through
      Resend and drains the outbox the database queues HTTP calls into. The
      Supabase-named settings below are then filled from the GCP ones:
        supabase_url              <- DATA_API_URL      (our PostgREST)
        supabase_anon_key         <- ANON_KEY          (JWT, role anon, our secret)
        supabase_service_role_key <- SERVICE_ROLE_KEY  (JWT, role service_role)
        supabase_jwt_secret       <- JWT_SECRET        (shared with PostgREST)
      so the existing routes (subscriber layer, reports, subscription, ingest)
      run unchanged against Cloud SQL.

Secrets never live in the image: on Cloud Run they arrive as env vars mounted
from Secret Manager (deploy/gcp/setup.sh). Never in the repo .env, never in chat.
"""
from __future__ import annotations

from pathlib import Path

from dotenv import dotenv_values
from pydantic_settings import BaseSettings, SettingsConfigDict

API_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = API_DIR.parent


def _web_env() -> dict[str, str]:
    p = REPO_DIR / ".env"
    return {k: (v or "") for k, v in dotenv_values(p).items()} if p.exists() else {}


class Settings(BaseSettings):
    backend: str = "supabase"                        # supabase | gcp
    env: str = "local"                               # local | production

    # ── data API (Supabase's PostgREST, or ours on GCP) ────────────────────
    supabase_url: str = ""
    supabase_anon_key: str = ""                      # legacy anon JWT or sb_publishable_…
    supabase_publishable_key: str | None = None      # new-style public key (preferred when set)
    supabase_service_role_key: str | None = None     # legacy service_role JWT
    supabase_secret_key: str | None = None           # new-style sb_secret_… (preferred when set)
    supabase_jwt_secret: str | None = None           # HS256 secret (Supabase legacy, or ours on GCP)
    allowed_origins: str = "http://localhost:5173,https://attackedmap.vercel.app"
    reports_dir: str = str(REPO_DIR / "public" / "reports")
    ingest_token: str | None = None
    subscriber_tiers: str = "enterprise,admin"
    # the sign-in code email on the Supabase backend (routers/auth_code.py)
    gmail_user: str | None = None
    gmail_app_password: str | None = None
    email_from: str | None = None
    ingest_tables: str = "incidents,sources,blast_radius,peer_watchlist,adaptive_controls,historical_analogues,control_objectives,incident_updates"

    # ── gcp backend ─────────────────────────────────────────────────────────
    public_url: str = "http://localhost:5173"        # the site readers use, e.g. https://app.attacked.ai
    data_api_url: str | None = None                  # our PostgREST base (attacked-data service)
    anon_key: str | None = None
    service_role_key: str | None = None
    jwt_secret: str | None = None                    # PGRST_JWT_SECRET, ≥ 32 chars
    database_url: str | None = None                  # postgresql://attacked_api:…@/attacked?host=/cloudsql/<instance>
    session_days: int = 30                           # absolute sign-in lifetime (owner: at least a month)
    access_token_ttl: int = 3600                     # seconds; the data-API JWT
    session_cookie: str = "__session"                # the ONLY cookie Firebase Hosting forwards
    code_ttl_minutes: int = 10
    code_max_attempts: int = 5
    codes_per_email_hour: int = 5
    codes_per_ip_hour: int = 20
    google_client_id: str | None = None
    google_client_secret: str | None = None
    google_allowed_domain: str | None = None         # e.g. attacked.ai to allow only a Workspace domain
    resend_api_key: str | None = None
    mail_from: str = "Attacked.ai <brief@attacked.ai>"
    internal_token: str | None = None                # API -> functions (x-internal-token)
    function_urls: str = "{}"                        # {"daily-digest": "https://fn-daily-digest-….run.app", …}
    scheduler_sa_email: str | None = None            # Cloud Scheduler's service account
    jobs_audience: str | None = None                 # this service's run.app URL (Scheduler OIDC audience)
    gcs_bucket_avatars: str | None = None
    gcs_bucket_media: str | None = None              # report heroes, incident pictures
    public_media_base: str = "https://storage.googleapis.com"
    dev_direct_signin: bool = False                  # local testing only; refused unless env=local

    model_config = SettingsConfigDict(env_file=str(API_DIR / ".env"), extra="ignore")

    @property
    def gcp(self) -> bool:
        return self.backend == "gcp"

    @property
    def secure_cookies(self) -> bool:
        return self.public_url.startswith("https://")

    @property
    def public_key(self) -> str:
        """What goes in the apikey header."""
        return self.supabase_publishable_key or self.supabase_anon_key

    @property
    def server_key(self) -> str | None:
        """The secret that bypasses RLS, if configured (new-style first)."""
        return self.supabase_secret_key or self.supabase_service_role_key

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    @property
    def subscriber_tier_set(self) -> set[str]:
        return {t.strip() for t in self.subscriber_tiers.split(",") if t.strip()}

    @property
    def ingest_table_set(self) -> set[str]:
        return {t.strip() for t in self.ingest_tables.split(",") if t.strip()}


def load_settings() -> Settings:
    s = Settings()
    if s.gcp:
        # GCP: fill the Supabase-named settings from ours; never read ../.env.
        s.supabase_url = s.data_api_url or s.supabase_url
        s.supabase_anon_key = s.anon_key or s.supabase_anon_key
        s.supabase_service_role_key = s.service_role_key or s.supabase_service_role_key
        s.supabase_jwt_secret = s.jwt_secret or s.supabase_jwt_secret
        s.supabase_publishable_key = None
        s.supabase_secret_key = None
        missing = [n for n, v in (("DATA_API_URL", s.supabase_url), ("ANON_KEY", s.supabase_anon_key),
                                  ("JWT_SECRET", s.supabase_jwt_secret), ("DATABASE_URL", s.database_url)) if not v]
        if missing:
            raise RuntimeError(f"BACKEND=gcp needs {', '.join(missing)} (Secret Manager / env)")
        if len(s.supabase_jwt_secret or "") < 32:
            raise RuntimeError("JWT_SECRET must be at least 32 characters")
        if s.env != "local" and s.dev_direct_signin:
            raise RuntimeError("DEV_DIRECT_SIGNIN is for local testing only")
    else:
        web = _web_env()
        s.supabase_url = s.supabase_url or web.get("VITE_SUPABASE_URL", "")
        s.supabase_anon_key = s.supabase_anon_key or web.get("VITE_SUPABASE_ANON_KEY", "")
        s.supabase_publishable_key = s.supabase_publishable_key or web.get("VITE_SUPABASE_PUBLISHABLE_KEY") or None
        if not s.supabase_url or not s.public_key:
            raise RuntimeError("SUPABASE_URL and a public key (SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY) are required — api/.env, or VITE_* in the repo .env")
    s.supabase_url = s.supabase_url.rstrip("/")
    return s


settings = load_settings()
