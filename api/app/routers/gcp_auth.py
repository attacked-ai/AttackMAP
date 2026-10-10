"""Sign-in on the GCP backend (mounted under /api). Replaces Supabase Auth.

  POST /api/auth/email/start   {email, meta?}   email a 6-digit code (Resend)
  POST /api/auth/email/verify  {email, code}    code -> session cookie
  GET  /api/auth/google/start  ?redirect=/?dashboard   -> Google
  GET  /api/auth/google/callback                -> session cookie -> redirect
  GET  /api/auth/me                             who is signed in, and until when
  POST /api/auth/token                          1-hour JWT for the data API
  POST /api/auth/logout        {all?}           end this (or every) session
  POST /api/auth/dev/direct    {email}          LOCAL TESTING ONLY, no code

The browser never sees a long-lived secret: the session is an HttpOnly cookie
and the JWT it exchanges for lives in memory for an hour (gcp/tokens.py).
Answers do not reveal whether an address has an account.
"""
from __future__ import annotations

import datetime as dt
import hmac
import json
import logging
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..gcp import accounts, deps, google, mailer, pg, tokens

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("uvicorn.error")
UTC = dt.timezone.utc
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# What the sign-up form may store on a new account (AuthModal meta). Anything
# else is dropped; values are short strings, or a boolean for the opt-in.
META_KEYS = {"first_name", "last_name", "full_name", "job_title", "company", "industry"}


def clean_meta(meta: dict | None) -> dict:
    out: dict = {}
    for k, v in (meta or {}).items():
        if k in META_KEYS and isinstance(v, str):
            out[k] = v.strip()[:200]
        elif k == "marketing_opt_in" and isinstance(v, bool):
            out[k] = v
    return out


def clean_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if not EMAIL_RE.match(email) or len(email) > 254:
        raise HTTPException(400, "that does not look like an email address")
    return email


def safe_redirect(target: str | None) -> str:
    """Same-site paths only: never an open redirect."""
    t = (target or "").strip()
    if not t.startswith("/") or t.startswith("//") or t.startswith("/\\") or len(t) > 300:
        return "/?dashboard"
    return t


def session_payload(s, access_token: str | None = None, expires_in: int | None = None) -> dict:
    out = {
        "user": {"id": str(s["user_id"]), "email": s["email"]},
        "session": {"method": s["method"], "created_at": s["created_at"].isoformat(),
                    "expires_at": s["expires_at"].isoformat()},
    }
    if access_token:
        out["access_token"], out["expires_in"] = access_token, expires_in
    return out


async def open_session(conn, request: Request, user_id, email: str, method: str):
    raw, s = await accounts.create_session(conn, user_id, method, request.headers.get("user-agent"), deps.client_ip(request))
    row = {**dict(s), "email": email}
    token, ttl = tokens.mint_access_token(user_id, email, s["id"], s["expires_at"].timestamp())
    return raw, row, token, ttl


# ── email code ──────────────────────────────────────────────────────────────
class StartBody(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    meta: dict | None = None


@router.post("/email/start")
async def email_start(body: StartBody, request: Request):
    email = clean_email(body.email)
    ip = deps.client_ip(request)
    p = await pg.pool()
    async with p.acquire() as conn:
        per_email = await conn.fetchval(
            "select count(*) from auth.email_codes where lower(email) = $1 and created_at > now() - interval '1 hour'", email)
        per_ip = await conn.fetchval(
            "select count(*) from auth.email_codes where ip = $1::inet and created_at > now() - interval '1 hour'", ip) if ip else 0
        if per_email >= settings.codes_per_email_hour or per_ip >= settings.codes_per_ip_hour:
            raise HTTPException(429, "Too many codes requested. Wait a few minutes, then try again.")
        code = tokens.new_code()
        async with conn.transaction():
            # Only the newest code works: older unused ones stop the moment a new one is sent.
            await conn.execute("update auth.email_codes set consumed_at = now() "
                               "where lower(email) = $1 and consumed_at is null", email)
            await conn.execute(
                "insert into auth.email_codes (email, code_hash, meta, expires_at, ip) "
                "values ($1, $2, $3::jsonb, now() + make_interval(mins => $4), $5::inet)",
                email, tokens.hash_code(email, code), json.dumps(clean_meta(body.meta)) if body.meta else None,
                settings.code_ttl_minutes, ip)
    subject, html_body, text = mailer.code_email(code)
    try:
        # Sent before answering: Cloud Run throttles CPU after the response.
        await mailer.send(email, subject, html_body, text, tags={"kind": "signin_code"})
    except mailer.MailError as e:
        log.error("sign-in code email failed: %s", e)
        raise HTTPException(502, "We could not send the code email. Try again in a minute.")
    return {"sent": True, "length": 6, "expires_in": settings.code_ttl_minutes * 60}


class VerifyBody(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    code: str = Field(min_length=1, max_length=12)


@router.post("/email/verify")
async def email_verify(body: VerifyBody, request: Request):
    email = clean_email(body.email)
    code = tokens.normalise_code(body.code)
    bad = HTTPException(400, "That code didn't match. Use the code from the newest email, or request a new one.")
    p = await pg.pool()
    async with p.acquire() as conn:
        # Decide inside the transaction, raise after it: raising inside would roll
        # back the attempts counter and make the 5-try limit guessable forever.
        matched = False
        async with conn.transaction():
            row = await conn.fetchrow(
                "select id, code_hash, attempts, meta from auth.email_codes "
                "where lower(email) = $1 and consumed_at is null and expires_at > now() "
                "order by created_at desc limit 1 for update", email)
            if row is not None and row["attempts"] < settings.code_max_attempts:
                if len(code) == 6 and hmac.compare_digest(bytes(row["code_hash"]), tokens.hash_code(email, code)):
                    await conn.execute("update auth.email_codes set consumed_at = now() where id = $1", row["id"])
                    matched = True
                else:
                    await conn.execute("update auth.email_codes set attempts = attempts + 1 where id = $1", row["id"])
        if not matched:
            raise bad
        meta = row["meta"] if isinstance(row["meta"], dict) else (json.loads(row["meta"]) if row["meta"] else None)
        try:
            user, created = await accounts.upsert_user(conn, email, provider="email", provider_id=email, meta=meta)
        except accounts.AccountError as e:
            raise HTTPException(403, str(e))
        raw, s, token, ttl = await open_session(conn, request, user["id"], email, "email")
    resp = JSONResponse({**session_payload(s, token, ttl), "created": created})
    deps.set_session_cookie(resp, raw, s["expires_at"])
    return resp


# ── Google ──────────────────────────────────────────────────────────────────
@router.get("/google/start")
async def google_start(redirect: str | None = None, login_hint: str | None = None):
    if not settings.google_client_id:
        raise HTTPException(503, "Google sign-in is not configured")
    state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    verifier, challenge = google.pkce_pair()
    p = await pg.pool()
    async with p.acquire() as conn:
        await conn.execute("delete from auth.oauth_states where created_at < now() - interval '1 hour'")
        await conn.execute("insert into auth.oauth_states (state, code_verifier, nonce, redirect_to) values ($1, $2, $3, $4)",
                           state, verifier, nonce, safe_redirect(redirect))
    hint = login_hint if login_hint and EMAIL_RE.match(login_hint) else None
    return RedirectResponse(google.authorize_url(state, nonce, challenge, hint), status_code=302)


@router.get("/google/callback")
async def google_callback(request: Request, state: str | None = None, code: str | None = None, error: str | None = None):
    def fail(reason: str) -> RedirectResponse:
        return RedirectResponse(f"/?home&signin_error={reason}", status_code=302)

    if error or not state or not code:
        return fail("cancelled" if error == "access_denied" else "google")
    p = await pg.pool()
    async with p.acquire() as conn:
        st = await conn.fetchrow("delete from auth.oauth_states where state = $1 and created_at > now() - interval '10 minutes' "
                                 "returning code_verifier, nonce, redirect_to", state)
        if st is None:
            return fail("expired")
        try:
            id_token = await google.exchange_code(code, st["code_verifier"])
            claims = await google.verify_id_token(id_token, settings.google_client_id, nonce=st["nonce"])
        except google.GoogleError as e:
            log.warning("google sign-in refused: %s", e)
            return fail("google")
        email = (claims.get("email") or "").lower()
        if not email or not claims.get("email_verified"):
            return fail("unverified")
        if settings.google_allowed_domain and claims.get("hd") != settings.google_allowed_domain:
            return fail("domain")
        try:
            user, _ = await accounts.upsert_user(
                conn, email, provider="google", provider_id=str(claims["sub"]),
                identity_data={k: claims.get(k) for k in ("name", "picture", "email", "hd") if claims.get(k)},
                meta={k: v for k, v in (("full_name", claims.get("name")), ("avatar_url", claims.get("picture"))) if v})
        except accounts.AccountError:
            return fail("suspended")
        raw, s, _, _ = await open_session(conn, request, user["id"], email, "google")
    resp = RedirectResponse(st["redirect_to"], status_code=302)
    deps.set_session_cookie(resp, raw, s["expires_at"])
    return resp


# ── session ─────────────────────────────────────────────────────────────────
@router.get("/me")
async def me(s=Depends(deps.require_session)):
    return session_payload(s)


@router.post("/token")
async def token(request: Request, s=Depends(deps.require_session)):
    deps.same_origin(request)
    tok, ttl = tokens.mint_access_token(s["user_id"], s["email"], s["id"], s["expires_at"].timestamp())
    return JSONResponse(session_payload(s, tok, ttl), headers={"Cache-Control": "no-store"})


class LogoutBody(BaseModel):
    all: bool = False


@router.post("/logout")
async def logout(request: Request, body: LogoutBody | None = None):
    deps.same_origin(request)
    s = await deps.current_session(request)
    if s is not None:
        p = await pg.pool()
        async with p.acquire() as conn:
            await accounts.revoke_session(conn, s["id"], everywhere_for=s["user_id"] if body and body.all else None)
    resp = JSONResponse({"ok": True})
    deps.clear_session_cookie(resp)
    return resp


# ── local testing only ──────────────────────────────────────────────────────
class DirectBody(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    meta: dict | None = None


@router.post("/dev/direct")
async def dev_direct(body: DirectBody, request: Request):
    """Testing mode: straight in with just the email. Refused unless ENV=local,
    DEV_DIRECT_SIGNIN=true and the call comes from this machine."""
    if not (settings.env == "local" and settings.dev_direct_signin):
        raise HTTPException(404, "not found")
    if deps.client_ip(request) not in {"127.0.0.1", "::1"}:
        raise HTTPException(403, "local only")
    deps.same_origin(request)
    email = clean_email(body.email)
    p = await pg.pool()
    async with p.acquire() as conn:
        user, created = await accounts.upsert_user(conn, email, provider="email", provider_id=email, meta=clean_meta(body.meta))
        raw, s, token, ttl = await open_session(conn, request, user["id"], email, "dev")
    resp = JSONResponse({**session_payload(s, token, ttl), "created": created})
    deps.set_session_cookie(resp, raw, s["expires_at"])
    return resp
