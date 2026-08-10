import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionSpec } from '@noriq-dev/shared';
import type { ModelDefault, PermissionProfile, ProjectManifest, Run } from '@noriq-dev/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunAgent } from '../src/client';
import {
  type ContextPackFetcher,
  type ContextPackRequest,
  type ContextPackRetrieval,
  retrieveContextPack,
  summarizeContextPackRetrieval,
} from '../src/context-pack';
import type { AgentDriver, DriverCapabilities, DriverSession } from '../src/drivers/types';
import type { ContextPack } from '../src/memory-contract';
import { type PrepareHost, prepareRun } from '../src/stages';
import type { AnchorTask, ResolvedRepo, RunReport } from '../src/supervisor';
import type { Workspace } from '../src/vcs/types';
import { type VerificationReportWire, evidenceHash } from '../src/verification-report';

// RUN-228: fetch a task context pack during preparation, bounded and always-degrading, and
// record what happened. FETCH AND RECORD ONLY WAS this task's own boundary — RUN-229 verifies a
// pack's citations against the worktree, and RUN-231 (`memory-render.ts`) is the renderer that
// finally opens the gate this task deliberately left shut. Two layers of test:
// `retrieveContextPack`/`summarizeContextPackRetrieval` in isolation (the DI seam a fake fetcher
// exercises directly), and `prepareRun` end to end (the request this daemon actually sends, and
// — since RUN-231 — where the pack's content now DOES surface, quoted, and where it still does not).

const MARKER = 'ACME-DISTINCTIVE-EXCERPT-TEXT-DO-NOT-LEAK';

function validPack(over: Partial<ContextPack> = {}): ContextPack {
  return {
    taskId: 'task_1',
    projectId: 'prj_1',
    branch: null,
    baseId: null,
    tokenBudget: null,
    verifiedDecisions: [],
    relevantEntities: [],
    similarEpisodes: [],
    knownHazards: [],
    affectedTests: [],
    activeNeighboringWork: [],
    staleWarnings: [],
    generatedAt: '2026-08-09T00:00:00.000Z',
    role: 'build',
    mode: 'keyword',
    charBudget: 4000,
    charsUsed: 200,
    taskFacts: {
      taskId: 'task_1',
      key: 'RUN-1',
      title: 't',
      body: null,
      status: 'todo',
      priority: 2,
      claimedBy: null,
      claimExpiresAt: null,
      openComments: [],
      executionSpec: null,
      executionSpecUnreadable: false,
    },
    sections: [
      {
        id: 'active_decisions',
        provenance: ['exact'],
        notice: null,
        charsAllotted: 500,
        charsUsed: 120,
        excerpts: [
          {
            excerptKind: 'memory',
            id: 'mem_1',
            memoryKind: 'decision',
            statement: MARKER,
            authority: 3,
            confidence: 0.8,
            validity: 'active',
            isLead: false,
            leadReasons: [],
            evidence: [],
            recordedByAgentId: null,
            recordedAt: '2026-08-01T00:00:00.000Z',
            supersedesMemoryId: null,
          },
        ],
        graphEntities: [],
        coverage: null,
        items: [],
      },
    ],
    notices: [],
    ...over,
  };
}

// RUN-274, measured against the live server before it was written: the server takes one `branch`
// value and uses it as both a hard filter and a rerank preference, so naming any branch drops every
// memory recorded on another one — and this daemon correctly names `defaultBranch` while every run
// works off a branch. `branch: main` returned 800 chars with all memory sections empty; the same
// request with no branch returned 9319 and four excerpts. Reverts when PLNR-385 separates the two.
describe('retrieveContextPack — branch is not sent (RUN-274)', () => {
  it('omits `branch` from the wire request even when the inquiry supplies one', async () => {
    let sent: ContextPackRequest | undefined;
    const fetcher: ContextPackFetcher = async (input) => {
      sent = input;
      return validPack();
    };
    const result = await retrieveContextPack(fetcher, {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'repo-key',
      baseId: 'sha',
      branch: 'main',
      role: 'build',
    });
    expect(result.pack).not.toBeNull();
    expect(sent && 'branch' in sent).toBe(false);
    // The scoping that DOES survive, and is the stronger of the two the server checks.
    expect(sent?.baseId).toBe('sha');
    expect(sent?.repositoryKey).toBe('repo-key');
  });
});

describe('retrieveContextPack — the bounded, always-degrading fetch', () => {
  it('no fetcher wired: not attempted, no I/O', async () => {
    const result = await retrieveContextPack(undefined, {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'repo-key',
      baseId: 'sha',
      branch: 'main',
      role: 'build',
    });
    expect(result).toEqual({ attempted: false, pack: null, omission: { reason: 'no-fetcher' }, tookMs: 0 });
  });

  it('no repositoryKey: skipped before any request leaves the box (locked decision)', async () => {
    let called = false;
    const fetcher: ContextPackFetcher = async () => {
      called = true;
      return validPack();
    };
    const result = await retrieveContextPack(fetcher, {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: null,
      baseId: 'sha',
      branch: 'main',
      role: 'build',
    });
    expect(called).toBe(false);
    expect(result.attempted).toBe(false);
    expect(result.omission).toEqual({ reason: 'no-repository-key' });
  });

  it('no task anchor: skipped — nothing to ask the server about', async () => {
    let called = false;
    const fetcher: ContextPackFetcher = async () => {
      called = true;
      return validPack();
    };
    const result = await retrieveContextPack(fetcher, {
      projectId: 'prj_1',
      taskId: null,
      repositoryKey: 'repo-key',
      baseId: 'sha',
      branch: 'main',
      role: 'build',
    });
    expect(called).toBe(false);
    expect(result.omission).toEqual({ reason: 'no-task' });
  });

  it('a successful fetch carries the pack and the exact request the caller built', async () => {
    let captured: ContextPackRequest | undefined;
    const fetcher: ContextPackFetcher = async (req) => {
      captured = req;
      return validPack();
    };
    const result = await retrieveContextPack(fetcher, {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'repo-key',
      baseId: 'sha123',
      branch: 'main',
      role: 'verify',
      budgetTokens: 500,
    });
    expect(result.attempted).toBe(true);
    expect(result.omission).toBeNull();
    expect(result.pack).toEqual(validPack());
    // No `branch` — the inquiry supplied one and RUN-274 declines to send it; a deep-equal is how
    // that stays true, since an extra field reappearing here is exactly the regression.
    expect(captured).toEqual({
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'repo-key',
      baseId: 'sha123',
      role: 'verify',
      budgetTokens: 500,
    });
  });

  it('budgetTokens omitted by the caller never appears in the request at all', async () => {
    let captured: ContextPackRequest | undefined;
    const fetcher: ContextPackFetcher = async (req) => {
      captured = req;
      return validPack();
    };
    await retrieveContextPack(fetcher, {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'repo-key',
      baseId: null,
      branch: null,
      role: 'build',
    });
    expect(captured && 'budgetTokens' in captured).toBe(false);
  });

  it('a fetcher resolving null (the collapsed HTTP-error/old-server/malformed-body case) degrades to "unavailable"', async () => {
    const fetcher: ContextPackFetcher = async () => null;
    const result = await retrieveContextPack(fetcher, {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'repo-key',
      baseId: 'sha',
      branch: 'main',
      role: 'build',
    });
    expect(result.attempted).toBe(true);
    expect(result.pack).toBeNull();
    expect(result.omission).toEqual({ reason: 'unavailable' });
  });

  it('a fetcher that throws — despite its own no-throw contract — still degrades rather than rejecting', async () => {
    const fetcher: ContextPackFetcher = async () => {
      throw new Error('a fetcher that broke its contract');
    };
    const result = await retrieveContextPack(fetcher, {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'repo-key',
      baseId: 'sha',
      branch: 'main',
      role: 'build',
    });
    expect(result.attempted).toBe(true);
    expect(result.omission).toEqual({ reason: 'unavailable' });
  });

  describe('timeout', () => {
    afterEach(() => vi.useRealTimers());

    it('a fetcher that never resolves times out at the bound, never hangs the run', async () => {
      vi.useFakeTimers();
      const fetcher: ContextPackFetcher = () => new Promise<ContextPack | null>(() => {});
      const pending = retrieveContextPack(
        fetcher,
        {
          projectId: 'prj_1',
          taskId: 'task_1',
          repositoryKey: 'repo-key',
          baseId: 'sha',
          branch: 'main',
          role: 'build',
        },
        50, // a short bound for the test — CONTEXT_PACK_TIMEOUT_MS in production
      );
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;
      expect(result.attempted).toBe(true);
      expect(result.pack).toBeNull();
      expect(result.omission).toEqual({ reason: 'timeout', afterMs: 50 });
    });
  });
});

describe('summarizeContextPackRetrieval — bounded, never the excerpt text', () => {
  it('an omitted-before-attempt retrieval is not summarized by this function at all (prepare.ts gates on `attempted`)', () => {
    // Documented via the retrieval's own shape rather than a call: `attempted: false` is the
    // signal `prepareRun` uses to skip calling this function, so there is nothing to assert about
    // its OUTPUT for that case — only that the caller never asks.
    const r: ContextPackRetrieval = {
      attempted: false,
      pack: null,
      omission: { reason: 'no-fetcher' },
      tookMs: 0,
    };
    expect(r.attempted).toBe(false);
  });

  it('timeout summary names the bound, not any content', () => {
    const r: ContextPackRetrieval = {
      attempted: true,
      pack: null,
      omission: { reason: 'timeout', afterMs: 10_000 },
      tookMs: 10_000,
    };
    expect(summarizeContextPackRetrieval(r)).toMatch(/timed out after 10000ms/);
  });

  it('unavailable summary names no server-side detail this daemon never received', () => {
    const r: ContextPackRetrieval = {
      attempted: true,
      pack: null,
      omission: { reason: 'unavailable' },
      tookMs: 5,
    };
    expect(summarizeContextPackRetrieval(r)).toMatch(/unavailable/);
  });

  it('a successful retrieval summarizes section/excerpt COUNTS and never the excerpt statement text', () => {
    const r: ContextPackRetrieval = { attempted: true, pack: validPack(), omission: null, tookMs: 42 };
    const summary = summarizeContextPackRetrieval(r);
    expect(summary).toMatch(/1 section\(s\)/);
    expect(summary).toMatch(/1 excerpt\(s\)/);
    expect(summary).not.toContain(MARKER);
  });
});

// ---------------------------------------------------------------------------------------------
// prepareRun integration — the request this daemon actually sends, and the proof nothing from a
// retrieved pack reaches an agent prompt (this task's own acceptance line).
// ---------------------------------------------------------------------------------------------

const perm = (write: boolean): PermissionProfile => ({ write, allow: [], deny: [], auto: false });
const noModel = (): ModelDefault => ({ agent: null, model: null, effort: null });
const manifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  key: 'PROJ',
  board: null,
  verify: { cmd: 'npm test', timeoutSeconds: null, shell: null, maxRounds: 2, agent: null },
  context: { requiredReading: [], entryPoints: [], conventions: [], agentInstructions: 'inline' as const },
  tool: null,
  defaultBranch: 'main',
  repositoryKey: 'acme/widgets',
  index: null,
  land: null,
  setup: null,
  permissions: { scope: perm(false), build: perm(true), verify: perm(false) },
  defaults: { scope: noModel(), build: noModel(), verify: noModel() },
  workflows: {},
  ...over,
});

const makeRun = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  projectId: 'prj_p',
  runnerId: 'rnr_1',
  agentId: null,
  planKey: null,
  targetBranch: null,
  kind: 'build',
  anchor: { type: 'task', taskId: 'task_9' },
  verifiesRunId: null,
  brief: 'ship the thing',
  repoRef: 'repo_a',
  agentTool: 'claude',
  agent: null,
  workflow: null,
  model: null,
  effort: null,
  budget: { maxTokens: null, maxUsd: null, maxDurationSeconds: null, maxRounds: null },
  status: 'dispatched',
  phase: null,
  exit: null,
  worktreePath: null,
  modelUsage: null,
  createdBy: 'usr_1',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  dispatchedAt: '2026-07-14T00:00:00.000Z',
  startedAt: null,
  ...over,
});

const CAPS: DriverCapabilities = {
  toolHooks: true,
  steer: true,
  interrupt: true,
  resumableSession: true,
  perModelTelemetry: true,
};
const driver: AgentDriver = {
  tool: 'claude',
  capabilities: CAPS,
  catalog: { models: [], efforts: [] },
  start: () => ({}) as DriverSession,
};

// Deliberately DIFFERENT from `repo.manifest.repositoryKey` and from `worktree.baseId` — the
// local checkout id must never leak into the request (locked decision), so using a look-alike-but-
// wrong value here is what makes a test that asserts the WRONG field a visible failure rather
// than an accidental pass.
const LOCAL_CHECKOUT_ID = 'repo_local_sha_do_not_send';
const LEASED_BASE_ID = 'leased-base-sha-999';

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  runId: 'run_1',
  localPath: '/wt/run_1',
  readOnly: false,
  workRef: 'noriq/run/run_1', // never sent as `branch` — see context-pack.ts's own doc
  baseId: LEASED_BASE_ID,
  location: { branch: 'noriq/run/run_1' },
  ...over,
});

function harness(
  over: {
    repo?: ResolvedRepo | null;
    getContextPack?: ContextPackFetcher;
    reportVerification?: PrepareHost['reportVerification'];
    agentToken?: string;
    /** RUN-232: a task with a spec, so `suggestedMemoryPaths` has a declared scope to diverge from. */
    task?: AnchorTask | null;
    /** RUN-232: a REAL directory so a citation can verify `valid` — `verifyContextPack`'s default
     *  `readCitationFile` touches actual disk, and `prepareRun` injects no override for it. */
    worktreeLocalPath?: string;
  } = {},
) {
  const reports: RunReport[] = [];
  const milestones: string[] = [];
  const repo: ResolvedRepo | null =
    over.repo === undefined ? { root: '/repo', manifest: manifest() } : over.repo;
  const vcs = {
    kind: 'git' as const,
    lease: async (): Promise<Workspace> =>
      ws(over.worktreeLocalPath ? { localPath: over.worktreeLocalPath } : {}),
    dispose: async (): Promise<void> => {},
    hasWork: async (): Promise<boolean> => false,
  };
  const host: PrepareHost = {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    report: (_id, frame) => reports.push(frame),
    postComment: () => {},
    transcript: () => ({ milestone: (m: string) => milestones.push(m), text: () => {} }) as never,
    server: 'https://noriq.test',
    resolveRepo: async () => repo,
    driverFor: () => driver,
    vcsFor: () => vcs as never,
    planBase: async () => null,
    createRunAgent: async (): Promise<RunAgent> => ({
      agentId: 'agt_1',
      label: 'build-abc',
      token: over.agentToken ?? 'tok_run',
      projectId: 'prj_p',
      expiresIn: 3600,
    }),
    resolveAnchorTask: async () => (over.task === undefined ? null : over.task),
    lockScopeBranch: () => 'main',
    lockEnforcerFor: () => undefined,
    runBudget: () => null,
    context: { probe: async () => false, read: async () => '' },
    ...(over.getContextPack ? { getContextPack: over.getContextPack } : {}),
    ...(over.reportVerification ? { reportVerification: over.reportVerification } : {}),
  };
  return { host, reports, milestones };
}

const EMPTY_SPEC = {
  requirementIds: [],
  anticipatedFiles: [],
  requiredReading: [],
  lockedDecisions: [],
  discretion: [],
  deferred: [],
  acceptance: { observableTruths: [], artifacts: [], links: [] },
  steps: [],
};

describe("prepareRun — RUN-228 retrieval, in the daemon's own preparation pipeline", () => {
  it('the request carries the CANONICAL repositoryKey and the LEASED baseId, never the local checkout id', async () => {
    let captured: ContextPackRequest | undefined;
    const getContextPack: ContextPackFetcher = async (req) => {
      captured = req;
      return validPack();
    };
    const { host } = harness({ getContextPack });
    const out = await prepareRun(host, makeRun());
    expect(out.ok).toBe(true);
    expect(captured).toBeDefined();
    expect(captured?.repositoryKey).toBe('acme/widgets'); // repo.manifest.repositoryKey
    expect(captured?.baseId).toBe(LEASED_BASE_ID); // worktree.baseId
    expect(captured?.baseId).not.toBe(LOCAL_CHECKOUT_ID);
    // `branch` is not sent at all since RUN-274 (the server would filter on it and drop every
    // memory recorded elsewhere). The original invariant this line guarded — the run's own
    // throwaway `workRef` must never become `branch` — now holds by construction rather than by
    // choosing the right value, and is asserted as absence.
    expect('branch' in (captured ?? {})).toBe(false);
    expect(captured?.projectId).toBe('prj_p'); // run.projectId
    expect(captured?.taskId).toBe('task_9');
    expect(captured?.role).toBe('build'); // the effective kind
  });

  // RUN-231 is the gate this task's own doc comment named and left shut: the pack now DOES reach
  // the BUILD prompt (this run's `start.prompt`, and `rebuildPrompt` — which renders the same
  // shape), always through `memory-render.ts`'s quoted frame, never as a bare, unprefixed line.
  // RUN-232 wires the three pre-execution actors (planner/pattern-mapper/plan-checker) into the
  // SAME gate — no second renderer, no re-derivation from the pack — so the marker now reaches
  // all six surfaces this test can see, every one of them quoted.
  it('a retrieved, verified pack reaches every actor through the quoted frame — build AND the pre-execution three (RUN-231/232)', async () => {
    const getContextPack: ContextPackFetcher = async () => validPack();
    const { host, milestones } = harness({ getContextPack });
    const out = await prepareRun(host, makeRun());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.contextPack.pack).not.toBeNull(); // the fetch DID succeed — a real retrieval to check
    expect(out.verifiedContextPack).not.toBeNull(); // RUN-229 verified it (no citations to check)

    expect(out.start.prompt).toContain(MARKER);
    expect(out.start.prompt).toContain('QUOTED FROM PROJECT MEMORY');
    // Every line carrying the marker is QUOTED — the structural prefix, not merely present
    // somewhere in a much longer prompt.
    const markerLines = out.start.prompt.split('\n').filter((l) => l.includes(MARKER));
    expect(markerLines.length).toBeGreaterThan(0);
    for (const l of markerLines) expect(l.startsWith('| ')).toBe(true);

    // `rebuildPrompt` renders the same BUILD shape (no `shape` override), so it carries the block
    // too — this is the "plan an unplanned task" resume path, not a second, forgotten call site.
    expect(out.rebuildPrompt(null)).toContain(MARKER);

    // The two AUTHOR pre-execution actors (RUN-232): a decision already settled is exactly what a
    // planner should not re-derive, and a verified citation IS "a file and a line" — the pattern
    // mapper's own rule for what counts as useful.
    expect(out.plannerPrompt).toContain(MARKER);
    expect(out.mapperPrompt({ spec: EMPTY_SPEC, findings: [] })).toContain(MARKER);
    // The plan checker gets the REVIEWER rendering — same marker, smaller budget, judging frame.
    expect(out.checkerPrompt(EMPTY_SPEC, '')).toContain(MARKER);

    // Recorded (locked decision), but still bounded — the transcript line itself must not be how
    // the marker leaks.
    const line = milestones.find((m) => m.includes('context pack'));
    expect(line).toBeDefined();
    expect(line).not.toContain(MARKER);
  });

  // RUN-232 locked decision 2/3: a memory-verified path beyond the spec's own declared scope is a
  // SUGGESTION, recorded visibly in the transcript — never a lock, and never folded into the spec
  // the run is judged against.
  it('a citation naming a path the spec did not declare is recorded as a suggestion, not folded into scope', async () => {
    // A REAL file: `verifyContextPack`'s default reader touches actual disk and `prepareRun`
    // injects no override, so a 'valid' verdict needs a citation whose path genuinely exists.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-ctxpack-'));
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'undeclared.ts'), 'export const x = 1;\n');
      const packWithCitation = validPack({
        sections: [
          {
            id: 'active_decisions',
            provenance: ['exact'],
            notice: null,
            charsAllotted: 500,
            charsUsed: 120,
            excerpts: [
              {
                excerptKind: 'memory',
                id: 'mem_1',
                memoryKind: 'decision',
                statement: MARKER,
                authority: 3,
                confidence: 0.8,
                validity: 'active',
                isLead: false,
                leadReasons: [],
                evidence: [
                  {
                    repositoryKey: 'acme/widgets',
                    branch: 'main',
                    baseId: LEASED_BASE_ID,
                    path: 'src/undeclared.ts',
                    symbol: null,
                    verificationState: 'valid',
                    lastVerifiedAt: null,
                    lastVerifiedBaseId: null,
                    lastVerifiedBranch: null,
                    verifiedForCaller: true,
                  },
                ],
                recordedByAgentId: null,
                recordedAt: '2026-08-01T00:00:00.000Z',
                supersedesMemoryId: null,
              },
            ],
            graphEntities: [],
            coverage: null,
            items: [],
          },
        ],
      });
      const getContextPack: ContextPackFetcher = async () => packWithCitation;
      const task: AnchorTask = {
        key: 'RUN-9',
        title: 't',
        body: null,
        executionSpec: ExecutionSpec.parse({ anticipatedFiles: [{ path: 'src/declared.ts' }] }),
      };
      const { host, milestones } = harness({ getContextPack, task, worktreeLocalPath: dir });
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      // The citation actually verified 'valid' — otherwise this test would pass for the wrong
      // reason (a 'missing' citation renders no suggestion either, per locked decision 4).
      const excerpt = out.verifiedContextPack?.sections[0]?.excerpts[0];
      if (!excerpt || excerpt.excerptKind !== 'memory') throw new Error('expected a memory excerpt');
      expect(excerpt.evidence[0]?.verification.state).toBe('valid');
      // The spec's own declared scope is untouched — RUN-232 must not fold a citation into it.
      expect(out.checkedSpec?.spec.anticipatedFiles.map((f) => f.path)).toEqual(['src/declared.ts']);
      const line = milestones.find((m) => m.includes('suggests') && m.includes('declared scope'));
      expect(line).toBeDefined();
      expect(line).toContain('src/undeclared.ts');
      expect(line).not.toContain('src/declared.ts'); // the DECLARED path is not a "suggestion"
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The line is written by the DAEMON into a human-facing stream out of what the server said. A
  // `valid` verdict bounds the CONTENT (each path exists in this workspace) and nothing else — not
  // the count, and not a filename's own characters — so the cap and the one-line shape are the
  // invariants, and both regress silently.
  it('the suggestion milestone stays one line and names at most a bounded sample', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-ctxpack-'));
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      // One more file than the cap, plus a legal POSIX name carrying a newline — which would break
      // the frame's line shape if the path went into the line verbatim.
      const names = Array.from({ length: 15 }, (_, i) => `f${i}.ts`).concat('two\nlines.ts');
      for (const n of names) await writeFile(path.join(dir, 'src', n), 'export const x = 1;\n');
      const packWithMany = validPack({
        sections: [
          {
            id: 'active_decisions',
            provenance: ['exact'],
            notice: null,
            charsAllotted: 500,
            charsUsed: 120,
            excerpts: [
              {
                excerptKind: 'memory',
                id: 'mem_1',
                memoryKind: 'decision',
                statement: MARKER,
                authority: 3,
                confidence: 0.8,
                validity: 'active',
                isLead: false,
                leadReasons: [],
                evidence: names.map((n) => ({
                  repositoryKey: 'acme/widgets',
                  branch: 'main',
                  baseId: LEASED_BASE_ID,
                  path: `src/${n}`,
                  symbol: null,
                  verificationState: 'valid' as const,
                  lastVerifiedAt: null,
                  lastVerifiedBaseId: null,
                  lastVerifiedBranch: null,
                  verifiedForCaller: true,
                })),
                recordedByAgentId: null,
                recordedAt: '2026-08-01T00:00:00.000Z',
                supersedesMemoryId: null,
              },
            ],
            graphEntities: [],
            coverage: null,
            items: [],
          },
        ],
      });
      const task: AnchorTask = {
        key: 'RUN-9',
        title: 't',
        body: null,
        executionSpec: ExecutionSpec.parse({ anticipatedFiles: [{ path: 'src/declared.ts' }] }),
      };
      const { host, milestones } = harness({
        getContextPack: async () => packWithMany,
        task,
        worktreeLocalPath: dir,
      });
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true);
      const line = milestones.find((m) => m.includes('suggests') && m.includes('declared scope'));
      expect(line).toBeDefined();
      expect(line).not.toContain('\n'); // the newline-bearing filename never breaks the line
      expect(line).toContain('16 path(s)'); // the true total is still reported
      expect(line).toContain('(+4 more)'); // 12 shown, the rest counted rather than dumped
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no repositoryKey on the repo: preparation proceeds exactly as it always has (no fetch attempted)', async () => {
    let called = false;
    const getContextPack: ContextPackFetcher = async () => {
      called = true;
      return validPack();
    };
    const { host, milestones } = harness({
      repo: { root: '/repo', manifest: manifest({ repositoryKey: null }) },
      getContextPack,
    });
    const out = await prepareRun(host, makeRun());
    expect(out.ok).toBe(true);
    expect(called).toBe(false);
    expect(out.ok && out.contextPack.attempted).toBe(false);
    expect(milestones.some((m) => m.includes('context pack'))).toBe(false); // no noise on the common case
  });

  it('an HTTP error / old server / malformed body (collapsed to a null fetch) degrades silently — same prepared shape', async () => {
    const failing: ContextPackFetcher = async () => null;
    const withFailure = harness({ getContextPack: failing });
    const withoutFetcher = harness({});
    const outFailure = await prepareRun(withFailure.host, makeRun());
    const outBaseline = await prepareRun(withoutFetcher.host, makeRun());
    expect(outFailure.ok).toBe(true);
    expect(outBaseline.ok).toBe(true);
    if (!outFailure.ok || !outBaseline.ok) return;
    // The PROMPT — what the acceptance actually holds preparation to — is identical either way.
    expect(outFailure.start.prompt).toBe(outBaseline.start.prompt);
    expect(outFailure.contextPack.pack).toBeNull();
    expect(outFailure.contextPack.omission).toEqual({ reason: 'unavailable' });
  });

  it('a run with no task anchor (a pure-brief dispatch) skips retrieval — nothing to ask about', async () => {
    let called = false;
    const getContextPack: ContextPackFetcher = async () => {
      called = true;
      return validPack();
    };
    const { host } = harness({ getContextPack });
    const out = await prepareRun(host, makeRun({ anchor: null }));
    expect(out.ok).toBe(true);
    expect(called).toBe(false);
    expect(out.ok && out.contextPack.omission).toEqual({ reason: 'no-task' });
  });

  // RUN-229 — wired here rather than repeated: `test/citation-verify.test.ts` owns the
  // classification rules exhaustively; these two prove `prepareRun` actually calls it, attaches
  // the result under `verifiedContextPack`, and degrades the same way every other pre-execution
  // enrichment in this file does.
  describe('RUN-229 — citation verification runs after retrieval and attaches to the prepared run', () => {
    it('a retrieved pack is verified against the leased worktree — the citation carries its verdict inline', async () => {
      const withCitation = validPack({
        sections: [
          {
            id: 'active_decisions',
            provenance: ['exact'],
            notice: null,
            charsAllotted: 500,
            charsUsed: 120,
            excerpts: [
              {
                excerptKind: 'memory',
                id: 'mem_1',
                memoryKind: 'decision',
                statement: MARKER,
                authority: 3,
                confidence: 0.8,
                validity: 'active',
                isLead: false,
                leadReasons: [],
                evidence: [
                  {
                    repositoryKey: 'acme/widgets', // repo.manifest.repositoryKey — this test's `harness()`
                    branch: 'main',
                    baseId: LEASED_BASE_ID, // the SAME base as the leased worktree
                    path: 'src/nonexistent-in-this-fake-worktree.ts',
                    symbol: null,
                    verificationState: 'unverifiable',
                    lastVerifiedAt: null,
                    lastVerifiedBaseId: null,
                    lastVerifiedBranch: null,
                    verifiedForCaller: false,
                  },
                ],
                recordedByAgentId: null,
                recordedAt: '2026-08-01T00:00:00.000Z',
                supersedesMemoryId: null,
              },
            ],
            graphEntities: [],
            coverage: null,
            items: [],
          },
        ],
      });
      const getContextPack: ContextPackFetcher = async () => withCitation;
      const { host } = harness({ getContextPack });
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.verifiedContextPack).not.toBeNull();
      const excerpt = out.verifiedContextPack?.sections[0]?.excerpts[0];
      expect(excerpt?.excerptKind).toBe('memory');
      if (excerpt?.excerptKind !== 'memory') return;
      // The fake worktree's `localPath` (`/wt/run_1`) is not a real directory, so the ONLY honest
      // classification is `missing` — proving the daemon's default reader ran for real rather
      // than being silently skipped, without this test needing to fabricate a real checkout.
      expect(excerpt.evidence[0]?.verification.state).toBe('missing');
    });

    it('a citation naming a different repository than this run is unverifiable, never checked against the wrong tree', async () => {
      const foreign = validPack({
        sections: [
          {
            id: 'active_decisions',
            provenance: ['exact'],
            notice: null,
            charsAllotted: 500,
            charsUsed: 120,
            excerpts: [
              {
                excerptKind: 'memory',
                id: 'mem_1',
                memoryKind: 'decision',
                statement: MARKER,
                authority: 3,
                confidence: 0.8,
                validity: 'active',
                isLead: false,
                leadReasons: [],
                evidence: [
                  {
                    repositoryKey: 'someone/else', // NOT repo.manifest.repositoryKey
                    branch: 'main',
                    baseId: LEASED_BASE_ID,
                    path: 'src/foo.ts',
                    symbol: null,
                    verificationState: 'valid', // the server's own belief — must not be trusted verbatim
                    lastVerifiedAt: null,
                    lastVerifiedBaseId: null,
                    lastVerifiedBranch: null,
                    verifiedForCaller: true,
                  },
                ],
                recordedByAgentId: null,
                recordedAt: '2026-08-01T00:00:00.000Z',
                supersedesMemoryId: null,
              },
            ],
            graphEntities: [],
            coverage: null,
            items: [],
          },
        ],
      });
      const getContextPack: ContextPackFetcher = async () => foreign;
      const { host } = harness({ getContextPack });
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const excerpt = out.verifiedContextPack?.sections[0]?.excerpts[0];
      if (excerpt?.excerptKind !== 'memory') throw new Error('expected a memory excerpt');
      expect(excerpt.evidence[0]?.verification.state).toBe('unverifiable');
      expect(excerpt.evidence[0]?.verification.agreesWithServer).toBe(false);
    });

    it('no pack retrieved: verifiedContextPack is null, never a stale or empty stand-in', async () => {
      const { host } = harness({}); // no getContextPack wired at all
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true);
      expect(out.ok && out.verifiedContextPack).toBeNull();
    });
  });

  // RUN-230 — wired here rather than repeated: `test/verification-report.test.ts` owns
  // `buildVerificationReport`/`evidenceHash` in isolation; these prove `prepareRun` actually calls
  // it AFTER `runAgent` exists (the report can only be authenticated as the run's own bound
  // agent), hands the result to `host.reportVerification` fire-and-forget, and never gates the run
  // on it.
  describe('RUN-230 — the verification report is built and handed to delivery once runAgent exists', () => {
    const citation = (over: Record<string, unknown> = {}) => ({
      repositoryKey: 'acme/widgets',
      branch: 'main',
      baseId: LEASED_BASE_ID,
      path: 'src/foo.ts',
      symbol: null,
      verificationState: 'unverifiable',
      lastVerifiedAt: null,
      lastVerifiedBaseId: null,
      lastVerifiedBranch: null,
      verifiedForCaller: false,
      ...over,
    });

    const packWithEvidence = (evidence: ReturnType<typeof citation>[]) =>
      validPack({
        sections: [
          {
            id: 'active_decisions',
            provenance: ['exact'],
            notice: null,
            charsAllotted: 500,
            charsUsed: 120,
            excerpts: [
              {
                excerptKind: 'memory',
                id: 'mem_1',
                memoryKind: 'decision',
                statement: MARKER,
                authority: 3,
                confidence: 0.8,
                validity: 'active',
                isLead: false,
                leadReasons: [],
                evidence: evidence as never,
                recordedByAgentId: null,
                recordedAt: '2026-08-01T00:00:00.000Z',
                supersedesMemoryId: null,
              },
            ],
            graphEntities: [],
            coverage: null,
            items: [],
          },
        ],
      });

    it('sends the memory excerpt id, the daemon’s own verdict, and the OBSERVED base/branch — never the citation’s own recorded base', async () => {
      // A citation whose OWN baseId/branch differ from what this run's worktree is leased at
      // (LEASED_BASE_ID/'main') — a historical evidence identity, never what gets reported as
      // OBSERVED (locked decision 6).
      const withCitation = packWithEvidence([citation({ baseId: 'some-old-base', branch: 'feature/x' })]);
      let captured: { runId: string; agentToken: string; report: VerificationReportWire } | undefined;
      const reportVerification: PrepareHost['reportVerification'] = (runId, agentToken, report) => {
        captured = { runId, agentToken, report };
      };
      const { host } = harness({ getContextPack: async () => withCitation, reportVerification });
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true);
      expect(captured).toBeDefined();
      expect(captured?.runId).toBe('run_1');
      // The run's OWN bound-agent token — never the daemon's own — matching what `createRunAgent`
      // minted for this exact run (the server's gate requires exactly this identity).
      expect(captured?.agentToken).toBe('tok_run');
      expect(captured?.report.source).toBe('runner-thorough');
      expect(captured?.report.citations).toHaveLength(1);
      const sent = captured?.report.citations[0];
      expect(sent?.memoryItemId).toBe('mem_1'); // the enclosing EXCERPT's id, never on the citation
      expect(sent?.state).toBe('missing'); // this daemon's own verdict against the fake, empty worktree
      // OBSERVED base/branch — the worktree this run actually leased, never the citation's own
      // historical 'some-old-base'/'feature/x'.
      expect(sent?.baseId).toBe(LEASED_BASE_ID);
      expect(sent?.branch).toBe('main');
      expect(sent?.baseId).not.toBe('some-old-base');
      expect(sent?.branch).not.toBe('feature/x');
      // The hash identifies the evidence row by the CITATION's own identity fields, reproducing
      // planar's `evidenceHash` exactly — verified independently in verification-report.test.ts.
      expect(sent?.evidenceHash).toBe(
        evidenceHash({
          repositoryKey: 'acme/widgets',
          branch: 'feature/x',
          baseId: 'some-old-base',
          path: 'src/foo.ts',
          symbol: null,
        }),
      );
    });

    it('a citation naming a different repository is excluded from the report entirely', async () => {
      const foreignOnly = packWithEvidence([citation({ repositoryKey: 'someone/else' })]);
      let called = false;
      const reportVerification: PrepareHost['reportVerification'] = () => {
        called = true;
      };
      const { host } = harness({ getContextPack: async () => foreignOnly, reportVerification });
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true);
      // Reporting it would stamp THIS workspace's baseId/branch onto an evidence row this daemon
      // never actually checked anything about — see `buildVerificationReport`'s own doc.
      expect(called).toBe(false);
    });

    it('no citations verified at all: reportVerification is never called', async () => {
      let called = false;
      const reportVerification: PrepareHost['reportVerification'] = () => {
        called = true;
      };
      const { host } = harness({ getContextPack: async () => validPack(), reportVerification });
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true);
      expect(called).toBe(false);
    });

    it('no defaultBranch configured: skipped — the wire has no valid branch value to report', async () => {
      const withCitation = packWithEvidence([citation()]);
      let called = false;
      const reportVerification: PrepareHost['reportVerification'] = () => {
        called = true;
      };
      const { host } = harness({
        repo: { root: '/repo', manifest: manifest({ defaultBranch: null }) },
        getContextPack: async () => withCitation,
        reportVerification,
      });
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true);
      expect(called).toBe(false);
    });

    it('never gates: prepareRun resolves synchronously without awaiting the delivery call', async () => {
      const withCitation = packWithEvidence([citation()]);
      // A real delivery function is async and never awaited by prepareRun — a fire-and-forget dep
      // that never resolves must not stall preparation. `reportVerification`'s own type is
      // synchronous `void`, so this fake simply never lets its own (unawaited) promise settle,
      // proving the CALLER treats it as fire-and-forget rather than only asserting the type does.
      let neverSettles: Promise<void> | undefined;
      const reportVerification: PrepareHost['reportVerification'] = () => {
        neverSettles = new Promise(() => {});
      };
      const { host } = harness({ getContextPack: async () => withCitation, reportVerification });
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true); // resolved despite the delivery "hanging" forever
      expect(neverSettles).toBeDefined();
    });

    it('no reportVerification wired at all: preparation proceeds exactly as before this task existed', async () => {
      const withCitation = packWithEvidence([citation()]);
      const { host } = harness({ getContextPack: async () => withCitation }); // no reportVerification
      const out = await prepareRun(host, makeRun());
      expect(out.ok).toBe(true);
    });
  });
});
