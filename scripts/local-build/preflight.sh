#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ok() {
  printf '[OK] %s\n' "$1"
}

warn() {
  printf '[WARN] %s\n' "$1"
}

info() {
  printf '[INFO] %s\n' "$1"
}

echo "OrbitTerm local build preflight"
echo "Project: ${ROOT_DIR}"
echo

if command -v docker >/dev/null; then
  ok "docker found: $(docker --version | sed 's/^Docker version //')"
else
  warn "docker not found"
fi

if docker info >/dev/null 2>&1; then
  ok "docker daemon is reachable"
else
  warn "docker daemon is NOT reachable (please start Docker Desktop)"
fi

if command -v docker >/dev/null && docker buildx version >/dev/null 2>&1; then
  ok "docker buildx available"
else
  warn "docker buildx not available"
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  info "Detected host OS: macOS ($(uname -m))"
  if command -v xcode-select >/dev/null 2>&1; then
    ok "xcode-select path: $(xcode-select -p 2>/dev/null || echo 'unknown')"
  fi
  if DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -version >/dev/null 2>&1; then
    ok "Xcode app is available at /Applications/Xcode.app"
  else
    warn "Xcode app not fully available (install Xcode from App Store)"
  fi
  if DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list devices >/dev/null 2>&1; then
    ok "iOS Simulator runtime query passed"
  else
    warn "iOS Simulator unavailable (usually Xcode license not accepted yet)"
  fi
  IOS_RUNTIMES="$(DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list runtimes 2>/dev/null | rg -v '^== Runtimes ==' | rg -v '^[[:space:]]*$' || true)"
  if [[ -n "${IOS_RUNTIMES}" ]]; then
    ok "iOS Simulator Runtime is installed"
  else
    warn "iOS Simulator Runtime not installed yet (run: xcodebuild -downloadPlatform iOS)"
  fi
else
  warn "Host is not macOS, macOS/iOS packaging is unavailable"
fi

if command -v rustup >/dev/null 2>&1; then
  ok "rustup found: $(rustup --version | head -n 1)"
  if rustup toolchain list | rg -n '^stable' >/dev/null 2>&1; then
    ok "Rust stable toolchain is installed"
  else
    warn "Rust stable toolchain is not installed yet (scripts will install it on first run)"
  fi
else
  warn "rustup not found (required for host macOS build)"
fi

if command -v node >/dev/null 2>&1; then
  ok "node found: $(node --version)"
else
  warn "node not found"
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm found: $(npm --version)"
else
  warn "npm not found"
fi

JAVA_BIN=""
if [[ -x "/opt/homebrew/opt/openjdk@17/bin/java" ]]; then
  JAVA_BIN="/opt/homebrew/opt/openjdk@17/bin/java"
elif command -v java >/dev/null 2>&1; then
  JAVA_BIN="$(command -v java)"
fi

if [[ -n "${JAVA_BIN}" ]]; then
  JAVA_VERSION_LINE="$("${JAVA_BIN}" -version 2>&1 | head -n 1 || true)"
  if [[ "${JAVA_VERSION_LINE}" == *"Unable to locate a Java Runtime"* ]]; then
    warn "java command exists but no usable JDK runtime detected"
  else
    ok "java found: ${JAVA_VERSION_LINE}"
  fi
else
  warn "java not found (Android prerequisite)"
fi

if command -v sdkmanager >/dev/null 2>&1; then
  ok "sdkmanager found"
else
  warn "sdkmanager not found (install android-commandlinetools)"
fi

if command -v adb >/dev/null 2>&1; then
  ok "adb found"
else
  warn "adb not found (install android-platform-tools)"
fi

if [[ -d "${HOME}/Library/Android/sdk" ]]; then
  ok "Android SDK directory exists: ${HOME}/Library/Android/sdk"
else
  warn "Android SDK directory missing: ${HOME}/Library/Android/sdk"
fi

if rg -n 'tauri = \{ version = "2' "${ROOT_DIR}/src-tauri/Cargo.toml" >/dev/null 2>&1; then
  ok "Current project uses Tauri v2"
else
  warn "Tauri v2 not detected; mobile packaging may be unavailable"
fi

echo
info "Suggested next steps:"
echo "  1) bash scripts/local-build/build-linux-docker.sh --arch amd64"
echo "  2) bash scripts/local-build/build-macos-host.sh --arch arm64"
echo "  3) bash scripts/local-build/build-macos-host.sh --arch x64"
echo "  4) bash scripts/local-build/build-ios.sh"
