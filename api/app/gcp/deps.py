"""Request helpers shared by the GCP routes: the session cookie, CSRF, caller IP."""
from __future__ import annotations

import datetime as dt
import ipaddress

from fastapi import HTTPException, Request, Response

from ..config import settings
from . import accounts, pg

UTC = dt.timezone.utc


def client_ip(request: Request) -> str | None:
    """uvicorn --proxy-headers already resolved X-Forwarded-For into request.client."""
    host = request.client.host if request.client else None
    try:
        return str(ipaddress.ip_address(host)) if host else None
    except ValueError:
        return None


def same_origin(request: Request) -> None:
    """CSRF guard for cookie-authenticated writes.

    The session cookie is SameSite=Lax, so other sites cannot send it with a
    POST. On top of that every state-changing call must carry
    X-Requested-With: attacked. A cross-site page cannot add a custom header
    without a CORS preflight, and this API grants none to other origins."""
    if request.headers.get("x-requested-with", "").lower() != "attacked":
        raise HTTPException(403, "missing X-Requested-With header")
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") not in {settings.public_url.rstrip("/"), *settings.origins}:
        raise HTTPException(403, "cross-site request refused")


def set_session_cookie(response: Response, raw: str, expires_at: dt.datetime) -> None:
    max_age = max(0, int((expires_at - dt.datetime.now(UTC)).total_seconds()))
    response.set_cookie(settings.session_cookie, raw, max_age=max_age, expires=max_age, path="/",
                        secure=settings.secure_cookies, httponly=True, samesite="lax")


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(settings.session_cookie, path="/", secure=settings.secure_cookies,
                           httponly=True, samesite="lax")


async def current_session(request: Request):
    """The signed-in session for this request, or None."""
    raw = request.cookies.get(settings.session_cookie)
    if not raw:
        return None
    p = await pg.pool()
    async with p.acquire() as conn:
        return await accounts.session_from_token(conn, raw)


async def require_session(request: Request):
    s = await current_session(request)
    if s is None:
        raise HTTPException(401, "sign in required")
    return s
