"""Scheduled work on the GCP backend (mounted under /api/jobs). Cloud Scheduler
calls these with a Google-signed OIDC token for its service account
(deploy/gcp/setup.sh creates the jobs); an operator can call them by hand with
the x-internal-token header.

  POST /api/jobs/outbox        every minute: send the HTTP calls the database
                               queued (net.http_post from triggers and pg_cron;
                               deploy/gcp/db/01_supabase_compat.sql)
  POST /api/jobs/run/{name}    run one function now (incident-deliver every
                               30 min, daily-digest 08:00 UTC, incident-images)
  POST /api/jobs/cleanup       daily: drop expired sessions, codes, round trips

The functions are private Cloud Run services (deploy/gcp/functions): only this
API's service account may invoke them. Each call carries a Google ID token for
the target (Cloud Run checks it) and x-internal-token (the function checks it).
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import re
import time

import httpx
from fastapi import APIRouter, HTTPException, Request

from ..config import settings
from ..gcp import google, pg

router = APIRouter(prefix="/jobs", tags=["jobs"])
log = logging.getLogger("uvicorn.error")
FN_RE = re.compile(r"/functions/v1/([A-Za-z0-9_-]+)")
METADATA_ID_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
_id_tokens: dict[str, tuple[str, float]] = {}


async def jobs_caller(request: Request) -> str:
    tok = request.headers.get("x-internal-token")
    if tok and settings.internal_token and hmac.compare_digest(tok.encode(), settings.internal_token.encode()):
        return "operator"
    if not settings.jobs_audience:
        raise HTTPException(401, "jobs need JOBS_AUDIENCE (or x-internal-token)")
    try:
        claims = await google.verify_scheduler_call(request.headers.get("authorization"), settings.jobs_audience)
    except google.GoogleError:
        raise HTTPException(401, "not a scheduler call")
    return claims["email"]


def function_urls() -> dict[str, str]:
    try:
        return {k: v.rstrip("/") for k, v in json.loads(settings.function_urls or "{}").items()}
    except ValueError:
        log.error("FUNCTION_URLS is not valid JSON")
        return {}


async def id_token_for(audience: str) -> str | None:
    """Google ID token for calling a private Cloud Run service. None off GCP."""
    hit = _id_tokens.get(audience)
    if hit and hit[1] > time.time() + 60:
        return hit[0]
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(METADATA_ID_URL, params={"audience": audience, "format": "full"},
                            headers={"Metadata-Flavor": "Google"})
        if r.status_code != 200:
            return None
    except httpx.HTTPError:
        return None
    _id_tokens[audience] = (r.text, time.time() + 50 * 60)
    return r.text


async def call_function(name: str, method: str = "POST", body=None, params: dict | None = None,
                        timeout_s: float = 120) -> tuple[int, str]:
    base = function_urls().get(name)
    if not base:
        return 0, f"no FUNCTION_URLS entry for {name}"
    headers = {"Content-Type": "application/json"}
    if settings.internal_token:
        headers["x-internal-token"] = settings.internal_token
    idt = await id_token_for(base)
    if idt:
        headers["Authorization"] = f"Bearer {idt}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_s, connect=10)) as c:
            r = await c.request(method, base, json=body if method != "GET" else None, params=params or None, headers=headers)
        return r.status_code, r.text[:500]
    except httpx.HTTPError as e:
        return 0, e.__class__.__name__


@router.post("/outbox")
async def drain_outbox(request: Request):
    await jobs_caller(request)
    p = await pg.pool()
    async with p.acquire() as conn:
        # Lease up to 25 due requests for 5 minutes; a crashed run frees them.
        rows = await conn.fetch(
            "update outbox.requests set attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes' "
            "where id in (select id from outbox.requests where done_at is null and next_attempt_at <= now() "
            "             and attempts < 6 order by id limit 25 for update skip locked) "
            "returning id, method, url, body, params, timeout_ms, attempts")
    sem = asyncio.Semaphore(5)

    async def one(row):
        m = FN_RE.search(row["url"])
        async with sem:
            if not m:
                status, detail = 0, "only /functions/v1/<name> targets are routed"
            else:
                body = json.loads(row["body"]) if isinstance(row["body"], str) else row["body"]
                params = json.loads(row["params"]) if isinstance(row["params"], str) else row["params"]
                status, detail = await call_function(m.group(1), row["method"], body, params,
                                                     timeout_s=max(5, min((row["timeout_ms"] or 5000) / 1000 * 4, 120)))
        async with p.acquire() as conn:
            if 200 <= status < 300:
                await conn.execute("update outbox.requests set done_at = now(), last_status = $2, last_error = null where id = $1",
                                   row["id"], status)
            else:
                # 2, 4, 8, 16, 32 minutes, then it stays for a person to look at.
                await conn.execute("update outbox.requests set last_status = $2, last_error = $3, "
                                   "next_attempt_at = now() + make_interval(mins => power(2, $4)::int) where id = $1",
                                   row["id"], status or None, detail[:500], row["attempts"])
                log.warning("outbox %s -> %s failed (%s): %s", row["id"], row["url"], status, detail[:120])
        return 200 <= status < 300

    results = await asyncio.gather(*(one(r) for r in rows))
    return {"claimed": len(rows), "sent": sum(results), "failed": len(rows) - sum(results)}


@router.post("/run/{name}")
async def run_function(name: str, request: Request):
    who = await jobs_caller(request)
    if name not in function_urls():
        raise HTTPException(404, "unknown function")
    try:
        body = await request.json()
    except ValueError:
        body = {}
    status, detail = await call_function(name, "POST", body or {}, timeout_s=600)
    log.info("job run %s by %s -> %s", name, who, status)
    if not 200 <= status < 300:
        raise HTTPException(502, f"{name} failed ({status})")
    return {"function": name, "status": status}


@router.post("/cleanup")
async def cleanup(request: Request):
    await jobs_caller(request)
    p = await pg.pool()
    async with p.acquire() as conn:
        s = await conn.execute("delete from auth.sessions where expires_at < now() - interval '30 days' "
                               "or revoked_at < now() - interval '30 days'")
        c = await conn.execute("delete from auth.email_codes where created_at < now() - interval '1 day'")
        o = await conn.execute("delete from auth.oauth_states where created_at < now() - interval '1 hour'")
        q = await conn.execute("delete from outbox.requests where done_at < now() - interval '30 days'")
    return {"sessions": s, "codes": c, "oauth_states": o, "outbox": q}
