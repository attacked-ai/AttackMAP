"""Secrets in transit: session tokens, sign-in codes, and the data-API JWT.

How a sign-in is held (the answer to "cookies, JWT, how long"):

  __session cookie   a random 256-bit token. HttpOnly (page scripts cannot read
                     it), Secure, SameSite=Lax, Path=/. Only its SHA-256 is stored
                     (auth.sessions.token_hash), so a database leak does not leak
                     sign-ins. It expires SESSION_DAYS (30) after sign-in, ABSOLUTE:
                     using the site does not extend it. Sign-out revokes it.
  access token       a JWT (HS256, JWT_SECRET shared with PostgREST) that lives
                     ACCESS_TOKEN_TTL (1 hour). The page keeps it in memory only and
                     asks POST /api/auth/token for a fresh one with the cookie.
                     PostgREST verifies it and runs the query as role
                     "authenticated" with auth.uid() = sub, so row-level security
                     works exactly as on Supabase. It never outlives the session.
  sign-in code       6 digits, 10 minutes, 5 tries, single use. Stored as an
                     HMAC-SHA256 keyed with JWT_SECRET, never in the clear.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
import uuid

import jwt

from ..config import settings

ISSUER = "attacked-api"


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_session_token(raw: str) -> bytes:
    return hashlib.sha256(raw.encode("utf-8")).digest()


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def normalise_code(raw: str) -> str:
    """Digits only; a code that lost its leading zero in a mail client still matches."""
    d = "".join(ch for ch in str(raw or "") if ch.isdigit())
    return d.zfill(6) if 0 < len(d) < 6 else d


def hash_code(email: str, code: str) -> bytes:
    key = (settings.supabase_jwt_secret or "").encode("utf-8")
    return hmac.new(key, f"{email.lower()}:{code}".encode("utf-8"), hashlib.sha256).digest()


def mint_access_token(user_id: uuid.UUID | str, email: str | None, session_id: uuid.UUID | str,
                      session_expires_at: float) -> tuple[str, int]:
    """A PostgREST-ready JWT for this reader; never valid past the session's end."""
    now = int(time.time())
    exp = min(now + settings.access_token_ttl, int(session_expires_at))
    claims = {
        "iss": ISSUER, "aud": "authenticated", "role": "authenticated",
        "sub": str(user_id), "email": email, "session_id": str(session_id),
        "iat": now, "exp": exp,
    }
    return jwt.encode(claims, settings.supabase_jwt_secret, algorithm="HS256"), exp - now


def mint_role_key(role: str, years: int = 5) -> str:
    """The long-lived anon / service_role keys (deploy/gcp/setup.sh stores them in
    Secret Manager). anon is public by design, like Supabase's anon key;
    service_role bypasses row-level security and must stay server-side."""
    now = int(time.time())
    return jwt.encode({"iss": ISSUER, "role": role, "iat": now, "exp": now + years * 365 * 86400},
                      settings.supabase_jwt_secret, algorithm="HS256")
