#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

echo "[1/3] Type check"
npm run typecheck

echo "[2/3] Android snippet workflow regression tests"
npm run test:android:regression

echo "[3/3] Build smoke check"
npm run build

echo "Android regression checks passed."
