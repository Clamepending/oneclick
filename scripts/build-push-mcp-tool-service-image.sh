#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-951831705476}"
REPOSITORY="${ECR_REPOSITORY:-oneclick-openclaw}"
TAG="${MCP_TOOL_SERVICE_TAG:-mcp-tool-service-$(date -u +%Y%m%d-%H%M%S)}"
IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPOSITORY}:${TAG}"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" >/dev/null

docker buildx build \
  --platform linux/amd64 \
  --file "$ROOT_DIR/docker/mcp-tool-service/Dockerfile" \
  --tag "$IMAGE_URI" \
  --push \
  "$ROOT_DIR/docker/mcp-tool-service"

echo "$IMAGE_URI"
