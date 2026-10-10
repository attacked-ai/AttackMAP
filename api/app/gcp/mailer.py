"""Email through Resend (https://resend.com): one HTTPS call per message.

Setup (deploy/gcp/README.md → Email): verify the sending domain in Resend (it
gives SPF + DKIM DNS records; add a DMARC record too), create an API key with
"Sending access" only, and put it in Secret Manager as resend-api-key.
MAIL_FROM must be an address on that verified domain.

Sends happen BEFORE the API answers. On Cloud Run the CPU is throttled once a
response is sent, so a background send can stall; a sign-in code must not.
"""
from __future__ import annotations

import asyncio
import html
import logging

import httpx

from ..config import settings

log = logging.getLogger("uvicorn.error")
RESEND_URL = "https://api.resend.com/emails"


class MailError(Exception):
    pass


async def send(to: str, subject: str, html_body: str, text: str | None = None,
               headers: dict[str, str] | None = None, idempotency_key: str | None = None,
               tags: dict[str, str] | None = None) -> str:
    """Send one message; returns Resend's message id. Retries 429 / 5xx."""
    if not settings.resend_api_key:
        raise MailError("RESEND_API_KEY is not configured")
    payload: dict = {"from": settings.mail_from, "to": [to], "subject": subject, "html": html_body}
    if text:
        payload["text"] = text
    if headers:
        payload["headers"] = headers
    if tags:
        payload["tags"] = [{"name": k, "value": v} for k, v in tags.items()]
    h = {"Authorization": f"Bearer {settings.resend_api_key}", "Content-Type": "application/json"}
    if idempotency_key:
        h["Idempotency-Key"] = idempotency_key
    delay = 0.5
    async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as c:
        for attempt in range(3):
            try:
                r = await c.post(RESEND_URL, json=payload, headers=h)
            except httpx.HTTPError as e:
                if attempt == 2:
                    raise MailError(f"mail service unreachable: {e.__class__.__name__}") from e
            else:
                if r.status_code < 300:
                    return (r.json() or {}).get("id", "")
                if r.status_code != 429 and r.status_code < 500:
                    # A 4xx other than rate limiting will not get better on retry.
                    log.error("resend refused a message (%s): %s", r.status_code, r.text[:200])
                    raise MailError(f"mail service refused the message ({r.status_code})")
            await asyncio.sleep(delay)
            delay *= 3
    raise MailError("mail service kept failing")


def code_email(code: str) -> tuple[str, str, str]:
    """Subject, HTML, text for the sign-in code. The code is not in the subject:
    subjects show on lock screens and in notification previews."""
    c = html.escape(code)
    minutes = settings.code_ttl_minutes
    body = f"""<!doctype html><html><body style="margin:0;background:#0E1116;font-family:Inter,Arial,sans-serif;color:#fff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#161616;border:1px solid #2a2a2a;border-radius:6px">
<tr><td style="padding:28px 32px 8px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#FCBD00;font-weight:700">Attacked.ai&trade; &middot; Secure sign-in</td></tr>
<tr><td style="padding:0 32px 6px;font-size:22px;font-weight:700">Your sign-in code.</td></tr>
<tr><td style="padding:0 32px 22px;font-size:14px;line-height:1.55;color:#bdbdbd">Enter this code back on Attacked.ai. It works once and expires in {minutes} minutes.</td></tr>
<tr><td align="center" style="padding:0 32px 26px"><div style="display:inline-block;padding:18px 28px;border:1px solid #3a3a3a;border-radius:6px;background:#0E1116;font-family:'JetBrains Mono','Courier New',monospace;font-size:38px;font-weight:700;letter-spacing:.32em;color:#FCBD00">{c}</div></td></tr>
<tr><td style="padding:0 32px 30px;font-size:12px;line-height:1.55;color:#7a7a7a">Didn&rsquo;t request this? Someone may have typed your address by mistake &mdash; you can ignore this email. Attacked.ai never asks for this code by phone or chat.</td></tr>
</table></td></tr></table></body></html>"""
    text = (f"Your Attacked.ai sign-in code is {code}. It works once and expires in {minutes} minutes.\n\n"
            "Didn't request this? You can ignore this email.")
    return "Your Attacked.ai sign-in code", body, text
