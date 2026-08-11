/**
 * Building a run's brief, separated from acquiring the resources it needs (RUN-169).
 *
 * `prepare` does two different jobs in one pass: it TAKES things — a workspace lease, a Noriq
 * identity, a predictive lock — and it WRITES a brief from the repo, the task and the checkout.
 * Only the first half has an order that matters and an unwind on every path; the second is a pure
 * function of facts already in hand.
 *
 * They were fused, and the cost was paid by `resume`, which has all the facts and none of the
 * assembly: it restores a workspace and an identity from the park record and then has no way to
 * build a brief, so it sends only the human's answer. That is right for the session it restores —
 * which already holds everything else — and wrong for any session opened afterwards. A decomposed
 * run that parked mid-chain could therefore finish the step it parked on and no more (RUN-168),
 * because a fresh step briefed with an answer to a question it never asked is worse than one that
 * does not run.
 *
 * It is also how these two paths have drifted before: RUN-154's repo context and RUN-145's
 * acceptance criteria were both "the resume path never got this". A brief that exists in one place
 * is a brief both entry points can be given.
 */

import type { ExecutionSpec, IntelligenceContextConsumptionMetric, Run, RunKind } from '@noriq-dev/shared';
import { acceptanceOverflow, enumerateAcceptance } from '../acceptance';
import type { VerifiedContextPack } from '../citation-verify';
import type { RunAgent } from '../client';
import { buildContextConsumption } from '../context-consumption';
import type { ContextPackRetrieval } from '../context-pack';
import {
  type CheckedExecutionSpec,
  checkExecutionSpec,
  renderExecutionSpec,
  renderUnreadableSpec,
} from '../execution-spec';
import type { SpecPathProbe } from '../execution-spec';
import type { logger as defaultLogger } from '../logger';
import { renderMemoryEvidence } from '../memory-render';
import { type DocReader, type PathProbe, loadRepoContext, renderRepoContext } from '../repo-context';
import { type AnchorTask, type ResolvedRepo, assemblePrompt } from '../supervisor';
import type { Workspace } from '../vcs/types';
import { type Workflow, workflowFor } from '../workflow';

/** What building a brief may reach — a strict subset of `PrepareHost`, and deliberately so: this
 *  half touches no VCS, no server, no lock layer, and adding one of those to it would be the
 *  fusion this exists to undo. */
export interface BriefHost {
  readonly log: typeof defaultLogger;
  readonly server: string;
  readonly context: {
    probe?: PathProbe;
    specProbe?: SpecPathProbe;
    read?: DocReader;
    budget?: number;
  };
}

export interface BriefInputs {
  run: Run;
  repo: ResolvedRepo;
  /** The RUN's workspace, not the discovered checkout — they are different trees, and the brief
   *  describes the one the agent stands in. */
  worktree: Workspace;
  task: AnchorTask | null;
  runAgent: RunAgent;
  kind: RunKind;
  workflow?: Workflow | undefined;
  diffCmd?: string | undefined;
  /** RUN-231: the run's verified context pack — absent on a resume that never fetched one (see
   *  `RunPipeline.verifiedContextPack`'s own doc). `undefined` and `null` both render `''`. */
  verifiedContextPack?: VerifiedContextPack | null;
  /**
   * RUN-247: this sitting's own retrieval facts (`prepare.ts`'s `contextPack` local), so the
   * consumption metric captured below can tell "never asked" from "asked but nothing survived to
   * render" — a distinction `verifiedContextPack` alone cannot make (`null` means both). Absent on
   * a resume, for the same reason `verifiedContextPack` is: `resume` has no `prepare`, so nothing
   * retrieved one THIS sitting — and `buildContextConsumption` reads that absence as "no assertion
   * to make" rather than guessing at `not_applicable`, which would claim knowledge of a prior
   * sitting this process was never handed.
   */
  contextPack?: ContextPackRetrieval;
}

export interface BuiltBrief {
  /** The repo's resolved `[context]`, kept because `prepare` reports on what did not resolve. */
  repoCtx: Awaited<ReturnType<typeof loadRepoContext>>;
  /** The anchor task's spec, checked against this checkout. Null when it carries none. */
  checkedSpec: CheckedExecutionSpec | null;
  /**
   * Assemble a prompt from those facts.
   *
   * The spec block and the criteria arrive separately because they go to different actors: the
   * author gets the whole spec, and a gate gets the criteria alone, numbered, so it can answer
   * them one by one (RUN-145). `shape` overrides the template for the pre-execution actors that
   * read the same facts and are asked a different question.
   */
  buildPrompt: BuildPrompt;
  /**
   * RUN-247: what this sitting actually rendered from `verifiedContextPack`, captured HERE — the
   * render point — rather than at retrieval (`prepare.ts`), which is what lets a run that requested
   * context but failed before rendering report `unavailable` instead of a fabricated `complete`.
   * `null` when there is nothing this daemon may assert (see `BriefInputs.contextPack`'s own doc on
   * when that is): a caller threads it onto `RunPipeline` only when truthy, the same
   * omit-rather-than-fabricate convention `contextPack`/`verifiedContextPack` already follow.
   */
  contextConsumption: IntelligenceContextConsumptionMetric | null;
}

export type BuildPrompt = (
  specBlock: string,
  forVerify: ExecutionSpec | null,
  shape?: 'planner' | 'plan-checker' | 'pattern-mapper',
  ledger?: string,
) => string;

/**
 * Resolve the repo's context and the task's spec against this checkout, and hand back the
 * assembler.
 *
 * Warnings rather than failures throughout, which is the same posture both halves of the original
 * had: a `[context]` path that does not resolve is reported and dropped, because a required-reading
 * list that quietly shrinks to nothing leaves a repo believing its agents are oriented when they
 * are not; and a spec that disagrees with the checkout is told to the agent rather than used to
 * refuse the run.
 */
export async function buildRunBrief(host: BriefHost, input: BriefInputs): Promise<BuiltBrief> {
  const { run, repo, worktree, task, runAgent, kind } = input;

  // Read the context out of the RUN'S WORKSPACE, not the discovered checkout (RUN-128/129). They
  // are different trees: a build forks from the plan base, a continuation adopts a branch with its
  // own edits, and a verify run leases the build's branch. Inlining the checkout's CLAUDE.md and
  // then telling the agent not to re-read it would hand it instructions that do not describe the
  // tree it is standing in.
  const repoCtx = await loadRepoContext(worktree.localPath, repo.manifest.context, {
    probe: host.context.probe,
    read: host.context.read,
    budget: host.context.budget,
  });
  for (const u of repoCtx.resolved.unresolved) {
    host.log.warn(
      `[context] ${u.declared} in ${repo.manifest.key} is ${
        u.reason === 'outside-repo' ? 'outside the repo — refused' : 'missing'
      }; not included in the brief`,
    );
  }
  if (repoCtx.loaded.skipped.length) {
    host.log.warn(
      `[context] budget spent before ${repoCtx.loaded.skipped.join(', ')} — named in the brief, not inlined`,
    );
  }

  // The anchor task's spec, checked against THIS checkout before a token is spent (RUN-139). Never
  // fatal: a spec is orientation, and refusing to run because a file moved would make it a
  // tripwire. The adversarial pre-execution check is RUN-141's own stage.
  const checkedSpec = task?.executionSpec
    ? await checkExecutionSpec(task.executionSpec, worktree.localPath, {
        // NOT `context.probe`: that seam answers `[context]`'s question (is this worth putting in
        // the brief) and collapses "could not look" into "missing". This one needs the kind and
        // the uncertainty (RUN-139).
        probe: host.context.specProbe,
        produces: (input.workflow ?? workflowFor(kind)).produces,
      })
    : null;

  // RUN-231: one walk of the SAME pack, two renderings — the `repoContext`/`repoContextBrief`
  // precedent immediately above, not a second traversal. `input.verifiedContextPack` is `undefined`
  // on a resume that never fetched a pack (`RunPipeline`'s own doc); `renderMemoryEvidence` reads
  // `undefined` and `null` identically, both rendering `''`.
  const pack = input.verifiedContextPack ?? null;
  const authorRendered = renderMemoryEvidence(pack, { audience: 'author' });
  const memory = authorRendered.text;
  // RUN-247 locked decision: report the AUTHOR rendering, not the reviewer's — one metric per
  // episode, and the analytics question behind it (did context change the WORK) is the author's
  // question. `memoryBrief` below still renders for the actor that reads it; it just contributes
  // nothing to `contextConsumption`.
  const memoryBrief = renderMemoryEvidence(pack, { audience: 'reviewer' }).text;
  // RUN-247: captured HERE, not in `prepare.ts` — this IS the point the pack is handed to the
  // agent, and `authorRendered` is the only place this process knows whether that hand-off was cut.
  //
  // RUN-251: guarded — a throw here must cost only this one metric, never the brief itself. Unlike
  // every other analytics capture in this codebase, this one sits on the run's CRITICAL PATH: it
  // runs inside `buildRunBrief`, which `prepare` awaits unguarded, and `prepare` failing is fatal
  // for a continuation resume (a brief that cannot be rebuilt deliberately fails the run — see this
  // module's own top-of-file doc). The `settle`-stage `changeStats` catch (RUN-245) is the
  // precedent this restates one stage earlier: an analytics bug must degrade to a missing metric,
  // never take the run down with it.
  let contextConsumption: IntelligenceContextConsumptionMetric | null;
  try {
    contextConsumption = buildContextConsumption({
      retrieval: input.contextPack,
      verifiedContextPack: input.verifiedContextPack,
      rendered: authorRendered,
    });
  } catch (err) {
    host.log.warn('context consumption metric failed to build — briefing without it', {
      runId: run.id,
      err: String(err),
    });
    contextConsumption = null;
  }

  const buildPrompt = ((specBlock, forVerify, shape, ledger) =>
    assemblePrompt(run, repo.manifest, {
      agent: runAgent,
      server: host.server,
      task,
      ...(input.diffCmd ? { diffCmd: input.diffCmd } : {}),
      repoContext: repoCtx.rendered,
      // Rendered from the SAME resolved facts, not a second walk of the disk — only the inlined
      // documents differ (RUN-154).
      repoContextBrief: renderRepoContext(repoCtx.resolved, undefined, { audience: 'reviewer' }),
      memory,
      memoryBrief,
      executionSpec: specBlock,
      // The definition of done, NUMBERED, for the actor that judges (RUN-139/145).
      acceptance: enumerateAcceptance(forVerify),
      acceptanceOverflow: acceptanceOverflow(forVerify),
      ...(shape ? { promptShapeOverride: shape } : {}),
      ...(ledger !== undefined ? { ledger } : {}),
      ...(input.workflow ? { workflow: input.workflow } : {}),
      promptWarning: (message, details) => host.log.warn(message, details),
    })) as BuildPrompt;

  return { repoCtx, checkedSpec, buildPrompt, contextConsumption };
}

/** The spec block an AUTHOR sees: the whole spec, or the notice that the server holds one nobody
 *  can read (RUN-135) — which is not the same as having none, and must not be briefed as if it
 *  were. */
export function authorSpecBlock(task: AnchorTask | null, checked: CheckedExecutionSpec | null): string {
  return task?.executionSpecUnreadable ? renderUnreadableSpec() : renderExecutionSpec(checked);
}
