#!/usr/bin/env bash
# Re-run the measurement queries RUN-253/RUN-254 were built against and print their output, so a
# p4d version bump (or a rebuild after the pinned package moves) is re-verifiable in one command
# rather than by trusting last time's numbers. Every command below runs with
# P4CLIENT=no-such-client-at-all — the measured fact that a depot read needs no workspace, which
# is the entire basis for RUN-254's design (a depot read takes no workspace and no pool lease).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

wait_for_p4d

p4() {
  local bin
  bin="$(resolve_p4)"
  P4PORT="localhost:${P4D_PORT}" P4USER=noriq P4CLIENT=no-such-client-at-all "$bin" "$@"
}

echo "### p4 info (no client)"
p4 info

echo
echo "### p4 files //depot/...@2  (deletions and moves must both appear)"
p4 files //depot/...@2

echo
echo "### p4 fstat -Ol //depot/src/add.ts#2  (field-name trap: tag is 'digest', not 'headDigest';"
echo "### 'headDigest' parses fine and returns EMPTY. Digest algorithm is MD5.)"
p4 fstat -Ol //depot/src/add.ts#2

echo
echo "### p4 diff2 -q //depot/...@1 //depot/...@2  (added/deleted/modified header shapes —"
echo "### note the deleted arm ends in three '=' where the others end in four; parse by the"
echo "### '<none>' position and the trailing 'content' marker, never by counting '=')"
p4 diff2 -q //depot/...@1 //depot/...@2

echo
echo "### p4 -V (server + client version actually running)"
p4 -V
