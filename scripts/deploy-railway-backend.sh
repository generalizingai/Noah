#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Deploying backend to Railway (service=Noah, env=production)..."
railway up backend --path-as-root --service Noah -e production --detach --ci --verbose

echo "Deployment submitted."
