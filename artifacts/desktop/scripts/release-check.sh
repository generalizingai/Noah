#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/artifacts/desktop"

echo "== Noah Release Check =="
echo "This runs the pre-release validation flow before creating a DMG tag."

echo ""
echo "Step 1/3: Smoke checks"
cd "$DESKTOP_DIR"
bash ./scripts/smoke-test.sh

echo ""
echo "Step 2/3: Build desktop distribution artifacts"
npm run build:dmg

echo ""
echo "Step 3/3: Manual QA reminder"
cat <<'EOF'
Manual QA checklist (required):
- Hermes mode toggles to Active and /hermes/status reports active:true
- Assistant voice response shows speaking visualizer and Stop control
- ElevenLabs voice preview works (if key configured)
- Deepgram voice preview works (if key configured)
- Multi-line / bullet formatting displays correctly in assistant messages
- Floating bar interaction remains responsive during long responses
EOF

echo ""
echo "Release-check complete. If all manual QA passes, tag a release:"
echo "  git tag -a noah-vX.Y.Z -m \"Noah Desktop vX.Y.Z\""
echo "  git push origin noah-vX.Y.Z"
