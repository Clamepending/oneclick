#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/lambda"
ENTRY="$ROOT_DIR/src/lambda/sqsDeployConsumer.ts"
BUNDLE_JS="$OUT_DIR/index.js"
ZIP_PATH="$OUT_DIR/sqs-deploy-consumer.zip"

mkdir -p "$OUT_DIR"

npx esbuild "$ENTRY" \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --external:ssh2 \
  --outfile="$BUNDLE_JS" \
  --tsconfig="$ROOT_DIR/tsconfig.json"

rm -f "$ZIP_PATH"
(cd "$OUT_DIR" && zip -q -j "$ZIP_PATH" "$BUNDLE_JS")

echo "Built Lambda bundle: $ZIP_PATH"
