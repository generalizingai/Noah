#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
DESKTOP_DIR="$ROOT_DIR/artifacts/desktop"

echo "== Noah Dev Stack =="
echo "Root:    $ROOT_DIR"
echo "Backend: $BACKEND_DIR"
echo "Desktop: $DESKTOP_DIR"

if [ ! -f "$BACKEND_DIR/start.sh" ]; then
  echo "Backend start script not found: $BACKEND_DIR/start.sh"
  exit 1
fi

if [ ! -d "$DESKTOP_DIR/node_modules" ]; then
  echo "Desktop dependencies missing. Run: cd \"$DESKTOP_DIR\" && npm install"
  exit 1
fi

export NOAH_PREFER_LOCAL_BACKEND=1
export NOAH_BACKEND_URL="${NOAH_BACKEND_URL:-http://localhost:8001}"
export PORT="${PORT:-8001}"

echo ""
echo "Starting backend on :$PORT ..."
(
  cd "$BACKEND_DIR"
  ./start.sh
) &
BACKEND_PID=$!

cleanup() {
  echo ""
  echo "Stopping backend (pid=$BACKEND_PID)..."
  kill "$BACKEND_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "Waiting for backend health..."
for i in {1..40}; do
  if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    echo "Backend is healthy."
    break
  fi
  sleep 0.5
done

echo ""
echo "Launching desktop app in dev mode..."
echo "Tip: keep this terminal open while testing."
cd "$DESKTOP_DIR"
npm run dev
