"""Who is asking.

Supabase backend: Supabase Auth issues the tokens. The browser sends the
session's access token as `Authorization: Bearer <jwt>`; we verify it against
the project's published signing keys (ES256 JWKS at
/auth/v1/.well-known/jwks.json, no shared secret).

GCP backend: this API issues the tokens (gcp/tokens.py, HS256 with JWT_SECRET,
issuer "attacked-api"). A request is signed in by that bearer token OR by the
HttpOnly __session cookie.

Either way the tier and industry come from profiles, read as the reader.

Dependencies:
  current_user   → 401 unless signed in
  optional_user  → None for anonymous readers (the report route uses this)
  subscriber     → 403 unless tier is in SUBSCRIBER_TIERS
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import anyio
import httpx
import jwt
from fastapi import Depends, HTTPException, Request
from jwt import PyJWKClient

from .config import settings
from . import db

_jwks_client: PyJWKClient | None = None


def _jwks() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json", cache_keys=True, lifespan=600, timeout=10)
    return _jwks_client


@dataclass
class User:
    id: str
    email: str | None
    tier: str
    industry: str | None
    full_name: str | None
    company: str | None
    role: str | None
    token: str

    @property
    def subscriber(self) -> bool:
        return self.tier in settings.subscriber_tier_set


REQUIRED = {"require": ["exp", "sub", "aud"]}


async def decode_token(token: str) -> dict:
    """Verify signature, audience, expiry (and issuer on GCP); return the claims."""
    try:
        alg = jwt.get_unverified_header(token).get("alg", "")
        if alg == "HS256":
            if not settings.supabase_jwt_secret:
                raise HTTPException(401, "invalid token")
            if settings.gcp:
                from .gcp.tokens import ISSUER
                return jwt.decode(token, settings.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated",
                                  issuer=ISSUER, options=REQUIRED)
            return jwt.decode(token, settings.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated", options=REQUIRED)
        if settings.gcp:
            raise HTTPException(401, "invalid token")
        # PyJWKClient fetches keys with blocking I/O: keep it off the event loop,
        # or one slow key fetch (or a flood of unknown key ids) stalls every request.
        key = await anyio.to_thread.run_sync(lambda: _jwks().get_signing_key_from_jwt(token).key)
        return jwt.decode(token, key, algorithms=["ES256", "RS256"], audience="authenticated", options=REQUIRED)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "session expired — sign in again")
    except (jwt.PyJWTError, httpx.HTTPError, OSError):
        raise HTTPException(401, "invalid token")


def _bearer(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    return h[7:].strip() if h.lower().startswith("bearer ") and len(h) > 7 else None


async def _user_from_token(token: str) -> User:
    claims = await decode_token(token)
    uid = claims.get("sub")
    if not uid:
        raise HTTPException(401, "token has no subject")
    profile = await db.get_profile(uid, token) or {}
    return User(
        id=uid, email=claims.get("email") or profile.get("email"),
        tier=profile.get("tier") or "free", industry=profile.get("industry"),
        full_name=profile.get("full_name"), company=profile.get("company"), role=profile.get("role"),
        token=token,
    )


async def _token_from_cookie(request: Request) -> str | None:
    """GCP: the __session cookie stands in for a bearer token."""
    if not settings.gcp:
        return None
    from .gcp import deps, tokens
    s = await deps.current_session(request)
    if s is None:
        return None
    tok, _ = tokens.mint_access_token(s["user_id"], s["email"], s["id"], s["expires_at"].timestamp())
    return tok


async def current_user(request: Request) -> User:
    token = _bearer(request) or await _token_from_cookie(request)
    if not token:
        raise HTTPException(401, "sign in required")
    return await _user_from_token(token)


async def optional_user(request: Request) -> User | None:
    token = _bearer(request) or await _token_from_cookie(request)
    if not token:
        return None
    try:
        return await _user_from_token(token)
    except HTTPException:
        return None


async def subscriber(user: User = Depends(current_user)) -> User:
    if not user.subscriber:
        raise HTTPException(403, "subscriber layer — subscribe to open it")
    return user


def now() -> int:
    return int(time.time())
