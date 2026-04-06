#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="orbitterm/tauri-linux-builder:node24"
ARCH="amd64"
SIGNED_UPDATER="${SIGNED_UPDATER:-0}"
RUST_TOOLCHAIN="${RUST_TOOLCHAIN:-stable}"
LINUX_TARGETS="${LINUX_TARGETS:-deb,rpm}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      ARCH="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE_NAME="${2:-}"
      shift 2
      ;;
    --signed-updater)
      SIGNED_UPDATER="1"
      shift
      ;;
    --linux-targets)
      LINUX_TARGETS="${2:-}"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/local-build/build-linux-docker.sh [options]

Options:
  --arch amd64|arm64       Linux target arch. Default: amd64
  --image <name:tag>       Override builder image name
  --signed-updater         Use updater signing mode (requires TAURI_PRIVATE_KEY)
  --linux-targets <list>   Bundles to build, comma-separated. Default: deb,rpm

Env:
  RUST_TOOLCHAIN           Rust toolchain version. Default: stable
  LINUX_TARGETS            Same as --linux-targets
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
  amd64)
    DOCKER_PLATFORM="linux/amd64"
    TARGET_TRIPLE="x86_64-unknown-linux-gnu"
    ;;
  arm64)
    DOCKER_PLATFORM="linux/arm64"
    TARGET_TRIPLE="aarch64-unknown-linux-gnu"
    ;;
  *)
    echo "Unsupported arch: ${ARCH}. Expected amd64 or arm64."
    exit 1
    ;;
esac

ARCH_IMAGE="${IMAGE_NAME}-${ARCH}"

echo "[1/3] Building local Linux builder image: ${ARCH_IMAGE}"
docker build \
  --platform "${DOCKER_PLATFORM}" \
  --build-arg "RUST_TOOLCHAIN=${RUST_TOOLCHAIN}" \
  -f "${ROOT_DIR}/docker/local-builder/Dockerfile" \
  -t "${ARCH_IMAGE}" \
  "${ROOT_DIR}"

echo "[2/3] Running Tauri build in Docker (${DOCKER_PLATFORM}, ${TARGET_TRIPLE})"
docker run --rm \
  --platform "${DOCKER_PLATFORM}" \
  -e TAURI_PRIVATE_KEY \
  -e TAURI_KEY_PASSWORD \
  -e SIGNED_UPDATER="${SIGNED_UPDATER}" \
  -e LINUX_TARGETS="${LINUX_TARGETS}" \
  -e RUSTUP_TOOLCHAIN="${RUST_TOOLCHAIN}" \
  -e npm_config_cache="/tmp/.npm-cache" \
  -v "${ROOT_DIR}:/workspace" \
  -w /workspace \
  "${ARCH_IMAGE}" \
  bash -lc "
set -euo pipefail
npm ci
if [[ \"\${SIGNED_UPDATER}\" == \"1\" && -n \"\${TAURI_PRIVATE_KEY:-}\" ]]; then
  npx tauri build --target ${TARGET_TRIPLE} --bundles \"\${LINUX_TARGETS}\"
else
  TAURI_LOCAL_CONF=\"/tmp/tauri.local.conf.json\"
  node scripts/disable-tauri-updater.mjs src-tauri/tauri.conf.json \"\${TAURI_LOCAL_CONF}\"
  npx tauri build --config \"\${TAURI_LOCAL_CONF}\" --target ${TARGET_TRIPLE} --bundles \"\${LINUX_TARGETS}\"
fi
node scripts/local-build/generate-checksums.mjs
"

echo "[3/3] Linux build complete."
echo "Artifacts: ${ROOT_DIR}/src-tauri/target/${TARGET_TRIPLE}/release/bundle"
