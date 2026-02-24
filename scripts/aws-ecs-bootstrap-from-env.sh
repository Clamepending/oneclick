#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PATH="${1:-$ROOT_DIR/.env}"

if [[ ! -f "$ENV_PATH" ]]; then
  echo "Env file not found: $ENV_PATH" >&2
  exit 1
fi

# Export only the variables needed for Terraform/AWS bootstrap.
set -a
source "$ENV_PATH"
set +a

if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  cat >&2 <<EOF
Missing AWS credentials in $ENV_PATH.
Add these keys, then rerun:
  AWS_ACCESS_KEY_ID=...
  AWS_SECRET_ACCESS_KEY=...
  AWS_REGION=us-east-1
EOF
  exit 1
fi

backup_path="$ENV_PATH.bak.$(date +%Y%m%d%H%M%S)"
cp "$ENV_PATH" "$backup_path"
echo "Backup created: $backup_path"

bash "$ROOT_DIR/scripts/aws-ecs-bootstrap.sh"
node "$ROOT_DIR/scripts/upsert-env-file.mjs" "$ENV_PATH" "$ROOT_DIR/.env.aws-ecs"

cat <<EOF

Merged ECS env values into:
  $ENV_PATH

Your original file was backed up at:
  $backup_path

EOF
