#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra/aws"
TFVARS_PATH="$INFRA_DIR/terraform.tfvars"
ENV_OUT_PATH="$ROOT_DIR/.env.aws-ecs"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd terraform
require_cmd node

if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  echo "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set in your shell." >&2
  exit 1
fi

if [[ ! -f "$TFVARS_PATH" ]]; then
  cp "$INFRA_DIR/terraform.tfvars.example" "$TFVARS_PATH"
  if [[ -n "${AWS_REGION:-}" ]]; then
    TFVARS_PATH="$TFVARS_PATH" AWS_REGION="$AWS_REGION" node -e '
      const fs = require("fs");
      const path = process.env.TFVARS_PATH;
      const region = process.env.AWS_REGION;
      const text = fs.readFileSync(path, "utf8");
      fs.writeFileSync(path, text.replace(/aws_region\s*=\s*".*?"/, `aws_region = "${region}"`));
    '
  fi
  echo "Created $TFVARS_PATH (edit if you want non-default settings)."
fi

terraform -chdir="$INFRA_DIR" init
terraform -chdir="$INFRA_DIR" apply -auto-approve

JSON_OUTPUT="$(terraform -chdir="$INFRA_DIR" output -json)"

printf "%s" "$JSON_OUTPUT" | node -e '
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const out = JSON.parse(input);
const recommended = out.app_env_recommended?.value ?? {};
const lines = [];
for (const [key, value] of Object.entries(recommended)) {
  lines.push(`${key}=${String(value)}`);
}
if (out.aws_account_id?.value) lines.push(`AWS_ACCOUNT_ID=${out.aws_account_id.value}`);
if (out.ecr_repository_url?.value) lines.push(`ECR_REPOSITORY_URL=${out.ecr_repository_url.value}`);
process.stdout.write(lines.join("\n") + "\n");
' > "$ENV_OUT_PATH"

cat <<EOF

AWS base infra created/updated.
Wrote app env vars to:
  $ENV_OUT_PATH

Next:
1. Merge those values into your app env (.env.local / Vercel env)
2. Set DEPLOY_PROVIDER=ecs in your runtime env (included in file)
3. Re-deploy app/worker

EOF
