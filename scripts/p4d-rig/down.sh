#!/usr/bin/env bash
# Tear down the local p4d measurement rig (RUN-253). Default removes only the container — the
# volume (sample depot) and image (build cache) survive so the next up.sh is instant. Pass
# --volume to also drop the sample data, --image to also drop the built image, or --all for both.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

DROP_VOLUME=0
DROP_IMAGE=0
for arg in "$@"; do
  case "$arg" in
    --volume) DROP_VOLUME=1 ;;
    --image) DROP_IMAGE=1 ;;
    --all) DROP_VOLUME=1; DROP_IMAGE=1 ;;
    *) echo "error: unknown argument '$arg'" >&2; exit 1 ;;
  esac
done

if container_exists; then
  echo "Removing container ${CONTAINER_NAME}..."
  "$RUNTIME" rm -f "$CONTAINER_NAME" >/dev/null
else
  echo "No noriq-p4d container to remove."
fi

if [ "$DROP_VOLUME" -eq 1 ]; then
  if volume_exists; then
    echo "Removing volume ${VOLUME_NAME} (sample depot is gone; next up.sh+provision.sh rebuilds it)..."
    "$RUNTIME" volume rm "$VOLUME_NAME" >/dev/null
  fi
else
  echo "Volume ${VOLUME_NAME} left in place — pass --volume (or --all) to remove the sample depot too."
fi

if [ "$DROP_IMAGE" -eq 1 ]; then
  if image_exists; then
    echo "Removing image ${IMAGE}..."
    "$RUNTIME" rmi "$IMAGE" >/dev/null
  fi
else
  echo "Image ${IMAGE} left in place — pass --image (or --all) to remove the build too."
fi
