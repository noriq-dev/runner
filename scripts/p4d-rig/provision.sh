#!/usr/bin/env bash
# Populate the sample depot RUN-253/RUN-254 need: one client, two changelists, and the exact
# fixture matrix RUN-254's design was measured against (lockedDecisions #5) — including the
# binary file (content-based binary detection) and config/.env (RUN-209's deny-list fixture: a
# depot read hands a secret over cheerfully via `p4 print`, same as a filesystem read would).
# Idempotent — if change 2 is already submitted, do nothing rather than re-submitting.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

wait_for_p4d

if p4 changes -m1 //depot/... 2>/dev/null | grep -q '^Change 2 '; then
  echo "Sample depot already provisioned (change 2 present) — nothing to do."
  exit 0
fi

# Outside the repo tree entirely, not just gitignored: biome's VCS integration (biome.json
# `vcs.useIgnoreFile`) only honours the ROOT .gitignore in this biome version, not this directory's
# nested one — a workspace left under scripts/p4d-rig/ with real (sample) .ts/.json content in it
# broke `npm run check` the first time this rig was round-trip tested. A system temp dir sidesteps
# the whole class of problem instead of relying on ignore-file scope.
WS="${TMPDIR:-/tmp}/noriq-p4d-rig-workspace"
rm -rf "$WS"
mkdir -p "$WS"

CLIENT_NAME=noriq-sample
p4() {
  local bin
  bin="$(resolve_p4)"
  P4PORT="localhost:${P4D_PORT}" P4USER=noriq P4CLIENT="$CLIENT_NAME" "$bin" "$@"
}

p4 client -i <<EOF
Client: ${CLIENT_NAME}
Owner:  noriq
Root:   ${WS}
Options: noallwrite noclobber nocompress unlocked nomodtime normdir
SubmitOptions: submitunchanged
LineEnd: local
View:
	//depot/... //${CLIENT_NAME}/...
EOF

# --- change 1: initial tree -------------------------------------------------------------------
mkdir -p "${WS}/src/util" "${WS}/docs" "${WS}/config"

printf 'export function add(a: number, b: number) {\n  return a + b;\n}\n' > "${WS}/src/add.ts"
printf 'export const NAME = "sample";\n' > "${WS}/src/util/name.ts"
printf '# Sample\n\nA heading and a paragraph.\n' > "${WS}/docs/README.md"
printf '{ "key": "value" }\n' > "${WS}/config/app.json"
printf 'SECRET_TOKEN=should-never-be-indexed\n' > "${WS}/config/.env"
printf 'to be deleted\n' > "${WS}/docs/OLD.md"
printf 'to be renamed\n' > "${WS}/src/before.ts"
# Field-name trap: binary detection must be content-based, not extension-based — this is what
# proves it. 4096 bytes of real randomness; the exact bytes are never asserted on, only that the
# server (and later the runner) recognizes the file as binary regardless of extension.
head -c 4096 /dev/urandom > "${WS}/src/blob.bin"

p4 add "${WS}/src/add.ts" "${WS}/src/util/name.ts" "${WS}/docs/README.md" \
  "${WS}/config/app.json" "${WS}/config/.env" "${WS}/docs/OLD.md" "${WS}/src/before.ts"
p4 add -t binary "${WS}/src/blob.bin"
p4 submit -d "sample: initial tree"

# --- change 2: modify, delete, rename, add ----------------------------------------------------
p4 edit "${WS}/src/add.ts"
printf 'export function add(a: number, b: number) {\n  return a + b; // modified\n}\n' > "${WS}/src/add.ts"

p4 delete "${WS}/docs/OLD.md"

# p4 move requires the source open for edit first; the server then reports it as move/add at the
# new path and move/delete at the old one (field-name trap — `p4 files` lists both halves).
p4 edit "${WS}/src/before.ts"
p4 move "${WS}/src/before.ts" "${WS}/src/after.ts"

printf 'newly added\n' > "${WS}/docs/NEW.md"
p4 add "${WS}/docs/NEW.md"

p4 submit -d "sample: modify, delete, rename, add"

echo "Provisioned //depot with 2 changelists. Verify: p4 files //depot/...@2"
