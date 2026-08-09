import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CitationFileRead,
  type CitationFileReader,
  type CitationVerifyContext,
  readCitationFile,
  verifyContextPack,
} from '../src/citation-verify';
import { IndexAdapterRegistry, NOOP_ADAPTER } from '../src/index-adapters';
import type { IndexParserAdapter, ParsedSymbol } from '../src/index-adapters';
import type { ContextPack, ContextPackCitation, ContextPackMemoryExcerpt } from '../src/memory-contract';
import type { ChangesBetweenResult, VcsBackend } from '../src/vcs/types';

// RUN-229: verify a task ContextPack's citations against the ACTUAL leased worktree, before
// RUN-230/231 render anything from it. Every test here is pure — a fake VCS, a fake reader, a
// fake adapter registry — EXCEPT the `readCitationFile` confinement tests, which run against a
// real temp directory because a fake reader cannot exhibit the filesystem behaviour the
// confinement floor exists to defend (the same reasoning `test/repo-context.test.ts`'s own
// `openConfined` suite states). No test anywhere in this file touches real git, a real network,
// or a real agent.

const REPO_KEY = 'acme/widgets';
const CURRENT_BASE = 'base-current';

function citation(over: Partial<ContextPackCitation> = {}): ContextPackCitation {
  return {
    repositoryKey: REPO_KEY,
    branch: 'main',
    baseId: CURRENT_BASE,
    path: 'src/foo.ts',
    symbol: null,
    verificationState: 'unverifiable',
    lastVerifiedAt: null,
    lastVerifiedBaseId: null,
    lastVerifiedBranch: null,
    verifiedForCaller: false,
    ...over,
  };
}

function memoryExcerpt(evidence: ContextPackCitation[]): ContextPackMemoryExcerpt {
  return {
    excerptKind: 'memory',
    id: 'mem_1',
    memoryKind: 'decision',
    statement: 'the statement',
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

function pack(evidence: ContextPackCitation[]): ContextPack {
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
    sections: [
      {
        id: 'active_decisions',
        provenance: ['exact'],
        notice: null,
        charsAllotted: 500,
        charsUsed: 100,
        excerpts: [memoryExcerpt(evidence)],
        graphEntities: [],
        coverage: null,
        items: [],
      },
    ],
    notices: [],
  };
}

function fakeVcs(answer: ChangesBetweenResult | ((from: string) => ChangesBetweenResult)): {
  vcs: Pick<VcsBackend, 'changesBetween'>;
  calls: Array<[string, string, string]>;
} {
  const calls: Array<[string, string, string]> = [];
  return {
    calls,
    vcs: {
      changesBetween: async (repoRoot, from, to) => {
        calls.push([repoRoot, from, to]);
        return typeof answer === 'function' ? answer(from) : answer;
      },
    },
  };
}

function fakeReader(map: Record<string, CitationFileRead>): { reader: CitationFileReader; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reader: async (relPath) => {
      calls.push(relPath);
      return map[relPath] ?? { kind: 'missing' };
    },
  };
}

/** A controlled, WASM-free stand-in for the real adapter registry — `symbolsByPath` names which
 *  paths this fake claims; everything else falls through to `NOOP_ADAPTER` (no symbol support). */
function fakeAdapters(symbolsByPath: Record<string, ParsedSymbol[]>): IndexAdapterRegistry {
  const registry = new IndexAdapterRegistry();
  const parseCalls: string[] = [];
  const adapter: IndexParserAdapter = {
    id: 'fake',
    version: '1',
    canParse: (p) => p in symbolsByPath,
    parse: async (input) => {
      parseCalls.push(input.path);
      return { symbols: symbolsByPath[input.path] ?? [], diagnostics: [] };
    },
  };
  registry.register(adapter);
  registry.register(NOOP_ADAPTER);
  return registry;
}

function baseCtx(over: Partial<CitationVerifyContext> = {}): CitationVerifyContext {
  return {
    vcs: fakeVcs({ ok: true, changed: [], deleted: [] }).vcs,
    repoRoot: '/repo',
    worktree: { baseId: CURRENT_BASE, localPath: '/repo' },
    repositoryKey: REPO_KEY,
    readFile: fakeReader({}).reader,
    adapters: fakeAdapters({}),
    ...over,
  };
}

/** Verify a single citation and return just its verdict — every test below wants exactly one
 *  citation's outcome, and this is what makes the assertions read as "the classification of X". */
async function classify(c: ContextPackCitation, ctx: CitationVerifyContext) {
  const verified = await verifyContextPack(pack([c]), ctx);
  const excerpt = verified.sections[0]!.excerpts[0];
  if (excerpt!.excerptKind !== 'memory') throw new Error('expected a memory excerpt');
  return excerpt!.evidence[0]!;
}

// ---------------------------------------------------------------------------------------------
// The five states, each from a distinct cause — and `moved`, documented as unreachable.
// ---------------------------------------------------------------------------------------------

describe('verifyContextPack — classification', () => {
  it('missing: the path does not exist in the leased workspace', async () => {
    const v = await classify(citation({ path: 'gone.ts' }), baseCtx());
    expect(v.verification.state).toBe('missing');
  });

  it('valid: same base, path present, no symbol claim', async () => {
    const ctx = baseCtx({ readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader });
    const v = await classify(citation({ baseId: CURRENT_BASE }), ctx);
    expect(v.verification.state).toBe('valid');
  });

  it('valid: same base, path present, symbol resolves to exactly one declaration', async () => {
    const ctx = baseCtx({
      readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader,
      adapters: fakeAdapters({
        'src/foo.ts': [{ symbolPath: ['helper'], nodeType: 'symbol', label: 'helper', content: null }],
      }),
    });
    const v = await classify(citation({ symbol: 'helper' }), ctx);
    expect(v.verification.state).toBe('valid');
  });

  it('changed: bases differ, and the backend reports the cited path as changed (never valid on path existence alone)', async () => {
    const { vcs, calls } = fakeVcs({ ok: true, changed: ['src/foo.ts'], deleted: [] });
    const ctx = baseCtx({
      vcs,
      readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader,
    });
    const v = await classify(citation({ baseId: 'base-old' }), ctx);
    expect(v.verification.state).toBe('changed');
    // The seam was actually consulted — this is the acceptance's own load-bearing assertion, not
    // an implementation detail: a citation whose base differs from the workspace's must never be
    // classified from path existence alone.
    expect(calls).toEqual([['/repo', 'base-old', CURRENT_BASE]]);
  });

  it('changed: same base, path present, but the cited symbol no longer resolves in the file', async () => {
    const ctx = baseCtx({
      readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader,
      adapters: fakeAdapters({
        'src/foo.ts': [{ symbolPath: ['other'], nodeType: 'symbol', label: 'other', content: null }],
      }),
    });
    const v = await classify(citation({ symbol: 'helper' }), ctx);
    expect(v.verification.state).toBe('changed');
  });

  it('missing: bases differ and the backend reports the cited path as deleted', async () => {
    const { vcs } = fakeVcs({ ok: true, changed: [], deleted: ['src/foo.ts'] });
    const ctx = baseCtx({
      vcs,
      readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader,
    });
    const v = await classify(citation({ baseId: 'base-old' }), ctx);
    expect(v.verification.state).toBe('missing');
  });

  it('valid: bases differ, path in NEITHER list — byte-identical between the two bases (ChangesBetweenResult locked decision 2)', async () => {
    const { vcs } = fakeVcs({ ok: true, changed: [], deleted: [] });
    const ctx = baseCtx({
      vcs,
      readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader,
    });
    const v = await classify(citation({ baseId: 'base-old' }), ctx);
    expect(v.verification.state).toBe('valid');
  });

  it('unverifiable: the backend refuses to relate the two bases — never valid', async () => {
    const { vcs } = fakeVcs({ ok: false, reason: 'full-index-required', detail: 'unrelated histories' });
    const ctx = baseCtx({
      vcs,
      readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader,
    });
    const v = await classify(citation({ baseId: 'base-old' }), ctx);
    expect(v.verification.state).toBe('unverifiable');
    expect(v.verification.reason).toMatch(/base-old/);
  });

  it('unverifiable: a symbol name resolving to more than one declaration in the cited file', async () => {
    const ctx = baseCtx({
      readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader,
      adapters: fakeAdapters({
        'src/foo.ts': [
          { symbolPath: ['A', 'helper'], nodeType: 'symbol', label: 'helper', content: null },
          { symbolPath: ['B', 'helper'], nodeType: 'symbol', label: 'helper', content: null },
        ],
      }),
    });
    const v = await classify(citation({ symbol: 'helper' }), ctx);
    expect(v.verification.state).toBe('unverifiable');
  });

  it('valid: an ambiguous LEAF name still resolves uniquely when cited by its full nested path', async () => {
    const ctx = baseCtx({
      readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader,
      adapters: fakeAdapters({
        'src/foo.ts': [
          { symbolPath: ['A', 'helper'], nodeType: 'symbol', label: 'helper', content: null },
          { symbolPath: ['B', 'helper'], nodeType: 'symbol', label: 'helper', content: null },
        ],
      }),
    });
    const v = await classify(citation({ symbol: 'A.helper' }), ctx);
    expect(v.verification.state).toBe('valid');
  });

  it('unverifiable: no symbol-capable adapter recognises this file — most non-code citations land here', async () => {
    const ctx = baseCtx({
      readFile: fakeReader({ 'assets/logo.svg': { kind: 'present', content: '<svg/>' } }).reader,
      adapters: fakeAdapters({}), // nothing claims it but NOOP_ADAPTER
    });
    const v = await classify(citation({ path: 'assets/logo.svg', symbol: 'whatever' }), ctx);
    expect(v.verification.state).toBe('unverifiable');
    expect(v.verification.reason).toMatch(/no symbol-capable adapter/);
  });

  it('unverifiable: a file over the read bound cannot back a symbol claim, even though it plainly exists', async () => {
    const ctx = baseCtx({
      readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: null } }).reader,
    });
    const v = await classify(citation({ symbol: 'helper' }), ctx);
    expect(v.verification.state).toBe('unverifiable');
  });

  it('valid: an oversized file still verifies a bare path citation (no symbol claim needs the content)', async () => {
    const ctx = baseCtx({
      readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: null } }).reader,
    });
    const v = await classify(citation({ symbol: null }), ctx);
    expect(v.verification.state).toBe('valid');
  });

  it('unverifiable: a citation naming a DIFFERENT repository is never checked against this workspace', async () => {
    const { vcs, calls: vcsCalls } = fakeVcs({ ok: true, changed: [], deleted: [] });
    const { reader, calls: readCalls } = fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } });
    const ctx = baseCtx({ vcs, readFile: reader });
    const v = await classify(citation({ repositoryKey: 'someone/else', baseId: 'base-old' }), ctx);
    expect(v.verification.state).toBe('unverifiable');
    // The whole point: nothing about this workspace was ever consulted for a foreign citation.
    expect(vcsCalls).toEqual([]);
    expect(readCalls).toEqual([]);
  });

  it('unverifiable: a workspace with no canonical repositoryKey cannot verify anything against it', async () => {
    const v = await classify(citation(), baseCtx({ repositoryKey: null }));
    expect(v.verification.state).toBe('unverifiable');
  });

  it('`moved` is never produced — even a server that already believed a citation moved is reclassified honestly', async () => {
    const v = await classify(citation({ path: 'gone.ts', verificationState: 'moved' }), baseCtx());
    expect(v.verification.state).toBe('missing');
    expect(v.verification.state).not.toBe('moved');
    // Recorded, never trusted (locked decision): the server's belief travels through unchanged,
    // and this module's own independent verdict disagrees with it rather than deferring to it.
    expect(v.verification.serverState).toBe('moved');
    expect(v.verification.agreesWithServer).toBe(false);
  });

  it('the server state is recorded and cross-checked, never substituted for the independent verdict', async () => {
    const ctx = baseCtx({ readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader });
    const v = await classify(citation({ verificationState: 'valid' }), ctx);
    expect(v.verification.state).toBe('valid');
    expect(v.verification.serverState).toBe('valid');
    expect(v.verification.agreesWithServer).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Verdicts travel WITH the pack — the shape a renderer cannot bypass.
// ---------------------------------------------------------------------------------------------

describe('verifyContextPack — the shape', () => {
  it('a memory excerpt carries its verified citations inline, addressable at the same position an unverified reader would look', async () => {
    const ctx = baseCtx({ readFile: fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } }).reader });
    const verified = await verifyContextPack(pack([citation()]), ctx);
    const excerpt = verified.sections[0]!.excerpts[0];
    expect(excerpt!.excerptKind).toBe('memory');
    if (excerpt!.excerptKind !== 'memory') throw new Error('unreachable');
    expect(excerpt!.evidence[0]!.path).toBe('src/foo.ts');
    expect(excerpt!.evidence[0]!.verification.state).toBe('valid');
  });

  it('an episode excerpt passes through unchanged — it carries no ContextPackCitation evidence to verify', async () => {
    const withEpisode: ContextPack = {
      ...pack([]),
      sections: [
        {
          id: 'similar_episodes',
          provenance: ['similar-effort'],
          notice: null,
          charsAllotted: 100,
          charsUsed: 50,
          excerpts: [
            {
              excerptKind: 'episode',
              id: 'ep_1',
              runId: 'run_1',
              taskId: null,
              taskKey: null,
              runKind: 'build',
              outcome: 'done',
              landingOutcome: 'landed',
              whatWasAttempted: 'did a thing',
              whatFailed: [],
              whatRemainsUncertain: [],
              support: [{ kind: 'file-overlap', detail: 'src/foo.ts' }],
            },
          ],
          graphEntities: [],
          coverage: null,
          items: [],
        },
      ],
    };
    const verified = await verifyContextPack(withEpisode, baseCtx());
    expect(verified.sections[0]!.excerpts[0]).toEqual(withEpisode.sections[0]!.excerpts[0]);
  });
});

// ---------------------------------------------------------------------------------------------
// Run-scoped caching (locked decision: "cache for THIS run only, keyed on (path, citation
// baseId)"). Decomposed rather than one verdict cache at that key — see citation-verify.ts's own
// doc on `verifyContextPack` for why a single cache at that granularity would have collided two
// citations naming the same (path, baseId) but different SYMBOLS. These tests pin the dedup
// AND the absence of the collision in one shot: two citations sharing (path, baseId) but citing
// different symbols still get their OWN, correct verdicts.
// ---------------------------------------------------------------------------------------------

describe('verifyContextPack — run-scoped caching without cross-citation collisions', () => {
  it('changesBetween is consulted once per distinct base, even across many citations', async () => {
    const { vcs, calls } = fakeVcs({ ok: true, changed: [], deleted: [] });
    const ctx = baseCtx({
      vcs,
      readFile: fakeReader({
        'a.ts': { kind: 'present', content: 'x' },
        'b.ts': { kind: 'present', content: 'x' },
      }).reader,
    });
    await verifyContextPack(
      pack([citation({ path: 'a.ts', baseId: 'base-old' }), citation({ path: 'b.ts', baseId: 'base-old' })]),
      ctx,
    );
    expect(calls).toEqual([['/repo', 'base-old', CURRENT_BASE]]);
  });

  it("two citations sharing (path, baseId) but naming DIFFERENT symbols are not served each other's verdict", async () => {
    const { reader, calls } = fakeReader({ 'src/foo.ts': { kind: 'present', content: 'x' } });
    const ctx = baseCtx({
      readFile: reader,
      adapters: fakeAdapters({
        'src/foo.ts': [
          { symbolPath: ['known'], nodeType: 'symbol', label: 'known', content: null },
          // 'ghost' is deliberately absent — its citation must classify as `changed`, never
          // inherit `known`'s `valid` verdict from a cache keyed on (path, baseId) alone.
        ],
      }),
    });
    const verified = await verifyContextPack(
      pack([citation({ symbol: 'known' }), citation({ symbol: 'ghost' })]),
      ctx,
    );
    const evidence = (
      verified.sections[0]!.excerpts[0] as { evidence: { verification: { state: string } }[] }
    ).evidence;
    expect(evidence[0]!.verification.state).toBe('valid');
    expect(evidence[1]!.verification.state).toBe('changed');
    // The expensive local read is still deduped by path — this is what the caching buys.
    expect(calls).toEqual(['src/foo.ts']);
  });
});

// ---------------------------------------------------------------------------------------------
// Confinement — `readCitationFile` against a REAL filesystem, the same posture `openConfined`'s
// own suite in test/repo-context.test.ts uses and for the same reason: a fake reader cannot
// exhibit the escape this floor exists to refuse.
// ---------------------------------------------------------------------------------------------

describe('readCitationFile — confinement (RUN-151 posture)', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'noriq-cv-'));
    outside = await mkdtemp(path.join(tmpdir(), 'noriq-cv-out-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'foo.ts'), 'export const x = 1;');
    await writeFile(path.join(outside, 'secret'), 'SHOULD-NEVER-BE-READ');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reads a real in-repo file', async () => {
    const r = await readCitationFile('src/foo.ts', root);
    expect(r).toEqual({ kind: 'present', content: 'export const x = 1;' });
  });

  it('reports a genuinely absent path as missing', async () => {
    expect(await readCitationFile('src/nope.ts', root)).toEqual({ kind: 'missing' });
  });

  it('refuses a `..`-escaping citation path without ever opening the file it points at', async () => {
    const rel = path.relative(root, path.join(outside, 'secret'));
    expect(rel.startsWith('..')).toBe(true); // sanity: this really is an escape on this platform
    const r = await readCitationFile(rel, root);
    expect(r.kind).toBe('refused');
    expect(JSON.stringify(r)).not.toContain('SHOULD-NEVER-BE-READ');
  });

  it('refuses an absolute citation path even when it points at a real, readable file', async () => {
    const abs = path.join(outside, 'secret');
    const r = await readCitationFile(abs, root);
    expect(r.kind).toBe('refused');
    expect(JSON.stringify(r)).not.toContain('SHOULD-NEVER-BE-READ');
  });

  it('the same escape is refused end to end through verifyContextPack, never read, never valid', async () => {
    const rel = path.relative(root, path.join(outside, 'secret'));
    const ctx = baseCtx({ readFile: undefined, worktree: { baseId: CURRENT_BASE, localPath: root } });
    const v = await classify(citation({ path: rel }), ctx);
    expect(v.verification.state).toBe('unverifiable');
    expect(JSON.stringify(v)).not.toContain('SHOULD-NEVER-BE-READ');
  });
});
