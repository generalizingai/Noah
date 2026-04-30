#!/bin/bash
set -e

cd "$(dirname "$0")"

# On Apple Silicon Macs, Homebrew installs native libraries to /opt/homebrew/lib
# which Python's ctypes won't search by default. Add it so opuslib etc. can find libopus.
if [ -d "/opt/homebrew/lib" ]; then
  export DYLD_LIBRARY_PATH="/opt/homebrew/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
fi

# Load environment variables from .env if it exists (development only).
# Uses `set -a / source / set +a` which handles quoted multi-line values
# (e.g. JSON blobs) far better than the `export $(... | xargs)` pattern.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# If FIREBASE_GOOGLE_CREDENTIALS_JSON points to a file, load it into the env
# so callers don't have to inline the entire JSON on one line.
if [ -n "$FIREBASE_GOOGLE_CREDENTIALS_JSON" ] && [ -f "$FIREBASE_GOOGLE_CREDENTIALS_JSON" ]; then
  export FIREBASE_GOOGLE_CREDENTIALS_JSON="$(cat "$FIREBASE_GOOGLE_CREDENTIALS_JSON")"
fi
# Same for the legacy SERVICE_ACCOUNT_JSON name
if [ -n "$SERVICE_ACCOUNT_JSON" ] && [ -f "$SERVICE_ACCOUNT_JSON" ]; then
  export SERVICE_ACCOUNT_JSON="$(cat "$SERVICE_ACCOUNT_JSON")"
fi

# Start the FastAPI server without --reload to avoid subprocess startup timeout
exec uvicorn main:app --host 0.0.0.0 --port "${BACKEND_PORT:-8001}"
