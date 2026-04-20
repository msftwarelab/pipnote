#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-Pipnote}"
APP_BUNDLE_PATH="${ROOT_DIR}/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
DMG_DIR="${ROOT_DIR}/src-tauri/target/release/bundle/dmg"
STAGING_DIR="${DMG_DIR}/${APP_NAME}-dmg-staging"
README_TEMPLATE_PATH="${ROOT_DIR}/scripts/macos-dmg-readme.txt"
VERSION="${VERSION:-$(node -p "require('${ROOT_DIR}/package.json').version")}"
ARCH="$(uname -m)"
DMG_PATH="${DMG_DIR}/${APP_NAME}_${VERSION}_${ARCH}.dmg"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping DMG packaging: macOS only."
  exit 0
fi

if [[ ! -d "${APP_BUNDLE_PATH}" ]]; then
  echo "App bundle not found: ${APP_BUNDLE_PATH}" >&2
  exit 1
fi

mkdir -p "${DMG_DIR}"
rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}"
cp -R "${APP_BUNDLE_PATH}" "${STAGING_DIR}/${APP_NAME}.app"
ln -sfn /Applications "${STAGING_DIR}/Applications"
if [[ -f "${README_TEMPLATE_PATH}" ]]; then
  cp "${README_TEMPLATE_PATH}" "${STAGING_DIR}/Install ${APP_NAME}.txt"
fi
rm -f "${DMG_PATH}"

echo "Packaging DMG at ${DMG_PATH}"
hdiutil create \
  -volname "${APP_NAME}" \
  -srcfolder "${STAGING_DIR}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

echo "Created ${DMG_PATH}"
