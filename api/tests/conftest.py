"""Tests for the GCP backend, against a real PostgreSQL 17.

  TEST_PG_ADMIN_DSN=postgresql://postgres@127.0.0.1:54329/postgres  (default)
  cd api && python -m pytest -q

Each run creates a fresh database, applies deploy/gcp/db/01_supabase_compat.sql
and connects the API as attacked_api, exactly as on Cloud SQL. Mail and Google
are faked; nothing leaves the machine.
"""
from __future__ import annotations

import asyncio
import os
import pathlib

import pytest

ADMIN_DSN = os.environ.get("TEST_PG_ADMIN_DSN", "postgresql://postgres@127.0.0.1:54329/postgres")
DB = "attacked_apitest"
ROOT = pathlib.Path(__file__).resolve().parents[2]

os.environ.update({
    "BACKEND": "gcp", "ENV": "local", "PUBLIC_URL": "http://localhost:5173",
    "DATA_API_URL": "http://127.0.0.1:9", "ANON_KEY": "test-anon",
    "JWT_SECRET": "test-secret-test-secret-test-secret-0123456789",
    "DATABASE_URL": ADMIN_DSN.rsplit("/", 1)[0].replace("postgres@", "attacked_api@") + f"/{DB}",
    "RESEND_API_KEY": "re_test", "GOOGLE_CLIENT_ID": "cid.apps.googleusercontent.com", "GOOGLE_CLIENT_SECRET": "csecret",
    "DEV_DIRECT_SIGNIN": "true", "INTERNAL_TOKEN": "internal-test-token",
    "FUNCTION_URLS": '{"welcome-email": "http://fn.test/welcome-email"}',
})


def _setup_db() -> None:
    import asyncpg

    async def go():
        a = await asyncpg.connect(ADMIN_DSN)
        await a.execute(f"drop database if exists {DB} with (force)")
        await a.execute(f"create database {DB}")
        await a.close()
        c = await asyncpg.connect(ADMIN_DSN.rsplit("/", 1)[0] + f"/{DB}")
        await c.execute((ROOT / "deploy/gcp/db/01_supabase_compat.sql").read_text(encoding="utf-8"))
        await c.close()
    asyncio.run(go())


def pytest_sessionstart(session):
    try:
        _setup_db()
    except OSError as e:
        pytest.exit(f"PostgreSQL not reachable at {ADMIN_DSN}: {e}", returncode=1)


@pytest.fixture
async def admin_conn():
    import asyncpg
    c = await asyncpg.connect(ADMIN_DSN.rsplit("/", 1)[0] + f"/{DB}")
    yield c
    await c.close()


@pytest.fixture
async def client(monkeypatch):
    import httpx
    from app.main import app
    from app.gcp import mailer, pg

    sent: list[dict] = []

    async def fake_send(to, subject, html_body, text=None, **kw):
        sent.append({"to": to, "subject": subject, "html": html_body, "text": text})
        return "msg_test"

    monkeypatch.setattr(mailer, "send", fake_send)
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost:5173") as c:
        c.sent = sent
        yield c
    await pg.close()
