#!/bin/bash
# Installs CAT with the GPU-accelerated SAM3 segmentation service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec env CAT_INSTALL_VARIANT=gpu bash "$SCRIPT_DIR/install_cat.sh" "$@"