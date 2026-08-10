# Release: compatibility, upgrade, rollback, and support (RUN-240)

The operational counterpart to [`VENDORED-CONTRACT.md`](VENDORED-CONTRACT.md) (why the wire
contract is vendored, and the two-commit ordering that keeps a runner from outrunning its server)
and [`INDEX-OPERATIONS.md`](INDEX-OPERATIONS.md) (the day-to-day `[index]` operator walkthrough,
which this document does not restate). This one answers a narrower question: **what happens when
a runner and a server are not running the same release**, and what an operator does about it.

Every claim below corresponds to something this task actually ran or tested — a compatibility test
with an injected fake transport (`test/compat-old-server.test.ts`), a live demonstration against
this repo's own committed files (the provenance section), or a real `npm run build`. Where a claim
could not be tested that way, it says **unverified** rather than reading as coverage it isn't
(this document's own founding rule, and the reason it exists at all: a runbook that doesn't match
tested behaviour is worse than no runbook).

## The server-first release sequence

`VENDORED-CONTRACT.md`'s ordering, restated as an operational checklist:

1. **Planar first.** A wire-contract change lands in `packages/shared/src` and the server deploys
   it. The server must accept the new shape before any runner can send it — `RunnerHub` drops a
   frame its schema rejects silently, and the daemon's telemetry/transcript frames are
   fire-and-forget, so a runner deployed ahead of its server loses whatever the new field carried
   with nothing to correct it.
2. **Runner second.**
   - `npm run vendor:shared -- /path/to/noriq` — refreshes `vendor/noriq-shared/src` and writes
     `vendor/noriq-shared/PROVENANCE.json` (source commit, whether that source checkout was dirty,
     a hash per file). See "Vendored contract provenance" below.
   - `npm run check` — `vendor:check` (does the tree match its own provenance?) then typecheck,
     lint, test. All must pass; `vendor:check` is now a chokepoint inside `check`, so a
     hand-edited or partially-refreshed vendor tree fails here, locally, before a PR opens.
   - `npm run build` — bundles `dist/cli.js`. Real measured size at the time of this task:
     **13,313,290 bytes (~13.3 MB)**, `dist/cli.js.map` ~15.0 MB — the C++ tree-sitter grammar
     (RUN-239), not a regression. `npm run build`'s own output prints the figure on every build.
   - Bump `package.json`'s version, commit, open a PR.
3. **CI** (`.github/workflows/ci.yml`) runs on `ubuntu-latest` and `windows-latest` — both real
   matrix legs, fail-fast off (a Windows-only break must show up as one): `npm ci`, `vendor:check`,
   `typecheck`, `lint`, `test`, `build`, then the packed-binary smoke test (installs the real
   tarball with `npm install -g`, asserts on `noriq-runner version`'s and `help`'s actual OUTPUT —
   the v0.2.0 lesson: the bug that shipped was exit 0 with nothing printed, and only asserting on
   output catches that class again).
4. **Merge to main**, then **tag `vX.Y.Z`**. `.github/workflows/publish.yml` fires: checks the tag
   matches `package.json`'s version (catches "tagged before bumping" as a loud failure), `npm ci`,
   `npm run check` (which now includes `vendor:check` — a release cannot ship with vendored
   provenance that doesn't match the tree), `npm run build`, the same packed-binary smoke test, then
   `npm publish` over OIDC trusted publishing (no token anywhere; npm mints a short-lived credential
   for exactly this one publish, and provenance is attached automatically).
5. **Operators upgrade** with `npm i -g @noriq-dev/runner@latest`, or check first with
   `noriq-runner update` — a read-only version check against this repo's own `package.json` on
   `main` (`src/update.ts`), never a self-replace. The daemon **does not and cannot upgrade
   itself** — it holds live agent sessions and a WebSocket it cannot exec over cleanly, so
   replacement is deliberately a human running their own install path again (`src/update.ts`'s own
   module doc; see `THREAT-MODEL.md` for the supply-chain reasoning behind not automating this).

## Vendored contract provenance

Tested live, on this repo's own committed `vendor/noriq-shared/src` — not a temp-dir stand-in, and
then restored:

| Scenario | Command | Result |
| --- | --- | --- |
| Untouched tree | `npm run vendor:check` | `PASSED — 8 file(s) match recorded provenance (commit 2779095d5e76a9b8956e48be95236937eef92267)` |
| One file hand-edited (`memory.ts`, one comment line appended) | `npm run vendor:check` | `FAILED` — `hash mismatch: memory.ts (hand-edited since it was vendored)` |
| Partially-refreshed directory (one vendored file, `ws.ts`, deleted — what an interrupted `rm -rf` + `cp` leaves) | `npm run vendor:check` | `FAILED` — `missing: ws.ts (recorded in provenance, absent on disk)` |
| A stray file present but never recorded (the other half of the same interruption) | `npm run vendor:check` | `FAILED` — `extra: intelligence.ts (on disk, not recorded in provenance)` |

Each failure was restored before the next scenario; `git status --porcelain vendor/` was clean
afterward apart from the new `PROVENANCE.json` itself. The same four scenarios also have permanent
regression coverage against a temp directory, never this repo's own tree (`test/vendor-check.test.ts`)
— the live run above is a one-time demonstration this document quotes; the test file is what keeps
catching it.

**Why `vendor:check` runs inside `npm run check`, not only in CI** (this task's own discretion):
hashing eight small files costs milliseconds, and a hand-edit caught locally, before a PR even
opens, is strictly better than one caught after — the same "shift left" reasoning `check` already
applies to typecheck/lint/test. The trade is that `check` now also fails on a tree mid-refresh
(provenance recorded, files not yet all copied back) — an acceptable interruption of ordinary WIP,
the same as any other `check` failure on work in progress. CI runs it too, as its own explicit
first step (redundant with `check` in the common case, but named unambiguously rather than buried
as the first line of a longer log), and `publish.yml` gets the guarantee for free by calling
`npm run check` directly — a release cannot ship with a vendored tree that doesn't match its own
provenance record.

**This repo's own `PROVENANCE.json` needed a backfill**, worth stating plainly: the vendored tree
predates provenance tracking, so no commit was captured live at the original refresh. The commit it
now records (`2779095d5e76a9b8956e48be95236937eef92267`) was found by diffing the current tree
against `noriq`'s history until all eight files matched byte-for-byte — they matched exactly once —
not guessed. `sourceDirty: false` reflects that a historical commit is definitionally clean; it
does not attest to the working tree's state at the moment of the *original* refresh, which nothing
recorded. The record's own `note` field says this. Every refresh from this point on records commit
and dirty live, from the actual source checkout, at vendor time — see `VENDORED-CONTRACT.md` for
the full mechanism.

## Compatibility matrix

Every row was proven with an injected fake transport or a pure function
(`test/compat-old-server.test.ts`, 17 tests) — never a live server. "Mechanism" names the code path
that makes the row true; it is not a separate claim from the test.

| Scenario | What happens | Mechanism | Evidence |
| --- | --- | --- | --- |
| **New runner, old server — retrieval** (`getIndexCursor`, `getContextPack`) | Degrades to "nothing retrieved," recorded as an omission, never thrown | `NoriqClient` collapses every failure (404, network error, unparseable body) to `null` — one parser, one contract (`client.ts`); `retrieveContextPack` records `{attempted:true, omission:{reason:'unavailable'}}` rather than silently returning empty | `compat-old-server.test.ts` — "retrieval against an old server…" |
| **New runner, old server — an index/episode UPLOAD is refused** | Terminal, typed, logged — never retried into a hot loop | `mintIngestCapability`'s 503 (`disabled`) and 404 (`not-found`) are excluded from `RETRYABLE_REASONS` (`index-upload.ts`); `uploadGeneration` returns `{ok:false,...}` without a second attempt; `index-work.ts` converts that into a thrown Error the coordinator logs (`index work step failed`) and reports through its status stream — visible, not silently dropped | `compat-old-server.test.ts` — "an upload an old server refuses…", all four sub-cases including the coordinator-level trace |
| **Old runner, new server** | Not separately tested — the vendored contract is additive by convention (new optional fields), and every wire read in this daemon already goes through the same collapse-to-null/typed-refusal contracts proven above. An old runner talking to a new server is the SAME shape as a new runner degrading against an old one from the other end; this task did not stand up a second, older runner binary to prove it directly | Unverified as a distinct scenario — see "What this task did not verify" below |
| **Disabled memory** (`[index]` absent, not `true`, or the table is invalid) | The daemon proceeds; no cursor fetch, no snapshot lease, a `debug` log names why | `IndexCoordinator.attempt()`'s `resolveConfig` gate returns before any network or VCS call | `compat-old-server.test.ts` — "disabled memory: the daemon proceeds…" |
| **Missing/unavailable server-side object storage ("R2")** | Surfaces as an ordinary retryable 5xx during upload — there is no distinct "storage unavailable" signal to test more specifically, because that half of ingest is still only DESIGNED server-side, not built (`THREAT-MODEL.md`'s own "PARTLY IMPLEMENTED" row) | A persistent 5xx on `begin` retries with backoff up to `maxRetryAttempts`, then fails typed (`reason: 'http'`) — bounded, never unbounded | `compat-old-server.test.ts` — "a persistent 5xx during upload…" |
| **`INDEXER_VERSION` migration, `'1'` → `'2'`** (the REAL skew RUN-239 shipped in this history, not a hypothetical) | A daemon at `'2'` meeting an active generation built at `'1'` performs a full pass (a parser change also changes output for previously-untouched files) | `reconcile()`'s version-mismatch branch, `isNewerOrUnknown` false → `full` | `compat-old-server.test.ts` — "a daemon at '2' meeting…" |
| **Rollback**: daemon rolled back to `'1'`, server's active generation built at `'2'` | Refuses with `incompatible-version` — never overwrites the newer index with older, blinder output | `reconcile()`'s same branch, `isNewerOrUnknown` true (an ordinal comparison that cannot tell "newer" from "unparseable" fails toward the side that touches nothing) | `compat-old-server.test.ts` — "a daemon rolled back to '1'…" |
| **Rollback safety: the lease pool is never touched on a refusal** | `incompatible-version` (and every other non-`incremental`/`full` outcome) returns before `vcs.leaseIndexSnapshot` is ever called | `IndexCoordinator.attempt()`'s outcome switch | `compat-old-server.test.ts` — "rollback safety: incompatible-version never leases…" |
| **Rollback safety: run dispatch/verify/land/park are untouched** | Structurally true, not merely by observation: none of `supervisor.ts`, `run-machine.ts`, `land.ts`, `parked.ts` import any indexing-subsystem module | A source-level assertion, re-checked every test run — a future change that threads an index-coordinator import into the run path fails this immediately | `compat-old-server.test.ts` — "rollback safety: the RUN path never imports…" (4 files checked) |
| **Rollback safety: a declined/refused index path never fails a dispatch/verify/land/park** | Same structural fact as above, from the other direction: since the run path holds zero reference to the indexing subsystem, there is no code path by which an index failure COULD reach it — this is the strongest form of the acceptance line this task could prove without instrumenting a full run | See above | Structural (import graph), not a runtime assertion — see "What this task did not verify" |
| **Canonical server memory recoverable after rollback** | Retrieval (`getIndexCursor`/`getContextPack`) carries no local `indexerVersion` at all — a rolled-back daemon reads the exact same cursor/pack an up-to-date one would; nothing about retrieval is gated on this daemon's own indexer version | `client.ts`'s own request shapes — `indexerVersion` appears nowhere in either call's input | `compat-old-server.test.ts` — "canonical server memory stays recoverable…" |

## What this task did not verify

Stated here rather than left implicit, per this task's own instruction:

- **A live, actually-old deployed Noriq server.** Every row above is proven against an injected
  fake transport that reproduces the documented status codes and response shapes (404, 503,
  schema-invalid bodies). No older server binary was stood up and dispatched against for real.
- **An actually-older runner binary talking to a current server.** The "old runner, new server"
  row above reasons from the SAME contracts (collapse-to-null, typed terminal upload refusals)
  proven from the new-runner side, rather than building and running a second, older `dist/cli.js`.
- **macOS.** CI (`ci.yml`) runs `ubuntu-latest` and `windows-latest` only — this was checked
  against the actual workflow file, not assumed. macOS is expected to work (the same portable
  Node primitives every platform uses — `node:fs`, `node:path`, `os.homedir()`) but is not a CI
  leg and this task did not add one speculatively (a locked decision: an untested third leg makes
  a release runbook a guess). `README.md` and `INDEX-OPERATIONS.md` previously overstated macOS as
  a tested CI leg; both were corrected by this task to say "expected to work, not itself tested."
- **Perforce and Diversion release verification.** Neither backend's release behaviour was tested
  here. Diversion's index-SNAPSHOT path has since been verified directly against a live repo
  (lease/list/read/release — see `INDEX-OPERATIONS.md`'s "What is unmeasured" for exactly what that
  covers and what it does not), but a release-shaped test — an upgrade, a rollback, a full index pass
  and upload over a Diversion snapshot — is still not among them. Perforce remains entirely
  unexercised against a real server.
- **Server-side object storage ("R2").** Still only DESIGNED, not built — there is no real
  "storage unavailable" signal for this daemon to distinguish from an ordinary 5xx, so the
  compatibility matrix's R2 row tests the one thing that IS real: how an ordinary persistent 5xx
  during upload behaves (bounded retry, typed terminal failure).
- **A full, instrumented run proving an index refusal never fails dispatch/verify/land/park at
  runtime.** What this task proves instead is the stronger, structural fact: the run-path modules
  hold zero import of the indexing subsystem, so there is no code path for a refusal to travel
  through even in principle. Standing up a real run alongside a failing index job was judged lower
  value than closing the import graph, given the same fact is already true by construction.

## Rollback procedure

There is no dedicated rollback command — a rollback is an ordinary downgrade install:

```bash
npm i -g @noriq-dev/runner@<previous-version>
```

What is safe by the tests above, precisely:

- **Ordinary run execution is untouched.** The run path imports none of the indexing subsystem
  (proven structurally, see the matrix). A rolled-back daemon dispatches, verifies, lands, and
  parks exactly as it did before the version it's rolling back from was ever installed.
- **The server's index is never corrupted by an older daemon.** `reconcile()`'s
  `incompatible-version` outcome refuses to touch the lease pool at all when the server's active
  generation was built by a newer indexer than this (rolled-back) daemon has — there is no
  "best effort" partial reindex path that could downgrade it.
- **Retrieval keeps working.** Nothing in `getIndexCursor`/`getContextPack` is gated on this
  daemon's own `INDEXER_VERSION` — a rolled-back daemon's agents still get the same context packs
  and index cursor an up-to-date one would.
- **What a rollback loses**: this daemon's own ability to produce a FRESH index while rolled back
  (it will keep refusing with `incompatible-version` until it is upgraded again) — expected, not a
  bug: `INDEX-OPERATIONS.md`'s own Troubleshooting section already documents this state
  (`UPGRADE REQUIRED`) for the forward-skew case; a rollback is the same state entered from the
  other direction.
- **Local disposable state is not a rollback concern.** `~/.noriq/index-journal.json`,
  `index-staging/`, `index-status.json` are keyed by the full `(server, repositoryKey, baseId,
  indexerVersion, generationId)` tuple or are pure snapshots — a version mismatch is a MISS, never
  a partial reuse or a corruption (`INDEX-OPERATIONS.md`'s "Local journals and staging"). Nothing
  needs to be manually cleared to roll back.

## Upgrade procedure

```bash
noriq-runner update          # read-only: reports current vs. latest, never replaces itself
npm i -g @noriq-dev/runner@latest
```

After upgrading past an `INDEXER_VERSION` bump specifically (as RUN-239's `'1'` → `'2'` did): the
next trigger for every repo with `[index].enabled` performs a full reindex automatically — this is
`reconcile()`'s own designed behaviour, not a manual step (`INDEX-OPERATIONS.md`'s "INDEXER_VERSION
bump" section has the full accounting of what that does and does not buy). No operator action is
required beyond the ordinary upgrade above.

## Operational checks after a release

Cheap, real checks worth running post-deploy — none of these are new for this task, gathered here
because a release runbook should name them in one place:

- `noriq-runner version` — reports the installed version; compare against the tag just published.
- `noriq-runner index-selftest` — packaging smoke test: parses a trivial snippet through every
  bundled tree-sitter grammar from the REAL installed/bundled `dist/cli.js`, catching a bundling
  regression tsx/vitest cannot see (they read `.wasm` from `node_modules` directly).
  `INDEX-OPERATIONS.md`'s own "Adapter roadmap" section confirms this catches a real regression
  class, not a hypothetical one.
- `noriq-runner index-status` (with `[index].enabled` repos) — confirms the daemon is still
  reconciling correctly against the server after the upgrade; a `state: failed
  [BLOCKED — upgrade this daemon, do not retry]` line here is the live signal a rollback (or a
  server ahead of this daemon) has actually happened.
- CI's own packed-binary smoke test (`ci.yml`/`publish.yml`) already asserts on `noriq-runner
  version`'s and `help`'s real OUTPUT before any of the above ever reaches an operator — the v0.2.0
  lesson (a broken binary that printed nothing and exited 0) applies here exactly as it does to
  every other release.

## Support: where to look when something doesn't match this document

- **Index/memory operational failures, state-by-state** — `INDEX-OPERATIONS.md`'s
  Troubleshooting section and Operator recovery checklist; this document does not restate that.
- **Security boundaries** — `THREAT-MODEL.md`, especially the "Repository intelligence upload
  (`[index]`)" section for what is and is not implemented server-side.
- **Why the contract is vendored, and the two-commit ordering** — `VENDORED-CONTRACT.md`.
- **A provenance mismatch on `vendor:check`** — the three failure shapes (hash mismatch, missing,
  extra) are named directly in the check's own output; never hand-edit `vendor/noriq-shared/` to
  silence one — land the change in planar's `packages/shared/src` first, then `npm run
  vendor:shared` here.
