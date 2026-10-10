# Attacked.ai edge functions on Cloud Run: ONE image, one Cloud Run service per
# function. ENV FUNCTION picks which supabase/functions/<name>/index.ts runs
# (daily-digest, incident-deliver, incident-images, incident-report, welcome-email).
#
# Build context = supabase/functions (the way api/ is the API's context):
#   docker build -f deploy/gcp/functions/Dockerfile -t "$IMAGE" supabase/functions
#   docker run --rm -p 8000:8000 -e FUNCTION=incident-report --env-file fn.env "$IMAGE"
#
# The code is the Supabase edge-function code, unchanged in how it reads data: it
# calls SUPABASE_URL/rest/v1 (our PostgREST on GCP) with the service_role JWT in
# SUPABASE_SERVICE_ROLE_KEY. Each function's env, secrets and trigger:
# deploy/gcp/functions/README.md. Nothing secret is baked into the image.
FROM denoland/deno:alpine-2.1.4

WORKDIR /app

# Only the live functions and their shared helpers. notify-application and
# guard-ingest are retired; *.BACKUP* and deployed.index.ts are reference copies.
COPY _shared/                  /app/functions/_shared/
COPY daily-digest/index.ts     /app/functions/daily-digest/index.ts
COPY incident-deliver/index.ts /app/functions/incident-deliver/index.ts
COPY incident-images/index.ts  /app/functions/incident-images/index.ts
COPY incident-report/index.ts  /app/functions/incident-report/index.ts
COPY welcome-email/index.ts    /app/functions/welcome-email/index.ts

# Run as the image's unprivileged `deno` user, which owns DENO_DIR (/deno-dir).
# The code stays root-owned, so the runtime cannot rewrite it.
USER deno

# Download every dependency (deno.land/x, jsr:) at build time, so a cold start
# downloads nothing.
RUN deno cache \
      /app/functions/daily-digest/index.ts \
      /app/functions/incident-deliver/index.ts \
      /app/functions/incident-images/index.ts \
      /app/functions/incident-report/index.ts \
      /app/functions/welcome-email/index.ts

# Deno.serve's default port is 8000. Every function also listens on $PORT when it
# is set, and Cloud Run sets PORT to the container port: deploy with --port 8000.
ENV PORT=8000
EXPOSE 8000

# The base image's entrypoint (tini + docker-entrypoint.sh) execs this as is.
CMD ["/bin/sh", "-c", "exec deno run --allow-net --allow-env --allow-read \"/app/functions/${FUNCTION:?set FUNCTION to the function name}/index.ts\""]
