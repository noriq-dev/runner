import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LockDelegate } from './git';
import {
  type P4RawCli,
  PerforceDepotIndexSource,
  realP4RawCli,
  stripDepotPrefix,
} from './perforce-index-source';
import type {
  ChangesBetweenResult,
  IgnoreQueryResult,
  IndexSnapshot,
  IndexSnapshotResult,
  IntegrateResult,
  LeaseOptions,
  LockContext,
  LockOutcome,
  PublishResult,
  ReviewRequest,
  ReviewResult,
  VcsBackend,
  Workspace,
} from './types';

/**
 * Perforce, as a VcsBackend (RUN-52).
 *
 * Every mapping here was MEASURED against a real p4d (2024.2) in RUN-55 — VCS-SPIKE.md §10 —
 * which is why this backend is mechanically the easiest after git, the inverse of what the
 * paper spike feared:
 *
 *  - **`submit` IS the compare-and-swap.** A submit against a moved line fails, exit 1, naming
 *    each file: "must resolve #2 … Out of date files must be resolved or reverted." The server
 *    enforces it atomically — better than Diversion's backend-carried CAS (which has a window),
 *    equal to git's `--ff-only`.
 *  - **The agent conflict loop runs headless**: `p4 merge3 base theirs yours` prints the 3-way
 *    merge WITH MARKERS to stdout; the daemon writes it into the client file; the agent edits;
 *    `p4 resolve -ay` accepts the edited result; `p4 submit -c N` retries. Measured end to end.
 *  - **Orphan recovery is §5's "shelve, then clean", literally**: shelve the crashed run's
 *    pending change (run id in the description), revert the workspace — the work survives the
 *    machine, attributably, and the server is the registry.
 *
 * The model, stated plainly because it is NOT git's:
 *
 *  - **There are no branches here.** The run's work is a numbered pending changelist in the
 *    leased workspace, and landing is `p4 submit` to the line the client VIEWS (its stream,
 *    its depot path) — chosen when the operator configured the client, not per run. So
 *    `[land].branch` selects nothing on this backend: `targetExists` is always true (the
 *    viewed line exists by construction) and `createTarget` refuses loudly. Streams vs branch
 *    specs stays open until a real site's depot exists to decide it (RUN-55 §10); guessing
 *    would land work somewhere a branch name never said.
 *  - **Pool-of-1 lease on the repo's client workspace**, same as Diversion, same reason
 *    (RUN-48): the repo is large on purpose; runs take turns, in process.
 *  - **`allwrite` is flipped per lease.** Coding agents write files; they do not `p4 edit`
 *    first. A writable lease flips the client to `allwrite` so the agent can just work, and
 *    `checkpoint` runs `p4 reconcile` to gather what actually changed. A read-only lease flips
 *    `noallwrite`, and the OS enforces the scope floor for free — unopened files are
 *    `-r--r--r--` on disk (measured).
 *  - **`disposePreservesWork` is true**: dispose shelves whatever is still opened (durable,
 *    server-side, attributable), then reverts the workspace clean — so the caller may ALWAYS
 *    dispose and the pool is never held hostage to kept work. This flag exists because
 *    designing this backend exposed that git's keep-work shape — skip the dispose — wedges any
 *    pool-of-1 backend forever.
 */

/** Injectable p4 runner. cwd is the client workspace root — P4CONFIG there names the client;
 *  stdin carries specs for the `-i` commands (change -i, client -i). */
export type P4Cli = (
  args: string[],
  cwd: string,
  stdin?: string,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * p4 reports emptiness with a NONZERO exit and one of these messages — an ANSWER, not a failure.
 * Kept narrow on purpose: everything outside it must stay an error (RUN-152).
 *
 * Unlike the submit/resolve strings elsewhere in this file, these two are from p4's documented
 * behaviour, NOT from the measured RUN-55 acceptance session (VCS-SPIKE.md records nothing about
 * an empty `opened` or `reconcile -n`). Re-check them against a live server before this backend
 * ships: an emptiness message this regex does not recognise fails CLOSED — the run is treated as
 * holding work, which costs a wasted verify rather than a deleted diff, but it is still wrong.
 */
const P4_NOTHING_HERE = /not opened on this client|no file\(s\) to reconcile/i;

export const realP4Cli: P4Cli = (args, cwd, stdin) =>
  new Promise((resolve, reject) => {
    // PWD must MATCH cwd, and this is measured, not defensive: p4 trusts the PWD env var over
    // its actual working directory when walking up for P4CONFIG, and node's spawn({cwd})
    // changes the directory while inheriting the parent's PWD — so without this line every p4
    // call resolved P4CONFIG relative to wherever the DAEMON was started, and the live
    // acceptance run connected to the wrong server. The fakes could never have seen it.
    const child = spawn('p4', args, {
      cwd,
      env: { ...process.env, PWD: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`p4 ${args[0]} exited ${code}: ${stdout}${stderr}`));
    });
    child.stdin.end(stdin ?? '');
  });

interface P4Location {
  client: string;
  /** The run's pending changelist number. */
  change: string;
}

function p4Location(ws: Workspace): P4Location {
  const loc = ws.location as Partial<P4Location> | null | undefined;
  if (typeof loc?.client === 'string' && typeof loc?.change === 'string') {
    return { client: loc.client, change: loc.change };
  }
  throw new Error(
    `workspace for run ${ws.runId} does not carry a Perforce location — it was minted by another backend or an incompatible daemon version`,
  );
}

/**
 * What this backend stashes in an `IndexSnapshot`'s `location` (RUN-254) — tagged with a
 * discriminant, the same reasoning `GitIndexSnapshotLocation` gives: `IndexSnapshot` and
 * `Workspace` are structurally close enough (both carry `localPath`/`baseId`/`readOnly`/
 * `location`) that a `Workspace` variable satisfies this type by ordinary structural typing, so
 * `kind` is what lets `p4IndexSnapshotLocation` refuse a foreign object — a run's `P4Location`
 * (`client`+`change`) rather than a snapshot's (`prefix`+`change`) — at runtime.
 */
interface P4IndexSnapshotLocation {
  kind: 'perforce-index-snapshot';
  prefix: string;
  change: string;
}

function p4IndexSnapshotLocation(snapshot: IndexSnapshot): P4IndexSnapshotLocation {
  const loc = snapshot.location as Partial<P4IndexSnapshotLocation> | null | undefined;
  if (
    loc?.kind === 'perforce-index-snapshot' &&
    typeof loc.prefix === 'string' &&
    typeof loc.change === 'string'
  ) {
    return { kind: loc.kind, prefix: loc.prefix, change: loc.change };
  }
  throw new Error(
    'Perforce refuses to release an index snapshot it did not mint — this location was minted by another backend or an incompatible daemon version',
  );
}

/**
 * Mirrors `worktree.ts`'s `CHANGES_BETWEEN_MAX_PATHS` — same reasoning (past this many
 * changed+deleted paths, the "incremental" path is a slower full index with none of the savings),
 * kept as an independent constant so the two backends never share an accidental coupling.
 */
const PERFORCE_CHANGES_BETWEEN_MAX_PATHS = 10_000;

/**
 * `p4 diff2 -q` answers "these two bases are identical" as TEXT on an exit-0 call —
 * `"<pattern>@<from> - no differing files."`, on STDERR, with stdout left EMPTY — the same
 * "emptiness is an answer, not a failure" shape `P4_NOTHING_HERE` above already handles for
 * `opened`/`reconcile`, and the same stream split `changelistExists` hit for "no such
 * changelist." (both messages measured on stderr despite an exit-0 success). Measured against the
 * rig, not assumed.
 */
const P4_DIFF2_EMPTY = /no differing files/i;

/**
 * One `p4 diff2 -q` header line, parsed by POSITION — never by counting `=` (RUN-254 locked
 * decision 5, measured against the rig): the deleted arm's trailing marker is `===` (three
 * characters) where the added and modified arms end in `====` (four), which reads exactly like a
 * typo and would silently drop every deletion under a parser that counts equals signs instead.
 * `<none>` on either side of the ` - ` separator names which arm this is; the trailing ` content`
 * marker (present only on the modified arm, because `-q` still prints its header even though it
 * suppresses the diff body) is otherwise unused here — the caller already knows a path changed
 * from the fact that `-q` produced a header line for it at all, since it never lists an unchanged
 * file.
 */
function parseDiff2Header(line: string): { left: string | null; right: string | null } | null {
  const m = line.match(/^==== (.+?) =+(?: content)?$/);
  if (!m?.[1]) return null;
  const sepIdx = m[1].indexOf(' - ');
  if (sepIdx < 0) return null;
  // Each named side is `//depot/path#rev` (plus ` (type)` on the modified arm) — strip BOTH the
  // trailing `#rev` and the type annotation so what is returned is a plain depot path
  // `stripDepotPrefix` can relativize, never a revision-suffixed one that would silently
  // never match a real indexed path.
  const stripType = (side: string) =>
    side === '<none>' ? null : side.replace(/ \([^()]*\)$/, '').replace(/#\d+$/, '');
  return { left: stripType(m[1].slice(0, sepIdx)), right: stripType(m[1].slice(sepIdx + 3)) };
}

export interface PerforceBackendOpts {
  p4?: P4Cli;
  /** Injectable Buffer-safe runner for the depot index source's content reads (RUN-254) — see
   *  `perforce-index-source.ts`'s module doc for why `p4` (string-based) cannot serve this role. */
  p4Raw?: P4RawCli;
  /** Injectable for tests — writes the merge3 marker file into the workspace. */
  writeFileFn?: (p: string, content: string) => Promise<void>;
  /** The Noriq lock view (RUN-99). Perforce has real exclusive locks, but the runner's cross-run
   *  coordination + the unified dashboard live in the Noriq lock primitive — so acquire/release
   *  mirror there (authoritative for conflicts), and `p4 lock` is layered on as the native
   *  enforcement floor. Absent → the native layer only, and queryLocks/lock report `enabled:false`. */
  locks?: LockDelegate;
}

export class PerforceBackend implements VcsBackend {
  readonly kind = 'perforce';
  readonly disposePreservesWork = true;
  private readonly p4: P4Cli;
  private readonly p4Raw: P4RawCli;
  private readonly write: (p: string, content: string) => Promise<void>;
  private readonly locks?: LockDelegate;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly held = new Map<string, () => void>();

  constructor(opts: PerforceBackendOpts = {}) {
    this.p4 = opts.p4 ?? realP4Cli;
    this.p4Raw = opts.p4Raw ?? realP4RawCli;
    this.write = opts.writeFileFn ?? ((p, c) => writeFile(p, c, 'utf8'));
    this.locks = opts.locks;
  }

  /**
   * The depot path prefix this repo's client is configured to view (RUN-254) — read from the
   * OPERATOR's own client spec (`p4 client -o`), never from caller input: `leaseIndexSnapshot` and
   * `changesBetween` both scope their queries to this, and `perforce-index-source.ts`'s module doc
   * carries the full containment rationale for why that trust placement is what makes the depot
   * source's guarantee hold. Read-only — `client -o` outputs the spec, it does not touch it.
   *
   * Only the FIRST `View:` line is read (discretion: a multi-line view, or a stream client whose
   * view p4 assembles rather than stores literally, is unmeasured here) — a documented limitation,
   * not a silent one.
   */
  private async resolveDepotPrefix(repoRoot: string): Promise<string> {
    const client = await this.clientName(repoRoot);
    const { stdout: spec } = await this.p4(['client', '-o', client], repoRoot);
    const m = spec.match(/^View:\s*\r?\n\t(\S+)/m);
    if (!m?.[1]) {
      throw new Error(
        `client ${client}'s spec has no View mapping this backend could read a depot prefix from — cannot build an index source without one`,
      );
    }
    return m[1];
  }

  /**
   * Is `change` a real, currently-visible submitted changelist? p4 answers "no" as EXIT-0 TEXT
   * (`"<n> - no such changelist."`) from `describe -s`, not a nonzero exit — measured directly
   * (RUN-254), and load-bearing: `p4 diff2`/`p4 files` do NOT error for an out-of-range changelist
   * number either, they silently clamp to the depot's current head, which would otherwise make
   * `changesBetween` answer a confident, WRONG diff for a `to`/`from` that never existed. This
   * check is what stands between that silent clamp and an honest `full-index-required`. A
   * syntactically invalid id (non-numeric, negative, zero) exits NONZERO (a usage error) and folds
   * into the same "could not confirm it" answer via the caller's own try/catch.
   */
  private async changelistExists(change: string, cwd: string): Promise<boolean> {
    // "no such changelist." arrives on STDERR despite the exit-0 success (measured against the
    // live rig, the hard way — a first cut of this check read only `stdout`, which is where the
    // message lands when a shell merges the two streams for a human to read, and so it passed
    // every FAKE-driven unit test while silently treating a bogus changelist as real against a
    // live server). Both streams are checked so neither p4's human-facing convention nor a fake
    // that puts the message on the "wrong" stream can hide the answer.
    const { stdout, stderr } = await this.p4(['describe', '-s', change], cwd);
    const notFound = `${change} - no such changelist.`;
    return stdout.trim() !== notFound && stderr.trim() !== notFound;
  }

  private async clientName(cwd: string): Promise<string> {
    const { stdout } = await this.p4(['-Ztag', '-F', '%clientName%', 'info'], cwd);
    const name = stdout.trim();
    if (!name || name === '*unknown*') {
      throw new Error(`no Perforce client maps ${cwd} — set P4CONFIG in the workspace root`);
    }
    return name;
  }

  /**
   * One-way, once: make the client `allwrite` so agents can just write files (they do not
   * `p4 edit` first), and force-resync to fix the permissions of files already on disk.
   *
   * Measured live, not theorized: flipping the option is NOT retroactive — files synced under
   * `noallwrite` stay `-r--r--r--` until a `sync -f` re-materializes them, and the first
   * build agent EACCESes on its first write. And per-lease flipping (allwrite for builds,
   * noallwrite for scope) would pay that forced re-sync of a deliberately large repo on every
   * alternation — pathological. So: allwrite is a one-time migration, and a read-only lease's
   * floor is the driver permission profile, exactly as it is everywhere else.
   */
  private async ensureAllwrite(cwd: string, client: string): Promise<void> {
    const { stdout: spec } = await this.p4(['client', '-o', client], cwd);
    if (/\ballwrite\b/.test(spec) && !/\bnoallwrite\b/.test(spec)) return;
    await this.p4(['client', '-i'], cwd, spec.replace(/\bnoallwrite\b/, 'allwrite'));
    await this.p4(['sync', '-f'], cwd); // the one-time cost that makes existing files writable
  }

  async lease(repoRoot: string, runId: string, opts?: LeaseOptions): Promise<Workspace> {
    const turn = this.queue;
    let release!: () => void;
    this.queue = this.queue.then(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    await turn;
    this.held.set(runId, release);

    try {
      const client = await this.clientName(repoRoot);
      // A leased workspace is NOT a minted one (measured, the hard way): a previous run that
      // died without dispose leaves its files opened in a stale changelist, and `p4 reconcile
      // -c <new>` silently skips files already opened elsewhere — the new run's checkpoint
      // then gathers nothing and its submit says "No files to submit". Git cannot have this
      // problem (create mints fresh); a pool-of-1 lease must self-heal instead, with the same
      // shelve-then-clean the startup reaper uses: the dead run's work stays recoverable, the
      // workspace starts clean.
      await this.reapOrphans(repoRoot);
      // Writable runs need allwrite (the agent just writes; reconcile gathers). Read-only
      // leases change nothing: their floor is the driver permission profile, same as git.
      if (!opts?.readOnly) await this.ensureAllwrite(repoRoot, client);
      // Fresh base: the line's head, which is also what baseId honestly means here.
      await this.p4(['sync'], repoRoot);
      const { stdout: baseRaw } = await this.p4(
        ['-Ztag', '-F', '%change%', 'changes', '-m1', '#have'],
        repoRoot,
      );
      const baseId = baseRaw.trim() || '0';

      if (opts?.fromRunId) {
        // A verify run leases from the BUILD's work: unshelve its changelist into this
        // workspace — the measured cross-workspace recovery primitive.
        const buildChange = await this.findRunChange(repoRoot, opts.fromRunId);
        if (!buildChange) {
          throw new Error(`cannot lease from run ${opts.fromRunId}: no changelist names it`);
        }
        await this.p4(['unshelve', '-s', buildChange], repoRoot);
      }

      // Continue a failed run (RUN-93): a prior attempt at THIS run id shelved its work at dispose
      // (disposePreservesWork), and reapOrphans above spared it — a shelved changelist has no
      // opened files, so it is not re-cleaned. Find it now, BEFORE minting this sitting's
      // changelist, so `findRunChange` cannot match the one we are about to create.
      const priorChange = opts?.fromRunId ? null : await this.findRunChange(repoRoot, runId);

      // The run's pending changelist. Its description IS the crash-recovery record (the reaper
      // greps for it), mirroring git's run-id-in-the-branch-name. `--field` does the spec
      // surgery so no regex of ours can corrupt it — the exact pattern RUN-55 measured.
      const { stdout: changeSpec } = await this.p4(
        ['--field', `Description=noriq run ${runId}`, 'change', '-o'],
        repoRoot,
      );
      const created = await this.p4(['change', '-i'], repoRoot, changeSpec);
      const change = created.stdout.match(/Change (\d+) created/)?.[1];
      if (!change) throw new Error(`could not create a changelist: ${created.stdout}`);

      if (priorChange && priorChange !== change) {
        // Unshelve the prior attempt's work straight INTO this sitting's changelist — into the
        // named one, not the default, because `reconcile -c` at checkpoint SKIPS files already
        // opened elsewhere (the exact trap the lease self-heal above exists for), so work left in
        // the default would never make it into the submit. Then drop the stale shelf + changelist
        // so it stops matching `findRunChange` and cannot accumulate as an orphan.
        await this.p4(['unshelve', '-s', priorChange, '-c', change], repoRoot);
        await this.p4(['shelve', '-d', '-c', priorChange], repoRoot).catch(() => {});
        await this.p4(['change', '-d', priorChange], repoRoot).catch(() => {});
      }

      return {
        runId,
        localPath: repoRoot,
        readOnly: opts?.readOnly ?? false,
        baseId,
        workRef: `change ${change} in client ${client}`,
        location: { client, change } satisfies P4Location,
      };
    } catch (err) {
      this.held.delete(runId);
      release();
      throw err;
    }
  }

  private async findRunChange(cwd: string, runId: string): Promise<string | null> {
    const { stdout } = await this.p4(['changes', '-l'], cwd);
    const m = stdout.match(new RegExp(`Change (\\d+)[^\\n]*\\n\\n\\s*noriq run ${runId}\\b`));
    return m?.[1] ?? null;
  }

  /**
   * Give the workspace back. Deleting the changelist is the DESTRUCTIVE branch, and it is only
   * taken when p4 said there is nothing in it (RUN-157).
   *
   * This used to swallow the probe outright, so a p4 that could not be reached read as "nothing
   * opened" and the changelist was deleted — on an allwrite workspace whose edits were never
   * reconciled, that work was never shelved and leaks into whoever leases next. A backend that
   * advertises `disposePreservesWork` has to actually preserve it.
   *
   * An unreadable probe therefore takes the PRESERVE branch, and preserving is three steps rather
   * than two. `shelve` only captures files that are OPEN in the changelist, and on an allwrite
   * client an agent's edits are not open until something reconciles them — which is exactly the
   * work at risk here. So: reconcile (gather what is on disk), shelve (make it durable), then
   * revert. Reverting is conditional on the shelf actually landing: discarding the local copy
   * because a shelve we could not verify "probably worked" is the same mistake one layer down.
   */
  async dispose(ws: Workspace): Promise<void> {
    const loc = p4Location(ws);
    try {
      let opened: string;
      try {
        opened = (await this.p4(['opened', '-c', loc.change], ws.localPath)).stdout;
      } catch (err) {
        // "File(s) not opened on this client" is p4 ANSWERING empty; anything else means we could
        // not ask, and an unaskable changelist is not an empty one.
        opened = P4_NOTHING_HERE.test(String(err)) ? '' : 'unknown — assume this holds work';
      }
      if (opened.trim()) {
        // Unlanded work: durable FIRST (§5's shelve-then-clean — another workspace can recover it
        // byte-for-byte, measured), then clean. This is what makes always-dispose safe on a
        // pool-of-1 backend.
        await this.p4(['reconcile', '-c', loc.change], ws.localPath).catch(() => {});
        const shelved = await this.p4(['shelve', '-f', '-c', loc.change], ws.localPath).then(
          () => true,
          () => false,
        );
        // A failed shelf leaves the ONLY copy on disk. Reverting then would destroy it to tidy a
        // workspace — the pool pays for that with a dirty checkout the next lease has to sync over,
        // which is recoverable in a way the work is not. The changelist survives for the reaper.
        if (shelved) await this.p4(['revert', '-c', loc.change, '//...'], ws.localPath).catch(() => {});
      } else {
        // Nothing opened (landed, or a no-op run): delete the empty changelist. p4 REFUSES if
        // a shelf exists — the shelf is the orphan record, and it outlives the lease on purpose.
        await this.p4(['change', '-d', loc.change], ws.localPath).catch(() => {});
      }
    } finally {
      this.held.get(ws.runId)?.();
      this.held.delete(ws.runId);
    }
  }

  /**
   * Only p4's own "there is nothing here" is absorbed (RUN-152). Blanket-swallowing both probes
   * reported "no work" whenever p4 could not be reached at all, and the caller acts on `false` by
   * disposing the workspace — a fail-open on a destructive decision. The distinction is awkward
   * here rather than free, because p4 exits NONZERO for emptiness: `opened` on an empty change
   * says "File(s) not opened on this client", `reconcile -n` says "no file(s) to reconcile". Those
   * are answers. A dead connection, a bad client, an auth expiry are not.
   */
  async hasWork(ws: Workspace): Promise<boolean> {
    const loc = p4Location(ws);
    const opened = await this.emptyOrThrow(this.p4(['opened', '-c', loc.change], ws.localPath));
    if (opened.trim()) return true;
    // allwrite hides edits from p4 until a reconcile — preview what one would gather.
    const reconcile = await this.emptyOrThrow(this.p4(['reconcile', '-n'], ws.localPath));
    return /opened for (add|edit|delete)/.test(reconcile);
  }

  /** p4 says "nothing here" by failing. Absorb exactly that and let everything else through. */
  private async emptyOrThrow(call: Promise<{ stdout: string }>): Promise<string> {
    try {
      return (await call).stdout;
    } catch (err) {
      if (P4_NOTHING_HERE.test(String(err))) return '';
      throw err;
    }
  }

  /**
   * `false` means "there was nothing to save", never "the save could not be attempted" (RUN-157).
   *
   * Both probes used to be swallowed, so a p4 outage returned `false` — and the supervisor ignores
   * checkpoint's boolean, so the run continued to its gates with no durable copy and not one line
   * anywhere saying so. Propagating instead reaches the supervisor's own handler, which logs "could
   * not commit the run diff — it stays uncommitted". p4's emptiness messages are still absorbed:
   * a reconcile with nothing to gather is an answer.
   */
  async checkpoint(ws: Workspace, _message: string): Promise<boolean> {
    const loc = p4Location(ws);
    // Gather what the agent actually changed into the run's changelist…
    await this.emptyOrThrow(this.p4(['reconcile', '-c', loc.change], ws.localPath));
    const opened = await this.emptyOrThrow(this.p4(['opened', '-c', loc.change], ws.localPath));
    if (!opened.trim()) return false;
    // …then shelve: the durable server-side copy. This WRITES THE DEPOT before any gate runs —
    // RUN-48's accepted trade, in THREAT-MODEL.md in the operator's own terms. (The message is
    // unused: the changelist description already names the run; shelves have no message.)
    await this.p4(['shelve', '-f', '-c', loc.change], ws.localPath);
    return true;
  }

  /** The viewed line exists by construction — `[land].branch` selects nothing here (see the
   *  model note at the top). */
  async targetExists(_repoRoot: string, _target: string): Promise<boolean> {
    return true;
  }

  async createTarget(_repoRoot: string, target: string, _from: string): Promise<void> {
    throw new Error(
      `cannot create "${target}" on Perforce: the landing destination is the client workspace's own view (its stream/depot line), configured by the operator — streams vs branch specs needs a real depot to decide (VCS-SPIKE.md §10)`,
    );
  }

  /**
   * Bring the line's head into the workspace: sync schedules resolves for opened files,
   * `resolve -am` auto-merges the safe ones (measured: a true conflict is SKIPPED, "1
   * conflicting"), and each file still conflicting gets the merge3 marker text written IN
   * PLACE so an agent can edit it exactly as it would a git conflict.
   */
  async integrate(ws: Workspace, _target: string): Promise<IntegrateResult> {
    await this.p4(['sync'], ws.localPath);
    await this.p4(['resolve', '-am'], ws.localPath).catch(() => {});
    const conflicts = await this.unresolvedPaths(ws);
    if (!conflicts.length) return { ok: true };

    for (const clientFile of conflicts) {
      const merged = await this.merge3(ws, clientFile).catch(() => null);
      if (merged) await this.write(clientFile, merged);
    }
    return { ok: false, conflicts: conflicts.map((p) => this.relative(ws, p)) };
  }

  /**
   * A conflict path in the shape the rest of the system speaks: workspace-relative and `/`-spelled.
   *
   * These are contract values, not host ones — they are rendered into the agent's conflict prompt
   * and into the comment posted when landing fails, so a Windows daemon reporting `src\a.ts` would
   * describe the same conflict differently depending on who picked up the run.
   *
   * Containment is `path`'s arithmetic rather than a string prefix, because `startsWith` reads a
   * SIBLING as a child: a `/wt2/a.ts` under a `/wt` workspace was silently reported as the relative
   * path `2/a.ts`. Anything genuinely outside is handed back untouched — an absolute path is a poor
   * conflict label, but inventing a relative one for a file that is not in the workspace is worse.
   */
  private relative(ws: Workspace, p: string): string {
    const rel = path.relative(ws.localPath, p);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return p;
    return rel.split(path.sep).join('/');
  }

  private async unresolvedPaths(ws: Workspace): Promise<string[]> {
    const { stdout } = await this.p4(['resolve', '-n'], ws.localPath).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    // Measured shape: `<clientFile> - merging //depot/shared.txt#2`
    return stdout
      .split('\n')
      .map((l) => l.match(/^(.+?) - merging /)?.[1]?.trim())
      .filter((p): p is string => !!p);
  }

  private async merge3(ws: Workspace, clientFile: string): Promise<string | null> {
    // base = the from-rev the resolve starts at; theirs = the head rev it merges to. Measured
    // twice, the second time the hard way: merge3 takes THREE LOCAL FILES — hand it a depot
    // revision and it says "No such file or directory" — so base and theirs are p4-printed to
    // temp files first, exactly as RUN-55's live loop did. merge3 then prints the marked-up
    // merge to stdout, non-interactively.
    const { stdout: tag } = await this.p4(
      ['-Ztag', '-F', '%fromFile%\t%startFromRev%\t%endFromRev%', 'resolve', '-n', clientFile],
      ws.localPath,
    ).catch(() => ({ stdout: '', stderr: '' }));
    const [depotFile, startRev, endRev] = tag.trim().split('\t');
    if (!depotFile || !endRev) return null;

    const baseRev = !startRev || startRev === 'none' ? '1' : startRev;
    const tmp = (rev: string) =>
      path.join(os.tmpdir(), `noriq-merge3-${ws.runId}-${rev}-${path.basename(clientFile)}`);
    const baseFile = tmp(baseRev);
    const theirsFile = tmp(endRev);
    try {
      const { stdout: base } = await this.p4(['print', '-q', `${depotFile}#${baseRev}`], ws.localPath);
      const { stdout: theirs } = await this.p4(['print', '-q', `${depotFile}#${endRev}`], ws.localPath);
      await this.write(baseFile, base);
      await this.write(theirsFile, theirs);
      const { stdout } = await this.p4(['merge3', baseFile, theirsFile, clientFile], ws.localPath);
      return stdout;
    } finally {
      await rm(baseFile, { force: true }).catch(() => {});
      await rm(theirsFile, { force: true }).catch(() => {});
    }
  }

  /** The agent edited the marker files in place — accept the edited result (`resolve -ay`,
   *  the measured scripted route) and report anything still pending. */
  async resumeIntegrate(ws: Workspace): Promise<IntegrateResult> {
    await this.p4(['resolve', '-ay'], ws.localPath).catch(() => {});
    const conflicts = await this.unresolvedPaths(ws);
    return conflicts.length
      ? { ok: false, conflicts: conflicts.map((p) => this.relative(ws, p)) }
      : { ok: true };
  }

  /** Keeps the run's files and closes the pending resolves as "ours" — what is abandoned is
   *  the attempt to COMBINE, not the work, exactly as git's abort keeps the branch. The work
   *  stays recoverable via the shelf dispose() writes. */
  async abandonIntegrate(ws: Workspace): Promise<void> {
    await this.p4(['resolve', '-ay'], ws.localPath).catch(() => {});
  }

  /**
   * `p4 submit -c N`. The server's own CAS, measured exactly: a moved line refuses the submit
   * — exit 1, "Out of date files must be resolved or reverted", per file. No guard, no window.
   */
  async publish(ws: Workspace, _target: string): Promise<PublishResult> {
    const loc = p4Location(ws);
    // A changelist with shelved files refuses to submit — drop the shelf first. Between here
    // and the submit the server-side copy is gone while the local files still hold the work;
    // small, real, and strictly better than not shelving at all.
    await this.p4(['shelve', '-d', '-c', loc.change], ws.localPath).catch(() => {});
    try {
      const { stdout } = await this.p4(['submit', '-c', loc.change], ws.localPath);
      const submitted = stdout.match(/Change (\d+) submitted/)?.[1];
      return { ok: true, sha: `change ${submitted ?? loc.change}` };
    } catch (err) {
      const msg = (err as Error).message;
      if (/out of date|must resolve/i.test(msg)) {
        return {
          ok: false,
          reason: 'race',
          detail: 'the line moved since this run integrated it — p4 submit refused (out of date)',
        };
      }
      return { ok: false, reason: 'error', detail: msg };
    }
  }

  /**
   * The run-addressed pair (RUN-170) is refused here, honestly, for two reasons that compound:
   * this backend leases pool-of-1 (`leasesOverlap` absent), so a wave runs sequentially in the
   * parent's own workspace and these verbs never legitimately fire — and there is no per-run
   * LINE to name anyway: a run's work is a pending changelist, and submit lands on the line the
   * client VIEWS, chosen by the operator, not per run (see the model note at the top). A call
   * reaching this is a scheduling bug, and the loud failure is the diagnostic — quietly
   * composing something from unshelve would land work on a line no run id ever named.
   */
  async integrateFromRun(ws: Workspace, runId: string): Promise<IntegrateResult> {
    throw new Error(
      `cannot integrate run ${runId}'s work into run ${ws.runId}'s workspace on Perforce: leases here are pool-of-1, so wave steps run sequentially and share the parent's workspace — the run-addressed verbs have no target line on this backend`,
    );
  }

  async publishToRun(ws: Workspace, runId: string): Promise<PublishResult> {
    throw new Error(
      `cannot land run ${ws.runId}'s workspace on run ${runId}'s line on Perforce: submit lands on the line the client views, not on a per-run line — and pool-of-1 leases mean no wave step ever needs this verb here`,
    );
  }

  /** Submit already published; there is no further step — exactly like Diversion. */
  async share(_repoRoot: string, _target: string): Promise<{ ok: true }> {
    return { ok: true };
  }

  /**
   * The daemon cannot open a Perforce review (RUN-85): `gh` is not the review surface, and no
   * Swarm (or review-daemon) API has been measured — this file's rule is measured shape or
   * nothing. The work is not stranded: submit already put it on the line the client views,
   * numbered and attributed (`noriq@<client>`). What is missing is only the review ARTIFACT,
   * so the honest answer is a refusal naming where a human reviews — the caller warns and
   * records it instead of the silent nothing a hand-written `[land].mergeTarget` used to buy.
   * No p4 call: this method states a fact about Perforce, it does not act.
   */
  async openReview(_repoRoot: string, _review: ReviewRequest): Promise<ReviewResult> {
    return {
      ok: false,
      detail:
        'review happens in Perforce: the plan is submitted as numbered changelists on the line ' +
        'the client views — review them in your Perforce tooling (Swarm, or p4 describe); the ' +
        'daemon opens no Swarm review',
    };
  }

  /**
   * §5's shape, measured: shelve each orphaned noriq changelist (durable — another machine can
   * unshelve it byte-for-byte), then revert the workspace clean. Shelved orphans are REPORTED
   * via onSkip, never deleted; the server is the registry a human consults.
   */
  async reapOrphans(
    repoRoot: string,
    opts?: { onSkip?: (path: string) => void; isOwned?: (runId: string) => boolean },
  ): Promise<number> {
    const { stdout } = await this.p4(['changes', '-s', 'pending', '-l'], repoRoot).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    let cleaned = 0;
    for (const m of stdout.matchAll(/Change (\d+)[^\n]*\n\n\s*noriq run (\S+)/g)) {
      const change = m[1];
      if (!change) continue;
      // A LIVE run's changelist is what this would otherwise shelve and revert out from under the
      // agent still writing into it (RUN-153). At startup nothing is owned and this never fires.
      if (m[2] && opts?.isOwned?.(m[2])) continue;
      const { stdout: opened } = await this.p4(['opened', '-c', change], repoRoot).catch(() => ({
        stdout: '',
        stderr: '',
      }));
      if (opened.trim()) {
        await this.p4(['shelve', '-f', '-c', change], repoRoot).catch(() => {});
        await this.p4(['revert', '-c', change, '//...'], repoRoot).catch(() => {});
        cleaned += 1;
      }
      opts?.onSkip?.(`change ${change} (noriq run ${m[2]}) — shelved server-side`);
    }
    return cleaned;
  }

  /**
   * Mints a REAL depot-backed snapshot (RUN-254) — deliberately NOT a try-acquire against
   * `held`, the pool-of-1 lease's own occupancy. RUN-211's original design assumed a snapshot
   * would need SOME workspace, so a busy check stood between it and the deadlock
   * `integrateFromRun`'s doc warns about (an in-process promise chain with nothing to time out).
   * That assumption does not hold for this backend: every query below — `p4 client -o` to read
   * the operator's own View mapping, `p4 changes -m1` for the depot head, and everything
   * `PerforceDepotIndexSource` itself issues (`fstat`, `print`, `diff2`) — is a pure depot read
   * that needs no client workspace and touches no pending changelist, measured with
   * `P4CLIENT=no-such-client-at-all` against the rig (`perforce-index-source.ts`'s module doc
   * carries the full design). So this method never consults `held`: a snapshot may be requested
   * and answered while this SAME process holds the run pool, with zero contention — the
   * acceptance truth RUN-254 exists to prove, not merely assert. (Diversion, RUN-255, is a
   * different backend with its own measured shape and may still need the try-acquire this file's
   * own history shows.)
   *
   * Mints nothing on disk: `location` names the `(prefix, change)` pair the returned
   * `PerforceDepotIndexSource` reads through, and `localPath`/`branch` are both left absent —
   * the honest answer for a backend that materialized no tree and has no branch concept.
   *
   * `resolveDepotPrefix`'s own infra failures (no client mapped, an unreadable spec) and the
   * `changes -m1` probe's both REJECT the promise rather than answering here — the same posture
   * `lease` takes (this union is for outcomes a caller branches on, not for faults;
   * `IndexSnapshotResult`'s own doc states this).
   */
  async leaseIndexSnapshot(repoRoot: string): Promise<IndexSnapshotResult> {
    const prefix = await this.resolveDepotPrefix(repoRoot);
    const { stdout: changeRaw } = await this.p4(
      ['-Ztag', '-F', '%change%', 'changes', '-m1', prefix],
      repoRoot,
    );
    const change = changeRaw.trim();
    if (!change) {
      return {
        ok: false,
        reason: 'unsupported',
        detail: `no submitted changelist exists under ${prefix} — nothing for an index snapshot to pin to`,
      };
    }
    return {
      ok: true,
      snapshot: {
        source: new PerforceDepotIndexSource({
          p4: this.p4,
          p4Raw: this.p4Raw,
          cwd: repoRoot,
          prefix,
          change,
        }),
        baseId: change,
        readOnly: true,
        location: { kind: 'perforce-index-snapshot', prefix, change } satisfies P4IndexSnapshotLocation,
      },
    };
  }

  /**
   * IDEMPOTENT and structurally incapable of touching a run `Workspace` (`p4IndexSnapshotLocation`
   * refuses anything but this backend's own `{kind:'perforce-index-snapshot', …}` tag) — but there
   * is nothing ELSE to clean up: `leaseIndexSnapshot` materialized no client, no sync, no tree, so
   * releasing one is closing whatever the source itself held (nothing, today — `close` is a no-op
   * on `PerforceDepotIndexSource`) and no more.
   */
  async releaseIndexSnapshot(snapshot: IndexSnapshot): Promise<void> {
    p4IndexSnapshotLocation(snapshot); // throws on a foreign object — see its own doc
    await snapshot.source.close?.();
  }

  /**
   * `p4 diff2 -q` across the client's own depot prefix (RUN-254) — chosen over iterating
   * `changes`+`files@=<change>` because it reports the whole `from`→`to` delta, deletions
   * included, in ONE call regardless of how many intervening changelists separate them; the
   * iterate-and-union alternative pays one round trip per intervening changelist for the same
   * answer. `parseDiff2Header` above (measured against the rig) does the parsing: by POSITION
   * (`<none>`'s side, the trailing `content` marker), never by counting `=` — the deleted arm's
   * `===` vs the other arms' `====` reads exactly like a typo, and a parser that counted equals
   * signs would silently drop every deletion, the one thing an index must never lose track of
   * (locked decision 5).
   *
   * Every uncertain condition below answers `full-index-required` rather than throwing or
   * reporting an empty diff (`ChangesBetweenResult`'s locked decision 1), mirroring
   * `WorktreeManager.changesBetween`'s git-side structure:
   *  - the depot prefix cannot be resolved (no client mapped, an unreadable spec);
   *  - either `from` or `to` does not resolve to a real submitted changelist (RUN-254 locked
   *    decision 7) — checked explicitly via `changelistExists`, because `diff2` itself does NOT
   *    error for an unknown/future changelist number, it silently answers as of the depot's
   *    current head (measured, and the reason this check exists at all);
   *  - the `diff2` query itself fails (a connection drop, a server error);
   *  - any header line fails to parse (`parseDiff2Header` returns `null`, or names `<none>` on
   *    BOTH sides — a shape p4 has never been measured to produce and this refuses to guess at);
   *  - the reported change set exceeds `PERFORCE_CHANGES_BETWEEN_MAX_PATHS`.
   *
   * `{ok:true, changed:[], deleted:[]}` is a real, distinct answer (locked decision 2): p4 reports
   * two identical bases as `"... - no differing files."` on STDERR with stdout left empty, exit
   * 0 — recognized below by the empty stdout (and, defensively, `P4_DIFF2_EMPTY` against either
   * stream), never conflated with an unparseable or failed query.
   */
  async changesBetween(repoRoot: string, from: string, to: string): Promise<ChangesBetweenResult> {
    let prefix: string;
    try {
      prefix = await this.resolveDepotPrefix(repoRoot);
    } catch (err) {
      return {
        ok: false,
        reason: 'full-index-required',
        detail: `could not resolve a depot prefix for ${repoRoot}: ${(err as Error).message}`,
      };
    }

    for (const [label, id] of [
      ['from', from],
      ['to', to],
    ] as const) {
      let exists: boolean;
      try {
        exists = await this.changelistExists(id, repoRoot);
      } catch (err) {
        return {
          ok: false,
          reason: 'full-index-required',
          detail: `could not confirm the ${label} changelist ${JSON.stringify(id)}: ${(err as Error).message}`,
        };
      }
      if (!exists) {
        return {
          ok: false,
          reason: 'full-index-required',
          detail: `${label} changelist ${JSON.stringify(id)} does not resolve to a real submitted changelist under ${prefix} — unknown, purged, or invalid`,
        };
      }
    }

    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await this.p4(['diff2', '-q', `${prefix}@${from}`, `${prefix}@${to}`], repoRoot));
    } catch (err) {
      return {
        ok: false,
        reason: 'full-index-required',
        detail: `diff2 between ${from} and ${to} failed: ${(err as Error).message}`,
      };
    }

    // Every header line lives on STDOUT (measured); "no differing files." lives on STDERR with
    // stdout EMPTY (measured — the same stream split `changelistExists` hit for "no such
    // changelist."). So an empty stdout is already the reliable signal; `P4_DIFF2_EMPTY` against
    // BOTH streams is the defensive extra layer in case a future p4 version routes it elsewhere.
    const trimmed = stdout.trim();
    if (!trimmed || P4_DIFF2_EMPTY.test(stdout) || P4_DIFF2_EMPTY.test(stderr)) {
      return { ok: true, changed: [], deleted: [] };
    }

    const changed = new Set<string>();
    const deleted = new Set<string>();
    for (const line of trimmed.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseDiff2Header(line);
      if (!parsed || (parsed.left === null && parsed.right === null)) {
        return {
          ok: false,
          reason: 'full-index-required',
          detail: `unparseable diff2 header between ${from} and ${to}: ${JSON.stringify(line)}`,
        };
      }
      if (parsed.left === null) {
        const rel = parsed.right ? stripDepotPrefix(prefix, parsed.right) : null;
        if (rel !== null) changed.add(rel);
      } else if (parsed.right === null) {
        const rel = stripDepotPrefix(prefix, parsed.left);
        if (rel !== null) deleted.add(rel);
      } else {
        const rel = stripDepotPrefix(prefix, parsed.right);
        if (rel !== null) changed.add(rel);
      }
    }

    if (changed.size + deleted.size > PERFORCE_CHANGES_BETWEEN_MAX_PATHS) {
      return {
        ok: false,
        reason: 'full-index-required',
        detail: `${changed.size + deleted.size} changed paths between ${from} and ${to} exceeds the ${PERFORCE_CHANGES_BETWEEN_MAX_PATHS}-path cap`,
      };
    }

    return { ok: true, changed: [...changed], deleted: [...deleted] };
  }

  /**
   * `p4 ignores -i` (RUN-256) — measured against the rig to be a PURELY LOCAL, pattern-only check:
   * it still answers correctly with `P4PORT` unset entirely (measured), because it walks up from
   * each given path looking for `.p4ignore` files (P4IGNORE's default name, honored even with the
   * env var itself unset — also measured) and never touches a server or a depot. That is a
   * *stronger* answer than `leaseIndexSnapshot`'s own doc worries about for P4IGNORE (a
   * client-side concept the depot-read snapshot path has no client to evaluate against): this
   * method is never called from that path — only the DEBUG WALK calls it, over a live local
   * directory `p4 ignores` can read directly, client or no client.
   *
   * Batched (measured to accept many path arguments in one call and answer for all of them, no
   * `--stdin`/`-x -` support found — `p4 -x - ignores -i` measured to refuse with "At least one
   * file path must provided", so paths ride as ordinary arguments instead). p4's own exit code is
   * NOT the signal here (measured: exit 0 whether zero, some, or all of the given paths are
   * ignored — only a genuine usage error, e.g. a bad flag or an empty path list, exits nonzero) —
   * the OUTPUT is the answer: one line per path that IS ignored, `<absolute-path> ignored`
   * (measured, non-`-v` mode — a path this command does NOT consider ignored produces no line at
   * all, so the ignored subset is read by presence, never by parsing a "not ignored" line).
   * Every returned path comes back ABSOLUTIZED even when given relative (measured) —
   * `path.relative` undoes that here so the returned set matches the repo-relative, `/`-spelled
   * contract this seam promises everywhere else (`ChangesBetweenResult`'s doc states the same
   * requirement one method over).
   */
  async queryIgnored(repoRoot: string, paths: string[]): Promise<IgnoreQueryResult> {
    if (paths.length === 0) return { ok: true, ignored: new Set() };
    try {
      const { stdout } = await this.p4(['ignores', '-i', ...paths], repoRoot);
      const ignored = new Set<string>();
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(.*) ignored$/);
        if (!m?.[1]) continue;
        ignored.add(path.relative(repoRoot, m[1]).split(path.sep).join('/'));
      }
      return { ok: true, ignored };
    } catch (err) {
      return {
        ok: false,
        reason: 'unknown',
        detail: `p4 ignores failed in ${repoRoot}: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Locking on Perforce (RUN-99): TWO layers, both real.
   *
   *  1. The Noriq lock view is the AUTHORITATIVE cross-run coordination layer — the same
   *     primitive git uses, so two runner runs on one depot contend the same way everywhere and
   *     the dashboard shows one unified picture. Conflicts are decided here.
   *  2. `p4 lock` is the NATIVE enforcement floor, layered on after a grant: it locks whichever
   *     of the paths are already opened in the run's changelist against another client's submit.
   *     Best-effort — a path the agent has not opened yet is simply not p4-locked (predictive
   *     scope is a Noriq concept; p4's is opened-file granular), and a failure never fails the
   *     grant the Noriq view already made.
   *
   * A foreign client's raw `p4 lock` (a human at a workstation) is NOT yet reflected as a Noriq
   * conflict — surfacing that needs live-server fstat parsing and is a follow-up; the runner's
   * own runs coordinate fully today.
   */
  async lock(ws: Workspace, paths: string[], ctx: LockContext): Promise<LockOutcome> {
    if (!this.locks || paths.length === 0) return { ok: true, enabled: false, locks: [] };
    const r = await this.locks.acquire(ctx.token, {
      projectId: ctx.projectId,
      paths,
      branch: ctx.branch,
      taskId: ctx.taskId,
    });
    if (!r.ok) return { ok: false, conflicts: r.conflicts };
    if (r.enabled) await this.nativeLock(ws, paths, 'lock');
    return { ok: true, enabled: r.enabled, locks: r.locks };
  }

  async unlock(
    ws: Workspace,
    sel: { lockIds?: string[]; paths?: string[] },
    ctx: LockContext,
  ): Promise<void> {
    if (!this.locks) return;
    if (sel.paths?.length) await this.nativeLock(ws, sel.paths, 'unlock');
    await this.locks.release(ctx.token, ctx.projectId, sel);
  }

  async queryLocks(_repoRoot: string, paths: string[], ctx: LockContext) {
    if (!this.locks || paths.length === 0) return { enabled: false, conflicts: [], mine: [] };
    return this.locks.check(ctx.token, { projectId: ctx.projectId, paths, branch: ctx.branch });
  }

  /** Release the run's Noriq-view locks (RUN-104). Native p4 locks release with the changelist on
   *  dispose/submit, so only the view needs an explicit drop. */
  async releaseRunLocks(_ws: Workspace, ctx: LockContext): Promise<void> {
    if (!this.locks) return;
    await this.locks.releaseAllMine(ctx.token, ctx.projectId);
  }

  /** Best-effort native `p4 lock`/`p4 unlock` over the opened subset of `paths`. Guarded whole:
   *  the Noriq view already decided the outcome, so nothing here may throw into that decision. */
  private async nativeLock(ws: Workspace, paths: string[], verb: 'lock' | 'unlock'): Promise<void> {
    try {
      const loc = p4Location(ws);
      await this.p4([verb, '-c', loc.change, ...paths], ws.localPath);
    } catch {
      /* a path not opened in this change, or no p4 lock permission — the Noriq view stands */
    }
  }
}
