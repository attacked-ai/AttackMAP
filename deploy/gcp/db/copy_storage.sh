#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# copy_storage.sh — copy the Supabase Storage buckets into Cloud Storage.
#
#   export SUPABASE_URL=https://ovenyjguhkgiceddzwna.supabase.co
#   export SUPABASE_SERVICE_KEY="$(gcloud secrets versions access latest --secret=supabase-service-key)"
#   export BUCKET_PREFIX=<project-id>-
#   bash deploy/gcp/db/copy_storage.sh            # avatars, incident-media, sweep-archive
#
# Run in Cloud Shell (gcloud, curl, jq). Object paths are kept, so a stored URL
# .../public/incident-media/incidents/2596.jpg becomes
# https://storage.googleapis.com/<prefix>incident-media/incidents/2596.jpg,
# which is exactly what 02_after_restore.sql rewrites the rows to.
# Safe to run again: existing objects are overwritten with the same bytes.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
: "${SUPABASE_URL:?}" "${SUPABASE_SERVICE_KEY:?}" "${BUCKET_PREFIX:?}"
if [[ $# -gt 0 ]]; then BUCKETS=("$@"); else BUCKETS=(avatars incident-media sweep-archive); fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
H=(-H "Authorization: Bearer $SUPABASE_SERVICE_KEY" -H "apikey: $SUPABASE_SERVICE_KEY")

# list_all <bucket> <prefix>: every object path under prefix (folders are recursed).
list_all() {
  local bucket="$1" prefix="$2" offset=0 page
  while :; do
    page=$(curl -fsS "${H[@]}" -H "Content-Type: application/json" \
      -d "{\"prefix\":\"$prefix\",\"limit\":1000,\"offset\":$offset,\"sortBy\":{\"column\":\"name\",\"order\":\"asc\"}}" \
      "$SUPABASE_URL/storage/v1/object/list/$bucket")
    [[ "$(jq 'length' <<<"$page")" == "0" ]] && break
    # Files have an id; folders do not.
    jq -r --arg p "$prefix" '.[] | select(.id != null) | ($p + .name)' <<<"$page"
    local f
    while IFS= read -r f; do [[ -n "$f" ]] && list_all "$bucket" "$prefix$f/"; done < <(jq -r '.[] | select(.id == null) | .name' <<<"$page")
    offset=$((offset + 1000))
  done
}

for b in "${BUCKETS[@]}"; do
  echo "== $b -> gs://$BUCKET_PREFIX$b"
  n=0
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    mkdir -p "$TMP/$(dirname "$path")"
    curl -fsS "${H[@]}" "$SUPABASE_URL/storage/v1/object/$b/$path" -o "$TMP/$path"
    gcloud storage cp "$TMP/$path" "gs://$BUCKET_PREFIX$b/$path" --quiet >/dev/null
    rm -f "$TMP/$path"
    n=$((n + 1))
  done < <(list_all "$b" "")
  echo "   copied $n object(s)"
done
