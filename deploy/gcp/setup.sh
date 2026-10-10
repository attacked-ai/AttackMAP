#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup.sh — build the whole Attacked.ai stack on Google Cloud.
#
#   cp deploy/gcp/config.env.example deploy/gcp/config.env   # fill it in
#   bash deploy/gcp/setup.sh --dry-run          # print every command, change nothing
#   bash deploy/gcp/setup.sh                    # all steps, in order
#   bash deploy/gcp/setup.sh secrets deploy     # only some steps
#
# Run it in Cloud Shell (it has gcloud, openssl, jq, node) from the repo root.
# Every step is safe to run again: it creates what is missing and leaves what
# exists. Steps (deploy/gcp/README.md explains each):
#
#   apis       switch on the Google Cloud APIs
#   registry   Artifact Registry repo for the container images
#   accounts   one service account per service, least privilege
#   secrets    generate the machine secrets; list the ones YOU must add
#   sql        Cloud SQL PostgreSQL 17 instance + database "attacked"
#   buckets    Cloud Storage: avatars, incident media (public), reports, archive (private)
#   build      build + push the images (Cloud Build, deploy/gcp/cloudbuild.yaml)
#   migrate    copy the Supabase database into Cloud SQL (Cloud Run job)
#   deploy     first deploy of every Cloud Run service with its full config
#   scheduler  Cloud Scheduler jobs (outbox, incident brief, cleanup, digest)
#   hosting    Firebase Hosting (the website) + its rewrites to Cloud Run
#   monitoring uptime check on /api/health
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
[[ -f "$HERE/config.env" ]] || { echo "Missing $HERE/config.env (copy config.env.example)"; exit 1; }
# shellcheck disable=SC1091
source "$HERE/config.env"

DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; shift; fi
ALL_STEPS=(apis registry accounts secrets sql buckets build migrate deploy scheduler hosting monitoring)
STEPS=("$@"); [[ ${#STEPS[@]} -eq 0 ]] && STEPS=("${ALL_STEPS[@]}")

run() { echo "+ $*"; if [[ $DRY == 0 ]]; then "$@"; fi; }
exists() { [[ $DRY == 1 ]] && return 1; "$@" >/dev/null 2>&1; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

GC="gcloud --project=$PROJECT_ID --quiet"
INSTANCE_CONN="$PROJECT_ID:$REGION:$SQL_INSTANCE"
AR="$REGION-docker.pkg.dev/$PROJECT_ID/attacked"
sa() { echo "$1@$PROJECT_ID.iam.gserviceaccount.com"; }
SA_API=$(sa attacked-api); SA_DATA=$(sa attacked-data); SA_FN=$(sa attacked-fn)
SA_SCHED=$(sa attacked-scheduler); SA_MIGRATE=$(sa attacked-migrate); SA_BUILD=$(sa attacked-build)
B_AVATARS="$PROJECT_ID-avatars"; B_MEDIA="$PROJECT_ID-incident-media"
B_REPORTS="$PROJECT_ID-reports"; B_ARCHIVE="$PROJECT_ID-sweep-archive"
FUNCTIONS=(daily-digest incident-deliver welcome-email incident-images incident-report)
# Secrets only a person can supply (setup.sh creates them empty and stops until they have a value).
OWNER_SECRETS=(google-client-id google-client-secret resend-api-key)
OPTIONAL_SECRETS=(supabase-db-url supabase-service-key twilio-account-sid twilio-auth-token twilio-whatsapp-from)

secret_has_value() { [[ $DRY == 1 ]] && return 0; $GC secrets versions list "$1" --filter=state=enabled --limit=1 --format='value(name)' 2>/dev/null | grep -q .; }
secret_value() { if [[ $DRY == 1 ]]; then echo "dry-run-value-$1"; else $GC secrets versions access latest --secret="$1"; fi; }
ensure_secret() {   # ensure_secret NAME  (empty container)
  exists $GC secrets describe "$1" || run $GC secrets create "$1" --replication-policy=automatic
}
set_secret_once() { # set_secret_once NAME VALUE   (only if it has no value yet)
  ensure_secret "$1"
  if secret_has_value "$1" && [[ $DRY == 0 ]]; then echo "  $1: already set"; return; fi
  echo "+ gcloud secrets versions add $1 (value hidden)"
  [[ $DRY == 1 ]] || printf '%s' "$2" | $GC secrets versions add "$1" --data-file=-
}
grant_secret() {    # grant_secret NAME SA
  run $GC secrets add-iam-policy-binding "$1" --member="serviceAccount:$2" --role=roles/secretmanager.secretAccessor >/dev/null
}
service_url() { if [[ $DRY == 1 ]]; then echo "https://$1-dryrun.a.run.app"; else $GC run services describe "$1" --region="$REGION" --format='value(status.url)'; fi; }

# ── steps ────────────────────────────────────────────────────────────────────
step_apis() {
  say "APIs"
  run $GC services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com cloudbuild.googleapis.com cloudscheduler.googleapis.com \
    storage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
    firebase.googleapis.com firebasehosting.googleapis.com monitoring.googleapis.com logging.googleapis.com
}

step_registry() {
  say "Artifact Registry"
  exists $GC artifacts repositories describe attacked --location="$REGION" || \
    run $GC artifacts repositories create attacked --repository-format=docker --location="$REGION" \
      --description="Attacked.ai container images"
}

step_accounts() {
  say "Service accounts (one per service)"
  local name
  for name in attacked-api attacked-data attacked-fn attacked-scheduler attacked-migrate attacked-build; do
    exists $GC iam service-accounts describe "$(sa $name)" || \
      run $GC iam service-accounts create "$name" --display-name="Attacked.ai $name"
  done
  # Project-level roles: only what cannot be scoped to one resource.
  local b
  for b in "$SA_API:roles/cloudsql.client" "$SA_DATA:roles/cloudsql.client" "$SA_MIGRATE:roles/cloudsql.client" \
           "$SA_API:roles/logging.logWriter" "$SA_DATA:roles/logging.logWriter" "$SA_FN:roles/logging.logWriter" \
           "$SA_BUILD:roles/run.admin" "$SA_BUILD:roles/artifactregistry.writer" "$SA_BUILD:roles/logging.logWriter" \
           "$SA_BUILD:roles/firebasehosting.admin" "$SA_BUILD:roles/serviceusage.serviceUsageConsumer"; do
    run $GC projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${b%%:*}" --role="${b#*:}" --condition=None >/dev/null
  done
  # Cloud Build deploys services that run as the other accounts.
  for name in "$SA_API" "$SA_DATA" "$SA_FN"; do
    run $GC iam service-accounts add-iam-policy-binding "$name" --member="serviceAccount:$SA_BUILD" \
      --role=roles/iam.serviceAccountUser >/dev/null
  done
}

step_secrets() {
  say "Secrets"
  set_secret_once jwt-secret "$(rand_secret)"
  set_secret_once internal-token "$(rand_hex 32)"
  set_secret_once ingest-token "$(rand_hex 32)"
  set_secret_once db-admin-password "$(rand_hex 24)"
  set_secret_once db-authenticator-password "$(rand_hex 24)"
  set_secret_once db-api-password "$(rand_hex 24)"
  local jwt; jwt="$(secret_value jwt-secret)"
  set_secret_once anon-key "$(mint_jwt anon "$jwt")"
  set_secret_once service-role-key "$(mint_jwt service_role "$jwt")"
  set_secret_once pgrst-db-uri "postgres://authenticator:$(secret_value db-authenticator-password)@/attacked?host=/cloudsql/$INSTANCE_CONN"
  set_secret_once database-url "postgresql://attacked_api:$(secret_value db-api-password)@/attacked?host=/cloudsql/$INSTANCE_CONN"
  local s
  for s in "${OWNER_SECRETS[@]}" "${OPTIONAL_SECRETS[@]}"; do ensure_secret "$s"; done

  # Who may read which secret.
  for s in jwt-secret anon-key service-role-key database-url internal-token ingest-token resend-api-key google-client-id google-client-secret; do grant_secret "$s" "$SA_API"; done
  for s in pgrst-db-uri jwt-secret; do grant_secret "$s" "$SA_DATA"; done
  for s in service-role-key anon-key internal-token resend-api-key twilio-account-sid twilio-auth-token twilio-whatsapp-from; do grant_secret "$s" "$SA_FN"; done
  for s in db-admin-password db-authenticator-password db-api-password supabase-db-url; do grant_secret "$s" "$SA_MIGRATE"; done
  grant_secret anon-key "$SA_BUILD"

  local missing=()
  for s in "${OWNER_SECRETS[@]}"; do secret_has_value "$s" || missing+=("$s"); done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo
    echo "  Add these before the deploy step (deploy/gcp/README.md says where each comes from):"
    for s in "${missing[@]}"; do echo "    printf '%s' 'VALUE' | gcloud secrets versions add $s --data-file=-"; done
  fi
}

step_sql() {
  say "Cloud SQL"
  if ! exists $GC sql instances describe "$SQL_INSTANCE"; then
    local avail=ZONAL; [[ "${SQL_HA:-false}" == "true" ]] && avail=REGIONAL
    run $GC sql instances create "$SQL_INSTANCE" --database-version=POSTGRES_17 --edition=ENTERPRISE \
      --tier="$SQL_TIER" --region="$REGION" --availability-type="$avail" \
      --storage-type=SSD --storage-size=10 --storage-auto-increase \
      --backup-start-time=18:30 --enable-point-in-time-recovery --retained-backups-count=14 \
      --deletion-protection --root-password="$(secret_value db-admin-password)"
  fi
  exists $GC sql databases describe attacked --instance="$SQL_INSTANCE" || \
    run $GC sql databases create attacked --instance="$SQL_INSTANCE"
}

step_buckets() {
  say "Cloud Storage"
  local b
  for b in "$B_AVATARS" "$B_MEDIA" "$B_REPORTS" "$B_ARCHIVE"; do
    exists $GC storage buckets describe "gs://$b" || \
      run $GC storage buckets create "gs://$b" --location="$REGION" --uniform-bucket-level-access
  done
  # Public read for the pictures only; the reports and the archive stay private.
  for b in "$B_AVATARS" "$B_MEDIA"; do
    run $GC storage buckets add-iam-policy-binding "gs://$b" --member=allUsers --role=roles/storage.objectViewer >/dev/null
    run $GC storage buckets add-iam-policy-binding "gs://$b" --member="serviceAccount:$SA_API" --role=roles/storage.objectAdmin >/dev/null
  done
  run $GC storage buckets add-iam-policy-binding "gs://$B_MEDIA" --member="serviceAccount:$SA_FN" --role=roles/storage.objectAdmin >/dev/null
  run $GC storage buckets update "gs://$B_REPORTS" --public-access-prevention
  run $GC storage buckets update "gs://$B_ARCHIVE" --public-access-prevention
  run $GC storage buckets add-iam-policy-binding "gs://$B_REPORTS" --member="serviceAccount:$SA_API" --role=roles/storage.objectViewer >/dev/null
  echo "  Upload the report files (they are on the PC, not in git):"
  echo "    gcloud storage cp public/reports/*.html public/reports/manifest.json gs://$B_REPORTS/"
}

step_build() {
  say "Build + push images (no deploy)"
  run $GC builds submit "$ROOT" --config="$HERE/cloudbuild.yaml" --region="$REGION" \
    --service-account="projects/$PROJECT_ID/serviceAccounts/$SA_BUILD" \
    --substitutions="_REGION=$REGION,_SITE_URL=$SITE_URL,_DEPLOY=false"
}

step_migrate() {
  say "Database migration job (Supabase -> Cloud SQL)"
  if ! secret_has_value supabase-db-url; then
    echo "  Skipped: add the Supabase connection string first (README -> Database migration):"
    echo "    printf '%s' 'postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres' | gcloud secrets versions add supabase-db-url --data-file=-"
    return
  fi
  run $GC run jobs deploy attacked-migrate --image="$AR/migrate:latest" --region="$REGION" \
    --service-account="$SA_MIGRATE" --set-cloudsql-instances="$INSTANCE_CONN" --task-timeout=3600 --max-retries=0 \
    --set-env-vars="TARGET_INSTANCE_CONN=$INSTANCE_CONN,MODE=${MIGRATE_MODE:-rehearsal},PUBLIC_MEDIA_BASE=https://storage.googleapis.com,BUCKET_PREFIX=$PROJECT_ID-" \
    --set-secrets="SOURCE_DB_URL=supabase-db-url:latest,DB_ADMIN_PASSWORD=db-admin-password:latest,AUTHENTICATOR_PASSWORD=db-authenticator-password:latest,API_DB_PASSWORD=db-api-password:latest"
  run $GC run jobs execute attacked-migrate --region="$REGION" --wait
  echo "  That was MODE=${MIGRATE_MODE:-rehearsal} (restored into attacked_rehearsal). For the real move:"
  echo "    MIGRATE_MODE=apply bash deploy/gcp/setup.sh migrate"
}

step_deploy() {
  say "Deploy Cloud Run services"
  local s missing=()
  for s in "${OWNER_SECRETS[@]}"; do secret_has_value "$s" || missing+=("$s"); done
  if [[ ${#missing[@]} -gt 0 ]]; then echo "  Stopped: these secrets still have no value: ${missing[*]}"; exit 1; fi

  run $GC run deploy attacked-data --image="$AR/data:latest" --region="$REGION" --service-account="$SA_DATA" \
    --allow-unauthenticated --add-cloudsql-instances="$INSTANCE_CONN" --port=8080 --cpu=1 --memory=512Mi \
    --concurrency=80 --min-instances=0 --max-instances=10 \
    --set-env-vars="GCS_BUCKET_PREFIX=$PROJECT_ID-" \
    --set-secrets="PGRST_DB_URI=pgrst-db-uri:latest,PGRST_JWT_SECRET=jwt-secret:latest"
  local DATA_URL; DATA_URL="$(service_url attacked-data)"

  local f fn_urls="{" sep=""
  for f in "${FUNCTIONS[@]}"; do
    local auth="--no-allow-unauthenticated"
    local secrets="SUPABASE_SERVICE_ROLE_KEY=service-role-key:latest,INTERNAL_TOKEN=internal-token:latest,RESEND_API_KEY=resend-api-key:latest"
    # incident-report is read by the daily-brief dashboard in a browser, with the anon key.
    [[ "$f" == "incident-report" ]] && { auth="--allow-unauthenticated"; secrets+=",SUPABASE_ANON_KEY=anon-key:latest"; }
    # WhatsApp in the incident brief only once the Twilio secrets exist.
    if [[ "$f" == "incident-deliver" ]] && secret_has_value twilio-account-sid; then
      secrets+=",TWILIO_ACCOUNT_SID=twilio-account-sid:latest,TWILIO_AUTH_TOKEN=twilio-auth-token:latest,TWILIO_WHATSAPP_FROM=twilio-whatsapp-from:latest"
    fi
    run $GC run deploy "fn-$f" --image="$AR/functions:latest" --region="$REGION" --service-account="$SA_FN" \
      $auth --port=8000 --cpu=1 --memory=512Mi --timeout=900 --min-instances=0 --max-instances=3 \
      --set-env-vars="^|^FUNCTION=$f|SUPABASE_URL=$DATA_URL|APP_URL=$SITE_URL|DASHBOARD_URL=$SITE_URL|MAIL_FROM=$MAIL_FROM|GCS_BUCKET_MEDIA=$B_MEDIA|PUBLIC_MEDIA_BASE=https://storage.googleapis.com" \
      --set-secrets="$secrets"
    run $GC run services add-iam-policy-binding "fn-$f" --region="$REGION" --member="serviceAccount:$SA_API" --role=roles/run.invoker >/dev/null
    fn_urls+="$sep\"$f\":\"$(service_url "fn-$f")\""; sep=","
  done
  fn_urls+="}"

  run $GC run deploy attacked-api --image="$AR/api:latest" --region="$REGION" --service-account="$SA_API" \
    --allow-unauthenticated --add-cloudsql-instances="$INSTANCE_CONN" --port=8080 --cpu=1 --memory=512Mi \
    --timeout=600 --min-instances=0 --max-instances=10 \
    --add-volume=name=reports,type=cloud-storage,bucket="$B_REPORTS",readonly=true \
    --add-volume-mount=volume=reports,mount-path=/mnt/reports \
    --set-env-vars="^|^BACKEND=gcp|ENV=production|PUBLIC_URL=$SITE_URL|DATA_API_URL=$DATA_URL|MAIL_FROM=$MAIL_FROM|GCS_BUCKET_AVATARS=$B_AVATARS|GCS_BUCKET_MEDIA=$B_MEDIA|REPORTS_DIR=/mnt/reports|SCHEDULER_SA_EMAIL=$SA_SCHED|GOOGLE_ALLOWED_DOMAIN=${GOOGLE_ALLOWED_DOMAIN:-}|FUNCTION_URLS=$fn_urls" \
    --set-secrets="JWT_SECRET=jwt-secret:latest,ANON_KEY=anon-key:latest,SERVICE_ROLE_KEY=service-role-key:latest,DATABASE_URL=database-url:latest,INTERNAL_TOKEN=internal-token:latest,INGEST_TOKEN=ingest-token:latest,RESEND_API_KEY=resend-api-key:latest,GOOGLE_CLIENT_ID=google-client-id:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest"
  local API_URL; API_URL="$(service_url attacked-api)"
  # Cloud Scheduler signs its calls for this audience.
  run $GC run services update attacked-api --region="$REGION" --update-env-vars="JOBS_AUDIENCE=$API_URL"
  echo "  data: $DATA_URL"
  echo "  api:  $API_URL"
}

step_scheduler() {
  say "Cloud Scheduler"
  local API_URL; API_URL="$(service_url attacked-api)"
  # name|schedule|path|paused?
  local jobs=(
    "attacked-outbox|* * * * *|/api/jobs/outbox|no"
    "attacked-incident-deliver|*/30 * * * *|/api/jobs/run/incident-deliver|no"
    "attacked-cleanup|30 3 * * *|/api/jobs/cleanup|no"
    "attacked-daily-digest|0 8 * * *|/api/jobs/run/daily-digest|yes"
    "attacked-incident-images|*/10 * * * *|/api/jobs/run/incident-images|yes"
  )
  local j name sched path paused
  for j in "${jobs[@]}"; do
    IFS='|' read -r name sched path paused <<<"$j"
    if ! exists $GC scheduler jobs describe "$name" --location="$REGION"; then
      run $GC scheduler jobs create http "$name" --location="$REGION" --schedule="$sched" --time-zone=Etc/UTC \
        --uri="$API_URL$path" --http-method=POST --headers=Content-Type=application/json --message-body='{}' \
        --oidc-service-account-email="$SA_SCHED" --oidc-token-audience="$API_URL" --attempt-deadline=600s
      # The daily digest and the picture generator are off today (as on Supabase);
      # resume them with: gcloud scheduler jobs resume <name> --location=<region>
      [[ "$paused" == "yes" ]] && run $GC scheduler jobs pause "$name" --location="$REGION"
    fi
  done
}

step_hosting() {
  say "Firebase Hosting"
  if [[ "$REGION" != "asia-south1" ]]; then
    run sed -i "s/\"region\": \"asia-south1\"/\"region\": \"$REGION\"/g" "$ROOT/firebase.json"
  fi
  echo "  One-time, in the Firebase console (https://console.firebase.google.com):"
  echo "    Add project -> choose the existing Google Cloud project $PROJECT_ID -> Hosting -> Get started."
  echo "  Then Cloud Build deploys the site on every push (deploy/gcp/cloudbuild.yaml), or by hand:"
  echo "    npm ci && VITE_BACKEND=gcp VITE_SUPABASE_URL=$SITE_URL VITE_SUPABASE_ANON_KEY=\$(gcloud secrets versions access latest --secret=anon-key) VITE_AUTH_PROVIDERS=google npm run build"
  echo "    npx firebase-tools deploy --only hosting --project $PROJECT_ID"
  echo "  Custom domain: Hosting -> Add custom domain (it gives the DNS records and a free certificate)."
}

step_monitoring() {
  say "Monitoring"
  local host; host="$(echo "$SITE_URL" | sed -E 's#^https?://##; s#/.*$##')"
  local have=""
  [[ $DRY == 0 ]] && have="$($GC monitoring uptime list-configs --filter="displayName=attacked-api-health" --format='value(name)' 2>/dev/null || true)"
  [[ -n "$have" ]] || \
    run $GC monitoring uptime create attacked-api-health --resource-type=uptime-url \
      --resource-labels="host=$host,project_id=$PROJECT_ID" --path=/api/health --protocol=https --period=5 --timeout=10 || \
    echo "  Create it in the console instead: Monitoring -> Uptime checks -> $SITE_URL/api/health"
  echo "  Alerting: Monitoring -> Alerting -> policy on that uptime check, email $ALERT_EMAIL."
}

for step in "${STEPS[@]}"; do
  if declare -F "step_$step" >/dev/null; then "step_$step"; else echo "Unknown step: $step (one of: ${ALL_STEPS[*]})"; exit 1; fi
done
say "Done: ${STEPS[*]}"
