#!/bin/sh
# Start PostgREST and nginx; if either exits, stop the container so Cloud Run
# starts a fresh one instead of serving half a service.
set -eu

/usr/local/bin/postgrest &
PGRST=$!

/docker-entrypoint.sh nginx -g 'daemon off;' &
NGINX=$!

while kill -0 "$PGRST" 2>/dev/null && kill -0 "$NGINX" 2>/dev/null; do
  sleep 2
done
echo "attacked-data: a process exited; stopping the container" >&2
kill "$PGRST" "$NGINX" 2>/dev/null || true
exit 1
