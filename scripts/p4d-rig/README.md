# p4d measurement rig (RUN-253)

A local, disposable Perforce server for measuring the depot-read path against a *real* `p4d`
rather than assuming its behaviour — the same "measured, not assumed" tradition as VCS-SPIKE.md's
RUN-51/RUN-55 hands-on sections. RUN-254 (the depot-read implementation in
`src/vcs/perforce.ts`) is designed against the facts this rig produces; this directory exists so
those facts stay re-verifiable instead of resting on one closed terminal.

**Never wired into `npm run check`, CI, or the build (lockedDecisions #3).** CI has no depot, and
a test suite that needs a container is a suite people learn to skip. Nothing here runs unless you
run it yourself.

## Quick start

```bash
scripts/p4d-rig/up.sh          # build image (first run only), start p4d at localhost:1666
scripts/p4d-rig/provision.sh   # create the sample depot + two changelists (idempotent)
scripts/p4d-rig/measure.sh     # re-run the measurement queries this rig was built to answer
scripts/p4d-rig/down.sh        # stop and remove the container; volume + image survive
scripts/p4d-rig/down.sh --all  # also drop the sample depot and the built image
```

Every script is idempotent — see "Idempotency" below for exactly what that means per script.

## Why this is safe to run: the open-security caveat (lockedDecisions #4)

The server runs with `security=0` and **no passwords** — anyone who can reach `localhost:1666`
has full access, including super-user operations. That is acceptable **only** because:

- it is bound to `localhost` only — `up.sh` publishes `127.0.0.1:1666:1666`, pinned deliberately.
  A bare `-p 1666:1666` (no host IP) publishes to `0.0.0.0` on most podman/docker setups instead —
  confirmed by inspecting the actual listening socket during this rig's build, not assumed — which
  would make an open, passwordless p4d reachable from the whole LAN. If you ever change the
  `-p` flag in `up.sh`, keep the `127.0.0.1:` prefix or this paragraph stops being true;
- it holds nothing but the synthetic sample tree provisioning creates;
- it is destroyed and rebuilt routinely.

**This must never become a place real work lives.** If you find yourself tempted to point it at
an actual project's depot, stop — that is a different, hardened setup this rig does not provide.

## What gets built, and from where (lockedDecisions #1)

`Dockerfile` builds from `registry.fedoraproject.org/fedora:44`, imports Perforce's own signing
key (`rpm --import https://package.perforce.com/perforce.pubkey`), adds a `[perforce]` yum repo at
`https://package.perforce.com/yum/rhel/10/x86_64` with `gpgcheck=1`, and installs a **pinned**
`p4-server`/`p4-cli` build (`2026.1-2972966.el10` by default — override for one build with
`P4D_PKG_VERSION=2026.2-... scripts/p4d-rig/up.sh --rebuild`, or edit the Dockerfile's `ARG`
default to change it permanently). Tagged `noriq-p4d:2026.1` — override with `P4D_IMAGE_TAG` if
you want a different tag to coexist rather than replace the pinned build.

Do **not** switch this to a third-party image (e.g. `docker.io/perforce/helix-p4d`) even though
one exists on Docker Hub: it returned "requested access to the resource is denied" when measured
for this task (not publicly pullable), and `cdn.perforce.com` does not resolve from this network.
Every Docker Hub alternative is an unknown publisher shipping a version-control server — that
trust question doesn't expire just because the build takes a few minutes. `package.perforce.com`
is the working official source; build from it or don't build.

Server binary: `/opt/perforce/sbin/p4d`. Client binary: `/opt/perforce/bin/p4`.

## Runtime: podman, detected not assumed (lockedDecisions #2)

This box has podman 5.8.4 and no `docker` binary or socket, so the scripts default to podman —
but `lib.sh` detects whichever of `podman`/`docker` is on `PATH` first and uses that runtime's CLI
throughout (`build`/`run`/`exec`/`cp`/`volume`/`rm`/`stop` — the two tools share this surface).
Untested against docker specifically; flag it if it breaks there.

## Where the host `p4` client lives, and why

This box is immutable-base Fedora with no `p4` package available anywhere on it. `up.sh` copies
the client binary out of the built image into `scripts/p4d-rig/.bin/p4` (gitignored) rather than
somewhere global like `~/.local/bin` — the rig should not leave anything outside this directory
that a teardown has to know to clean up. `lib.sh`'s `resolve_p4` prefers that local copy and falls
back to a `p4` already on `PATH`, so `provision.sh`/`measure.sh` work with no manual `PATH` or
`P4PORT`/`P4USER` exports. If you want `p4` on your interactive shell's `PATH` too, that's a
`PATH="$PWD/scripts/p4d-rig/.bin:$PATH"` away — nothing stops you, it's just not what the scripts
themselves depend on. (Do not commit this binary — see below.)

## Do not commit the `p4` binary (lockedDecisions #6)

`.gitignore` in this directory excludes `.bin/` (the copied client) for the same reason: a ~30MB
vendor binary in git is something every future contributor has to notice and undo before they can
work. Nothing under it is ever committed; `up.sh` regenerates it on demand.

`provision.sh`'s scratch client workspace (where the sample files actually get written before
`p4 add`/`p4 submit`) lives under `${TMPDIR:-/tmp}/noriq-p4d-rig-workspace` — **outside the repo
entirely**, not merely gitignored. The first round-trip test of this rig put it under
`scripts/p4d-rig/.workspace/` instead, and it broke `npm run check`: biome's VCS integration
(`biome.json`'s `vcs.useIgnoreFile`) only reads the ROOT `.gitignore` in the installed biome
version, not this directory's nested one, so the sample `.ts`/`.json` fixture files (which are not
valid TypeScript/JSON — they're plain text with those extensions) got linted and failed to parse.
Keeping generated workspace state out of the repo tree sidesteps that whole class of problem
rather than trying to get an ignore file recognized correctly.

## The sample fixture matrix (lockedDecisions #5)

`provision.sh` creates client `noriq-sample` (`View: //depot/... //noriq-sample/...`, user
`noriq`) and submits exactly two changelists:

- **change 1** (`sample: initial tree`): `src/add.ts`, `src/util/name.ts`, `docs/README.md`,
  `config/app.json`, `config/.env`, `src/blob.bin` (`-t binary`, 4096 random bytes),
  `docs/OLD.md`, `src/before.ts`.
- **change 2** (`sample: modify, delete, rename, add`): edit `src/add.ts`, delete `docs/OLD.md`,
  move `src/before.ts` → `src/after.ts`, add `docs/NEW.md`.

Neither file is decorative:

- `config/.env` (`SECRET_TOKEN=should-never-be-indexed`) is the fixture proving RUN-209's hard
  deny list still binds when the bytes come from a depot read — `p4 print //depot/config/.env`
  hands the secret over exactly as cheerfully as a filesystem read would, so whatever reads
  depot content for indexing has to apply the same deny list, not rely on the filesystem walker
  never seeing the file.
- `src/blob.bin` is what proves *content-based* binary detection, not extension-based — it's
  random bytes, not something that merely has a suggestive name.

A simpler tree can't verify what RUN-254 claims; don't trim this matrix to make provisioning
faster.

## Setup traps (encoded in `up.sh` — read this before touching that script)

1. **`p4d -cset` takes ONE quoted argument.** `p4d -r /p4root "-cset security=0"` works;
   `p4d -r /p4root -cset "security=0"` (or any other two-arg split) fails with "Unexpected
   arguments" — **per key**, so a loop over several configurables in the two-arg form looks like
   it worked while setting nothing. `up.sh` passes each `-cset key=value` as a single argument in
   its own throwaway container invocation.
2. **A fresh 2026.1 server refuses unauthenticated commands past `p4 info`** —
   `p4 client -i` reports "Client unknown", other commands report "Perforce password (P4PASSWD)
   invalid or unset" — unless **both** `security=0` and `dm.user.noautocreate=0` are set before
   real users ever touch it. Setting only one is not enough; `up.sh` sets both before the first
   real start.
3. **`-L /dev/stdout` trips p4d's free-space precheck.** `/dev` is a small tmpfs inside the
   container, so p4d reports "The filesystem 'P4LOG' has only 64M free, but the server
   configuration requires at least 250M available" and refuses to start. `up.sh` logs to
   `/p4root/p4d.log` (inside the volume) instead, and lowers every `filesys.*.min` configurable
   (`P4ROOT`, `depot`, `P4JOURNAL`, `P4LOG`, all to `10M`) so the precheck passes against a volume
   this small.
4. **A brand-new `P4ROOT`'s first live start silently resets `security` back to the package
   default (4), undoing trap #2's `-cset`.** This one was not anticipated going in — it surfaced
   from this rig's own required round-trip verification (tear down, rebuild from scratch, confirm
   it actually works), not from any upstream doc. The first-ever start of a fresh `P4ROOT` runs a
   one-time topology-registration bootstrap pass; its log says outright *"No entries made in
   db.topology for server address ... ServerID for the server should be set and a server restart
   is required"* — and as a side effect of that pass, `security` reverts to 4 even though nothing
   in between issued another `-cset`. Left alone, `provision.sh`'s first run after a from-scratch
   `up.sh` fails with "Password must be set by super user before access can be granted." `up.sh`
   handles it by detecting a `P4ROOT` with no `db.config` yet, running one throwaway bootstrap
   start+stop, then re-applying the configurables before the container that stays up is started.
   Verified stable across every restart after that one (this rig's own round-trip test restarted
   the container repeatedly with no further reset).
5. **`docker.io/perforce/helix-p4d` is not publicly pullable** ("requested access to the resource
   is denied") and **`cdn.perforce.com` does not resolve** from this network.
   `package.perforce.com` is the source that actually works — see lockedDecisions #1 above.

## Field-name traps (what `measure.sh` re-verifies)

- **The fstat digest tag is `digest`, not `headDigest`.** `p4 fstat -Ol` with `headDigest` parses
  without error and returns **EMPTY** — a silent wrong answer, not a loud one. `-Ol` is required
  for both `fileSize` and `digest` to appear at all.
- **The digest is MD5**, not any other algorithm — e.g. `//depot/src/add.ts#1` (62 bytes) digests
  to `F9255466A3252510E1173597BA669BED`. It must never become the index's content hash (that's a
  different, stronger hash elsewhere in this codebase); treat the depot digest as an
  integrity/change-detection signal only.
- **`p4 files //depot/...@<change>` includes deletions** — e.g.
  `//depot/docs/OLD.md#2 - delete change 2`. A consumer that filters these out because "files"
  sounds like "files that exist" will miss every delete.
- **`p4 move` arrives as two entries**: `move/add` at the new path, `move/delete` at the old one.
  Neither alone tells the whole story; both need to be read together to reconstruct a rename.
- **`p4 diff2 -q //depot/...@1 //depot/...@2` header shapes** — three distinct forms:
  - added: `==== <none> - //depot/docs/NEW.md#1 ====`
  - deleted: `==== //depot/docs/OLD.md#1 - <none> ===`
  - modified: `==== //depot/src/add.ts#1 (text) - //depot/src/add.ts#2 (text) ==== content`

  **The deleted arm ends in three `=` where the other two end in four.** This is easy to miss and
  easy to parse wrong by counting `=` characters. Parse by the position of `<none>` (which side it
  appears on, or its absence) and by the trailing `content` marker on the modified form — never by
  counting equals signs.

## The measured fact RUN-254's design rests on

**Every depot read above succeeded with `P4CLIENT=no-such-client-at-all`.** `measure.sh` runs
every query under that exact client name — a workspace that has never been created — and every
one of them (`info`, `files`, `fstat -Ol`, `diff2 -q`) still returns full, correct data. That is
the entire basis for RUN-254's design: a depot read takes no workspace and no pool lease. If a
future p4d version or configuration changes that, `measure.sh` is what will show it breaking.

## Idempotency

- **`up.sh` run twice**: the second run sees the container already exists and either confirms
  it's running or starts it — it never re-touches the volume, never re-runs the configurables
  loop against an already-initialized server, and never re-copies the client if
  `scripts/p4d-rig/.bin/p4` is already there. Acceptance-truth requirement: no duplicate
  containers, no re-submitted changelists, no error.
- **`provision.sh` run twice**: it checks whether change 2 is already submitted and, if so, does
  nothing. Safe to re-run after a `down.sh` (no `--volume`) + `up.sh` cycle.
- **`down.sh` run on an already-torn-down rig**: reports "No noriq-p4d container to remove" and
  exits 0 rather than erroring.

## `down.sh` and what "leaves the machine as it was" means

Default (`down.sh`, no flags) removes only the container. The volume (sample depot) and image
(build cache) are left in place on purpose — the next `up.sh` is then near-instant and
`provision.sh` finds the same two changelists still there. Pass `--volume` to also drop the
sample depot (next `provision.sh` rebuilds it from scratch, re-triggering setup trap #4's
bootstrap dance), `--image` to also drop the build (next `up.sh` rebuilds the image), or `--all`
for both — a true "no container, no volume, no image" clean slate.

## `measure.sh`

Re-runs the exact queries the setup traps and field-name traps above were measured against, and
prints their raw output. Run it after bumping `P4D_PKG_VERSION` in the Dockerfile (or after any
podman/host upgrade you're suspicious of) to confirm the documented facts — digest algorithm,
`P4CLIENT`-less reads, the diff2 header shapes — still hold before trusting them again.

## What this rig cannot answer

Everything below is explicitly out of scope for this task (see the task's `deferred` list) and
unmeasured here:

- Any change to `src/vcs/perforce.ts` or the depot-read implementation itself — that's RUN-254.
- Behaviour against a real, large, organically-grown depot (streams vs. classic depot paths,
  real workspace sync cost) — VCS-SPIKE.md §10 already flagged this as unanswerable by a toy
  server, and this rig is still a toy server.
- Anything requiring Swarm (pre-commit review) — a bare `p4d` doesn't have it installed.
- CI integration — deliberately not wired in; see lockedDecisions #3.
