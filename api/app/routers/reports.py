"""GET /reports/{ref} — a baked full report with the lock applied SERVER-SIDE.

The 310 reports are static HTML (public/reports/<ref>.html). Today the
browser fetches the file and hides three sections with CSS, which anyone can
undo. Here the lock happens before the bytes leave the server: for a reader
who is not a subscriber, the body of "Who else is exposed" (#r-blast),
"GUARD controls against the scenario" (#r-ctrl) and "Vendor intelligence"
(#r-vend) is replaced by a locked block with a Subscribe link. Subscribers
get the file untouched. Anonymous readers count as free.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse

from ..auth import User, optional_user
from ..config import settings

router = APIRouter(prefix="/reports", tags=["reports"])

LOCKED = ("r-blast", "r-ctrl", "r-vend")
REF_OK = re.compile(r"^[A-Za-z0-9._-]{3,64}$")

LOCK_BLOCK = """
<div class="dash-lock-server" style="margin:18px 0 8px;padding:22px 20px;border:1px solid #FCBD00;border-radius:12px;background:#0f0f0f;color:#fff;font:14px/1.5 Inter,system-ui,sans-serif">
  <div style="font-weight:700;color:#FCBD00;letter-spacing:.08em;text-transform:uppercase;font-size:11px;margin-bottom:6px">Subscriber layer</div>
  <div style="font-size:15px;font-weight:600;margin-bottom:12px">Who it reaches, and what to do about it.</div>
  <a href="/?subscribe" style="display:inline-block;background:#FCBD00;color:#0f0f0f;text-decoration:none;font-weight:800;font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding:10px 16px;border-radius:8px">Subscribe →</a>
</div>
"""


def lock_sections(html: str) -> str:
    """Keep each locked section's title; replace the rest of it with the lock block."""
    for sid in LOCKED:
        m = re.search(rf'<section[^>]*\bid="{sid}"[^>]*>', html)
        if not m:
            continue
        start = m.end()
        end = html.find("</section>", start)
        if end < 0:
            continue
        inner = html[start:end]
        title = re.search(r"<h2[^>]*>.*?</h2>", inner, flags=re.S)
        keep = title.group(0) if title else ""
        # data-locked tells the browser-side lock (src/lib/reportLock.js) to leave
        # this section alone, so a free reader never sees a lock on a lock.
        open_tag = m.group(0)[:-1] + ' data-locked="server">'
        html = html[:m.start()] + open_tag + keep + LOCK_BLOCK + html[end:]
    return html


@router.get("/manifest.json")
async def manifest():
    """incident id -> report ref (public; no report content). On GCP the report
    files live in a private bucket mounted at REPORTS_DIR, so the site reads the
    manifest here instead of from its own static files."""
    path = Path(settings.reports_dir) / "manifest.json"
    if not path.is_file():
        raise HTTPException(404, "no manifest")
    return JSONResponse(json.loads(path.read_text(encoding="utf-8")),
                        headers={"Cache-Control": "public, max-age=3600"})


@router.get("/{ref}", response_class=HTMLResponse)
async def report(ref: str, user: User | None = Depends(optional_user)):
    if not REF_OK.match(ref):
        raise HTTPException(400, "bad report reference")
    path = Path(settings.reports_dir) / f"{ref}.html"
    if not path.is_file():
        raise HTTPException(404, "no such report")
    html = path.read_text(encoding="utf-8", errors="replace")
    if user and user.subscriber:
        return HTMLResponse(html)
    return HTMLResponse(lock_sections(html), headers={"Cache-Control": "private, no-store"})
