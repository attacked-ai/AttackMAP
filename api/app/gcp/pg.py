"""Cloud SQL connection pool (asyncpg), for the tables only the API touches:
auth.* (accounts, sessions, codes, Google round trips) and outbox.requests.
App data still goes through PostgREST so row-level security applies to it.

DATABASE_URL on Cloud Run uses the Cloud SQL Unix socket that
`--add-cloudsql-instances` mounts; no public IP, no proxy:
  postgresql://attacked_api:<password>@/attacked?host=/cloudsql/<project>:<region>:<instance>
Locally: postgresql://attacked_api:<password>@127.0.0.1:5432/attacked
"""
from __future__ import annotations

import asyncpg

from ..config import settings

_pool: asyncpg.Pool | None = None


async def pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        # Small pool: Cloud Run adds containers under load, and Cloud SQL's
        # connection limit is shared by all of them and by PostgREST.
        _pool = await asyncpg.create_pool(settings.database_url, min_size=0, max_size=5,
                                          command_timeout=10, max_inactive_connection_lifetime=300)
    return _pool


async def close() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
