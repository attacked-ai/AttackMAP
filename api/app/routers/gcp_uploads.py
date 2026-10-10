"""Uploads on the GCP backend (mounted under /api): pictures go to Cloud
Storage, never through PostgREST.

  POST /api/me/avatar      multipart "file"   the reader's own profile picture
  POST /api/admin/media    multipart "file", "kind" (report|incident), "ref"
                                              admin-only: report heroes, incident pictures

Buckets (deploy/gcp/setup.sh): <project>-avatars and <project>-media, both
public-read with uniform access; the API's service account is the only writer.
The stored URL is the public object URL, cache-busted with ?t= so a new picture
shows at once.
"""
from __future__ import annotations

import re
import time

import anyio
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile

from .. import db
from ..config import settings
from ..gcp import deps, tokens

router = APIRouter(tags=["uploads"])

TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
MAX_BYTES = 5 * 1024 * 1024
REF_OK = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


def _bucket_name(kind: str) -> str:
    name = settings.gcs_bucket_avatars if kind == "avatars" else settings.gcs_bucket_media
    if not name:
        raise HTTPException(503, f"no Cloud Storage bucket configured for {kind}")
    return name


def _upload(bucket: str, path: str, data: bytes, content_type: str, cache: str) -> None:
    from google.cloud import storage  # imported lazily: only the GCP backend needs it
    blob = storage.Client().bucket(bucket).blob(path)
    blob.cache_control = cache
    blob.upload_from_string(data, content_type=content_type)


async def _read_image(file: UploadFile) -> tuple[bytes, str]:
    ctype = (file.content_type or "").lower()
    if ctype not in TYPES:
        raise HTTPException(400, "Please choose a PNG, JPEG, WebP or GIF image.")
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(400, "Image must be under 5 MB.")
    return data, TYPES[ctype]


def _reader_token(s) -> str:
    tok, _ = tokens.mint_access_token(s["user_id"], s["email"], s["id"], s["expires_at"].timestamp())
    return tok


@router.post("/me/avatar")
async def upload_avatar(request: Request, file: UploadFile = File(...), s=Depends(deps.require_session)):
    deps.same_origin(request)
    data, ext = await _read_image(file)
    bucket = _bucket_name("avatars")
    path = f"{s['user_id']}.{ext}"
    await anyio.to_thread.run_sync(_upload, bucket, path, data, file.content_type, "public, max-age=3600")
    url = f"{settings.public_media_base.rstrip('/')}/{bucket}/{path}?t={int(time.time())}"
    # Saved AS THE READER through PostgREST, so the own-row policy applies.
    r = await db.client().patch(f"{db.REST}/profiles", params={"id": f"eq.{s['user_id']}"}, json={"avatar_url": url},
                                headers={**db._auth(as_server=False, user_token=_reader_token(s)),
                                         "Content-Type": "application/json", "Prefer": "return=minimal"})
    if r.status_code >= 400:
        raise HTTPException(502, "the picture uploaded but the profile could not be updated")
    return {"url": url}


@router.post("/admin/media")
async def upload_media(request: Request, file: UploadFile = File(...), kind: str = Form(...), ref: str = Form(...),
                       s=Depends(deps.require_session)):
    deps.same_origin(request)
    if not await db.rpc("_is_admin", {}, _reader_token(s)):
        raise HTTPException(403, "admin only")
    if kind not in {"report", "incident"} or not REF_OK.match(ref):
        raise HTTPException(400, "bad kind or ref")
    data, ext = await _read_image(file)
    bucket = _bucket_name("media")
    path = f"reports/{ref}.{ext}" if kind == "report" else f"incident-{ref}-{int(time.time())}.{ext}"
    await anyio.to_thread.run_sync(_upload, bucket, path, data, file.content_type, "public, max-age=31536000")
    return {"url": f"{settings.public_media_base.rstrip('/')}/{bucket}/{path}"}
