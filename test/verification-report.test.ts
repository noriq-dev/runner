import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { VerifiedContextPack } from '../src/citation-verify';
import { NoriqHttpError } from '../src/client';
import type { PendingVerificationReport } from '../src/verification-pending';
import {
  VERIFICATION_REPORT_SOURCE,
  type VerificationReportDeliveryDeps,
  buildVerificationReport,
  deliverVerificationReport,
  drainPendingVerificationReports,
  evidenceHash,
  sendVerificationReport,
} from '../src/verification-report';

// RUN-230: report RUN-229's citation verdicts back to Noriq — idempotently, queued when offline,
// never gating the run, and in a way an agent cannot forge. `test/context-pack.test.ts`'s own
// RUN-230 block proves the `prepareRun` WIRING (built after `runAgent` exists, fire-and-forget,
// never gates); this file owns the module's own logic in isolation: the pinned hash reproduction,
// what `buildVerificationReport` includes/excludes, send-outcome classification, and the
// durable-first delivery/drain pipeline against a fake pending store.

describe('evidenceHash — planar reproduction, pinned (PLNR-348 is filed to delete this)', () => {
  it('matches a hard-coded digest for a fixed input — verified independently against apps/api/src/memory/writes.ts', () => {
    // Computed via Node's webcrypto SHA-256 over
    // `{"repositoryKey":"test-repo","branch":"main","baseId":"abc123","path":"src/foo.ts","symbol":"myFunction"}`
    // — the exact key order `apps/api/src/memory/writes.ts`'s `evidenceHash` builds (a fresh
    // object literal, never a spread of the input). A planar-side reorder of these five fields —
    // a cosmetic-looking edit — silently voids every report this daemon sends (the server SKIPS
    // an unmatched (memoryItemId, evidenceHash) pair with HTTP 200 and no error); this test is
    // what turns that into a failing runner test instead.
    const hash = evidenceHash({
      repositoryKey: 'test-repo',
      branch: 'main',
      baseId: 'abc123',
      path: 'src/foo.ts',
      symbol: 'myFunction',
    });
    expect(hash).toBe('1f2e7a77374e3e2ad01f12968f88fd5dd8b00d92efacb84d86bbee704a688c75');
  });

  it('a null symbol still hashes — the key is present with a null value, never omitted', () => {
    // `JSON.stringify({..., symbol: null})` includes `"symbol":null` — omitting the key entirely
    // (e.g. via a spread that drops nullish fields) would produce a DIFFERENT hash for the exact
    // same evidence identity, and every path-only citation (no symbol claim) carries `symbol: null`.
    const withNull = evidenceHash({ repositoryKey: 'r', branch: 'b', baseId: 'x', path: 'p', symbol: null });
    const withoutSymbolKey = createHash('sha256')
      .update(JSON.stringify({ repositoryKey: 'r', branch: 'b', baseId: 'x', path: 'p' }), 'utf8')
      .digest('hex');
    expect(withNull).not.toBe(withoutSymbolKey);
  });

  it('field order is fixed, independent of the order the caller passes them in the object literal', () => {
    // TS object literal key order at the CALL site cannot affect this — the function reconstructs
    // its own literal internally — but this pins that property directly rather than trusting it.
    const a = evidenceHash({ repositoryKey: 'r', branch: 'b', baseId: 'x', path: 'p', symbol: 's' });
    const b = evidenceHash({ symbol: 's', path: 'p', baseId: 'x', branch: 'b', repositoryKey: 'r' });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// buildVerificationReport
// ---------------------------------------------------------------------------

const REPO_KEY = 'acme/widgets';

function memoryExcerpt(id: string, evidence: unknown[]) {
  return {
    excerptKind: 'memory' as const,
    id,
    memoryKind: 'decision' as const,
    statement: 'stmt',
    authority: 3,
    confidence: null,
    validity: 'active',
    isLead: false,
    leadReasons: [],
    evidence,
    recordedByAgentId: null,
    recordedAt: '2026-08-01T00:00:00.000Z',
    supersedesMemoryId: null,
  };
}

function verifiedCitation(over: Record<string, unknown> = {}) {
  return {
    repositoryKey: REPO_KEY,
    branch: 'main',
    baseId: 'historical-base',
    path: 'src/foo.ts',
    symbol: null,
    verificationState: 'unverifiable',
    lastVerifiedAt: null,
    lastVerifiedBaseId: null,
    lastVerifiedBranch: null,
    verifiedForCaller: false,
    verification: { state: 'valid', reason: 'ok', serverState: 'unverifiable', agreesWithServer: false },
    ...over,
  };
}

function pack(sections: Array<{ excerpts: unknown[] }>): VerifiedContextPack {
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
    mode: 'keyword',
    charBudget: 4000,
    charsUsed: 0,
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
    sections: sections.map((s) => ({
      id: 'active_decisions',
      provenance: ['exact'],
      notice: null,
      charsAllotted: 500,
      charsUsed: 0,
      excerpts: s.excerpts,
      graphEntities: [],
      coverage: null,
      items: [],
    })),
    notices: [],
  } as never as VerifiedContextPack;
}

const CTX = { repositoryKey: REPO_KEY, observedBaseId: 'leased-base', observedBranch: 'main' };

describe('buildVerificationReport', () => {
  it('reports memoryItemId from the enclosing EXCERPT, never the citation — the citation carries no id at all', () => {
    const p = pack([{ excerpts: [memoryExcerpt('mem_42', [verifiedCitation()])] }]);
    const out = buildVerificationReport(p, CTX);
    expect(out?.citations).toHaveLength(1);
    expect(out?.citations[0]?.memoryItemId).toBe('mem_42');
  });

  it('the state reported is this daemon’s own verdict, never the citation’s server-supplied verificationState', () => {
    const p = pack([
      {
        excerpts: [
          memoryExcerpt('mem_1', [
            verifiedCitation({
              verificationState: 'valid', // the server's own prior belief
              verification: { state: 'changed', reason: 'x', serverState: 'valid', agreesWithServer: false },
            }),
          ]),
        ],
      },
    ]);
    const out = buildVerificationReport(p, CTX);
    expect(out?.citations[0]?.state).toBe('changed');
  });

  it('baseId/branch reported are the OBSERVED (worktree) values, never the citation’s own recorded ones', () => {
    const p = pack([
      {
        excerpts: [
          memoryExcerpt('mem_1', [verifiedCitation({ baseId: 'ancient-base', branch: 'feature/old' })]),
        ],
      },
    ]);
    const out = buildVerificationReport(p, CTX);
    expect(out?.citations[0]?.baseId).toBe('leased-base');
    expect(out?.citations[0]?.branch).toBe('main');
  });

  it('evidenceHash is computed from the CITATION’s own identity fields, matching a direct evidenceHash() call', () => {
    const cit = verifiedCitation({ baseId: 'hist', branch: 'feat', path: 'src/bar.ts', symbol: 'fn' });
    const p = pack([{ excerpts: [memoryExcerpt('mem_1', [cit])] }]);
    const out = buildVerificationReport(p, CTX);
    expect(out?.citations[0]?.evidenceHash).toBe(
      evidenceHash({
        repositoryKey: REPO_KEY,
        branch: 'feat',
        baseId: 'hist',
        path: 'src/bar.ts',
        symbol: 'fn',
      }),
    );
  });

  it('a citation naming a DIFFERENT repository is excluded — never reported with this workspace’s base stamped on it', () => {
    const p = pack([
      { excerpts: [memoryExcerpt('mem_1', [verifiedCitation({ repositoryKey: 'someone/else' })])] },
    ]);
    expect(buildVerificationReport(p, CTX)).toBeNull();
  });

  it('an episode excerpt is skipped — it has no ContextPackCitation[] evidence to report', () => {
    const p = pack([
      {
        excerpts: [
          {
            excerptKind: 'episode' as const,
            id: 'epi_1',
            runId: 'run_x',
            taskId: null,
            taskKey: null,
            runKind: 'build',
            outcome: 'done',
            landingOutcome: 'landed' as const,
            whatWasAttempted: 'x',
            whatFailed: [],
            whatRemainsUncertain: [],
            support: [{ kind: 'file', detail: 'src/foo.ts' }],
          },
        ],
      },
    ]);
    expect(buildVerificationReport(p, CTX)).toBeNull();
  });

  it('an empty pack (no memory excerpts anywhere) returns null, never an empty citations array', () => {
    const p = pack([{ excerpts: [] }]);
    expect(buildVerificationReport(p, CTX)).toBeNull();
  });

  it('the source is always the daemon’s own thorough tier', () => {
    const p = pack([{ excerpts: [memoryExcerpt('mem_1', [verifiedCitation()])] }]);
    expect(buildVerificationReport(p, CTX)?.source).toBe(VERIFICATION_REPORT_SOURCE);
  });

  it('multiple citations across multiple excerpts all get collected', () => {
    const p = pack([
      { excerpts: [memoryExcerpt('mem_1', [verifiedCitation(), verifiedCitation({ path: 'src/b.ts' })])] },
      { excerpts: [memoryExcerpt('mem_2', [verifiedCitation({ path: 'src/c.ts' })])] },
    ]);
    const out = buildVerificationReport(p, CTX);
    expect(out?.citations).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// sendVerificationReport — outcome classification
// ---------------------------------------------------------------------------

const REPORT = {
  citations: [{ memoryItemId: 'm', evidenceHash: 'h', state: 'valid' as const, baseId: 'b', branch: 'main' }],
  source: 's',
};

describe('sendVerificationReport', () => {
  it('a successful call returns ok:true with the server’s result', async () => {
    const client = { reportVerification: async () => ({ applied: 1, skipped: 0, touchedMemoryIds: ['m'] }) };
    const out = await sendVerificationReport('run_1', 'tok', REPORT, { client });
    expect(out).toEqual({ ok: true, result: { applied: 1, skipped: 0, touchedMemoryIds: ['m'] } });
  });

  it('a 401 is classified non-retryable — the run’s own bound-agent token is revoked, not transient', async () => {
    const client = {
      reportVerification: async () => {
        throw new NoriqHttpError('POST x → 401: nope', 401, 'nope');
      },
    };
    const out = await sendVerificationReport('run_1', 'tok', REPORT, { client });
    expect(out).toEqual({ ok: false, retryable: false, detail: '401: POST x → 401: nope' });
  });

  it('a 403 is classified non-retryable for the identical reason', async () => {
    const client = {
      reportVerification: async () => {
        throw new NoriqHttpError('POST x → 403: nope', 403, 'nope');
      },
    };
    const out = await sendVerificationReport('run_1', 'tok', REPORT, { client });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.retryable).toBe(false);
  });

  it('a 500 (or any other transport failure) is classified retryable', async () => {
    const client = {
      reportVerification: async () => {
        throw new NoriqHttpError('POST x → 500: oops', 500, 'oops');
      },
    };
    const out = await sendVerificationReport('run_1', 'tok', REPORT, { client });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.retryable).toBe(true);
  });

  it('a plain network error (not a NoriqHttpError) is classified retryable', async () => {
    const client = {
      reportVerification: async () => {
        throw new Error('ECONNRESET');
      },
    };
    const out = await sendVerificationReport('run_1', 'tok', REPORT, { client });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deliverVerificationReport / drainPendingVerificationReports — durable-first delivery
// ---------------------------------------------------------------------------

function fakePending(initial: PendingVerificationReport[] = []) {
  const state = { entries: [...initial] };
  return {
    state,
    put: async (e: PendingVerificationReport) => {
      state.entries = [...state.entries.filter((x) => x.runId !== e.runId), e];
    },
    remove: async (runId: string) => {
      state.entries = state.entries.filter((x) => x.runId !== runId);
    },
    list: async () => state.entries,
    summary: async () => ({
      count: state.entries.length,
      oldestEnqueuedAt: state.entries[0]?.enqueuedAt ?? null,
    }),
  };
}

describe('deliverVerificationReport — durable first, never gates', () => {
  it('a successful send removes the entry it just persisted — enqueue happens even on success', async () => {
    const pending = fakePending();
    const puts: string[] = [];
    const originalPut = pending.put;
    pending.put = async (e) => {
      puts.push(e.runId);
      await originalPut(e);
    };
    const client = { reportVerification: async () => ({ applied: 1, skipped: 0, touchedMemoryIds: ['m'] }) };
    const deps: VerificationReportDeliveryDeps = { client, pending };
    await deliverVerificationReport('run_1', 'tok', REPORT, deps);
    expect(puts).toEqual(['run_1']); // persisted BEFORE the network attempt
    expect(await pending.list()).toHaveLength(0); // then removed on success
  });

  it('a retryable failure leaves the entry in the queue — this is what "queued when offline" means', async () => {
    const pending = fakePending();
    const client = {
      reportVerification: async () => {
        throw new Error('offline');
      },
    };
    const deps: VerificationReportDeliveryDeps = { client, pending };
    await deliverVerificationReport('run_1', 'tok', REPORT, deps);
    const left = await pending.list();
    expect(left).toHaveLength(1);
    expect(left[0]?.runId).toBe('run_1');
    // The resent body — if a retry drains this later — must be byte-identical, never re-derived.
    expect(left[0]?.report).toEqual(REPORT);
  });

  it('a non-retryable failure (401) drops the entry — a doomed retry must not occupy the bounded queue forever', async () => {
    const pending = fakePending();
    const client = {
      reportVerification: async () => {
        throw new NoriqHttpError('x', 401, 'x');
      },
    };
    const deps: VerificationReportDeliveryDeps = { client, pending };
    await deliverVerificationReport('run_1', 'tok', REPORT, deps);
    expect(await pending.list()).toHaveLength(0);
  });

  it('never gates: resolves even when the pending store itself throws on write', async () => {
    const client = { reportVerification: async () => ({ applied: 1, skipped: 0, touchedMemoryIds: [] }) };
    const brokenPending = {
      put: async () => {
        throw new Error('disk full');
      },
      remove: async () => {},
      list: async () => [],
      summary: async () => ({ count: 0, oldestEnqueuedAt: null }),
    };
    const deps: VerificationReportDeliveryDeps = { client, pending: brokenPending };
    await expect(deliverVerificationReport('run_1', 'tok', REPORT, deps)).resolves.toBeUndefined();
  });
});

describe('drainPendingVerificationReports', () => {
  it('delivers a pending report sent later — the resent body is byte-identical (the base it was OBSERVED at)', async () => {
    const entry: PendingVerificationReport = {
      runId: 'run_1',
      agentToken: 'tok',
      report: REPORT,
      enqueuedAt: '2026-08-01T00:00:00.000Z',
    };
    const pending = fakePending([entry]);
    let sentBody: unknown;
    const client = {
      reportVerification: async (_runId: string, _token: string, body: unknown) => {
        sentBody = body;
        return { applied: 1, skipped: 0, touchedMemoryIds: ['m'] };
      },
    };
    const deps: VerificationReportDeliveryDeps = { client, pending };
    const result = await drainPendingVerificationReports(deps);
    expect(result).toEqual({ delivered: 1, dropped: 0, remaining: 0 });
    expect(sentBody).toEqual(REPORT); // never re-derived at retry time
    expect(await pending.list()).toHaveLength(0);
  });

  it('drops permanently-undeliverable entries (401) and counts them separately from delivered', async () => {
    const entries: PendingVerificationReport[] = [
      { runId: 'run_1', agentToken: 'tok', report: REPORT, enqueuedAt: '2026-08-01T00:00:00.000Z' },
      { runId: 'run_2', agentToken: 'tok', report: REPORT, enqueuedAt: '2026-08-01T00:00:00.000Z' },
    ];
    const pending = fakePending(entries);
    const client = {
      reportVerification: async (runId: string) => {
        if (runId === 'run_1') throw new NoriqHttpError('x', 403, 'x');
        return { applied: 1, skipped: 0, touchedMemoryIds: [] };
      },
    };
    const deps: VerificationReportDeliveryDeps = { client, pending };
    const result = await drainPendingVerificationReports(deps);
    expect(result).toEqual({ delivered: 1, dropped: 1, remaining: 0 });
    expect(await pending.list()).toHaveLength(0);
  });

  it('a still-unreachable server leaves retryable entries in the queue, reported as remaining', async () => {
    const entries: PendingVerificationReport[] = [
      { runId: 'run_1', agentToken: 'tok', report: REPORT, enqueuedAt: '2026-08-01T00:00:00.000Z' },
    ];
    const pending = fakePending(entries);
    const client = {
      reportVerification: async () => {
        throw new Error('still offline');
      },
    };
    const deps: VerificationReportDeliveryDeps = { client, pending };
    const result = await drainPendingVerificationReports(deps);
    expect(result).toEqual({ delivered: 0, dropped: 0, remaining: 1 });
    expect(await pending.list()).toHaveLength(1);
  });

  it('an empty queue drains to nothing, no calls made', async () => {
    const pending = fakePending([]);
    let called = false;
    const client = {
      reportVerification: async () => {
        called = true;
        return { applied: 0, skipped: 0, touchedMemoryIds: [] };
      },
    };
    const deps: VerificationReportDeliveryDeps = { client, pending };
    const result = await drainPendingVerificationReports(deps);
    expect(result).toEqual({ delivered: 0, dropped: 0, remaining: 0 });
    expect(called).toBe(false);
  });
});
