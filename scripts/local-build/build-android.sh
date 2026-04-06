#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

# shellcheck disable=SC1091
source scripts/local-build/mobile-env.sh

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage: bash scripts/local-build/build-android.sh [tauri-android-build-args]

Default args when omitted:
  --apk --debug -t aarch64 i686 x86_64
USAGE
  exit 0
fi

if ! command -v sdkmanager >/dev/null 2>&1; then
  echo "sdkmanager not found. Run: bash scripts/local-build/setup-mobile.sh"
  exit 1
fi

if [[ ! -d src-tauri/gen/android ]]; then
  echo "Android project not initialized. Run: npx tauri android init"
  exit 1
fi

# Some Android WebView runtimes may show touch-hit inconsistencies when
# edge-to-edge is enabled by default. Ensure the generated MainActivity uses
# the safer baseline behavior before each local package build.
MAIN_ACTIVITY_FILE="$(find src-tauri/gen/android/app/src/main/java -name MainActivity.kt | head -n 1 || true)"
if [[ -n "${MAIN_ACTIVITY_FILE}" && -f "${MAIN_ACTIVITY_FILE}" ]]; then
  perl -0pi -e 's/\nimport androidx\.activity\.enableEdgeToEdge\s*\n/\n/g' "${MAIN_ACTIVITY_FILE}"
  perl -0pi -e 's/\n\s*enableEdgeToEdge\(\)\s*\n/\n/g' "${MAIN_ACTIVITY_FILE}"
fi

ANDROID_MANIFEST_FILE="src-tauri/gen/android/app/src/main/AndroidManifest.xml"
if [[ -f "${ANDROID_MANIFEST_FILE}" ]]; then
  if ! grep -q 'xmlns:tools="http://schemas.android.com/tools"' "${ANDROID_MANIFEST_FILE}"; then
    perl -0pi -e 's#<manifest xmlns:android="http://schemas.android.com/apk/res/android">#<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">#' "${ANDROID_MANIFEST_FILE}"
  fi
  if ! grep -q 'tools:replace="android:theme"' "${ANDROID_MANIFEST_FILE}"; then
    perl -0pi -e 's#android:theme="([^"]+)"#android:theme="$1"\n        tools:replace="android:theme"#' "${ANDROID_MANIFEST_FILE}"
  fi
fi

if [[ $# -eq 0 ]]; then
  # Build an installable multi-ABI debug APK by default so common Android
  # emulators (x86/x86_64) and modern physical devices (arm64-v8a) can run it.
  # Release APK output is unsigned by default in this project.
  set -- --apk --debug -t aarch64 i686 x86_64
fi

npx tauri android build "$@"
