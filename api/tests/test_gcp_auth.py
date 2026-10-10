"""Sign-in, sessions, tokens, jobs on the GCP backend (see conftest.py)."""
from __future__ import annotations

import re
import time
from urllib.parse import parse_qs, urlparse

import jwt
import pytest

from app.config import settings

H = {"X-Requested-With": "attacked"}


def code_from(mail: dict) -> str:
    return re.search(r"\b(\d{6})\b", mail["text"]).group(1)


async def sign_in(client, email: str, meta: dict | None = None):
    r = await client.post("/api/auth/email/start", json={"email": email, "meta": meta})
    assert r.status_code == 200, r.text
    return await client.post("/api/auth/email/verify", json={"email": email, "code": code_from(client.sent[-1])})


async def test_code_is_stored_hashed_and_not_in_subject(client, admin_conn):
    r = await client.post("/api/auth/email/start", json={"email": "Hash@Example.test"})
    assert r.status_code == 200 and r.json()["length"] == 6
    mail = client.sent[-1]
    code = code_from(mail)
    assert mail["to"] == "hash@example.test"
    assert code not in mail["subject"]
    row = await admin_conn.fetchrow("select code_hash, expires_at - created_at as ttl from auth.email_codes "
                                    "where email = 'hash@example.test' order by id desc limit 1")
    assert code.encode() not in bytes(row["code_hash"])
    assert 9 * 60 <= row["ttl"].total_seconds() <= 10 * 60 + 1


async def test_sign_in_sets_httponly_session_cookie_and_1h_token(client, admin_conn):
    r = await sign_in(client, "new@example.test", {"full_name": "New Reader", "industry": "Insurance", "tier": "admin"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] is True
    cookie = r.headers["set-cookie"]
    assert cookie.startswith("__session=") and "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie
    max_age = int(re.search(r"Max-Age=(\d+)", cookie).group(1))
    days = settings.session_days
    assert days >= 30                                               # owner: at least a month
    assert days * 86400 - 60 <= max_age <= days * 86400
    claims = jwt.decode(body["access_token"], settings.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated")
    assert claims["role"] == "authenticated" and claims["sub"] == body["user"]["id"] and claims["iss"] == "attacked-api"
    assert claims["exp"] - claims["iat"] <= 3600
    meta = await admin_conn.fetchval("select raw_user_meta_data from auth.users where email = 'new@example.test'")
    assert '"tier"' not in meta and "New Reader" in meta          # sign-up form kept, unknown keys dropped
    raw = client.cookies.get("__session")
    stored = await admin_conn.fetchval("select count(*) from auth.sessions where token_hash = $1", raw.encode())
    assert stored == 0                                              # only the hash is stored


async def test_wrong_code_counts_and_locks(client):
    await client.post("/api/auth/email/start", json={"email": "lock@example.test"})
    good = code_from(client.sent[-1])
    wrong = "000000" if good != "000000" else "111111"
    for _ in range(settings.code_max_attempts):
        r = await client.post("/api/auth/email/verify", json={"email": "lock@example.test", "code": wrong})
        assert r.status_code == 400
    r = await client.post("/api/auth/email/verify", json={"email": "lock@example.test", "code": good})
    assert r.status_code == 400                                     # locked after 5 wrong tries


async def test_only_the_newest_code_works(client):
    await client.post("/api/auth/email/start", json={"email": "newest@example.test"})
    first = code_from(client.sent[-1])
    await client.post("/api/auth/email/start", json={"email": "newest@example.test"})
    second = code_from(client.sent[-1])
    if first != second:
        r = await client.post("/api/auth/email/verify", json={"email": "newest@example.test", "code": first})
        assert r.status_code == 400
    r = await client.post("/api/auth/email/verify", json={"email": "newest@example.test", "code": second})
    assert r.status_code == 200


async def test_code_missing_leading_zero_still_matches(client, admin_conn, monkeypatch):
    from app.gcp import tokens
    monkeypatch.setattr(tokens, "new_code", lambda: "012345")
    await client.post("/api/auth/email/start", json={"email": "zero@example.test"})
    r = await client.post("/api/auth/email/verify", json={"email": "zero@example.test", "code": "12345"})
    assert r.status_code == 200


async def test_rate_limit_per_address(client):
    codes = []
    for _ in range(settings.codes_per_email_hour):
        r = await client.post("/api/auth/email/start", json={"email": "flood@example.test"})
        codes.append(r.status_code)
    assert codes == [200] * settings.codes_per_email_hour
    r = await client.post("/api/auth/email/start", json={"email": "flood@example.test"})
    assert r.status_code == 429


async def test_me_token_logout(client, admin_conn):
    r = await sign_in(client, "session@example.test")
    assert r.status_code == 200
    me = await client.get("/api/auth/me")
    assert me.status_code == 200 and me.json()["user"]["email"] == "session@example.test"
    assert (await client.post("/api/auth/token")).status_code == 403          # no CSRF header
    t = await client.post("/api/auth/token", headers=H)
    assert t.status_code == 200 and t.headers["cache-control"] == "no-store"
    bad_origin = await client.post("/api/auth/token", headers={**H, "Origin": "https://evil.test"})
    assert bad_origin.status_code == 403
    out = await client.post("/api/auth/logout", headers=H, json={})
    assert out.status_code == 200 and "__session=" in out.headers["set-cookie"]
    assert (await client.get("/api/auth/me")).status_code == 401
    revoked = await admin_conn.fetchval("select count(*) from auth.sessions s join auth.users u on u.id = s.user_id "
                                        "where u.email = 'session@example.test' and s.revoked_at is not null")
    assert revoked == 1


async def test_expired_session_is_refused(client, admin_conn):
    await sign_in(client, "expired@example.test")
    await admin_conn.execute("update auth.sessions set expires_at = now() - interval '1 second' "
                             "where user_id = (select id from auth.users where email = 'expired@example.test')")
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_access_token_never_outlives_session(client, admin_conn):
    await sign_in(client, "short@example.test")
    await admin_conn.execute("update auth.sessions set expires_at = now() + interval '10 minutes' "
                             "where user_id = (select id from auth.users where email = 'short@example.test')")
    t = (await client.post("/api/auth/token", headers=H)).json()
    assert t["expires_in"] <= 600


async def test_google_start_uses_pkce_and_state(client, admin_conn):
    r = await client.get("/api/auth/google/start", params={"redirect": "//evil.test/x"}, follow_redirects=False)
    assert r.status_code == 302
    u = urlparse(r.headers["location"])
    q = parse_qs(u.query)
    assert u.netloc == "accounts.google.com" and q["code_challenge_method"] == ["S256"] and q["client_id"] == [settings.google_client_id]
    assert q["redirect_uri"] == ["http://localhost:5173/api/auth/google/callback"]
    st = await admin_conn.fetchrow("select redirect_to, nonce from auth.oauth_states where state = $1", q["state"][0])
    assert st["redirect_to"] == "/?dashboard"                        # open redirect refused
    assert q["nonce"] == [st["nonce"]]


async def test_google_callback_links_existing_email_account(client, admin_conn, monkeypatch):
    from app.gcp import google
    await sign_in(client, "linked@example.test")
    client.cookies.clear()
    r = await client.get("/api/auth/google/start", params={"redirect": "/?hub"}, follow_redirects=False)
    q = parse_qs(urlparse(r.headers["location"]).query)
    state, nonce = q["state"][0], q["nonce"][0]

    async def fake_exchange(code, verifier):
        assert code == "abc" and verifier
        return "id-token"

    async def fake_verify(token, audience, nonce=None):
        assert audience == settings.google_client_id and nonce == q["nonce"][0]
        return {"sub": "google-sub-1", "email": "Linked@Example.test", "email_verified": True, "name": "Linked Person"}

    monkeypatch.setattr(google, "exchange_code", fake_exchange)
    monkeypatch.setattr(google, "verify_id_token", fake_verify)
    cb = await client.get("/api/auth/google/callback", params={"state": state, "code": "abc"}, follow_redirects=False)
    assert cb.status_code == 302 and cb.headers["location"] == "/?hub"
    assert "__session=" in cb.headers["set-cookie"]
    n_users = await admin_conn.fetchval("select count(*) from auth.users where lower(email) = 'linked@example.test'")
    providers = await admin_conn.fetch("select provider from auth.identities i join auth.users u on u.id = i.user_id "
                                       "where u.email = 'linked@example.test' order by provider")
    assert n_users == 1 and [p["provider"] for p in providers] == ["email", "google"]
    replay = await client.get("/api/auth/google/callback", params={"state": state, "code": "abc"}, follow_redirects=False)
    assert "signin_error=expired" in replay.headers["location"]          # state is single use


async def test_google_unverified_email_refused(client, monkeypatch):
    from app.gcp import google
    r = await client.get("/api/auth/google/start", follow_redirects=False)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]

    async def fake_exchange(code, verifier):
        return "id-token"

    async def fake_verify(token, audience, nonce=None):
        return {"sub": "g2", "email": "x@example.test", "email_verified": False}

    monkeypatch.setattr(google, "exchange_code", fake_exchange)
    monkeypatch.setattr(google, "verify_id_token", fake_verify)
    cb = await client.get("/api/auth/google/callback", params={"state": state, "code": "c"}, follow_redirects=False)
    assert "signin_error=unverified" in cb.headers["location"]


async def test_dev_direct_needs_local_and_header(client):
    assert (await client.post("/api/auth/dev/direct", json={"email": "dev@example.test"})).status_code == 403
    r = await client.post("/api/auth/dev/direct", json={"email": "dev@example.test"}, headers=H)
    assert r.status_code == 200 and r.json()["session"]["method"] == "dev"


async def test_outbox_drains_to_functions_and_backs_off(client, admin_conn, monkeypatch):
    from app.routers import gcp_jobs
    await admin_conn.execute("select net.http_post(url := 'https://old.supabase.co/functions/v1/welcome-email', "
                             "body := '{\"user_id\": \"u1\"}'::jsonb)")
    await admin_conn.execute("select net.http_post(url := 'https://old.supabase.co/functions/v1/welcome-email', "
                             "body := '{\"user_id\": \"fail\"}'::jsonb)")
    calls = []

    async def fake_call(name, method="POST", body=None, params=None, timeout_s=120):
        calls.append((name, body))
        return (500, "boom") if body.get("user_id") == "fail" else (200, "ok")

    monkeypatch.setattr(gcp_jobs, "call_function", fake_call)
    assert (await client.post("/api/jobs/outbox")).status_code == 401              # no credentials
    r = await client.post("/api/jobs/outbox", headers={"x-internal-token": "internal-test-token"})
    assert r.status_code == 200 and r.json() == {"claimed": 2, "sent": 1, "failed": 1}
    assert sorted(c[1]["user_id"] for c in calls) == ["fail", "u1"]
    failed = await admin_conn.fetchrow("select done_at, last_status, next_attempt_at > now() + interval '1 minute' as later "
                                       "from outbox.requests where body->>'user_id' = 'fail'")
    assert failed["done_at"] is None and failed["last_status"] == 500 and failed["later"]
    again = await client.post("/api/jobs/outbox", headers={"x-internal-token": "internal-test-token"})
    assert again.json()["claimed"] == 0                                            # not retried before its backoff


async def test_cleanup_job(client):
    r = await client.post("/api/jobs/cleanup", headers={"x-internal-token": "internal-test-token"})
    assert r.status_code == 200


async def test_decode_token_rejects_foreign_issuer_and_expired():
    from fastapi import HTTPException
    from app.auth import decode_token
    now = int(time.time())
    foreign = jwt.encode({"sub": "x", "aud": "authenticated", "exp": now + 60, "iss": "someone-else"},
                         settings.supabase_jwt_secret, algorithm="HS256")
    expired = jwt.encode({"sub": "x", "aud": "authenticated", "exp": now - 60, "iss": "attacked-api"},
                         settings.supabase_jwt_secret, algorithm="HS256")
    for tok in (foreign, expired):
        with pytest.raises(HTTPException):
            await decode_token(tok)


async def test_health_reveals_no_config(client):
    r = await client.get("/api/health")
    assert r.json() == {"ok": True, "backend": "gcp"}
