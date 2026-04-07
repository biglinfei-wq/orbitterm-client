#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

# shellcheck disable=SC1091
source scripts/local-build/mobile-env.sh

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage: bash scripts/local-build/build-android-release.sh [--with-debug-universal]

Builds Android release APK artifacts:
  1) arm64 release
  2) x86_64 release
  3) universal release
Optional:
  --with-debug-universal   Also package universal debug APK (for emulator troubleshooting)

Outputs:
  releases/v<version>/OrbitTerm_<version>_android-*.apk
  releases/v<version>/SHA256SUMS.android.txt
  releases/latest.json (if exists) android metadata updated
USAGE
  exit 0
fi

WITH_DEBUG_UNIVERSAL=0
if [[ "${1:-}" == "--with-debug-universal" ]]; then
  WITH_DEBUG_UNIVERSAL=1
fi

VERSION_RAW="$(node -e "const pkg=require('./package.json'); process.stdout.write(String(pkg.version||'0.0.0'))")"
VERSION_TAG="v${VERSION_RAW}"
RELEASE_DIR="releases/${VERSION_TAG}"
mkdir -p "${RELEASE_DIR}"

if ! command -v sdkmanager >/dev/null 2>&1; then
  echo "sdkmanager not found. Run: bash scripts/local-build/setup-mobile.sh"
  exit 1
fi

if [[ ! -d src-tauri/gen/android ]]; then
  echo "Android project not initialized. Run: npx tauri android init"
  exit 1
fi

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

echo "[1/4] Build split release APKs (arm64 + x86_64)"
npx tauri android build --apk --split-per-abi -t aarch64 x86_64

echo "[2/4] Build universal release APK"
npx tauri android build --apk -t aarch64

if [[ "${WITH_DEBUG_UNIVERSAL}" == "1" ]]; then
  echo "[2.5/4] Build universal debug APK"
  npx tauri android build --apk --debug -t aarch64 i686 x86_64
fi

ARM64_UNSIGNED="src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release-unsigned.apk"
X64_UNSIGNED="src-tauri/gen/android/app/build/outputs/apk/x86_64/release/app-x86_64-release-unsigned.apk"
UNIVERSAL_UNSIGNED="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
UNIVERSAL_DEBUG="src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"

ARM64_OUT="${RELEASE_DIR}/OrbitTerm_${VERSION_RAW}_android-arm64.apk"
X64_OUT="${RELEASE_DIR}/OrbitTerm_${VERSION_RAW}_android-x86_64.apk"
UNIVERSAL_OUT="${RELEASE_DIR}/OrbitTerm_${VERSION_RAW}_android-universal.apk"
UNIVERSAL_DEBUG_OUT="${RELEASE_DIR}/OrbitTerm_${VERSION_RAW}_android-universal-debug.apk"

APKSIGNER="$(find "${ANDROID_HOME}/build-tools" -name apksigner -type f 2>/dev/null | sort -V | tail -n 1 || true)"

KS_FILE="${ORBITTERM_ANDROID_KEYSTORE:-${HOME}/.android/debug.keystore}"
KS_ALIAS="${ORBITTERM_ANDROID_KEY_ALIAS:-androiddebugkey}"
KS_PASS="${ORBITTERM_ANDROID_KEYSTORE_PASSWORD:-android}"
KEY_PASS="${ORBITTERM_ANDROID_KEY_PASSWORD:-android}"

sign_or_copy_apk() {
  local src="$1"
  local dest="$2"
  if [[ ! -f "${src}" ]]; then
    echo "[WARN] Missing source APK: ${src}"
    return 1
  fi
  if [[ -n "${APKSIGNER}" && -f "${KS_FILE}" ]]; then
    "${APKSIGNER}" sign \
      --ks "${KS_FILE}" \
      --ks-key-alias "${KS_ALIAS}" \
      --ks-pass "pass:${KS_PASS}" \
      --key-pass "pass:${KEY_PASS}" \
      --out "${dest}" \
      "${src}"
  else
    cp -f "${src}" "${dest}"
    echo "[WARN] apksigner or keystore missing, copied unsigned APK: ${dest}"
  fi
}

echo "[3/4] Sign/package APKs"
sign_or_copy_apk "${ARM64_UNSIGNED}" "${ARM64_OUT}"
sign_or_copy_apk "${X64_UNSIGNED}" "${X64_OUT}"
sign_or_copy_apk "${UNIVERSAL_UNSIGNED}" "${UNIVERSAL_OUT}"
if [[ "${WITH_DEBUG_UNIVERSAL}" == "1" && -f "${UNIVERSAL_DEBUG}" ]]; then
  sign_or_copy_apk "${UNIVERSAL_DEBUG}" "${UNIVERSAL_DEBUG_OUT}"
fi

echo "[4/4] Generate checksums and update release metadata"
(
  cd "${RELEASE_DIR}"
  shasum -a 256 ./*.apk > SHA256SUMS.android.txt
)
node scripts/local-build/update-android-release-meta.mjs "${VERSION_TAG}" "${RELEASE_DIR}"

echo "Done."
echo "Artifacts:"
ls -lh "${RELEASE_DIR}"/*.apk
