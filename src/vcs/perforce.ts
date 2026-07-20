import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LockDelegate } from './git';
import type {
  IntegrateResult,
  LeaseOptions,
  LockContext,
  LockOutcome,
  PublishResult,
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

export interface PerforceBackendOpts {
  p4?: P4Cli;
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
  private readonly write: (p: string, content: string) => Promise<void>;
  private readonly locks?: LockDelegate;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly held = new Map<string, () => void>();

  constructor(opts: PerforceBackendOpts = {}) {
    this.p4 = opts.p4 ?? realP4Cli;
    this.write = opts.writeFileFn ?? ((p, c) => writeFile(p, c, 'utf8'));
    this.locks = opts.locks;
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

  async dispose(ws: Workspace): Promise<void> {
    const loc = p4Location(ws);
    try {
      const { stdout: opened } = await this.p4(['opened', '-c', loc.change], ws.localPath).catch(() => ({
        stdout: '',
        stderr: '',
      }));
      if (opened.trim()) {
        // Unlanded work: durable FIRST (§5's shelve-then-clean — another workspace can recover
        // it byte-for-byte, measured), then clean. This is what makes always-dispose safe on a
        // pool-of-1 backend.
        await this.p4(['shelve', '-f', '-c', loc.change], ws.localPath).catch(() => {});
        await this.p4(['revert', '-c', loc.change, '//...'], ws.localPath).catch(() => {});
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

  async hasWork(ws: Workspace): Promise<boolean> {
    const loc = p4Location(ws);
    const { stdout: opened } = await this.p4(['opened', '-c', loc.change], ws.localPath).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    if (opened.trim()) return true;
    // allwrite hides edits from p4 until a reconcile — preview what one would gather.
    const { stdout } = await this.p4(['reconcile', '-n'], ws.localPath).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    return /opened for (add|edit|delete)/.test(stdout);
  }

  async checkpoint(ws: Workspace, _message: string): Promise<boolean> {
    const loc = p4Location(ws);
    // Gather what the agent actually changed into the run's changelist…
    await this.p4(['reconcile', '-c', loc.change], ws.localPath).catch(() => {});
    const { stdout: opened } = await this.p4(['opened', '-c', loc.change], ws.localPath).catch(() => ({
      stdout: '',
      stderr: '',
    }));
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

  private relative(ws: Workspace, p: string): string {
    return p.startsWith(ws.localPath) ? path.relative(ws.localPath, p) : p;
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

  /** Submit already published; there is no further step — exactly like Diversion. */
  async share(_repoRoot: string, _target: string): Promise<{ ok: true }> {
    return { ok: true };
  }

  /**
   * §5's shape, measured: shelve each orphaned noriq changelist (durable — another machine can
   * unshelve it byte-for-byte), then revert the workspace clean. Shelved orphans are REPORTED
   * via onSkip, never deleted; the server is the registry a human consults.
   */
  async reapOrphans(repoRoot: string, opts?: { onSkip?: (path: string) => void }): Promise<number> {
    const { stdout } = await this.p4(['changes', '-s', 'pending', '-l'], repoRoot).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    let cleaned = 0;
    for (const m of stdout.matchAll(/Change (\d+)[^\n]*\n\n\s*noriq run (\S+)/g)) {
      const change = m[1];
      if (!change) continue;
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
