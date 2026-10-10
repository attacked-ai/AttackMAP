# attacked-data: the data API on Cloud Run. PostgREST (the same open-source
# engine Supabase runs) in front of Cloud SQL, behind a small nginx that keeps
# Supabase's URL shape, so the site's existing data calls work unchanged:
#   /rest/v1/<table|rpc>                 -> PostgREST
#   /storage/v1/object/public/<b>/<path> -> 302 to the Cloud Storage object
# Firebase Hosting forwards /rest/v1/** and /storage/v1/** here.
#
# Config is all env (setup.sh): PGRST_DB_URI and PGRST_JWT_SECRET from Secret
# Manager, the rest below. The container stops if either process dies, so
# Cloud Run replaces it.
FROM postgrest/postgrest:v12.2.12 AS postgrest

FROM nginx:1.27-alpine
COPY --from=postgrest /bin/postgrest /usr/local/bin/postgrest
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=8080 \
    PGRST_SERVER_HOST=127.0.0.1 \
    PGRST_SERVER_PORT=3000 \
    PGRST_DB_SCHEMAS=public \
    PGRST_DB_EXTRA_SEARCH_PATH=public,extensions \
    PGRST_DB_ANON_ROLE=anon \
    PGRST_DB_MAX_ROWS=1000 \
    PGRST_DB_POOL=10 \
    PGRST_OPENAPI_MODE=disabled \
    PGRST_LOG_LEVEL=warn \
    PUBLIC_MEDIA_BASE=https://storage.googleapis.com \
    GCS_BUCKET_PREFIX=

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
