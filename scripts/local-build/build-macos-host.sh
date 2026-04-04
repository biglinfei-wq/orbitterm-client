#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARCH="arm64"
SIGNED_UPDATER="${SIGNED_UPDATER:-0}"
RUST_TOOLCHAIN="${RUST_TOOLCHAIN:-stable}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only runs on macOS."
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      ARCH="${2:-}"
      shift 2
      ;;
    --signed-updater)
      SIGNED_UPDATER="1"
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/local-build/build-macos-host.sh [options]

Options:
  --arch arm64|x64         macOS target arch. Default: arm64
  --signed-updater         Use updater signing mode (requires TAURI_PRIVATE_KEY)

Env:
  RUST_TOOLCHAIN           Rust toolchain version. Default: stable
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

case "${ARCH}" in
  arm64)
    TARGET_TRIPLE="aarch64-apple-darwin"
    DMG_ARCH_SUFFIX="aarch64"
    ;;
  x64)
    TARGET_TRIPLE="x86_64-apple-darwin"
    DMG_ARCH_SUFFIX="x64"
    ;;
  *)
    echo "Unsupported arch: ${ARCH}. Expected arm64 or x64."
    exit 1
    ;;
esac

command -v xcodebuild >/dev/null || { echo "xcodebuild not found. Please install Xcode."; exit 1; }
command -v rustup >/dev/null || { echo "rustup not found."; exit 1; }
command -v npm >/dev/null || { echo "npm not found."; exit 1; }
command -v hdiutil >/dev/null || { echo "hdiutil not found."; exit 1; }

if ! xcodebuild -version >/dev/null 2>&1; then
  cat <<'NEXT'
Xcode is installed but not fully activated.
Run these once in your local terminal:
  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept
  sudo xcodebuild -runFirstLaunch
NEXT
  exit 1
fi

if ! xcrun simctl list devices >/dev/null 2>&1; then
  echo "[WARN] iOS Simulator service is currently unavailable. macOS desktop build will continue."
fi

echo "[1/3] Installing frontend dependencies"
cd "${ROOT_DIR}"
npm ci

echo "[2/3] Building macOS installer (${TARGET_TRIPLE})"
export RUSTUP_TOOLCHAIN="${RUST_TOOLCHAIN}"
rustup toolchain install "${RUST_TOOLCHAIN}" >/dev/null
rustup target add "${TARGET_TRIPLE}" --toolchain "${RUST_TOOLCHAIN}" >/dev/null
APP_VERSION="$(node -e "const c=require('./src-tauri/tauri.conf.json');console.log(c.version || (c.package&&c.package.version) || require('./package.json').version)")"
APP_BUNDLE_DIR="${ROOT_DIR}/src-tauri/target/${TARGET_TRIPLE}/release/bundle"
APP_PATH="${APP_BUNDLE_DIR}/macos/OrbitTerm.app"
DMG_PATH="${APP_BUNDLE_DIR}/dmg/OrbitTerm_${APP_VERSION}_${DMG_ARCH_SUFFIX}.dmg"

cleanup_rw_dmg() {
  rm -f "${APP_BUNDLE_DIR}/macos"/rw.*.dmg 2>/dev/null || true
}

build_manual_dmg() {
  mkdir -p "${APP_BUNDLE_DIR}/dmg"
  cleanup_rw_dmg
  rm -f "${DMG_PATH}"
  hdiutil create \
    -volname "OrbitTerm" \
    -srcfolder "${APP_PATH}" \
    -ov \
    -format UDZO \
    "${DMG_PATH}"
}

TAURI_BUILD_EXIT=0
if [[ "${SIGNED_UPDATER}" == "1" && -n "${TAURI_PRIVATE_KEY:-}" ]]; then
  npx tauri build --target "${TARGET_TRIPLE}" || TAURI_BUILD_EXIT=$?
else
  TAURI_LOCAL_CONF="$(mktemp -t tauri.local.conf.XXXXXX.json)"
  node scripts/disable-tauri-updater.mjs src-tauri/tauri.conf.json "${TAURI_LOCAL_CONF}"
  npx tauri build --config "${TAURI_LOCAL_CONF}" --target "${TARGET_TRIPLE}" || TAURI_BUILD_EXIT=$?
  rm -f "${TAURI_LOCAL_CONF}"
fi

if [[ "${TAURI_BUILD_EXIT}" != "0" ]]; then
  if [[ -d "${APP_PATH}" ]]; then
    echo "[WARN] Tauri dmg bundling failed, but app bundle exists. Falling back to manual dmg generation."
  else
    echo "[ERROR] Tauri build failed with exit code ${TAURI_BUILD_EXIT} and app bundle was not generated."
    exit "${TAURI_BUILD_EXIT}"
  fi
fi

if [[ ! -d "${APP_PATH}" ]]; then
  echo "[ERROR] App bundle not found at ${APP_PATH}"
  exit 1
fi

if [[ -f "${DMG_PATH}" ]]; then
  if ! hdiutil verify "${DMG_PATH}" >/dev/null 2>&1; then
    echo "[WARN] Existing dmg failed verification. Rebuilding dmg manually."
    build_manual_dmg
  fi
else
  echo "[INFO] dmg not found. Building dmg manually."
  build_manual_dmg
fi

if ! hdiutil verify "${DMG_PATH}" >/dev/null 2>&1; then
  echo "[ERROR] Final dmg verification failed: ${DMG_PATH}"
  exit 1
fi

echo "[3/3] Generating checksums"
node scripts/local-build/generate-checksums.mjs

echo "macOS build complete."
echo "Artifacts: ${ROOT_DIR}/src-tauri/target/${TARGET_TRIPLE}/release/bundle"
