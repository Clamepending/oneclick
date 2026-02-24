#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra/aws"

terraform -chdir="$INFRA_DIR" output -json | node -e '
const fs = require("fs");
const out = JSON.parse(fs.readFileSync(0, "utf8"));
const recommended = out.app_env_recommended?.value ?? {};
for (const [k, v] of Object.entries(recommended)) console.log(`${k}=${String(v)}`);
if (out.aws_account_id?.value) console.log(`AWS_ACCOUNT_ID=${out.aws_account_id.value}`);
if (out.ecr_repository_url?.value) console.log(`ECR_REPOSITORY_URL=${out.ecr_repository_url.value}`);
'
