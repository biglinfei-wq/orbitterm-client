#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SKIP_ANDROID=0
SKIP_IOS=0

ANDROID_PLATFORM="${ANDROID_PLATFORM:-android-35}"
ANDROID_BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-35.0.0}"
ANDROID_NDK_VERSION="${ANDROID_NDK_VERSION:-29.0.14206865}"
ANDROID_CMAKE_VERSION="${ANDROID_CMAKE_VERSION:-3.22.1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-android)
      SKIP_ANDROID=1
      shift
      ;;
    --skip-ios)
      SKIP_IOS=1
      shift
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: bash scripts/local-build/setup-mobile.sh [options]

Options:
  --skip-android   Skip Android toolchain setup
  --skip-ios       Skip iOS toolchain setup
USAGE
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only supports macOS."
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install Homebrew first."
  exit 1
fi

cd "${ROOT_DIR}"

if [[ "${SKIP_ANDROID}" == "0" ]]; then
  echo "[Android 1/4] Installing Homebrew packages"
  brew install openjdk@17 android-commandlinetools android-platform-tools

  # shellcheck disable=SC1091
  source scripts/local-build/mobile-env.sh

  echo "[Android 2/4] Installing SDK components into ${ANDROID_HOME}"
  mkdir -p "${ANDROID_HOME}"
  yes | sdkmanager --sdk_root="${ANDROID_HOME}" --licenses >/tmp/android-sdk-licenses.log
  sdkmanager --sdk_root="${ANDROID_HOME}" \
    "platform-tools" \
    "platforms;${ANDROID_PLATFORM}" \
    "build-tools;${ANDROID_BUILD_TOOLS}" \
    "ndk;${ANDROID_NDK_VERSION}" \
    "cmake;${ANDROID_CMAKE_VERSION}"

  echo "[Android 3/4] Installing Rust Android targets"
  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

  echo "[Android 4/4] Initializing Tauri Android project"
  if [[ -d src-tauri/gen/android ]]; then
    echo "Android project already initialized: src-tauri/gen/android"
  else
    npx tauri android init
  fi
fi

if [[ "${SKIP_IOS}" == "0" ]]; then
  echo "[iOS 1/3] Installing Homebrew packages"
  brew install xcodegen libimobiledevice cocoapods

  # shellcheck disable=SC1091
  source scripts/local-build/mobile-env.sh

  echo "[iOS 2/3] Installing Rust iOS targets"
  rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

  echo "[iOS 3/3] Initializing Tauri iOS project"
  if [[ -d src-tauri/gen/apple ]]; then
    echo "iOS project already initialized: src-tauri/gen/apple"
  else
    DEVELOPER_DIR="${DEVELOPER_DIR}" npx tauri ios init
  fi

  if ! DEVELOPER_DIR="${DEVELOPER_DIR}" xcrun simctl list devices >/dev/null 2>&1; then
    cat <<'NEXT'

Xcode is installed but not fully activated.
Run these once in your local terminal:
  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept
  sudo xcodebuild -runFirstLaunch

Then re-run:
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list devices
NEXT
  fi
fi

echo "Mobile setup complete."
