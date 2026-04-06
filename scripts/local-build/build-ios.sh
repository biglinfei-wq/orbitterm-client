#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

# shellcheck disable=SC1091
source scripts/local-build/mobile-env.sh

SKIP_RUNTIME_CHECK="${IOS_SKIP_RUNTIME_CHECK:-0}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage: bash scripts/local-build/build-ios.sh [options] [-- tauri-ios-build-args]

Options:
  --skip-runtime-check   Skip iOS Simulator Runtime precheck

Default args when omitted:
  --debug --target aarch64-sim
USAGE
  exit 0
fi

if [[ "${1:-}" == "--skip-runtime-check" ]]; then
  SKIP_RUNTIME_CHECK=1
  shift
fi

if [[ ! -d src-tauri/gen/apple ]]; then
  echo "iOS project not initialized. Run: DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer npx tauri ios init"
  exit 1
fi

if ! DEVELOPER_DIR="${DEVELOPER_DIR}" xcrun simctl list devices >/dev/null 2>&1; then
  cat <<'NEXT'
Xcode is installed but not fully activated.
Run these once in your local terminal:
  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept
  sudo xcodebuild -runFirstLaunch

Then retry this command.
NEXT
  exit 1
fi

if [[ "${SKIP_RUNTIME_CHECK}" != "1" ]]; then
  RUNTIME_LINES="$(DEVELOPER_DIR="${DEVELOPER_DIR}" xcrun simctl list runtimes 2>/dev/null | rg -v '^== Runtimes ==' | rg -v '^[[:space:]]*$' || true)"
  if [[ -z "${RUNTIME_LINES}" ]]; then
    cat <<'NEXT'
No iOS Simulator Runtime is installed yet.
Install it once, then retry:
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -downloadPlatform iOS

If download speed is slow in terminal, install from Xcode GUI:
  Xcode -> Settings -> Components -> iOS Simulator
NEXT
    exit 1
  fi
fi

if [[ $# -eq 0 ]]; then
  set -- --debug --target aarch64-sim
fi

DEVELOPER_DIR="${DEVELOPER_DIR}" npx tauri ios build "$@"
