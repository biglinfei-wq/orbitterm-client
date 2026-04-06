#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

INCLUDE_LINUX_AMD64=1
INCLUDE_LINUX_ARM64=1
INCLUDE_MAC_ARM64=1
INCLUDE_MAC_X64=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --desktop-only)
      shift
      ;;
    --skip-linux-arm64)
      INCLUDE_LINUX_ARM64=0
      shift
      ;;
    --skip-mac-x64)
      INCLUDE_MAC_X64=0
      shift
      ;;
    --skip-mac-arm64)
      INCLUDE_MAC_ARM64=0
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/local-build/build-all.sh [options]

Options:
  --skip-linux-arm64    Skip Linux arm64 docker build
  --skip-mac-arm64      Skip macOS arm64 host build
  --skip-mac-x64        Skip macOS x64 host build
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

cd "${ROOT_DIR}"

if [[ "${INCLUDE_LINUX_AMD64}" == "1" ]]; then
  bash scripts/local-build/build-linux-docker.sh --arch amd64
fi

if [[ "${INCLUDE_LINUX_ARM64}" == "1" ]]; then
  bash scripts/local-build/build-linux-docker.sh --arch arm64
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ "${INCLUDE_MAC_ARM64}" == "1" ]]; then
    bash scripts/local-build/build-macos-host.sh --arch arm64
  fi
  if [[ "${INCLUDE_MAC_X64}" == "1" ]]; then
    bash scripts/local-build/build-macos-host.sh --arch x64
  fi
else
  echo "Not on macOS, skip macOS host builds."
fi

echo "All selected desktop builds finished."

