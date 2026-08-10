# Index / Project Memory operations (RUN-235)

The operator-facing account of the `[index]` lifecycle: what each command does, what the nine
original states plus `staged` (RUN-260) mean, where local bookkeeping lives, how the two other
retry queues (episode and verification-report delivery) behave, and what to do when something
fails. [`THREAT-MODEL.md`](THREAT-MODEL.md)'s "Repository intelligence upload (`[index]`)" section
is the security authority this document does not restate; [`README.md`](README.md)'s "Repository
intelligence" section is the quick-start. This is the one place the full operator walkthrough
lives — if you find the same fact stated differently in more than one of these three, that is a
bug in this document, not a second source of truth to reconcile by hand.

## Read this first: local state is not server state

**`index-forget-journal` and deleting anything under `~/.noriq/` clears what THIS MACHINE
remembers about an upload attempt. It does not, and cannot, retract anything the server already
ingested.** There is no delete-on-the-server path this daemon can reach — turning `[index]` off,
or clearing every local file, stops the *next* trigger from firing again; it does not reach back
for what a prior one already sent. If you believe indexed content should not exist on the server,
that is a request to the server operator, not something this daemon's CLI can do. Every command
below that touches local state says this again at its own point, because an operator reaching for
`index-forget-journal` is usually trying to undo an upload — and this is the one command that
cannot do that.

## Commands

All six subcommands are documented in `noriq-runner help`, generated from the same command table
`noriq-runner completion` reads (`src/completion.ts`'s `COMMAND_TABLE` — see that file's module
doc if you are extending either surface: RUN-235 unified what used to be three independently
maintained lists of command names into one).

| Command | Needs a daemon? | Can it reach the server? |
| --- | --- | --- |
| `index-repo [--path] [--force] [--json] [--limit N] [--show-content] [--check-determinism]` | No | Never — asserted by import-graph test, not just comment |
| `index-status [--path] [--server] [--json]` | Prefers one; falls back to a local snapshot | Read-only, indirectly (reports what a daemon already observed) |
| `index-reindex [--path] [--server]` | Yes — exits 1 if none answers | Triggers the daemon's own upload path |
| `index-retry [--path] [--server]` | Yes | Identical call to `index-reindex` under a second name (see below) |
| `index-cancel [--path] [--server]` | Yes | Asks the daemon to abort an in-flight job |
| `index-forget-journal [--path] [--server]` | No | Never — no client/fetch dependency in its call graph at all |

### `index-repo` — local dry run

Index the current checkout (or `--path <dir>`) locally and print what a background job would
produce, without a daemon, without a server, and without ever minting an ingest capability:

```bash
noriq-runner index-repo                       # summary: files, entities, edges, diagnostics
noriq-runner index-repo --json                # the same, machine-readable
noriq-runner index-repo --check-determinism   # index twice, compare canonical output
noriq-runner index-repo --show-content --limit 200   # inspect what would be stored (still redacted)
```

Refuses without `[index].enabled` in `.noriq/project.toml` unless you pass `--force` (loudly named
as stepping past the repo's own consent boundary — for local debugging only). Because it walks
your live working directory rather than a clean tracked-only snapshot, it typically reports far
more than the daemon actually indexes — 6943 files against this repo's own working tree versus 243
in the tracked snapshot the daemon leases. If you want to see exactly what the daemon would upload,
this command over-reports; treat it as an upper bound and a place to check for parser diagnostics
(below), not a byte-for-byte preview of the payload.

### `index-status` — what a daemon last observed

```bash
noriq-runner index-status
noriq-runner index-status --json
```

Reads a *live* daemon's loopback control server (`index-control.ts`) if one answers for this
repo's server; otherwise falls back to the last snapshot that daemon persisted to
`~/.noriq/index-status.json`, labelled by its own timestamp — never presented as "now". A repo with
no `[index]` opt-in is answered locally, without touching a daemon at all: `state: no-opt-in`.

Sample text output (a live daemon, `staged`):

```
repository: noriq-runner
server: https://app.noriq.dev
source: live daemon
state: staged [awaiting admin activation — not a runner failure, do not retry]
since: 2026-08-09T12:00:00.000Z
detail: uploaded, sealed and validated — awaiting activation. Activation is an admin/human step this daemon cannot perform; this is not a runner failure and will not resolve itself with a retry.
last success: 2026-08-09T12:00:00.000Z (generation gen_abc123, base b1a2c3d, 4 batch(es) received)
last error: none observed
parser (indexer) version: 1
last requested: 2026-08-09T11:58:00.000Z (post-landing trigger)
last triggered: 2026-08-09T11:58:02.000Z
next poll: 2026-08-09T12:58:02.000Z
```

`--json` gives the machine-checkable body: `{ repositoryKey, server, source, record, trigger }`
(`record` is `null` for "no observation has ever been recorded", not an error).

### `index-reindex` / `index-retry` — ask a running daemon to go now

```bash
noriq-runner index-reindex
noriq-runner index-retry     # identical call under a different name — see below
```

Both call the exact same function (`requestManualReindex`, through the daemon's existing
coalescing/dedup trigger machinery). There is no separate "retry" code path: retrying is just
asking again, and asking twice converges on one generation rather than starting a second, so it is
always safe to run again while something is already in flight. Refuses **locally**, before ever
reaching the daemon, if `[index].enabled` is not true — a manual request must not bypass the same
consent gate the daemon enforces on itself. Exits 1 with "no runner daemon is reachable... start it
with `noriq-runner start` first" if nothing answers; never hangs waiting for one.

### `index-cancel` — abort an active job

```bash
noriq-runner index-cancel
```

Asks a running daemon to abort this repo's currently-active index job. A repo with nothing running
is a reported no-op ("nothing was running... no active job to cancel"), not an error — cancelling
something that already finished, or never started, is a race you lost harmlessly, not a mistake.
Requires a live daemon; with none reachable it exits 1 ("no runner daemon is reachable for this
repo — nothing to cancel").

### `index-forget-journal` — clear local bookkeeping only

```bash
noriq-runner index-forget-journal
```

Needs no daemon (its whole implementation, `forgetMatchingGenerations` in `src/index-stage.ts`,
takes no client/fetch dependency at all — structurally incapable of reaching the server). Clears
every journal entry and staged-bytes directory this machine holds for the resolved
`(server, repositoryKey)` pair and prints exactly what it did and did not do — see "Read this
first" above. Reach for this when a stale or corrupted local journal is blocking a clean resume
(see "Local journals and staging" below), not to try to walk back an upload.

### `index-selftest` — packaging smoke test

```bash
noriq-runner index-selftest
```

Parses a trivial snippet through every bundled tree-sitter grammar and reports pass/fail, exiting
non-zero on any failure. This is a packaging proof (does the grammar `.wasm` resolve from the
installed/bundled package, executing the real `dist/cli.js`) rather than an operational command —
mentioned here for completeness since it shares the command table, not because it belongs in a
day-to-day index-troubleshooting loop.

## Manifest examples

The wire-contract half (`enabled`/`include`/`exclude`) versus this daemon's own execution posture
is a deliberate split — see [`project.toml.example`](project.toml.example) for the fully
commented, authoritative version of every knob below; this is the shape distilled:

```toml
[index]
enabled = true                    # OFF (default) unless this is explicitly true — no inference
include = ["src/**", "docs/**"]   # optional; default is everything not excluded
exclude = ["**/*.generated.*"]    # every glob is confined to the repo root; an escaping or
                                   # absolute glob refuses indexing for the WHOLE repo, named
                                   # in the log

excludeDefaults = true            # ON by default (RUN-262): layers a conservative, machine-wide
                                   # exclude for committed lockfiles and a committed node_modules/
                                   # UNDER whatever `exclude` above already says. Set false if this
                                   # repo genuinely wants one of those indexed.

languages = ["typescript", "javascript", "markdown", "json", "toml"]
                                   # Full default set. An unrecognized name REFUSES indexing for
                                   # this repo (named in the log), never silently skips it.

contentMode = "full"              # "full" (default) stores read content, bounded by the size
                                   # knobs below. "metadata" records path/language/symbol facts
                                   # only — never raw source text.

maxFiles = 20000                  # Daemon POSTURE, not wire contract — raising these never needs
maxFileBytes = 1000000            # a server change. Defaults: 20k files / 100 MB total keeps a
maxTotalBytes = 100000000         # large monorepo bounded without exceeding an ordinary Node
                                   # heap (RUN-238 — see "Load and memory budgets" below for the
                                   # measured amplification behind this number and how to raise
                                   # it once you've measured your own host's headroom); 1 MB/file
                                   # excludes generated/binary content without excluding ordinary
                                   # hand-written source.

readDeadlineMs = 120000           # Wall-clock ceiling on ONE indexing pass (2 minutes).

pollIntervalMinutes = 60          # This repo's slot on the daemon's shared poll ticker (RUN-222).
                                   # Every repo is ALSO reindexed at daemon startup and after every
                                   # successful landing/publish regardless of this value — the
                                   # ticker only covers the gap between those two triggers.
```

An invalid value anywhere in this table refuses **indexing for this repo only** — an `error`-level
log names the offending key. It never takes discovery or run dispatch down with it: indexing is an
enrichment, the run pipeline is the product.

**Checked against the code, not assumed** (RUN-235's own instruction to verify before documenting
a knob as real): `languages`, `contentMode`, `excludeDefaults`, and `pollIntervalMinutes` are all
genuinely wired today — `languages` gates the tree-sitter adapter registry
(`src/index-registry.ts`), `contentMode` gates whether `indexer.ts` stores decoded text,
`excludeDefaults` layers `DEFAULT_EXCLUDE_GLOBS` under your own excludes
(`src/index-policy.ts`), and `pollIntervalMinutes` drives `IndexTriggerHub`'s per-repo poll timer
(`src/index-triggers.ts`). None of these are parsed-and-ignored. If you find one that reads as a
knob but isn't, that is exactly the defect class this document exists to avoid documenting as a
feature — report it rather than trusting the comment.

## Load and memory budgets (RUN-238)

An anchor measurement (before this section existed) found a single continuous **6.3-second
event-loop block** on an 8000-file/335920-record synthetic monorepo: `await adapter.parse(...)`
inside the candidate loop is a microtask continuation, not a yield — it refills the microtask
queue every iteration, so timers and the poll phase never get a turn — and the synchronous tail
(`sortRecords`/`computeContentHash`/`encodeBatches`) ran inside the same unbroken block. Long
enough to miss three of `ws-client.ts`'s 30s heartbeats and make the daemon drop and re-dial its
own socket while a large repo indexed.

**The fix**: `runIndexer`'s candidate loop and `index-batch.ts`'s `computeContentHash`/
`encodeBatches` now cooperatively yield to a REAL macrotask (`setImmediate`, never a microtask)
every `yieldEveryFiles`/`yieldEveryRecords` items, and re-check the coordinator's `AbortSignal` and
`isRunBusy()` predicate at every one of those checkpoints — both previously unreachable mid-pass
(`runIndexer` took no signal at all; `isRunBusy()` was consulted once, before leasing). A
checkpoint throws `IndexInterrupted` rather than pausing, so an aborted or busy pass stops before a
manifest, a generation, or a journal entry ever exists. `sortRecords` itself is NOT chunked — one
native, uninterruptible `Array.sort` call, 52-149ms across every tree size measured below, an order
of magnitude under hash/encode's own cost.

### The harness

`bench/index-load.mts` is the committed, reproducible load harness (deliberately excluded from
`npm run test`/`npm run check` — it takes tens of seconds and its numbers are host-dependent):

```bash
npx tsx bench/index-load.mts                                   # 8000 files, the anchor's own shape
npx tsx bench/index-load.mts --files 20000                     # maxFiles-adjacent scale
npx tsx bench/index-load.mts --yield-files 50 --yield-records 500   # tune the checkpoint cadence
npx tsx bench/index-load.mts --skip-determinism                # skip the extra two full passes
npx tsx bench/index-load.mts --keep                            # leave the generated tree on disk
```

It generates its own synthetic TypeScript tree (committed generator, not a checked-in fixture —
12 numbered functions + 1 combinator + 1 interface + 1 relative import per file, sharded 100 files
per directory), instruments event-loop lag on a 50ms interval THAT OUTLIVES the work it measures
(an earlier draft of this probe cleared its lag timer the instant `runIndexer` resolved, so the
tick that would have reported a trailing block never fired — a blocked loop read as a healthy one;
every timing claim in this section comes from a probe that stays armed past the pass), samples
peak RSS/heapUsed, and — by default — indexes the same tree twice and compares canonical output
byte-for-byte (`compareGenerations`, the same function `index-repo --check-determinism` uses)
to prove yielding changes no byte.

### Measured numbers (this host: Linux, Node v26.7.0, 32 cores, 62 GB RAM, `v8.getHeapStatistics().heap_size_limit` = 4192 MB unconfigured)

| Tree | files scanned | records | batches | peak RSS | peak heapUsed | worst event-loop stall | determinism |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8000 files / 15.9 MB (3 repeated runs) | 8000 | 335920 | 11 | 496-633 MB | 216-324 MB | 169-211 ms | `contentHash` identical across every run |
| 20000 files / 40.2 MB (maxFiles-adjacent) | 20000 | 839800 | 27 | 1.2 GB | 605 MB | 514 ms | identical across a fresh re-index |

Before the fix, the SAME 8000-file tree produced one continuous 6298ms block (MAX lag), with 1
tick late by more than 5 seconds. After: MAX lag 169-514ms across both sizes — the pre-fix block
was 2-3 ORDERS OF MAGNITUDE longer than anything measured after, and the daemon's heartbeat
tolerance (~90s, three missed 30s beats) is never remotely threatened by either.

**The residual 500ms-ish outlier at 20000 files is not explained by checkpoint cadence** — halving
`yieldEveryFiles` from 100 to 50 did not reduce it (547ms vs. 563ms, no meaningful difference,
measured directly). Direct isolated timing of `gzipSync(level: 9)` on the REAL largest batch's
JSONL content (7.86 MB, from an actual generated tree) took 31-34ms, ruling out one big
`encodeBatches` flush as the cause. The remaining plausible explanation, consistent with the
outlier scaling roughly with peak heap size across the two tree sizes, is an ordinary V8 GC pause
under memory pressure — cooperative yielding cannot preempt a stop-the-world GC pause, because that
pause is not JS-level work with a yield point to hook. This is stated as a reasoned inference from
the evidence above, not a directly instrumented fact (no GC tracing was added to confirm it
directly) — and it does not change the conclusion below: at ~0.5s worst case against a 90s
heartbeat-death threshold, it is not a reason to reach for worker-thread isolation.

### Why not worker threads (locked decision, re-examined against these numbers)

The task's locked decisions forbid worker-thread or process isolation "unless your own measurement
shows cooperative yielding is insufficient." It does not: the pre-fix defect (one continuous
multi-second block) is gone, replaced by sub-second, infrequent stalls two-to-three orders of
magnitude smaller, nowhere near the daemon's own heartbeat-death threshold. A worker would still
have to cross a structured-clone boundary for 335920-839800 records per pass, would still GC-pause
internally (merely isolated from the main thread rather than eliminated), and was already reasoned
against on cost grounds before any of this ran. Cooperative yielding is sufficient; a worker thread
would trade a bounded, well-understood cost for an unmeasured, more complex one to fix a residual
that isn't the defect this task exists to close.

### A second, independent finding: a real memory leak, discovered by this task's own "background-run coexistence" scope

Running the harness's determinism check (two extra full passes, same process) at 20000-file scale
first HUNG — confirmed via direct pass-by-pass timing (`node`, isolated script): pass 1 completed
in ~15s, pass 2 was still running past 3 minutes, CPU-bound (100%+), RSS flat (not still growing),
23 open file descriptors (no fd exhaustion). Root cause, found by reading `web-tree-sitter`'s own
type declarations: its `Parser` and `Tree` classes hold Emscripten/WASM-allocated memory behind an
explicit `.delete()` method, and there is no `FinalizationRegistry` anywhere in that library — so
plain JS garbage collection of the wrapper object never frees the underlying WASM memory.
`index-treesitter.ts`'s `parseFile` constructed a fresh `Parser`/`Tree` per file and never called
`.delete()` on either, across the ENTIRE life of the process (`Parser.init()` is one shared
Emscripten module, per `treesitter-runtime.ts`'s own doc — every file's leaked allocation lands in
the SAME arena). One 20000-file pass leaves ~20000 un-freed parse trees in that arena; a second
pass in the same process starts already bloated and compounds it.

This is not a harness artifact: it is exactly what a long-lived daemon does across its own
lifetime — every landing, every publish, every shared-poll-ticker tick re-triggers indexing
(`IndexTriggerHub`, `src/index-triggers.ts`) in the SAME process, for however many days it stays
up. Fixed in `index-treesitter.ts`'s `parseFile` (`.delete()` on both `tree` and `parser` in a
`finally`, never on the shared, cached `Language` a `Parser` was bound to). Verified directly: the
same isolated 3-pass timing that hung before the fix now completes in 13.3-14.2s per pass,
consistently, with no degradation across repeated passes. It also lowered PEAK RSS for a single
pass substantially — 8000 files went from ~1065 MB to 496-633 MB — because the leaked WASM
allocations were counted in RSS the whole time, even within one pass's own lifetime. All numbers
in this section are POST-fix.

### What this means for `[index].maxTotalBytes`

Peak heapUsed amplification over decoded content, measured post-fix: ~18x at 8000 files (216-324
MB / 15.9 MB), ~15x at 20000 files (605 MB / 40.2 MB) — stable, mildly decreasing with scale.
Peak RSS amplification: ~30-33x. The OLD default (`maxTotalBytes = 500_000_000`) predicted roughly
7.5-9 GB of peak V8 heap for a repo that actually reached it — comfortably past this exact host's
own measured, UNCONFIGURED `v8.getHeapStatistics().heap_size_limit` (4192 MB, on a 62 GB-RAM
machine: Node's default old-space cap does not simply track available RAM). That is a bound that
reads as a protection and is not one: hitting it crashes the WHOLE daemon process with a JS heap
OOM — every active run's supervision along with it — not merely truncates one index pass. The new
default (`100_000_000`, RUN-238) predicts ~1.5-1.8 GB of peak heap, under 40% of this host's
measured ceiling, leaving headroom for the rest of the daemon plus GC slack, while still 2.5x more
generous than this task's own largest measured tree (40.2 MB).

**This is calibrated to ONE measured host, stated as such rather than assumed universal.** A
repo/operator that has measured more headroom on their own host — a machine with an explicit
larger `--max-old-space-size`, or known-larger free RAM plus a raised V8 heap limit — can raise
`[index].maxTotalBytes` accordingly; the daemon reads it fresh per repo with no restart needed.
Nothing here bounds `maxFiles` (still 20000) or `maxFileBytes` (still 1 MB) differently — the
20000-file/40.2 MB tree measured above sits comfortably under 100 MB on content alone, so
`maxFiles` remains the practical ceiling for an ordinary (non-generated-content-heavy) monorepo
long before `maxTotalBytes` would trip.

### What is unmeasured

**Perforce and Diversion**: no large live depot was available on this host — the two live VCS
backends' own `IndexSnapshot.source` implementations (`vcs/perforce-index-source.ts`,
`vcs/diversion-index-source.ts`) were not load-tested by this task. `bench/index-load.mts` only
exercises `FilesystemIndexSource`, the same class every git checkout indexes through.

**Windows**: this task's measurements are Linux-only (see this host's own line above). `README.md`
states Windows is a real CI matrix leg for the runner generally; this task did not re-verify that
claim for the indexing load path specifically.

**A tree larger than 20000 files**: not generated or measured — `maxFiles`'s own default is the
practical ceiling this task tested up to. The amplification coefficients above are reported with
the two data points they came from; extrapolating them further is not done here.

## Incremental vs. full behaviour

Every trigger (startup, post-landing, poll) reconciles this checkout's current base against the
server's cursor (`reconcile`, `src/index-reconcile.ts`) and picks one of six outcomes, each folded
into an operator state by `reconcileOperatorState` (`src/index-status.ts`) — the fold is
exhaustive, so a seventh outcome added to the reconcile function fails to compile until it is
placed somewhere:

| reconcile outcome | Meaning | Operator state |
| --- | --- | --- |
| `unchanged` | Active generation's base, indexer version, and staleness bit all match this checkout | `active` (see below) |
| `incremental` | Base moved; `changesBetween` gave a confident diff | `queued` (detail names the diff) |
| `full` | No active generation yet, or `changesBetween` could not answer confidently, or the active generation is *older* than this daemon's indexer | `queued` (detail names the reason) |
| `association-conflict` | This checkout is bound to a *different* canonical repository server-side | `association-conflict` |
| `unavailable` | The cursor fetch failed for any reason (network, old/disabled server, unresolved project) | `failed` |
| `incompatible-version` | Active generation was built by an indexer *newer* than this daemon's | `failed`, `requiresUpgrade: true` |

`incremental` only fires on a **confident** `changesBetween` result — anything else, including the
call throwing, becomes `full` rather than guessing at a diff. A full reindex costs more (it walks
and hashes everything, not just what changed) but is always correct; an incorrect incremental
would silently miss deleted or renamed content, which this daemon will not risk.

## The state vocabulary (ten values, not nine)

`OPERATOR_INDEX_STATES` (`src/index-status.ts`) is a closed, ten-value type. The original RUN-223
design had nine; RUN-260 added `staged` as a real, measured tenth state after the first live
dogfood ingest showed the old code reporting `active` while the server's own cursor still had no
`activeGeneration` and `search_project_memory` returned nothing. Document it as it now stands:

| State | What it means | What to do |
| --- | --- | --- |
| `no-opt-in` | `[index]` is absent, `enabled` is not `true`, or the table is invalid | Nothing — this is the default. Add `[index].enabled = true` to opt in |
| `queued` | A job was accepted (`incremental` or `full`) and is about to run | Wait; `index-status` again shortly should show `parsing` |
| `parsing` | The work step's own progress callback — scanning and hashing is happening now | Wait |
| `uploading` | Batches are being staged and sent | Wait |
| `server-validating` | The upload's `complete()` call is in flight, server-side validation running | Wait |
| **`staged`** | Upload succeeded, sealed and validated — **awaiting admin activation, which this daemon cannot perform** | Nothing to retry. See "generation stuck STAGED" below |
| `active` | The server's own cursor confirms this checkout's exact base is the active, serving generation | Nothing — this is the goal state |
| `failed` | The attempt did not proceed, for a reason named in `detail` | See Troubleshooting below; most `failed` states are safely retried with `index-reindex` |
| `association-conflict` | This checkout is bound to a different canonical repository server-side | See Troubleshooting below — this is a data-integrity gate, not a transient failure |
| `unchanged` (legacy) | Kept in the type only so an OLDER daemon's persisted snapshot still parses | See note below — a live daemon on current code cannot produce this as a fresh observation |

**`unchanged` is effectively unreachable from a live daemon on current code**, and documenting it
as an ordinary state you might see would be the same "reads as real but isn't" defect class this
task exists to avoid in the other direction. `reconcile` only ever returns the `unchanged` outcome
when the fetched cursor's own `activeGeneration` is non-null (`src/index-reconcile.ts`); the
coordinator threads that same `activeGeneration.id` into every reconcile event
(`src/index-coordinator.ts`); and `IndexStatusStore.record` promotes *every* `unchanged` outcome
with that evidence straight to `active` (`src/index-status.ts`, RUN-260). So on the production
path, `unchanged` never survives as a live record's own state — it is retained in the type
purely so `readIndexStatusSnapshot` still accepts a file an older daemon binary wrote before
RUN-260 existed, rather than discarding it as corrupt. If you see `state: unchanged` from a
running daemon on current code, that is worth reporting as a regression, not treating as normal.

A `failed` from `incompatible-version` is visible on the state line itself
(`state: failed [BLOCKED — upgrade this daemon, do not retry]`), and `staged` gets its own
unmistakable marker (`[awaiting admin activation — not a runner failure, do not retry]`) — neither
requires reading `detail` closely to act correctly.

## Local journals and staging

Everything under `~/.noriq/` in this section is **disposable** — the server is the sole authority
on what it actually ingested. A missing or corrupt file costs a slower or repeated attempt, never
a wrong belief about what the server holds (the one exception, `index-control.json`, is discovery
metadata for a *live* process, not upload state, and is covered separately below).

| File | What it holds | If it's gone or corrupt |
| --- | --- | --- |
| `~/.noriq/index-journal.json` | Per-generation upload progress, keyed by the full `(server, repositoryKey, baseId, indexerVersion, generationId)` tuple — every field must match or it's a miss | Redo the work; nothing is lost that the server doesn't already have a record of |
| `~/.noriq/index-staging/<hash>/` | Locally staged, gzip-compressed batches for a generation still uploading — lets a pool-of-1 VCS lease (Perforce, Diversion) release before the network upload finishes | Miss the whole directory, re-stage from the leased snapshot |
| `~/.noriq/index-status.json` | The last snapshot this daemon observed, for `index-status`'s offline fallback | A view is lost, nothing else — `index-status` reports "unknown" instead of a stale one |
| `~/.noriq/index-control.json` | `{pid, port, startedAt, token}` for the CURRENTLY RUNNING daemon's loopback control server, mode 0600 | Read fresh each call; a stale file naming a dead port reads as "no daemon", never a crash |

`sweepOrphanedStaging` removes every staging directory with no live journal entry, but **only
once, at daemon startup** — never on a timer, because a periodic sweep mid-upload cannot tell a
live job's staged bytes from an actual orphan. If a staging directory grows unbounded between
restarts (a daemon that has been up a long time, with a repeatedly-failing upload), that is what
`index-forget-journal` is for: it removes both the journal entry and its staged bytes for a
matching `(server, repositoryKey)`, forcing the next trigger to start clean.

`index-control.json`'s token is the loopback control server's actual authentication boundary — not
just defense in depth. `index-status`/`-reindex`/`-retry`/`-cancel` all read it to reach a running
daemon.

## Episode retries and verification-report retries — no CLI command, and that's deliberate

Two OTHER bounded, restart-surviving queues live beside the index journal and behave differently
from everything above — worth knowing so you don't go looking for `noriq-runner episode-retry`:

- **`~/.noriq/episode-pending.json`** — undelivered run "episodes" (the enrichment upload on top of
  the server's own automatic skeleton). A retry mints a *fresh* ingest capability against the
  daemon's own long-lived OAuth credential, so it is retryable forever — bounded at 500 entries and
  a 7-day age, oldest evicted first on both axes.
- **`~/.noriq/verification-pending.json`** — undelivered citation-verification reports (RUN-230),
  one per run, built once from that run's own `VerifiedContextPack` and never rebuilt on retry. A
  retry here CAN go permanently dead: delivery is gated by the run's own bound-agent token, which
  the server revokes once the run reaches a terminal state, so a 401/403 drops the entry
  immediately (classified non-retryable) rather than holding it for the full age bound.

**Neither has an operator command**, unlike the index queue's `index-reindex`/`-retry`/`-cancel`.
Both drain automatically at exactly two moments: daemon startup, and every WebSocket reconnect —
"the server might be reachable now when it was not a moment ago" is the one signal this daemon has
for either, short of a fixed-interval timer, and both are logged at `info` (delivered count) and
`warn` (dropped/queued count) on every drain attempt. RUN-234: an episode's PER-ATTEMPT `warn` now
also names *why* — `reason` (a closed vocabulary: `disabled`/`expired`/`too-large`/`transport`/…,
or `skipped-server-side` for the recorded-nothing race `episode-upload.ts` already classified) plus
a bounded `detail` — both on the first delivery attempt (`deliverEpisode`) and on every later drain
pass (`drainPendingEpisodes`); before this an ordinary (non-throwing) failed attempt was entirely
silent between drains, with only the aggregate `delivered`/`remaining` counts visible. If a report
or episode seems stuck, the daemon's own log at those two moments — including now the per-attempt
reason — is the only visibility today; there is no
`noriq-verification-status` to ask instead. A verification-report enqueue also logs the current
queue DEPTH on every failed send attempt (`pendingCount`), so a growing backlog is visible in the
log line itself rather than only inferable from repeated warnings.

## Verification

"Verification" here means citation verification (RUN-228…231): every claim a context pack cited is
checked against the leased worktree before it is trusted, and the verdicts are reported back to
the server as a `VerificationReportWire` — the queue described immediately above. This is a
separate mechanism from index generations entirely; a `staged`/`active` index state says nothing
about whether any particular citation has been verified, and a verification-report delivery
failure never blocks or fails a run (the report is fire-and-forget from `stages/prepare.ts`'s point
of view).

## Troubleshooting

Every entry names what `index-status` (or the daemon's log) actually shows, and what to do.

**Server memory disabled or too old.** `index-status` shows `state: failed`, and — because the
cursor fetch (`getIndexCursor`) collapses *every* failure mode (network error, non-2xx, an
unparseable body, or an old server missing the route) into the identical generic outcome —
`detail: index cursor unavailable — the fetch failed, returned an unparseable body, or this
checkout has no resolved project on this server yet`. **`index-status`'s `detail` text alone still
cannot distinguish these** — that collapse is a locked, deliberate contract (`client.ts`'s own doc:
one parser, so a caller never has to keep three failure modes in sync with a server that fails in
new ways). RUN-234 closed the actual visibility gap one layer down, without touching that contract:
the daemon's own log now carries a `warn` line for every failed attempt, naming the CATEGORY —
`category: "http"` with the real numeric status code, `category: "schema"` for a 200 whose body
fails the vendored schema, or `category: "transport"` for a network-level failure — never the
response body, never the request URL. Read the daemon's log (not `index-status`) for this
distinction: a `404`/`503` there is a real, actionable difference from an `ECONNREFUSED`, even
though `index-status` itself still shows the same generic `detail` either way. If the failure
instead happens during upload itself (after a `queued`/`uploading` state), the ingest client
DOES distinguish a `503` in `detail` directly — it will read `ingest begin → 503: ...` and the
reason is a real `disabled`, meaning the server has no ingest at all right now. `index-reindex` is
always safe to try again once you believe the server side has changed.

**R2/staging unavailable.** Server-side object storage for uploaded batches is still only
DESIGNED, not built (see `THREAT-MODEL.md`'s "PARTLY IMPLEMENTED" row) — there is no distinct
server-side "storage unavailable" signal to document as reachable today; a server-side storage
failure would currently surface as an ordinary `ingest ... → 5xx` failure, indistinguishable from
any other server error in `detail`. What IS real today is this machine's OWN local staging
directory (`~/.noriq/index-staging`) becoming unwritable — a full disk or a permissions problem.
That shows as `state: failed` with the raw filesystem error message verbatim in `detail` (e.g. an
`ENOSPC` or `EACCES` message), because a work-step failure's `detail` is always `err.message`,
whatever threw it. Free disk space or fix permissions on `~/.noriq/index-staging`, then
`index-reindex`.

**Repository association conflict.** `index-status` shows `state: association-conflict`, with
`detail` carrying the server's own prose for why. The daemon's own log — at the moment it happens,
`error` level — is more specific: `repository association conflict: this checkout is already bound
to a different canonical repository (<id>) — <reason>. Indexing is blocked for this repository;
ordinary runs are unaffected.` This is a data-integrity gate, not a transient failure:
`index-reindex` will not clear it, because reconcile checks the association before it looks at
anything else. Resolving it is a server-side repository-identity question (which `repositoryKey`
in `.noriq/project.toml` should own which canonical repository) — not something local state can
fix. Ordinary runs (build/scope/verify) are explicitly unaffected; only indexing for this
repository is blocked.

**Parser failure on a file.** This is per-FILE, not per-job — one file that a tree-sitter adapter
cannot parse never fails the whole indexing attempt; it becomes a bounded diagnostic
(`IndexDiagnostic`, `src/index-entity.ts`) and the rest of the repository is still indexed and
still uploaded. **This is still invisible in `index-status`** — background-indexing status never
carries per-file diagnostics, only job-level phase/success/failure, and that is unchanged. What
RUN-234 added is a level below that: the daemon's own log now carries one bounded `index parse
complete` line per job (`info`, or `warn` when there is something worth chasing) — total files,
diagnostic count and how many were errors vs. warnings, whether either bounded collector overflowed,
how many candidates were skipped broken down by a closed reason vocabulary
(`excluded`/`binary`/`too-large`/... — never a path), and whether the scan stopped early. That
answers "did anything go wrong this pass, and roughly what kind" without a local run at all — it
still never names a file. For WHICH file, `noriq-runner index-repo` (or `index-repo --json`) run
locally against the same checkout is still the only way: it prints a bounded diagnostics section
(`diagnostics: N (+M beyond the collector's own cap)`) with the actual paths, which is where a
parser regression or a genuinely malformed file shows up.

**Ingest capability expiry.** A minted ingest capability's TTL is **15 minutes**. Ordinary
expiry mid-upload is handled automatically and transparently — the client re-mints against the
same scope and retries the one call that hit `401` once — so a slow upload outliving 15 minutes is
not, by itself, something you need to act on. **Capability revocation does not exist in any form**
(`THREAT-MODEL.md`'s own words, stated plainly rather than softened): there is no way, from this
daemon or the server, to invalidate a minted capability early. The 15-minute TTL is CURRENTLY the
only thing that ever ends one. If you believe a capability was compromised, there is nothing this
daemon can do about it beyond waiting for it to expire — this is a real, acknowledged gap, not an
oversight this document is hiding.

**A generation stuck `staged`, awaiting activation.** This is not a runner failure and
`index-reindex` will not change it — a `staged` generation is uploaded, sealed, and validated
exactly as intended; the daemon has done everything it can. Activation (`POST
.../generations/:id/activate`) is `userAuth` + `requireAdmin` on the server, a route this daemon's
agent-authenticated credential structurally cannot reach. `search_project_memory` returns nothing
from a `staged` generation until a human with admin access on the Noriq server activates it. If a
generation has been `staged` for a long time, that is a server-side admin action to chase, not a
runner-side retry. RUN-234: the daemon's own log says this at the moment it happens too, not only
`index-status` — every successful upload logs `index generation uploaded — staged, awaiting admin
activation` (`info`), so a generation that never leaves `staged` is diagnosable from the log alone,
not only from a live or persisted `index-status` read.

**`UPGRADE REQUIRED` failure.** `index-status` shows `state: failed [BLOCKED — upgrade this daemon,
do not retry]`, `requiresUpgrade: true` in JSON output, and `detail` prefixed unmistakably with
`UPGRADE REQUIRED — active generation was built by indexer version X, newer than this daemon's Y`.
This is the one `failed` state where **retrying is pointless** — the server's active generation was
built by a newer indexer than this daemon has, and reconcile refuses on purpose rather than risk
overwriting it with older output. `index-reindex` will keep failing identically until this runner
itself is upgraded (`noriq-runner update` to check, then upgrade through your normal install path —
the daemon never replaces itself). Every OTHER `failed` state invites a retry; this is the
exception, and it says so on the state line itself so it cannot be missed by skimming.

## Operator recovery checklist

Work through this top to bottom; most problems resolve at step 2 or 3.

1. **Confirm opt-in and identity.** `[index].enabled = true` and a `repositoryKey` are both set in
   `.noriq/project.toml`. `index-status` answers `no-opt-in` or names a missing `repositoryKey`
   locally, without needing a daemon, if either is missing.
2. **Confirm a daemon is actually running for this repo.** `index-reindex`/`index-retry`/
   `index-cancel` all need one; `noriq-runner start` if not. `index-status` alone degrades
   gracefully to the last local snapshot with no daemon at all.
3. **Read the state, not just "it failed."** `index-status` (or `--json` for scripting) — check
   whether it's `staged` (nothing to do — chase server-side activation), `association-conflict`
   (a data-integrity gate, not a retry target), `requiresUpgrade` (upgrade the daemon, don't
   retry), or an ordinary `failed` (safe to retry).
4. **For an ordinary `failed`, just ask again.** `index-reindex` — it converges on the same
   generation rather than duplicating work, so it is always safe to run again, including while
   something is already in flight.
5. **For a parser-level concern, check locally.** `noriq-runner index-repo` (optionally `--force`
   if `[index].enabled` isn't set yet, `--json` to script it) surfaces per-file diagnostics that
   `index-status` never shows.
6. **If local state itself looks wrong** — a journal entry for a generation that no longer makes
   sense, a staging directory that never clears — `index-forget-journal` clears this machine's own
   bookkeeping for the resolved `(server, repositoryKey)` and forces a clean next attempt. Remember:
   this cannot retract anything already uploaded (see "Read this first" at the top).
7. **If episodes or verification reports seem stuck**, there is no command — check the daemon's own
   log around the last startup or WebSocket reconnect, the only two moments those two queues drain.
8. **Still stuck?** Capture `index-status --json` and the daemon's recent log around the failure,
   and escalate to whoever operates your Noriq server — several of the states above (disabled/old
   server, activation, capability revocation) are server-side or admin-side by design, not
   something this daemon's CLI can resolve alone.

## Cross-platform notes

The runner itself — including every command in this document — is tested on Linux, macOS, and
**native Windows** as a real CI matrix leg, not a best-effort claim (`README.md`'s "Platforms"
note). The Node-side machinery these commands rest on (`node:fs`, `node:path`, `os.homedir()`) is
genuinely portable: `~/.noriq/index-journal.json` etc. resolve correctly under `%USERPROFILE%` on
Windows the same way they resolve under `$HOME` elsewhere.

Two things are NOT uniformly cross-platform, stated plainly rather than glossed over:

- **Shell completion is bash and zsh only.** `noriq-runner completion` accepts exactly those two
  shell names — there is no PowerShell or cmd.exe completion script on any platform. On Windows,
  Git Bash or WSL can source the bash script; native PowerShell gets nothing. The CLI commands
  themselves work identically on native Windows regardless; only the generated completion SCRIPT
  assumes a POSIX shell.
- **File mode bits (`0600`/`0700`) are POSIX-only.** Every file this document names under
  `~/.noriq/` — the journal, the status snapshot, the control-info file (which holds a bearer
  token), the pending-episode and pending-verification queues — is written with the same
  `{ mode: 0o600 }` call `credentials.json` uses. Node ignores `mode` on Windows apart from the
  read-only flag (the exact caveat `THREAT-MODEL.md` already states for `credentials.json`, and it
  applies identically here — the same `fs.writeFile` call, the same directory). On Windows, these
  files are protected by whatever ACL `%USERPROFILE%` carries by default (that user, SYSTEM, and
  Administrators), not by anything this daemon sets.
