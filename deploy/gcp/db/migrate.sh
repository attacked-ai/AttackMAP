#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# migrate.sh — copy the Attacked.ai database from Supabase into Cloud SQL.
#
# Runs inside the attacked-migrate Cloud Run job (it has the Cloud SQL socket
# and the secrets). Env:
#   SOURCE_DB_URL          Supabase connection string (Project Settings →
#                          Database → Connection string → Session pooler, port 5432)
#   TARGET_INSTANCE_CONN   <project>:<region>:<instance>
#   DB_ADMIN_PASSWORD      Cloud SQL "postgres" user
#   AUTHENTICATOR_PASSWORD, API_DB_PASSWORD   logins for PostgREST and the API
#   MODE                   rehearsal (default): restore into attacked_rehearsal,
#                          compare, leave the real database alone.
#                          apply: restore into attacked (must be empty).
#   PUBLIC_MEDIA_BASE, BUCKET_PREFIX   where stored picture URLs now point
#
# What it moves: the 8 app schemas (cms content identity map ops public
# reference sweep) with data, grants and RLS policies; the accounts
# (auth.users, auth.identities); the one vault secret; the auth.users
# signup trigger. What it does NOT move: Supabase's own schemas, sessions
# (everyone signs in again), pg_cron jobs (Cloud Scheduler replaces them),
# storage files (deploy/gcp/db/copy_storage.sh).
#
# Before MODE=apply: stop the GUARD pipeline pushes, so nothing is written to
# Supabase while it copies (a few minutes for ~220 MB).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

MODE="${MODE:-rehearsal}"
DB=attacked; [[ "$MODE" == "apply" ]] || DB=attacked_rehearsal
SOCK="/cloudsql/$TARGET_INSTANCE_CONN"
export PGPASSWORD="$DB_ADMIN_PASSWORD"
TGT_ADMIN="host=$SOCK user=postgres dbname=postgres"
TGT="host=$SOCK user=postgres dbname=$DB"
SRC="$SOURCE_DB_URL"
SCHEMAS=(cms content identity map ops public reference sweep)
LOG=/tmp/restore.log

say() { printf '\n== %s\n' "$*"; }
q() { psql "$1" -v ON_ERROR_STOP=1 -At -c "$2"; }

say "mode=$MODE target database=$DB"
q "$SRC" "select 'source: ' || version()"

if [[ "$MODE" == "rehearsal" ]]; then
  q "$TGT_ADMIN" "drop database if exists attacked_rehearsal with (force)"
  q "$TGT_ADMIN" "create database attacked_rehearsal"
else
  n=$(q "$TGT" "select count(*) from information_schema.tables where table_schema = 'sweep'")
  if [[ "$n" != "0" && "${FORCE:-0}" != "1" ]]; then
    echo "Target database $DB already has sweep tables ($n). Refusing to overwrite (FORCE=1 to override)."; exit 1
  fi
fi

say "1/7 compatibility layer (roles, auth, net, vault)"
psql "$TGT" -v ON_ERROR_STOP=1 -q -f 01_supabase_compat.sql
psql "$TGT" -v ON_ERROR_STOP=1 -q -v pw="$AUTHENTICATOR_PASSWORD" -c "alter role authenticator password :'pw'"
psql "$TGT" -v ON_ERROR_STOP=1 -q -v pw="$API_DB_PASSWORD" -c "alter role attacked_api password :'pw'"

say "2/7 accounts (auth.users, auth.identities)"
psql "$SRC" -v ON_ERROR_STOP=1 -c "\copy (select id, coalesce(aud,'authenticated'), coalesce(role,'authenticated'), lower(email), email_confirmed_at, last_sign_in_at, coalesce(raw_app_meta_data,'{}'::jsonb), coalesce(raw_user_meta_data,'{}'::jsonb), banned_until, deleted_at, coalesce(created_at, now()), coalesce(updated_at, now()) from auth.users) to stdout with (format csv)" \
  | psql "$TGT" -v ON_ERROR_STOP=1 -c "\copy auth.users (id, aud, role, email, email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, banned_until, deleted_at, created_at, updated_at) from stdin with (format csv)"
# Email identities are keyed by the address in our sign-in (Supabase used the user id).
psql "$SRC" -v ON_ERROR_STOP=1 -c "\copy (select i.id, i.user_id, i.provider, case when i.provider = 'email' then lower(coalesce(i.identity_data->>'email', u.email)) else i.provider_id end, coalesce(i.identity_data,'{}'::jsonb), lower(coalesce(i.email, u.email)), i.last_sign_in_at, coalesce(i.created_at, now()), coalesce(i.updated_at, now()) from auth.identities i join auth.users u on u.id = i.user_id) to stdout with (format csv)" \
  | psql "$TGT" -v ON_ERROR_STOP=1 -c "\copy auth.identities (id, user_id, provider, provider_id, identity_data, email, last_sign_in_at, created_at, updated_at) from stdin with (format csv)"

say "3/7 app schemas (schema, data, grants, policies)"
DUMP=/tmp/app.dump
args=(); for s in "${SCHEMAS[@]}"; do args+=(--schema="$s"); done
pg_dump "$SRC" --format=custom --no-owner --no-publications --no-subscriptions --no-security-labels "${args[@]}" --file="$DUMP"
# Errors are expected for Supabase-only pieces (pg_net extension, supabase_*
# default privileges, event triggers); everything else must restore cleanly.
set +e
pg_restore --dbname="$TGT" --no-owner --role=attacked_owner --jobs=4 "$DUMP" 2> "$LOG"
set -e
echo "restore finished with $(grep -c 'error:' "$LOG" || true) error line(s); unexpected ones:"
grep 'error:' "$LOG" | grep -viE 'pg_net|extension "pg_net"|supabase_|pgsodium|event trigger|graphql|realtime|must be member of role|schema "public" already exists|already exists' || echo "  (none)"

say "4/7 signup trigger on auth.users (from the source definition)"
psql "$SRC" -At -c "select pg_get_triggerdef(t.oid) || ';' from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal" > /tmp/auth_triggers.sql
cat /tmp/auth_triggers.sql
psql "$TGT" -v ON_ERROR_STOP=1 -q -c "set role attacked_owner" -f /tmp/auth_triggers.sql

say "5/7 vault secret(s)"
psql "$SRC" -v ON_ERROR_STOP=1 -c "\copy (select name, decrypted_secret from vault.decrypted_secrets where name is not null) to stdout with (format csv)" \
  | psql "$TGT" -v ON_ERROR_STOP=1 -c "\copy vault.secrets (name, secret) from stdin with (format csv)"

say "6/7 after-restore fixes (security, picture URLs)"
OLD_BASE="$(printf '%s' "$SRC" | sed -nE 's#.*postgres\.([a-z0-9]+):.*#https://\1.supabase.co/storage/v1/object/public/#p')"
[[ -n "$OLD_BASE" ]] || OLD_BASE="https://ovenyjguhkgiceddzwna.supabase.co/storage/v1/object/public/"
psql "$TGT" -v ON_ERROR_STOP=1 -v old_base="$OLD_BASE" -v new_base="${PUBLIC_MEDIA_BASE:-https://storage.googleapis.com}/${BUCKET_PREFIX:-}" -f 02_after_restore.sql

say "7/7 row counts, source vs target"
tables=$(q "$SRC" "select string_agg(format('%I.%I', schemaname, tablename), ' ' order by 1) from pg_tables where schemaname = any('{cms,content,identity,map,ops,public,reference,sweep}')")
bad=0
for t in $tables auth.users; do
  a=$(q "$SRC" "select count(*) from $t"); b=$(q "$TGT" "select count(*) from $t" 2>/dev/null || echo missing)
  if [[ "$a" == "$b" ]]; then printf '  ok   %-40s %s\n' "$t" "$a"; else printf '  DIFF %-40s source=%s target=%s\n' "$t" "$a" "$b"; bad=1; fi
done
[[ $bad == 0 ]] && say "all counts match ($MODE)" || { say "some counts differ: read the list above before going live"; exit 2; }
