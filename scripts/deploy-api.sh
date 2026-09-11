#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASSWORD="$(node --input-type=module -e "process.loadEnvFile('.env'); process.stdout.write(process.env.REPORT_ACCESS_PASSWORD || '')")"
if [[ -z "$PASSWORD" ]]; then
  echo "Set REPORT_ACCESS_PASSWORD in .env before deploying." >&2
  exit 1
fi

API_PROJECT="${API_PROJECT:-expiry-tracker-cc}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-bacchus-report-api}"
SA="bachus-report-api@${API_PROJECT}.iam.gserviceaccount.com"
PAGES_ORIGIN="${PAGES_ORIGIN:-https://codecross-github.github.io}"

ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
cat > "$ENV_FILE" <<EOF
REPORT_ACCESS_PASSWORD: "${PASSWORD}"
CORS_ORIGIN: "${PAGES_ORIGIN}"
EOF

gcloud run deploy "$SERVICE" \
  --project="$API_PROJECT" \
  --region="$REGION" \
  --source="$ROOT" \
  --service-account="$SA" \
  --allow-unauthenticated \
  --memory=512Mi \
  --timeout=60s \
  --env-vars-file="$ENV_FILE" \
  --quiet
