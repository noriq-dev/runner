#!/usr/bin/env bash
# Shared constants and helpers for the p4d-rig scripts (RUN-253). Sourced, never executed
# directly — every entry point (up.sh, down.sh, provision.sh, measure.sh) starts by sourcing
# this so the container/volume/port names and the runtime-detection logic live in one place.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE_NAME=noriq-p4d
IMAGE_TAG="${P4D_IMAGE_TAG:-2026.1}"
IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
CONTAINER_NAME=noriq-p4d
VOLUME_NAME=noriq-p4root
P4D_PORT=1666
LOCAL_BIN_DIR="${SCRIPT_DIR}/.bin"

# lockedDecisions #2: podman is what this box has (no docker binary/socket), but detect rather
# than assume so a docker-only machine isn't dead on arrival. Whichever is found first wins; both
# speak the same CLI surface used below (build/run/exec/cp/volume/rm/stop).
detect_runtime() {
  if command -v podman >/dev/null 2>&1; then
    echo podman
  elif command -v docker >/dev/null 2>&1; then
    echo docker
  else
    echo "error: neither podman nor docker found on PATH" >&2
    exit 1
  fi
}
RUNTIME="$(detect_runtime)"

container_exists() {
  "$RUNTIME" container exists "$CONTAINER_NAME" 2>/dev/null
}

container_running() {
  [ "$("$RUNTIME" inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)" = "true" ]
}

volume_exists() {
  "$RUNTIME" volume exists "$VOLUME_NAME" 2>/dev/null
}

image_exists() {
  "$RUNTIME" image exists "$IMAGE" 2>/dev/null
}

# Resolve the p4 client without touching the caller's shell. up.sh copies the client out of the
# image into scripts/p4d-rig/.bin/ (gitignored) rather than a global path like ~/.local/bin — the
# rig should not leave anything outside this directory when torn down. Falls back to a `p4` already
# on PATH so a machine that already has one (or exported LOCAL_BIN_DIR itself) still works.
resolve_p4() {
  if [ -x "${LOCAL_BIN_DIR}/p4" ]; then
    echo "${LOCAL_BIN_DIR}/p4"
  elif command -v p4 >/dev/null 2>&1; then
    command -v p4
  else
    echo "error: no p4 client found — run up.sh first (it copies one out of the image into ${LOCAL_BIN_DIR})" >&2
    exit 1
  fi
}

# Every p4 invocation in provision.sh/measure.sh goes through this so P4PORT/P4USER stay pinned to
# the rig regardless of what the caller's environment happens to export.
p4() {
  local bin
  bin="$(resolve_p4)"
  P4PORT="localhost:${P4D_PORT}" P4USER=noriq "$bin" "$@"
}

wait_for_p4d() {
  local bin tries=30
  bin="$(resolve_p4)"
  while [ "$tries" -gt 0 ]; do
    if P4PORT="localhost:${P4D_PORT}" "$bin" -u noriq info >/dev/null 2>&1; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 1
  done
  echo "error: p4d did not become reachable on localhost:${P4D_PORT} in time" >&2
  return 1
}
