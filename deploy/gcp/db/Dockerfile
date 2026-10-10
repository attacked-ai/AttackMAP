# attacked-migrate: the one-time Supabase -> Cloud SQL move, as a Cloud Run job
# (deploy/gcp/setup.sh step "migrate"). PostgreSQL 17 client tools, because
# pg_dump must be at least the source server's version (Supabase runs 17.6).
FROM postgres:17-bookworm
WORKDIR /migrate
COPY 01_supabase_compat.sql 02_after_restore.sql migrate.sh ./
RUN chmod +x migrate.sh
ENTRYPOINT ["bash", "/migrate/migrate.sh"]
