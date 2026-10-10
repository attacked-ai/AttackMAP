"""Google sign-in (OpenID Connect, authorization-code flow with PKCE), and the
check for Google-signed calls from Cloud Scheduler.

Setup (deploy/gcp/README.md → Google sign-in): Google Cloud console → APIs &
Services → OAuth consent screen (External, app name, support email, privacy
policy + terms URLs on your domain), then Credentials → OAuth client ID → Web
application with the authorised redirect URI
    <PUBLIC_URL>/api/auth/google/callback
Put the client id / secret in Secret Manager (google-client-id / -secret).
GOOGLE_ALLOWED_DOMAIN=attacked.ai would limit sign-in to one Workspace domain;
leave it empty for customers' own Google accounts.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
from urllib.parse import urlencode

import anyio
import httpx
import jwt
from jwt import PyJWKClient

from ..config import settings

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = {"https://accounts.google.com", "accounts.google.com"}

_jwks = PyJWKClient(CERTS_URL, cache_keys=True, lifespan=3600, timeout=10)


class GoogleError(Exception):
    pass


def redirect_uri() -> str:
    return f"{settings.public_url.rstrip('/')}/api/auth/google/callback"


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def authorize_url(state: str, nonce: str, challenge: str, login_hint: str | None = None) -> str:
    q = {
        "client_id": settings.google_client_id, "redirect_uri": redirect_uri(), "response_type": "code",
        "scope": "openid email profile", "state": state, "nonce": nonce,
        "code_challenge": challenge, "code_challenge_method": "S256", "prompt": "select_account",
    }
    if settings.google_allowed_domain:
        q["hd"] = settings.google_allowed_domain
    if login_hint:
        q["login_hint"] = login_hint
    return f"{AUTH_URL}?{urlencode(q)}"


async def verify_id_token(token: str, audience: str, nonce: str | None = None) -> dict:
    """Signature (Google's published keys), issuer, audience, expiry, nonce."""
    try:
        # PyJWKClient fetches keys with blocking I/O: keep it off the event loop.
        key = await anyio.to_thread.run_sync(lambda: _jwks.get_signing_key_from_jwt(token).key)
        claims = jwt.decode(token, key, algorithms=["RS256"], audience=audience,
                            options={"require": ["exp", "iat", "iss", "aud", "sub"]})
    except (jwt.PyJWTError, httpx.HTTPError, OSError) as e:
        raise GoogleError(f"id token rejected ({e.__class__.__name__})") from e
    if claims.get("iss") not in ISSUERS:
        raise GoogleError("id token has the wrong issuer")
    if nonce is not None and not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
        raise GoogleError("id token nonce mismatch")
    return claims


async def exchange_code(code: str, verifier: str) -> str:
    """Code -> Google's id_token for the signing-in person (check it with verify_id_token)."""
    if not (settings.google_client_id and settings.google_client_secret):
        raise GoogleError("Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)")
    async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as c:
        r = await c.post(TOKEN_URL, data={
            "code": code, "client_id": settings.google_client_id, "client_secret": settings.google_client_secret,
            "redirect_uri": redirect_uri(), "grant_type": "authorization_code", "code_verifier": verifier,
        })
    if r.status_code != 200:
        raise GoogleError(f"Google refused the sign-in code ({r.status_code})")
    tok = r.json().get("id_token")
    if not tok:
        raise GoogleError("Google returned no id token")
    return tok


async def verify_scheduler_call(authorization: str | None, audience: str) -> dict:
    """Cloud Scheduler / Cloud Run service-to-service calls carry a Google-signed
    OIDC token for our service account. Accept only SCHEDULER_SA_EMAIL."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise GoogleError("missing bearer token")
    claims = await verify_id_token(authorization[7:].strip(), audience)
    if not settings.scheduler_sa_email or claims.get("email") != settings.scheduler_sa_email or not claims.get("email_verified"):
        raise GoogleError("caller is not the scheduler service account")
    return claims
