# Runner-enforced file locking — dogfood runbook (RUN-107)

The exit gate for the locking plan: **two runner-spawned agents dispatched onto overlapping files
on one repo never clobber each other** — on git via the Noriq lock view + injected hooks + worktree
isolation; on a server-backed VCS (Perforce/Diversion) via native locks — and a conflicting
dispatch is queued/refused, not raced.

Most of the machinery is proven by the automated suite (`npm test`); what only a live run can prove
is the three layers firing against a real agent + a real Noriq server. This is that run. It is a
manual step, like `DOGFOOD.md` — it needs credentials, a server, and model spend.

## What the automated tests already cover

- **LockClient** (`test/lock-client.test.ts`): acquire as the run token, branch scoping,
  all-or-nothing conflict shaping, disabled-project no-op, session re-init, `releaseAllMine`.
- **Seam impls** (`test/vcs-git.test.ts`, `vcs-perforce.test.ts`, `vcs-diversion.test.ts`): git
  delegation; Perforce `p4 lock` native floor + Noriq mirror; Diversion soft-lock degrade.
- **Reactive hook** (`test/lock-hooks.test.ts`): path extraction (incl. Bash fail-open), guard
  deny/allow/fail-open, Stop release, the Claude SDK PreToolUse glue.
- **Hard floor + predictive + release** (`test/supervisor.test.ts`): a build that changed a
  peer-held path is gated (`failed{lock}`, diff kept, never landed); predictive refuse disposes the
  lease before spawning; terminal release fires on every terminal path; land→release ordering.

So this runbook verifies the **integration** the units cannot: real agent → real MCP → real server.

## Prerequisites

1. A Noriq server you can reach, and a project with **file locking ENABLED** (it is opt-in, default
   off): project settings → set `fileLocking` on (or `setFileLocking`). Without this every acquire is
   a no-op grant and nothing is enforced — confirm it is ON first.
2. A runner authenticated to that server (`~/.noriq/credentials.json`), with a git repo marked with
   `.noriq/project.toml` under a `scanRoot`. For the server-backed half, a Perforce or Diversion repo
   the runner also discovers.
3. Two tasks (or two briefs) that will edit **the same file** — e.g. both add a function to
   `src/shared.ts`.

## Procedure — git repo

1. Start the daemon: `npm run build && node dist/cli.js start` (or the installed `noriq-runner`).
2. From the dashboard, **dispatch both build runs at once**, both aimed at `src/shared.ts`.
3. Watch the two run views.

### Expected

- **Reactive layer:** whichever agent reaches the edit second gets a PreToolUse **deny** — its
  transcript shows `🔒 lock hook blocked an edit to src/shared.ts — held by <run A's agent>` (RUN-106),
  and the model is told to coordinate/wait. It does NOT overwrite A's version.
- **Hard floor:** if a Codex run (no in-process hook) edits the file anyway, at landing the daemon's
  floor gates it — `🔒 hard lock floor gated this build …`, run ends `failed{lock}`, its diff is on
  its branch for review, and it never lands over A. A task comment names the holder.
- **Predictive (only if a declared scope is wired):** with `resolveLockScope` returning the file, the
  second dispatch is **refused before its agent spawns** — `declared file scope is locked by another
  run …`, the just-leased worktree disposed. (No scope source ships by default, so this layer is
  silent unless wired — expected.)
- **Release:** when A finishes (lands or fails), its locks release — B's next attempt proceeds.
  Confirm A held its lock THROUGH its landing (B could not grab the file mid-merge).

## Procedure — server-backed VCS (Perforce or Diversion)

Same dispatch, on the p4/dv repo. Additionally confirm:

- The Noriq lock view shows the holds (unified dashboard) — the coordination is identical to git.
- **Perforce:** the native `p4 lock` is laid on the run's changelist (`p4 opened -a` shows the lock).
- **Diversion:** on a Pro workspace the soft lock is posted; on non-Pro it degrades to the Noriq
  layer alone and the run still coordinates (no error).

## Pass criteria

- [ ] Two agents editing one file: exactly one write wins; the other is denied or gated, never a
      silent clobber.
- [ ] A conflicting dispatch with a declared scope is refused/queued, not raced (predictive layer).
- [ ] Locks are held through landing and released after; the freed file unblocks the peer.
- [ ] Lock holds/denials/gates are visible in the run view (transcript milestones) and as task
      comments.
- [ ] Server-backed VCS: native lock present AND mirrored to the Noriq view; Diversion degrades
      gracefully off-Pro.

## Notes / known edges to watch

- **Bash writes** the parser can't read confidently (globs, `$VARS`, command substitution) are
  fail-open at the reactive layer — the **hard floor** at landing is the backstop for those. Verify a
  `bash -c 'cat > src/shared.ts'`-style write on a Codex run still gets gated at landing.
- The exact **Diversion soft-lock endpoint** shape is confirmed here for the first time against a live
  Pro workspace (`src/vcs/diversion.ts` `nativeSoftLock`) — if the request 4xxs on a Pro workspace,
  adjust the endpoint/body to match the live API and re-run; the degrade path means locking still
  worked via the Noriq view meanwhile.
- A foreign client's raw `p4 lock` (a human at a workstation, not a runner agent) is not yet
  reflected as a Noriq conflict — a follow-up needs live-server `fstat` parsing.
