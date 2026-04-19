#!/usr/bin/env bash
# Build the Screen Recorder .app, replace the one in /Applications, and
# clean up the build output so Spotlight only ever sees the installed copy.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Screen Recorder.app"
TARGET="/Applications/${APP_NAME}"
BUILD_DIR="release/1.3.0/mac-arm64"
SOURCE="${BUILD_DIR}/${APP_NAME}"

echo "→ Quitting any running instance…"
osascript -e 'quit app "Screen Recorder"' 2>/dev/null || true
sleep 1

echo "→ Building renderer + main bundle…"
npx tsc
npx vite build

echo "→ Packaging .app (arm64, ad-hoc signed)…"
npx electron-builder --mac --dir

if [ ! -d "${SOURCE}" ]; then
  echo "✗ Build succeeded but ${SOURCE} not found." >&2
  exit 1
fi

echo "→ Replacing /Applications/${APP_NAME}…"
rm -rf "${TARGET}"
cp -R "${SOURCE}" "${TARGET}"
xattr -rd com.apple.quarantine "${TARGET}" 2>/dev/null || true

echo "→ Cleaning release/ to avoid Spotlight duplicates…"
rm -rf release

echo
echo "✓ Done. /Applications/${APP_NAME} updated."
echo "  macOS may reset Screen Recording + Microphone perms on the new binary."
echo "  Re-toggle in System Settings → Privacy & Security if the app can't capture."
