#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

META_OUTPUT="$(node --input-type=module - <<'EOF'
import fs from 'node:fs'
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'))
console.log(config.productName || 'Pipnote')
console.log(config.version || '0.0.0')
EOF
)"
PRODUCT_NAME="$(printf '%s\n' "$META_OUTPUT" | sed -n '1p')"
VERSION="$(printf '%s\n' "$META_OUTPUT" | sed -n '2p')"
TARGET_DIR="src-tauri/target/release/bundle"
OS_NAME="$(uname -s)"

find_first() {
  local pattern="$1"
  find "$TARGET_DIR" -type f -name "$pattern" | sort | head -n 1
}

find_first_dir() {
  local pattern="$1"
  find "$TARGET_DIR" -type d -name "$pattern" | sort | head -n 1
}

DMG_PATH="$(find_first "${PRODUCT_NAME}_${VERSION}_*.dmg")"
APP_PATH="$(find_first_dir "${PRODUCT_NAME}.app")"
MSI_PATH="$(find_first "${PRODUCT_NAME}_${VERSION}_*.msi")"
DEB_PATH="$(find_first "$(printf '%s_%s_*.deb' "$(printf '%s' "$PRODUCT_NAME" | tr '[:upper:]' '[:lower:]')" "$VERSION")")"
APPIMAGE_PATH="$(find_first "${PRODUCT_NAME}_${VERSION}_*.AppImage")"

echo "Artifact summary for ${PRODUCT_NAME} ${VERSION}"
echo "Bundle directory: ${TARGET_DIR}"
echo
printf '%-12s %s\n' "macOS app:" "${APP_PATH:-missing}"
printf '%-12s %s\n' "DMG:" "${DMG_PATH:-missing}"
printf '%-12s %s\n' "MSI:" "${MSI_PATH:-missing}"
printf '%-12s %s\n' "DEB:" "${DEB_PATH:-missing}"
printf '%-12s %s\n' "AppImage:" "${APPIMAGE_PATH:-missing}"

case "$OS_NAME" in
  Darwin)
    if [[ -z "$DMG_PATH" ]]; then
      echo
      echo "Expected a macOS DMG artifact, but none was found."
      exit 1
    fi
    ;;
  Linux)
    if [[ -z "$DEB_PATH" && -z "$APPIMAGE_PATH" ]]; then
      echo
      echo "Expected a Linux package artifact, but neither DEB nor AppImage was found."
      exit 1
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    if [[ -z "$MSI_PATH" ]]; then
      echo
      echo "Expected a Windows MSI artifact, but none was found."
      exit 1
    fi
    ;;
esac

echo
echo "Artifact verification complete."
