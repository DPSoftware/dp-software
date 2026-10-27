#!/usr/bin/env bash
# Dev link: points libs/point-cloud-wasm/src/lib/wasm (git-ignored) at the wasm-pack build output of the
# private Rust repo checked out in external/pointcloud-processor-rs. Safe to re-run.
# With --check it only verifies that the link target exists (used by the build target).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="$ROOT/external/pointcloud-processor-rs/crates/point-cloud-wasm-core/pkg"
LINK="$ROOT/libs/point-cloud-wasm/src/lib/wasm"

if [ "${1:-}" = "--check" ]; then
    if [ ! -f "$LINK/point_cloud_wasm_core.js" ] || [ ! -f "$LINK/point_cloud_wasm_core_bg.wasm" ]; then
        echo "error: $LINK has no wasm build. Run scripts/build-wasm.sh in external/pointcloud-processor-rs, then tools/scripts/link-wasm.sh" >&2
        exit 1
    fi
    exit 0
fi

if [ ! -d "$PKG" ]; then
    echo "warning: $PKG does not exist yet; run scripts/build-wasm.sh in the Rust repo first" >&2
fi

rm -f "$ROOT/node_modules/@dp-software/point-cloud-wasm-core"
ln -sfn "$PKG" "$LINK"
echo "linked libs/point-cloud-wasm/src/lib/wasm -> $PKG"
