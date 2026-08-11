import { IntelligenceContextConsumptionMetric, UploadedEpisodeIntelligence } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import type {
  VerifiedCitation,
  VerifiedContextPack,
  VerifiedContextPackExcerpt,
  VerifiedContextPackSection,
} from '../src/citation-verify';
import { buildContextConsumption } from '../src/context-consumption';
import type { ContextPackRetrieval } from '../src/context-pack';
import type { RenderedMemoryEvidence } from '../src/memory-render';

// RUN-247: `buildContextConsumption` maps a rendered pack + its retrieval into the vendored
// `IntelligenceContextConsumptionMetric` — the status ladder (not_applicable / unavailable /
// complete / partial), the no-text rule, and the `staleCitationsCount` source decision. Every
// fixture here is a plain `VerifiedContextPack`/`ContextPackRetrieval`, the same posture
// `memory-render.test.ts` and `citation-verify.test.ts` already take with this contract — no disk,
// no network, no driver.

function citation(over: Partial<VerifiedCitation> = {}): VerifiedCitation {
  return {
    repositoryKey: 'acme/widgets',
    branch: 'main',
    baseId: 'base-1',
    path: 'src/foo.ts',
    symbol: null,
    verificationState: 'valid',
    lastVerifiedAt: null,
    lastVerifiedBaseId: null,
    lastVerifiedBranch: null,
    verifiedForCaller: true,
    verification: {
      state: 'valid',
      reason: 'path and symbol both confirmed',
      serverState: 'valid',
      agreesWithServer: true,
    },
    ...over,
  };
}

function memoryExcerpt(
  over: Partial<VerifiedContextPackExcerpt & { excerptKind: 'memory' }> = {},
): VerifiedContextPackExcerpt {
  return {
    excerptKind: 'memory',
    id: 'mem_1',
    memoryKind: 'decision',
    statement: 'use the confined reader for every path',
    authority: 3,
    confidence: 0.8,
    validity: 'active',
    isLead: false,
    leadReasons: [],
    evidence: [],
    recordedByAgentId: null,
    recordedAt: '2026-08-01T00:00:00.000Z',
    supersedesMemoryId: null,
    ...over,
  } as VerifiedContextPackExcerpt;
}

function section(over: Partial<VerifiedContextPackSection> = {}): VerifiedContextPackSection {
  return {
    id: 'active_decisions',
    provenance: ['exact'],
    notice: null,
    charsAllotted: 500,
    charsUsed: 100,
    excerpts: [],
    graphEntities: [],
    coverage: null,
    items: [],
    ...over,
  };
}

function pack(
  sections: VerifiedContextPackSection[],
  over: Partial<VerifiedContextPack> = {},
): VerifiedContextPack {
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
    generatedAt: '2026-08-01T00:00:00.000Z',
    role: 'build',
    mode: 'semantic',
    charBudget: 4000,
    charsUsed: 100,
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
    sections,
    notices: [],
    ...over,
  };
}

function retrieval(over: Partial<ContextPackRetrieval> = {}): ContextPackRetrieval {
  return { attempted: true, pack: null, omission: null, tookMs: 42, ...over };
}

function rendered(over: Partial<RenderedMemoryEvidence> = {}): RenderedMemoryEvidence {
  return { text: '', chars: 0, truncated: false, ...over };
}

describe('buildContextConsumption — the status ladder (RUN-247)', () => {
  it('never asked (no retrieval this sitting at all) → no assertion, null', () => {
    // The resume case: `resume` has no `prepare`, so nothing retrieved a pack THIS sitting. Asserting
    // `not_applicable` here would claim "never asked", which may be false — a prior sitting may well
    // have asked. `null` is the only honest answer, and the caller omits the metric entirely.
    expect(
      buildContextConsumption({ retrieval: undefined, verifiedContextPack: null, rendered: rendered() }),
    ).toBeNull();
  });

  it('never asked (no task anchor / no repositoryKey) → not_applicable, value null', () => {
    const m = buildContextConsumption({
      retrieval: retrieval({ attempted: false, omission: { reason: 'no-repository-key' } }),
      verifiedContextPack: null,
      rendered: rendered(),
    });
    expect(m).toMatchObject({ status: 'not_applicable', value: null });
  });

  it('asked and got nothing back (timeout) → unavailable, value null — distinguishable from not_applicable ONLY by status', () => {
    const notApplicable = buildContextConsumption({
      retrieval: retrieval({ attempted: false, omission: { reason: 'no-task' } }),
      verifiedContextPack: null,
      rendered: rendered(),
    });
    const unavailable = buildContextConsumption({
      retrieval: retrieval({ attempted: true, omission: { reason: 'timeout', afterMs: 10_000 } }),
      verifiedContextPack: null,
      rendered: rendered(),
    });
    expect(notApplicable?.value).toBeNull();
    expect(unavailable?.value).toBeNull();
    expect(notApplicable?.status).toBe('not_applicable');
    expect(unavailable?.status).toBe('unavailable');
    expect(notApplicable?.status).not.toBe(unavailable?.status);
  });

  // The task's first acceptance criterion: a run that RETRIEVED a pack but failed BEFORE RENDERING
  // (a citation-verification crash, say — `prepare.ts`'s own best-effort posture) must not read as
  // `complete`/`partial`. Modeled here as `retrieval.attempted === true`, `retrieval.omission ===
  // null` (a pack genuinely came back) yet `verifiedContextPack === null` (nothing survived past
  // it) — the exact shape `prepare.ts` produces when `verifyContextPack` throws.
  it('retrieved a pack but failed before rendering → unavailable, never complete/partial', () => {
    const m = buildContextConsumption({
      retrieval: retrieval({ attempted: true, omission: null }),
      verifiedContextPack: null,
      rendered: rendered(),
    });
    expect(m?.status).toBe('unavailable');
    expect(m?.value).toBeNull();
    expect(m?.reason).toBeTruthy(); // says SOMETHING was attempted, never a bare unexplained null
  });

  it('a real, whole rendering (semantic mode, no section notice, renderer did not cut) → complete', () => {
    const p = pack([section({ excerpts: [memoryExcerpt()] })], { mode: 'semantic' });
    const m = buildContextConsumption({
      retrieval: retrieval(),
      verifiedContextPack: p,
      rendered: rendered({ text: 'x'.repeat(50), chars: 50, truncated: false }),
    });
    expect(m?.status).toBe('complete');
  });

  it('keyword mode → partial, never unavailable and never complete (the degraded-but-real state)', () => {
    const p = pack([section()], { mode: 'keyword' });
    const m = buildContextConsumption({
      retrieval: retrieval(),
      verifiedContextPack: p,
      rendered: rendered(),
    });
    expect(m?.status).toBe('partial');
  });

  it('a section notice (truncated) → partial', () => {
    const p = pack([section({ notice: { kind: 'truncated', reason: 'budget' } })], { mode: 'semantic' });
    const m = buildContextConsumption({
      retrieval: retrieval(),
      verifiedContextPack: p,
      rendered: rendered(),
    });
    expect(m?.status).toBe('partial');
  });

  it('a section notice (unanswerable) → partial', () => {
    const p = pack([section({ notice: { kind: 'unanswerable', reason: 'graph off' } })], {
      mode: 'semantic',
    });
    const m = buildContextConsumption({
      retrieval: retrieval(),
      verifiedContextPack: p,
      rendered: rendered(),
    });
    expect(m?.status).toBe('partial');
  });

  // The task's fifth acceptance criterion: a runner-performed cut is visible even when the PACK
  // itself reported nothing wrong — semantic mode, no section notice — because the renderer's own
  // budget is independent of the pack's server-side `charBudget`.
  it('the renderer cut (truncated: true) → partial, even with semantic mode and no section notice', () => {
    const p = pack([section({ excerpts: [memoryExcerpt()] })], { mode: 'semantic' });
    const m = buildContextConsumption({
      retrieval: retrieval(),
      verifiedContextPack: p,
      rendered: rendered({ truncated: true }),
    });
    expect(m?.status).toBe('partial');
  });
});

describe('buildContextConsumption — the snapshot mirrors the pack it actually rendered (RUN-247)', () => {
  it('every field maps to the real pack fixture, not a hand-built snapshot', () => {
    const p = pack(
      [
        section({
          id: 'active_decisions',
          excerpts: [memoryExcerpt(), memoryExcerpt({ id: 'mem_2' })],
          graphEntities: [{ uri: 'u', type: 't', label: 'l', depth: 1, edgePath: 'e' }],
        }),
        section({ id: 'known_hazards', excerpts: [], graphEntities: [] }),
      ],
      {
        mode: 'semantic',
        role: 'build',
        charBudget: 8000,
        charsUsed: 3200,
        similarEpisodes: ['ep_1', 'ep_2'],
        notices: [{ kind: 'required_facts_exceeded_budget', reason: 'floor exceeded the budget' }],
      },
    );
    const r = retrieval({ tookMs: 777 });
    const m = buildContextConsumption({ retrieval: r, verifiedContextPack: p, rendered: rendered() });
    expect(m?.status).toBe('complete');
    expect(m?.value).toMatchObject({
      mode: 'semantic',
      role: 'build',
      charBudget: 8000,
      charsUsed: 3200,
      similarEpisodesConsidered: 2,
      noticesCount: 1,
      retrievalTookMs: 777,
    });
    expect(m?.value?.sections).toEqual([
      { id: 'active_decisions', excerptCount: 2, graphEntityCount: 1, truncated: false, unanswerable: false },
      { id: 'known_hazards', excerptCount: 0, graphEntityCount: 0, truncated: false, unanswerable: false },
    ]);
  });
});

describe('buildContextConsumption — staleCitationsCount (RUN-247 locked decision)', () => {
  it("counts THIS runner's own citation-verification failures, not pack.staleWarnings — proving which source was used", () => {
    const p = pack(
      [
        section({
          excerpts: [
            memoryExcerpt({
              evidence: [
                citation({
                  path: 'src/a.ts',
                  verification: {
                    state: 'valid',
                    reason: 'ok',
                    serverState: 'valid',
                    agreesWithServer: true,
                  },
                }),
                citation({
                  path: 'src/b.ts',
                  verification: {
                    state: 'changed',
                    reason: 'symbol moved',
                    serverState: 'valid',
                    agreesWithServer: false,
                  },
                }),
              ],
            }),
          ],
        }),
      ],
      { staleWarnings: [] }, // the SERVER's own view says nothing is stale
    );
    const m = buildContextConsumption({
      retrieval: retrieval(),
      verifiedContextPack: p,
      rendered: rendered(),
    });
    expect(p.staleWarnings).toHaveLength(0); // the field this decision explicitly did NOT use
    expect(m?.value?.staleCitationsCount).toBe(1); // this runner's own verdict caught what the server did not
  });

  it('an episode excerpt (no citations) contributes nothing to the count', () => {
    const p = pack([
      section({
        id: 'similar_episodes',
        excerpts: [
          {
            excerptKind: 'episode',
            id: 'ep_1',
            runId: 'run_1',
            taskId: 'task_1',
            taskKey: 'RUN-1',
            runKind: 'build',
            outcome: 'landed the change',
            landingOutcome: 'landed',
            whatWasAttempted: 'x',
            whatFailed: [],
            whatRemainsUncertain: [],
            support: [],
          },
        ],
      }),
    ]);
    const m = buildContextConsumption({
      retrieval: retrieval(),
      verifiedContextPack: p,
      rendered: rendered(),
    });
    expect(m?.value?.staleCitationsCount).toBe(0);
  });
});

describe('buildContextConsumption — no text ever crosses (RUN-247 locked decision)', () => {
  it('a distinctive statement/reason/path never appears anywhere in the serialized metric', () => {
    const marker = 'MARKER-ACME-DISTINCTIVE-TEXT';
    const p = pack(
      [
        section({
          notice: { kind: 'truncated', reason: marker },
          excerpts: [
            memoryExcerpt({
              statement: marker,
              leadReasons: [marker],
              evidence: [
                citation({
                  path: marker,
                  symbol: marker,
                  verification: {
                    state: 'changed',
                    reason: marker,
                    serverState: 'valid',
                    agreesWithServer: false,
                  },
                }),
              ],
            }),
          ],
        }),
      ],
      { staleWarnings: [marker], notices: [{ kind: 'required_facts_exceeded_budget', reason: marker }] },
    );
    const m = buildContextConsumption({
      retrieval: retrieval(),
      verifiedContextPack: p,
      rendered: rendered(),
    });
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain(marker);
    // The metric's own `reason` field is allowed to carry a DAEMON-authored sentence about the
    // measurement itself — asserted separately, so the assertion above is not vacuously true because
    // `reason` was blank throughout this fixture.
    expect(m?.reason).toBeNull(); // complete/partial carry no reason; nothing to leak here either.
  });
});

describe('buildContextConsumption — validates against the vendored schema (RUN-247)', () => {
  const cases: Array<[string, Parameters<typeof buildContextConsumption>[0]]> = [
    [
      'not_applicable',
      {
        retrieval: retrieval({ attempted: false, omission: { reason: 'no-task' } }),
        verifiedContextPack: null,
        rendered: rendered(),
      },
    ],
    [
      'unavailable',
      {
        retrieval: retrieval({ attempted: true, omission: { reason: 'unavailable' } }),
        verifiedContextPack: null,
        rendered: rendered(),
      },
    ],
    [
      'complete',
      {
        retrieval: retrieval(),
        verifiedContextPack: pack([section({ excerpts: [memoryExcerpt()] })], { mode: 'semantic' }),
        rendered: rendered(),
      },
    ],
    [
      'partial',
      {
        retrieval: retrieval(),
        verifiedContextPack: pack([section()], { mode: 'keyword' }),
        rendered: rendered(),
      },
    ],
  ];

  it.each(cases)('%s round-trips through IntelligenceContextConsumptionMetric.safeParse', (_label, input) => {
    const m = buildContextConsumption(input);
    const parsed = IntelligenceContextConsumptionMetric.safeParse(m);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('every produced status carries daemon-legal provenance/source and a null acceptedAt', () => {
    for (const [, input] of cases) {
      const m = buildContextConsumption(input);
      expect(m?.provenance).toBe('runner_observed');
      expect(m?.source).toBe('runner');
      expect(m?.acceptedAt).toBeNull();
    }
  });
});

describe('the snapshot validates against the vendored contract with REAL measured values (RUN-286)', () => {
  // The defect the first live run found. Every earlier test here built a snapshot from hand-written
  // integers, so none of them exercised the one field the real path feeds from `performance.now()`:
  // `retrievalTookMs` was fractional by construction and could never satisfy `z.number().int()`.
  // Because a refine failure drops the WHOLE `intelligence` payload, this single float took the
  // stages, clocks and change stats down with it on every run.
  it('a fractional retrieval duration still validates, rounded to the contract’s own unit', () => {
    const p = pack([section({ excerpts: [memoryExcerpt()] })], { mode: 'semantic' });
    const metric = buildContextConsumption({
      // The exact shape `elapsedMs` produces: a `performance.now()` delta, not a whole millisecond.
      retrieval: { ...retrieval(), tookMs: 143.2857 },
      verifiedContextPack: p,
      rendered: rendered({ text: 'x'.repeat(50), chars: 50, truncated: false }),
    });
    expect(metric?.value?.retrievalTookMs).toBe(143);
    expect(Number.isInteger(metric?.value?.retrievalTookMs)).toBe(true);
    const parsed = UploadedEpisodeIntelligence.safeParse({ contextConsumption: metric });
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
