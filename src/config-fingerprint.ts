/**
 * RUN-246: `ConfigurationFingerprint[]` for the six vendored kinds (`runner`, `workflow`,
 * `reviewer`, `verifier`, `manifest`, `context`) — Project Intelligence's cohort-splitting evidence
 * over CONFIGURATION revisions, distinct from `StrategyCoordinate`'s per-run coordinate. Two builds
 * on `main` a month apart, or two edits of the same custom workflow, must be distinguishable by
 * something sturdier than a name: a workflow named `build` today is not the same workflow it was
 * before someone edited its prompt, and a name-only comparison would silently merge the cohorts.
 *
 * ## The central risk this module exists to close
 *
 * `canonicalHash` (vendored, `memory.ts`) is SHA-256 over `JSON.stringify`, and its own doc says
 * property insertion order is part of the wire contract. TOML parse order, object spreads, and
 * optional-field assembly all vary insertion order for otherwise-identical data, so hashing a
 * built object directly would fingerprint *how the object was built*, not *what it contains* —
 * failing "identical effective config produces the same fingerprint deterministically" outright.
 * `sortKeysDeep` below fixes every input to canonicalHash to its DATA before hashing; arrays are
 * left in insertion order because for every input here that order IS data (a workflow's declared
 * stage sequence, a repo's `requiredReading` priority) rather than an assembly artifact.
 *
 * ## What is deliberately excluded from every hash input, and why
 *
 * No absolute path and no environment/credential value ever reaches `sortKeysDeep`/`canonicalHash`
 * here. `ResolvedRepo.root` and `Workspace.localPath` are never read by this module at all — not
 * filtered out, simply never passed in — which is what makes the two-roots test in
 * `config-fingerprint.test.ts` a structural proof rather than a spot check: the same committed repo
 * checked out at two different absolute paths feeds this module byte-identical inputs, so it can
 * only ever produce byte-identical fingerprints. `~/.noriq/runner.toml` (`RunnerConfig` —
 * `scanRoots`, `label`, the server URL) is machine-local and is likewise never read here; the
 * runner's identity for this purpose is its release VERSION alone (see the `runner` kind below).
 *
 * ## Per-kind design and the discretion the task left open
 *
 * - **runner**: `version` carries `VERSION` (`src/version.ts`) and the fingerprint is a hash of
 *   just that string. There is no other per-repo-invariant knob at this grain — everything else
 *   observable about "which code ran" is already the `workflow`/`manifest`/`context` kinds, and the
 *   only OTHER candidate (`RunnerConfig`) is machine-local, which is exactly what must not leak into
 *   a fingerprint that two operators' boxes should agree on for the same runner release.
 * - **workflow**: hashes the RESOLVED content — `promptShape`, the posture flags, the declared
 *   `stages`/`stageAgents`, and the prompt TEXT. Never the prompt's file path (RUN-192's own point:
 *   a file-prompt workflow's path does not change when the file's content does, so hashing the path
 *   would blind the fingerprint to the exact edit it exists to catch). A built-in workflow (no
 *   `promptRef`) hashes the bundled template's own text via `promptTemplate`, so `workflow`
 *   distinguishes prompt EDITS for built-ins too, not only for custom `.noriq/workflows/*.toml`.
 * - **manifest**: hashes the WHOLE parsed `ProjectManifest`. The alternative — a curated slice of
 *   permissions/defaults/land/setup — was considered and rejected: this schema (vendor/manifest.ts)
 *   carries no credential and no absolute path in any field (every path in it is declared
 *   repo-relative and confinement-checked before use, per `repo-context.ts`), so nothing is bought
 *   by narrowing it, and a slice can only ever go stale as the schema grows a field nobody remembers
 *   to add to the curated list. `manifest.key` (public, committed, not a filesystem path) is the
 *   fingerprint's `name`.
 * - **context**: hashes the manifest's declared `[context]` table (`requiredReading`, `entryPoints`,
 *   `conventions`, `agentInstructions`) — the CONFIGURATION, not the resolved file contents. The
 *   alternative (also hashing the inlined document text `loadRepoContext` produces) was rejected for
 *   two reasons: that resolved form is not available at this call site without threading a new field
 *   through `PreparedRun` for a single fingerprint's sake, and it is not even a single answer —
 *   author and reviewer audiences already inline different, differently-truncated slices
 *   (`REVIEWER_CONTEXT_MAX_CHARS` vs the author budget), so "the resolved content" is actually two
 *   different things depending on which actor asked. The declared table is the one fact both
 *   audiences agree on and the one a config edit actually changes.
 * - **reviewer** / **verifier**: split along the same line THREAT-MODEL.md already draws between
 *   the inline adversarial reviewer (`[verify.agent]`, an LLM judge) and the deterministic verify
 *   floor (`[verify].cmd`/`.timeoutSeconds`/`.shell`/`.maxRounds`, a shell command the daemon runs
 *   for zero tokens). Both fingerprint the DECLARED manifest config, not a per-round RESOLVED
 *   coordinate — the inline reviewer's actual model is chosen per round inside `runReviewer`, well
 *   after this module's one call site in `supervise()`, so hashing "what was chosen" here would mean
 *   guessing. Hashing "what is configured" is determinable immediately and is still real cohort
 *   evidence: two repos whose `[verify.agent]` blocks differ are two different reviewer regimes
 *   regardless of which model any single round happened to use. Either kind is OMITTED — never an
 *   empty-string placeholder, which `ConfigurationFingerprint.fingerprint`'s `min(1)` would reject
 *   anyway — when the repo declares neither half of `[verify]`.
 */

import { createHash } from 'node:crypto';
import type { ConfigurationFingerprint, ProjectManifest } from '@noriq-dev/shared';
import { promptTemplate } from './prompts';
import type { Workflow } from './workflow';

/**
 * Recursively sort object keys so `canonicalHash` (SHA-256 over `JSON.stringify`, which serializes
 * in INSERTION order) sees one canonical shape for one set of data, regardless of how the object
 * was assembled. Arrays keep their existing order — every array reaching this module is already
 * meaningful sequence (declared stages, `requiredReading` priority), not an artifact of assembly,
 * and sorting it would destroy the thing being fingerprinted rather than normalize it.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * SYNCHRONOUS by design, and byte-identical to the shared `canonicalHash` (RUN-246).
 *
 * The shared helper is `crypto.subtle.digest`, so every digest it returns settles on a MACROTASK.
 * Awaiting five of those inside `supervise` would put real event-loop turns on a run's critical
 * path — the RUN-238 distinction — and making the report fire-and-forget instead loses a race with
 * the terminal status, which `daemon.ts` uses to drop an undelivered `pendingConfiguration`. Neither
 * cost is worth paying for a hash.
 *
 * It is not a divergence: `canonicalHash` is SHA-256 over `JSON.stringify`'s UTF-8 bytes, and so is
 * this, so the two agree for every input. `config-fingerprint.test.ts` pins that against the shared
 * function directly rather than asserting it here — the vendored contract stays the oracle, which is
 * what PLNR-348 put it in the slice for. Nothing server-side recomputes a configuration fingerprint
 * (it is stored, not verified), so agreement is a property worth keeping rather than a requirement.
 */
function fingerprint(
  kind: ConfigurationFingerprint['kind'],
  name: string | null,
  version: string | null,
  content: unknown,
): ConfigurationFingerprint {
  const json = JSON.stringify(sortKeysDeep(content));
  return { kind, name, version, fingerprint: createHash('sha256').update(json, 'utf8').digest('hex') };
}

/** Which bundled template a built-in `promptShape` actually renders — the verify family's template
 *  is `verify-agent`, not `verify`, so this is not simply `promptShape` restated. Kept local: it is
 *  a fact about prompt assembly (`supervisor.ts` `assemblePrompt`), not about workflow posture. */
const BUILTIN_PROMPT_TEMPLATE: Record<Workflow['promptShape'], string> = {
  scope: 'scope',
  build: 'build',
  verify: 'verify-agent',
};

export interface ConfigFingerprintInput {
  /** `VERSION` from `src/version.ts` — see the module doc's `runner` entry for why nothing else
   *  belongs in this kind. */
  runnerVersion: string;
  /** The manifest this run resolved under (`ResolvedRepo.manifest` / `PreparedRun.repo.manifest`).
   *  Read for its CONTENT only — never for `ResolvedRepo.root`, which this interface does not even
   *  carry. */
  manifest: ProjectManifest;
  /** The workflow this run resolved (`PreparedRun.workflow`) — already clamped and, for a custom
   *  definition, already carrying its resolved prompt TEXT on `promptRef` (never a bare path). */
  workflow: Workflow;
}

/**
 * The kinds this run can determine right now, in `supervise()`, before a single token is spent.
 * `reviewer`/`verifier` are common omissions (`[verify]` absent, or declaring only one half) —
 * that is the expected shape of "a run emits the kinds it can determine and omits the ones it
 * can't", not a bug. `strategy.reviewer`/`.verifier` on the SAME telemetry frame stay `null` for a
 * different reason entirely (the per-round resolved coordinate is not chosen this early) and this
 * function does not touch that field.
 */
export function computeConfigurationFingerprints(input: ConfigFingerprintInput): ConfigurationFingerprint[] {
  const { manifest, workflow, runnerVersion } = input;
  const out: ConfigurationFingerprint[] = [];

  out.push(fingerprint('runner', null, runnerVersion, { version: runnerVersion }));

  const promptText = workflow.promptRef ?? promptTemplate(BUILTIN_PROMPT_TEMPLATE[workflow.promptShape]);
  out.push(
    fingerprint('workflow', workflow.id, null, {
      promptShape: workflow.promptShape,
      worktreeWritable: workflow.worktreeWritable,
      produces: workflow.produces,
      verifyActor: workflow.verifyActor,
      usesPlanBase: workflow.usesPlanBase,
      promptText,
      stages: workflow.stages.map((s) => ({ name: s.name, role: s.role, agent: s.agent })),
      stageAgents: workflow.stageAgents ?? null,
    }),
  );

  out.push(fingerprint('manifest', manifest.key, null, manifest));

  out.push(fingerprint('context', null, null, manifest.context));

  if (manifest.verify?.agent) {
    out.push(fingerprint('reviewer', manifest.verify.agent.agent, null, manifest.verify.agent));
  }
  if (manifest.verify?.cmd) {
    out.push(
      fingerprint('verifier', null, null, {
        cmd: manifest.verify.cmd,
        timeoutSeconds: manifest.verify.timeoutSeconds,
        shell: manifest.verify.shell,
        maxRounds: manifest.verify.maxRounds,
      }),
    );
  }

  return out;
}
