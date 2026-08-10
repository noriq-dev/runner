# Index / Project Memory operations (RUN-235)

The operator-facing account of the `[index]` lifecycle: what each command does, what the nine
original states plus `staged` (RUN-260) mean, where local bookkeeping lives, how the two other
retry queues (episode and verification-report delivery) behave, and what to do when something
fails. [`THREAT-MODEL.md`](THREAT-MODEL.md)'s "Repository intelligence upload (`[index]`)" section
is the security authority this document does not restate; [`README.md`](README.md)'s "Repository
intelligence" section is the quick-start; [`RELEASE.md`](RELEASE.md) (RUN-240) is the *release*
authority — old-server/new-runner and new-server/old-runner compatibility, disabled memory, an
indexer-version migration, and rollback — this document does not restate that either. This is the
one place the full operator walkthrough lives — if you find the same fact stated differently in
more than one of these four, that is a bug in this document, not a second source of truth to
reconcile by hand.

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

## Adapter roadmap (RUN-239)

Language/format coverage grows from MEASURED demand, not a guessed list — every number below was
counted on this host, on the three Noriq-managed projects that actually exist, not estimated.

### Measured demand, per project

**CORRECTED after RUN-239 shipped**: the first pass measured
`~/Diversion/Prototypes/ProjectNodPrototypeV1`, which is NOT the checkout the daemon discovers. The
marked one — the path in the `dv` registry, carrying `.noriq/project.toml` — is
`~/Diversion/Prototype`, and it is far larger. Both are recorded below because the mistake is
instructive: a language-demand count is only as good as the checkout it was taken on, and the
daemon's own discovery log names which that is. The figures for the MARKED checkout come from the
Diversion snapshot's own tracked listing, not a filesystem walk.

| Project | VCS | Language/format | Files (marked checkout) | Files (first pass, wrong checkout) |
| --- | --- | --- | --- | --- |
| Project Nod (Unreal) | Diversion | `.cpp` + `.h` | **997 + 852 = 1849** | 137 + 120 = 257 |
| Project Nod | Diversion | `.cs` (all `.Build.cs`/`.Target.cs` — UBT, not hand-authored gameplay code) | **51** | 8 |
| Project Nod | Diversion | `.md` | 43 | — |
| Project Nod | Diversion | `.uplugin` / `.uproject` | 20 + 1 = 21 | 4 + 1 = 5 |
| Project Nod | Diversion | `.ini` | 5 | 6 |
| Project Nod | Diversion | binary assets (`.uasset` + `.umap`, machine-generated, DEFAULT-EXCLUDED) | **4187 + 15 = 4202, 8.36 GB** | 3201 + 6 |
| Project Nod | Diversion | total tracked files in the snapshot | **6216** | 3586 |
| noriq, runner | git | TypeScript | (already covered) | — |
| — | — | Go | **0** | **0** |
| — | — | Rust | **0** | **0** |

The task body's own guessed language list led with Go and Rust — zero files, in any managed project,
on either checkout. C++ was fourth on that list and is the only one with real demand at meaningful
scale; the corrected count makes that conclusion stronger, not weaker.

The `.uasset`/`.umap` default exclusion earns its place on this repo specifically: **8.36 GB** of
tracked binary payload that is never read, against ~21 MB of source that is. Without it this repo
would trip `maxTotalBytes` on asset bytes and index almost none of its code.

### What shipped, and why

- **C++** (`src/index-treesitter.ts`, `createCppTreeSitterAdapter`): `tree-sitter-cpp.wasm`,
  inlined through the SAME build-time base64 rail TS/JS/TSX already use (`scripts/build.mjs`,
  `src/treesitter-runtime.ts`) — one packaging mechanism, not two. Claims `.cpp`/`.cc`/`.cxx`/
  `.h`/`.hpp`/`.hh` (not `.inl`/`.ipp` — see the adapter's own doc for why, and not `.c` — no
  measured demand for a separate C grammar). A free function, a class/struct and its methods
  (inline or declared-only), a namespace, an enum, a `using`-alias, and a `typedef` each become a
  `symbol` entity; enum members do not (values, not declarations — the same rule the TS adapter
  already applies). **A header declaration and its out-of-class implementation are deliberately
  TWO symbol entities, not one** — merging them would require this per-file adapter to decide "is
  this declaration the same as that definition" across (usually) two files it never sees together,
  which is exactly the kind of identity claim it cannot back; two entities is the same answer
  `dedupeSymbolPaths` already gives a TS overload group. Same-file calls resolve on the identical
  rule the TS adapter uses (`resolved` for an unambiguous bare call, `inferred` for `this->member`).
  Declines, deliberately, and each PROVEN by a test rather than claimed in a comment
  (`test/index-treesitter.test.ts`): a bodyless forward class declaration, a plain variable
  declaration, a function-pointer VARIABLE declaration (`int (*fnPtr)(int,int);` — indistinguishable
  from "function returning a pointer" without an unsound guess), an operator overload, an
  out-of-line templated method definition (`Container<T>::method` — a template argument is not
  stable identity text), and a class whose name was mangled by an export-macro-before-classname
  convention (`class FOO_API Widget : public Base`) — real, but NOT the dominant cause of this
  repo's parse errors, corrected below. Every declaration this adapter would otherwise emit a
  symbol from is gated on `node.hasError` (does ITS OWN parse-tree subtree contain an
  ERROR/MISSING node), coarser than the TS/JS adapter's one-diagnostic-per-file design — see "why
  per-declaration, not per-file" below.
- **Macro-noise blanking** (`blankCppMacroNoise`, applied to a COPY of the source before parsing
  only — see "measured cause of the parse errors, and the fix" below): three UE macro families
  measured to actually break the parse are blanked to equal-length spaces before the C++ grammar
  ever sees them, recovering real declarations the grammar would otherwise lose around them.
- **ini** (`createIniTreeSitterAdapter`): `tree-sitter-ini.wasm`, 4,716 bytes — effectively free on
  the same rail. Sections and settings become `symbol` entities, values gated through the same
  `shouldWithholdValue` check the JSON/TOML adapters already use.
- **`.uproject`/`.uplugin`**: claimed by the EXISTING JSON adapter (`src/index-formats.ts`) — no
  grammar, no new code path. Checked against Project Nod's own `Survival.uproject`: a plain JSON
  object whose `Modules[].AdditionalDependencies` is the project's module dependency graph, which
  the generic key-value walk already turns into entities with zero project-specific code.
- **NOT added**: C# (`tree-sitter-c-sharp.wasm`, 5,103,332 bytes measured — nearly as large as
  C++), Go, Rust, Python. See "What is deliberately absent" below for the measured counts behind
  each.

### Why per-declaration error gating, not per-file (measured)

The TS/JS adapter trusts declarations found outside one narrow syntax-error region and emits a
single bounded diagnostic per file. Sampling all 227 `.cpp`/`.h` files under Project Nod's
`Source/` tree, **97 (42.7%) contain at least one parse-error node** — later widened to all 257
tracked `.cpp`/`.h` files in the whole repo, **114/257 (44.4%)**. One real, measured cause: parsing
`class SURVIVAL_API UC_InventoryComponent : public UActorComponent { ... }` (real Project Nod
source, reduced to a minimal reproduction in `test/index-treesitter.test.ts`), tree-sitter's error
recovery produces a `class_specifier` whose OWN `name` field is the literal token `SURVIVAL_API`,
not `UC_InventoryComponent` — the corruption does not sit near the identity this adapter would
extract, it IS the identity. A per-FILE diagnostic policy would let that fabricated symbol
through; a per-DECLARATION `hasError` gate declines it (and every sibling still parses
independently — the gate is never applied to a container node like `namespace_definition`, so one
broken member never takes a whole namespace down with it).

**This export macro is NOT, however, the dominant cause of the 114/257 error rate** — corrected
after measurement, not assumed either way: blanking every `\b[A-Z][A-Z0-9_]*_API\b` token to
equal-length spaces across all 257 files and re-parsing left the error count IDENTICAL, 114/257,
not one file improved. Clustering the actual first ERROR/MISSING node in each of the 114 failing
files found the real causes — see "measured cause of the parse errors, and the fix" below.

Confirmed end to end on the real repo: `noriq-runner index-repo --path <Project Nod> --force`
produced 134 diagnostics, entirely `warning`-severity per-file parse-error notes, zero fabricated
symbols, zero crashes.

### Measured cause of the parse errors, and the fix (`blankCppMacroNoise`)

Clustering the first ERROR/MISSING node in each of the 114 failing `.cpp`/`.h` files (of 257
total) gives three real causes, none of them the export macro above:

| Cause | Files | Shape |
| --- | --- | --- |
| `GENERATED_BODY()` and siblings (`_UCLASS_BODY`/`_IINTERFACE_BODY`/`_USTRUCT_BODY`) | 82 | Call-shaped, no trailing `;`, inside a class body — the grammar reports a MISSING semicolon and loses whatever follows in that scope. |
| `UMETA(...)` | 23 | Breaks a `UENUM`'s enumerator list (`enum class X : uint8 { A UMETA(DisplayName="…") }`). |
| `DECLARE_..._DELEGATE...(...)` | 9 | The `DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam`/`FourParams` family. |

`createCppTreeSitterAdapter` blanks all three to EQUAL-LENGTH spaces — never deletes — before
handing the text to the parser, on a COPY of `input.content` only: the stored file entity and
every symbol's own `content` field still read the true, un-blanked source (`content` is sliced
from the original text via `node.startIndex`/`endIndex`, never `node.text`, which would read off
the blanked parse tree). An embedded newline inside a matched span is preserved as a newline,
specifically so line numbers — and therefore every `SymbolRange` — never shift; a byte-for-byte
space-fill that also blanked newlines would silently mis-line every symbol after the match.
`UCLASS`/`USTRUCT`/`UPROPERTY`/`UFUNCTION` are deliberately NOT blanked — they already parse as
ordinary call expressions and no symbol gain was measured from touching them.

**Measured gain, real repo, raw vs. blanked**: the C++ adapter in isolation, fed raw source versus
source with the three macro families pre-blanked to equal-length spaces:

```
parse errors  raw: 114/257 (44.4%)   blanked: 114/257 (44.4%)   <- unchanged — see below
symbols       raw: 1609              blanked: 1875              <- +266 (+16.5%), across 23 files
```

Confirmed independently, end to end, through the real command an operator would actually run —
`noriq-runner index-repo --path <Project Nod> --force --json` against the whole repository
(every language, not just C++), before this fix versus after:

```
symbol entities   before: 1470   after: 1736   <- +266, matching the isolated C++-only measurement exactly
declares edges    before: 1470   after: 1736   <- one per symbol, moves in lockstep
diagnostics.total before: 134    after: 134    <- unchanged — the SAME 134 warnings, not fewer, not more
```

**The parse-error COUNT does not move — that is the gate working, not a bug.** The
per-declaration `hasError` gate recovers the GOOD declarations that sit next to a now-blanked
macro; it does not make the file's OWN remaining unfixed constructs (an export-macro-mangled class
header, say) parse cleanly, and blanking a macro elsewhere in the file does not remove errors a
DIFFERENT construct is still causing. **114/257 files still contain a real parse-error node with
this change in place — that is not a regression to fix, it is the honest number, and no comment or
document in this repo should claim a clean parse.** The metric that actually improved is symbol
recovery, not error count.

### Bundle-size trade — measured, before and after

| | dist/cli.js | dist/cli.js.map |
| --- | --- | --- |
| Before RUN-239 (TS/JS/TSX only) | 6,096,684 bytes (~5.8 MB) | — |
| After RUN-239 (+ C++, + ini, + macro-noise blanking) | 13,313,290 bytes (~12.7 MB) | 15.0 MB |

`tree-sitter-cpp.wasm` alone is 5,394,393 bytes — base64-inlined, that is the entire size of the
increase; `tree-sitter-ini.wasm` (4,716 bytes) is noise by comparison. Accepted explicitly, shown
these exact numbers, rather than inventing a second, lazily-loaded packaging mechanism for the one
large grammar — one mechanism to reason about, and C++ is the one language this task's own
measurement found real demand for at meaningful scale. `npm run build`'s own output prints the
figure on every build; `noriq-runner index-selftest`, run against the actual built `dist/cli.js`
(not tsx/vitest, which reads `.wasm` files from `node_modules` directly and would not catch a
bundling regression — see `src/treesitter-runtime.ts`'s own doc), confirms all five grammars —
`typescript`/`javascript`/`tsx`/`cpp`/`ini` — load and parse from the bundle, with the runtime
engine initialized exactly once (`initCount: 1`) regardless of how many grammars a pass touches.

### INDEXER_VERSION bump, and the acceptance line it cannot fully satisfy

`INDEXER_VERSION` (`src/index-reconcile.ts`) moved `'1'` → `'2'` — mandatory, not housekeeping: a
new adapter (or a widened `canParse`) changes this daemon's output for files that were previously
untouched or NOOP-only, and `deriveGenerationId` is keyed on `indexerVersion` specifically so an
older active generation is unconditionally superseded by a FULL pass rather than silently trusted
as still-accurate.

**What this buys, and what it does not.** Every repo's next reconcile becomes `full`, regardless of
whether that repo has a single C++ file — there is no cheaper PER-LANGUAGE reindex this daemon can
offer today. This is the one acceptance line this task cannot satisfy locally: `IndexGenerationManifest`
(`vendor/noriq-shared/src/memory.ts`) carries only one whole-daemon `indexerVersion` field, no
per-parser version reaches the wire, and the vendored contract must land planar-side FIRST
(`VENDORED-CONTRACT.md`) — a targeted reindex needs a schema change this task does not make. Locally,
`parserVersions` (`indexer.ts`'s own `IndexerResult`, and `noriq-runner index-repo`'s own JSON output
carries it — see the sample run in this document's own history) IS recorded per adapter, but nothing
branches on it. Reported blocked here rather than declared met by that field's mere presence.

### Unreal binary assets, DEFAULT_EXCLUDE_GLOBS, and a measured caveat on the status collector

`DEFAULT_EXCLUDE_GLOBS` (`src/index-policy.ts`) gained `**/*.uasset` and `**/*.umap` — Unreal's
compiled asset/level binaries, machine-generated by the editor on save, never hand-authored, the
same category as a committed lockfile. `[index].excludeDefaults = false` still brings them back,
same escape hatch as every other entry on that list.

**What this measurably buys**: the exclude check (`index-scan.ts`) runs BEFORE the read/binary-sniff
step, so a matched `.uasset`/`.umap` never has its bytes read at all — real I/O and CPU avoided on
files that are often several MB each — and its status reason becomes the accurate, deliberate
`excluded-default` rather than the (equally correct, but less informative) `binary` it would have
gotten anyway.

**What it measurably does NOT buy, checked by actually running it rather than assumed**: a smaller
scan-status collector. Running `noriq-runner index-repo --path <Project Nod> --force --json`
against the real repository (live working tree, not a clean checkout — see `index-repo`'s own
"local dry run" note above) produced `scanStatuses: { total: 1000, overflow: 2308, byReason:
{ "excluded-default": 899, "too-large": 87, "binary": 14 } }` — the collector's 1000-record cap was
reached and 2308 more records overflowed past it, with 899 of the 1000 VISIBLE records being
`excluded-default` .uasset/.umap noise. The reason: `index-scan.ts`'s `exclude`/`defaultExclude`
check has no directory-level pruning analogue to the one the hard deny list and `vcsIgnored` get
(`makeShouldDescend`, `index-scan.ts`) — each matched file still costs its own `pushStatus` call,
identically to what `binary` would have cost. An extension-shaped glob like `**/*.uasset` cannot
soundly support directory-level pruning either (not every file under a directory containing
`.uasset` files is itself one), and a directory-NAME-based default (e.g. any `Content/`) would be
exactly the per-repo-layout judgement call `DEFAULT_EXCLUDE_GLOBS`'s own doc says does not belong
in this list. Closing this gap properly needs a real (and larger) change to `index-scan.ts`'s
matching engine — directory-level pruning for `exclude`/`defaultExclude`, or an aggregated-count
status entry instead of one row per matched file — which this task does not make. What IS true,
and tested (`test/index-policy.test.ts`): the existing `MAX_STATUS_RECORDS`/`statusOverflow`
bookkeeping holds correctly under this load — no crash, no hang, an honest count of what did not
fit — and the escape hatch (`excludeDefaults = false`) still works exactly as it does for every
other default.

### What is deliberately absent

- **C#, Go, Rust, Python adapters** — measured, not overlooked: 8 UBT `.Build.cs`/`.Target.cs`
  files (C#, `tree-sitter-c-sharp.wasm` is 5,103,332 bytes — nearly doubling the bundle again for a
  vendor-tooling format, not gameplay code), 2 `.py` files, and zero Go/Rust files anywhere.
- **A non-tree-sitter `.Build.cs`/`.Target.cs` adapter** extracting UBT module dependencies without
  paying the 5.1 MB C# grammar cost — those files declare the Unreal module graph, the most
  interesting structure in the repo after `.uproject`/`.uplugin`, and are the most likely NEXT step;
  deliberately not this task.
- **Per-language parser versions on the wire, and targeted per-language reindex** — see the
  INDEXER_VERSION section above; blocked on a planar contract change.
- **Marking Project Nod with a `.noriq/project.toml`** — it has none today, so the daemon does not
  discover it at all. This task makes C++ ready; it does not onboard that repo.
- **Load-testing an Unreal repo end to end through the Diversion backend** — the snapshot path
  (lease/list/read/release) is verified now, see "What is unmeasured" below; the LOAD path is not,
  and nothing here changes that (the real-repo runs in this section used `index-repo`'s local
  filesystem walk, never the Diversion
  snapshot lease path).
- **Directory-level pruning for `exclude`/`defaultExclude` in `index-scan.ts`** — see the status-
  collector caveat immediately above; a real gap, sized larger than this task, left for a follow-up.

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
native, uninterruptible `Array.sort` call with no mid-sort yield point to hook, and chunking its
INPUT would change comparison order. RUN-278 made that acceptable on the merits rather than on a bad
number: 184ms at 20000 records-heavy files, after the comparator stopped building a string per
comparison. The figure this line used to carry (52-149ms) was a measurement artifact — see "The
residual ~500ms stall" below.

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
peak RSS/heapUsed, records every GC pause and attributes each stall to the collections overlapping
it (RUN-278 — without that join a stall is just a number, and one was mis-explained for a whole
task), takes its per-phase timings from INSIDE the pass rather than re-running stages on the finished
result, and — by default — indexes the same tree twice and compares canonical output byte-for-byte
(`compareGenerations`, the same function `index-repo --check-determinism` uses) to prove yielding
changes no byte.

### Measured numbers (this host: Linux, Node v26.7.0, 32 cores, 62 GB RAM, `v8.getHeapStatistics().heap_size_limit` = 4192 MB unconfigured)

| Tree | files scanned | records | batches | peak RSS | peak heapUsed | worst event-loop stall | determinism |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8000 files / 15.9 MB | 8000 | 335920 | 11 | 477-494 MB | 222-247 MB | 76 ms | `contentHash` identical across every run |
| 20000 files / 40.2 MB (maxFiles-adjacent) | 20000 | 839800 | 27 | 827 MB | 435 MB | 156 ms | identical across a fresh re-index |

Before RUN-238, the SAME 8000-file tree produced one continuous 6298ms block (MAX lag), with 1 tick
late by more than 5 seconds. After RUN-238 and RUN-278: MAX lag **76-156ms** at both sizes, zero
ticks late by more than 250ms — the pre-fix block was **~80x** the worst stall measured now, and the
daemon's heartbeat tolerance (~90s, three missed 30s beats) is nowhere near threatened.

In-pass phase timings, reported from inside `runIndexer` (`IndexerDeps.onPhaseTiming`):

| | scan | parse | sort | hash | encode |
| --- | --- | --- | --- | --- | --- |
| 8000 files | 1452 ms | 3049 ms | **65 ms** | 327 ms | 851 ms |
| 20000 files | 3205 ms | 7738 ms | **184 ms** | 812 ms | 2183 ms |

`contentHash` for the 8000-file tree is `c98fdc64a66aea5f17f818be69fec946bced4cf39e350409c2dc113071f6a5db`
both before and after RUN-278's comparator change — the same value RUN-238 recorded, which is the
point: a faster ordering that is not the SAME ordering would be a determinism regression, not an
optimization.

### The residual ~500ms stall, and why "GC pause" was the wrong answer (RUN-278)

RUN-238 left a single ~500-555ms stall at 20000 files recorded as "most likely an ordinary V8 GC
pause under memory pressure", explicitly labelled an inference rather than an instrumented fact. It
was instrumented, and **the inference was wrong**:

- A `PerformanceObserver({entryTypes:['gc']})` over the same tree, joining each stall against the GC
  pauses overlapping its window, put GC at **13-17ms of the 555ms — 3%**.
- The worst single GC pause in an entire 20000-file run was **5.9ms**. 832 collections, 649ms total,
  spread thinly across the whole pass.

The real cause was `sortRecords`, the one stage deliberately left unchunked: **543-587ms** on the
real in-pass record order. `recordIdentity` was being called on BOTH operands of every comparison, so
~17M comparisons built ~34M throwaway concatenations *inside the sort*. Comparing an edge's three
fields in place is the identical ordering with no allocation: **171ms, 3.1x faster** (a
derive-the-key-once variant was measured too and is worse here — 309ms, and it retains ~540k strings
for the duration of the sort).

**Why a whole task's measurement missed it, which is the more useful lesson:** the harness timed
`sortRecords([...result.records])` — and `result.records` is *already sorted*, which V8's TimSort
walks in O(n). It reported **53ms** for work that cost **533ms**, and `src/index-batch.ts` then
rested "leave the sort unchunked" on that number. This is the same class of error the harness's own
module doc already warned about once (a lag probe cleared before the tick that would report the
block): **a measurement taken from outside a pipeline can only measure the input it constructs
itself.** Phase timings now come from inside the pass, and the harness carries the GC observer, so
the next unexplained stall is attributable in one run rather than a fresh investigation.

### Why not worker threads (locked decision, re-examined against these numbers)

RUN-238's locked decisions forbid worker-thread or process isolation "unless your own measurement
shows cooperative yielding is insufficient." It does not, and RUN-278 strengthened rather than
weakened that: the multi-second block is gone, and so is the ~500ms residual that was the only
remaining argument for isolation — it was ordinary JS work in the sort, which is precisely the kind
of cost yielding and cheaper comparisons address. What is left is 156-172ms at both measured sizes,
against a ~90s heartbeat-death threshold. A worker would still have to cross a structured-clone
boundary for 335920-839800 records per pass, and GC would still happen inside it (isolated from the
main thread, not eliminated). The lever above worker threads, if the sort ever climbs back toward
the 250ms bound, is chunk-and-merge — and it has to prove identical ordering before it earns the
latency, because `contentHash` and the per-batch idempotency key both depend on that order.

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

**Perforce**: no live depot was available on this host — `vcs/perforce-index-source.ts` has never
been exercised against a real server, for either correctness or load.

**Diversion — the SNAPSHOT path is verified now; LOAD is still not.** Measured directly against
Project Nod's live Diversion repo (`dv.repo.e821a7a1…`, 6216 tracked files), narrowly and honestly:

| checked | result |
| --- | --- |
| `leaseIndexSnapshot` | ok — `baseId=dv.commit.474`, `branch=main`, `readOnly=true`; since RUN-281, `localPath` is the offered checkout root, never a materialized tree (see below) |
| `list()` | 6216 tracked files in 969 ms, zero refusals, deterministic order |
| tracked-only property | holds — `Intermediate/`, `Binaries/`, `DerivedDataCache/`, `.o`, `.d`, `.rsp` all absent by construction, per `.dvignore` |
| `read()` | 10/10 sampled files byte-exact against their on-disk size, 408 B to 58 KB |
| `releaseIndexSnapshot` | clean (it materializes nothing, so there is nothing to give back) |

What that does NOT cover, and must not be read as covering: a full `runIndexer` PARSE pass (entity
extraction, tree-sitter) over a Diversion snapshot under real event-loop/memory load, an upload of
one, `changesBetween` (which this backend refuses outright — `full-index-required`), and anything
about Perforce. `bench/index-load.mts` still only exercises `FilesystemIndexSource`.

### Verify-then-read for API-backed sources (RUN-281): the deadline problem, measured and fixed

The measurement immediately above is what exposed the actual defect: Diversion serves every file
as its own HTTP round trip — **161 ms/file measured** against this same live account — so a
1905-source-file pass hit `readDeadlineMs`'s then-120s filesystem-calibrated default at **741
files, `stoppedEarly: true`, 123 s elapsed** (~166 ms/file end to end, matching the independent
161 ms/file figure). Every API-backed backend silently indexes a prefix under that bound and
re-downloads the whole tree every pass — a cost with no cache to amortize it.

**The fix has two independent parts, and only the second one is unconditional.** First, `list()`
already caches `path → blob.sha` as it yields (one HTTP call per `TREE_PAGE_SIZE` files, already
paid for by enumeration) — and that digest is measured to be plain SHA-1 of the raw file bytes
(31/31 sampled paths matched: source, binaries, `.uasset`/`.png`, the 3 largest tracked files up to
418,986,745 bytes, and 10 CRLF-containing files with no line-ending normalization by the depot). So
`DiversionIndexSource.read()` now tries a locally-offered candidate root first (`leaseIndexSnapshot`
offers the same directory the daemon's pool-of-1 workspace lives at, `repoRoot`, as
`IndexSnapshot.localPath` — never trusted, never walked, never opened outside `read()`'s own hash
check): read the local file, SHA-1 it, compare against the cached depot digest for that exact path
at this exact commit. A match uses those bytes; a mismatch, a missing file, or an unreadable one all
fall back to the unchanged `/blobs` fetch, silently, with no special case. **The one safety
property this scheme has, and the only one**: the hash comparison. No mtime check, no size-only
check, no "the checkout looks clean" shortcut. No lease is ever taken to do this — indexing yields
to runs, always, and a verify-then-read pass that needed the lease to be safe would not be safe:
hashing every byte is what makes it safe WITHOUT one, even while a run is actively re-checking that
same directory out from under the scan. Second, and independently of whether the fast path finds
anything to verify: `DiversionIndexSource.minReadDeadlineMs` (600,000 ms, a measured floor derived
from 1905 files × ~166 ms/file with headroom) is folded into the effective deadline by
`index-work.ts` — `Math.max(config.readDeadlineMs, source.minReadDeadlineMs ?? 0)` — so a cold or
fully dirty pass (nothing to verify locally) still gets minutes, not the filesystem-calibrated 120s
default, without relying on the fast path to hide the problem. (Project Nod's own manifest already
carries an explicit `readDeadlineMs = 600000` as a prior stopgap for this exact symptom — on this
one repo the two mechanisms agree rather than one masking the other's absence; a Diversion repo with
no such override gets the same 600s floor automatically, from the source's own declared capability,
proven independently in `test/index-work.test.ts`.)

**Measured before/after, Project Nod, real repo (`dv.commit.474`, 2026-08-10):**

| | before (given, not re-derived) | after (this task, measured) |
| --- | --- | --- |
| wall clock | 123 s | **1.6 s** |
| files reached | 741 / 1905, `stoppedEarly: true` | **1962 candidates, 1967 files opened, `stoppedEarly: false`** |
| content HTTP (blob) calls | 741 (one per file reached) | **1** |
| fast-path (verified-local) hit rate | n/a (scheme did not exist) | **99.9%** (1966 / 1967) |
| effective `readDeadlineMs` | 120,000 ms (filesystem-calibrated default) | 600,000 ms |

A ~77x wall-clock improvement on a pass that now completes instead of stopping early, with all but
one of 1967 files served from disk after a fresh hash check rather than a network round trip — the
one HTTP fallback is exactly what the scheme predicts for a checkout not byte-for-byte current with
the API's own head.

**Admissibility, proven on the real repo, not only a fixture**: 15 real files sampled from the live
listing (`.md`/`.ini`/`AGENTS.md`), read once through the verified-local path and once through a
second `DiversionIndexSource` instance constructed with no local root at all (forcing every read
over HTTP, the exact pre-RUN-281 shape) — **15/15 produced an identical SHA-256 `contentHash`**,
proving the property that makes this admissible at all: which path served the bytes is invisible to
everything downstream of `read()`.

**What this does NOT cover, stated plainly**: a full `runIndexer` PARSE pass (tree-sitter,
entity/edge extraction) combined with the Diversion source under real event-loop/memory load — this
measurement only exercises `scanIndexSource`, the scan/read/hash stage, not parsing; an actual
`uploadGeneration` against a Diversion-backed generation; the pool-of-1 workspace ACTUALLY being
re-checked-out by a concurrent run while a scan is in flight (reasoned about — a changed file fails
its hash and falls back — but not observed under a real race); and the Perforce half, deliberately
not built here (its listing carries a digest for the same reason, and the seam — `IndexSource
.minReadDeadlineMs`, `index-source.ts`'s `readVerifiedLocal`, `IndexSnapshot.localPath`'s widened
contract — is shaped to fit it without a Perforce-specific redesign).

**A measurement trap worth keeping, because it cost a nearly-filed false defect**: the first read
probe reported "ok BUT EMPTY" for all ten files, including a 6972-byte `.cpp`, and the file size was
confirmed on disk. The probe was wrong, not the backend — `IndexSourceReadOutcome`'s `ok` arm carries
**`bytes: Buffer`** and `overLimit`, never `content`, and `TextDecoder().decode(undefined)` returns
the empty string rather than throwing. Ten healthy reads read as ten silent failures. This is the
third instance in one sitting of an instrument producing a clean-looking wrong answer (the others:
RUN-238's lag probe cleared before the tick that would report the block, and RUN-278's sort timing
run against already-sorted input) — check the shape a result is supposed to have before believing
what it says.

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

The runner itself — including every command in this document — is tested on Linux and **native
Windows** as real CI matrix legs, not a best-effort claim (`.github/workflows/ci.yml`'s
`ubuntu-latest`/`windows-latest` matrix; `README.md`'s "Platforms" note). macOS is expected to work
on the same portable primitives but is not itself a CI leg — unverified, stated plainly rather than
claimed (RUN-240; this line previously overstated it as tested and was corrected here). The
Node-side machinery these commands rest on (`node:fs`, `node:path`, `os.homedir()`) is genuinely
portable: `~/.noriq/index-journal.json` etc. resolve correctly under `%USERPROFILE%` on Windows the
same way they resolve under `$HOME` elsewhere.

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
