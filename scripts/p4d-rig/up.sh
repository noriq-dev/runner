#!/usr/bin/env bash
# Bring up the local p4d measurement rig (RUN-253): build the image if needed, create the data
# volume, apply the one-time configurables against a stopped server, then start the container.
# Idempotent — running this twice in a row must be harmless (acceptance truth): if the container
# already exists we only make sure it's running, we never re-touch the volume or reapply
# configurables to a server that has already been initialized.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    *) echo "error: unknown argument '$arg'" >&2; exit 1 ;;
  esac
done

if container_exists; then
  if container_running; then
    echo "noriq-p4d is already up (${IMAGE})."
  else
    echo "Starting existing noriq-p4d container..."
    "$RUNTIME" start "$CONTAINER_NAME" >/dev/null
    wait_for_p4d
    echo "noriq-p4d is up at localhost:${P4D_PORT}."
  fi
  exit 0
fi

if [ "$REBUILD" -eq 1 ] || ! image_exists; then
  echo "Building ${IMAGE} from package.perforce.com (lockedDecisions #1 — never a third-party image)..."
  BUILD_ARGS=()
  if [ -n "${P4D_PKG_VERSION:-}" ]; then
    BUILD_ARGS+=(--build-arg "P4D_PKG_VERSION=${P4D_PKG_VERSION}")
  fi
  "$RUNTIME" build "${BUILD_ARGS[@]}" -t "$IMAGE" "$SCRIPT_DIR"
fi

if ! volume_exists; then
  echo "Creating volume ${VOLUME_NAME}..."
  "$RUNTIME" volume create "$VOLUME_NAME" >/dev/null
fi

# Recorded before anything below touches the volume — `p4d -cset` (next step) creates db.config as
# a side effect, so checking for it after that step would always say "not fresh".
FRESH=0
if [ -z "$("$RUNTIME" run --rm -v "${VOLUME_NAME}:/p4root" "$IMAGE" sh -c 'ls /p4root/db.config 2>/dev/null')" ]; then
  FRESH=1
fi

# Setup trap #2: a fresh 2026.1 server refuses unauthenticated commands past `p4 info`
# ("Perforce password (P4PASSWD) invalid or unset", `p4 client -i` reports "Client unknown") unless
# BOTH security=0 and dm.user.noautocreate=0 are set before the server ever starts for real users.
# Setup trap #1: `p4d -cset` takes ONE quoted argument — `p4d -r /p4root "-cset key=value"`. The
# two-arg form (`-cset "key=value"`) fails with "Unexpected arguments" per key, silently setting
# nothing while looking like it worked. One throwaway container invocation per key below.
# Setup trap #3: logging to /dev/stdout trips p4d's free-space precheck (/dev is a small tmpfs:
# "only 64M free ... requires at least 250M"). We log into the volume instead (p4d.log, set via
# CMD below) and lower every filesys.*.min so the precheck passes against a small sample volume.
apply_configurables() {
  local kv
  for kv in "security=0" "dm.user.noautocreate=0" "filesys.P4ROOT.min=10M" \
    "filesys.depot.min=10M" "filesys.P4JOURNAL.min=10M" "filesys.P4LOG.min=10M"; do
    "$RUNTIME" run --rm -v "${VOLUME_NAME}:/p4root" "$IMAGE" \
      /opt/perforce/sbin/p4d -r /p4root "-cset ${kv}" >/dev/null
  done
}
echo "Applying configurables (server stopped, one throwaway container per key)..."
apply_configurables

# Setup trap #4 (found by this rig's own teardown-and-rebuild verification, not in any doc): a
# brand-new P4ROOT's FIRST live start runs a one-time topology-registration bootstrap pass — the
# log says outright "No entries made in db.topology ... a server restart is required" — and that
# pass silently resets `security` back to the package default (4), undoing the -cset above even
# though nothing after it touched db.config. One throwaway bootstrap start+stop, then re-applying
# the configurables, makes the value stick; every start after this one is stable (verified by
# repeated restart in this rig's own round-trip test). Skipped when the volume already has data —
# only a genuinely empty P4ROOT runs the topology bootstrap.
if [ "$FRESH" -eq 1 ]; then
  echo "Fresh P4ROOT — running the one-time topology bootstrap pass, then reapplying configurables..."
  "$RUNTIME" run -d --name "${CONTAINER_NAME}-bootstrap" -v "${VOLUME_NAME}:/p4root" "$IMAGE" \
    /opt/perforce/sbin/p4d -r /p4root -p "0.0.0.0:${P4D_PORT}" -L /p4root/p4d.log >/dev/null
  tries=30
  while [ "$tries" -gt 0 ] && [ "$("$RUNTIME" inspect -f '{{.State.Running}}' "${CONTAINER_NAME}-bootstrap" 2>/dev/null)" != "true" ]; do
    tries=$((tries - 1)); sleep 1
  done
  sleep 2
  "$RUNTIME" rm -f "${CONTAINER_NAME}-bootstrap" >/dev/null
  apply_configurables
fi

echo "Starting noriq-p4d..."
# lockedDecisions #4's "acceptable because bound to localhost" is a claim about the PUBLISHED
# port, not the in-container listen address — `-p N:N` alone publishes to 0.0.0.0 on the host
# (confirmed by inspecting the socket: it listens on every interface, not just loopback), which
# would make an open, passwordless p4d reachable from the LAN. Pin the publish to 127.0.0.1 so the
# safety reasoning is actually true rather than merely asserted.
"$RUNTIME" run -d --name "$CONTAINER_NAME" -p "127.0.0.1:${P4D_PORT}:${P4D_PORT}" \
  -v "${VOLUME_NAME}:/p4root" "$IMAGE" \
  /opt/perforce/sbin/p4d -r /p4root -p "0.0.0.0:${P4D_PORT}" -L /p4root/p4d.log >/dev/null

mkdir -p "$LOCAL_BIN_DIR"
if [ ! -x "${LOCAL_BIN_DIR}/p4" ]; then
  echo "Copying p4 client out of the image to ${LOCAL_BIN_DIR}/p4 (this box has no p4 package; see README)..."
  "$RUNTIME" cp "${CONTAINER_NAME}:/opt/perforce/bin/p4" "${LOCAL_BIN_DIR}/p4"
  chmod +x "${LOCAL_BIN_DIR}/p4"
fi

wait_for_p4d
echo "noriq-p4d is up at localhost:${P4D_PORT}. Run provision.sh next."
