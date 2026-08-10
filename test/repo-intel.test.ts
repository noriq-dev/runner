import { describe, expect, it, vi } from 'vitest';
import { type IntelStore, RepoIntel, emptyFacts, hasFacts, renderRepoFacts } from '../src/repo-intel';

// RUN-143. Nothing preserved what a repo IS: parked state preserves one session, continuation
// state preserves spend, transcripts preserve what happened — and every run still rediscovered
// where the tests live. This is that, cached, and the rules that keep it a cache.

const memStore = (): IntelStore & { file: Record<string, Record<string, unknown>> } => {
  const state = { file: {} as Record<string, Record<string, unknown>> };
  return {
    get file() {
      return state.file;
    },
    read: async () => structuredClone(state.file) as never,
    write: async (f) => {
      state.file = structuredClone(f) as never;
    },
  };
};

const facts = (over: Partial<ReturnType<typeof emptyFacts>> = {}) => ({ ...emptyFacts(), ...over });

describe('a hit is a hit only at the same base', () => {
  it('returns what a run learned, at the base it learned it at', async () => {
    const intel = new RepoIntel(memStore(), 'https://noriq.test');
    await intel.put('repo_a', 'sha1', facts({ entryPoints: ['src/daemon.ts'] }));
    expect(await intel.get('repo_a', 'sha1')).toMatchObject({ entryPoints: ['src/daemon.ts'] });
  });

  // Not a stale hit with a caveat: putting "is this still true?" in front of an agent is exactly
  // the work this exists to save.
  it('is a MISS at a different base, not an older answer', async () => {
    const intel = new RepoIntel(memStore(), 'https://noriq.test');
    await intel.put('repo_a', 'sha1', facts({ conventions: ['ESM only'] }));
    expect(await intel.get('repo_a', 'sha2')).toBeNull();
  });

  it('is a miss for a repo nobody has learned', async () => {
    expect(await new RepoIntel(memStore(), 'https://noriq.test').get('repo_new', 'sha1')).toBeNull();
  });

  // A checkout reachable from two Noriq instances is two projects sharing a directory, and one's
  // facts are not the other's.
  it('keeps two servers’ facts apart', async () => {
    const store = memStore();
    await new RepoIntel(store, 'https://a.test').put('repo_a', 'sha1', facts({ layout: ['A says so'] }));
    await new RepoIntel(store, 'https://b.test').put('repo_a', 'sha1', facts({ layout: ['B says so'] }));
    expect((await new RepoIntel(store, 'https://a.test').get('repo_a', 'sha1'))?.layout).toEqual([
      'A says so',
    ]);
    expect((await new RepoIntel(store, 'https://b.test').get('repo_a', 'sha1'))?.layout).toEqual([
      'B says so',
    ]);
  });
});

describe('writing', () => {
  // The facts describe one base; merging two bases' facts describes no repo at all.
  it('replaces rather than merges when the base moves', async () => {
    const intel = new RepoIntel(memStore(), 'https://noriq.test');
    await intel.put('repo_a', 'sha1', facts({ conventions: ['old'] }));
    await intel.put('repo_a', 'sha2', facts({ conventions: ['new'] }));
    expect((await intel.get('repo_a', 'sha2'))?.conventions).toEqual(['new']);
  });

  it('does not write when nothing was learned', async () => {
    const store = memStore();
    await new RepoIntel(store, 'https://noriq.test').put('repo_a', 'sha1', emptyFacts());
    expect(store.file).toEqual({});
  });

  it('caps how many facts of each kind are kept, and how long one may be', async () => {
    const intel = new RepoIntel(memStore(), 'https://noriq.test');
    await intel.put(
      'repo_a',
      'sha1',
      facts({
        conventions: Array.from({ length: 40 }, (_, i) => `convention ${i}`),
        layout: ['x'.repeat(1000)],
      }),
    );
    const got = await intel.get('repo_a', 'sha1');
    expect(got?.conventions).toHaveLength(12);
    expect(got?.layout[0]?.length).toBeLessThanOrEqual(240);
    expect(got?.layout[0]?.endsWith('…')).toBe(true);
  });

  it('drops blank entries rather than storing them', async () => {
    const intel = new RepoIntel(memStore(), 'https://noriq.test');
    await intel.put('repo_a', 'sha1', facts({ conventions: ['  ', 'real', ''] }));
    expect((await intel.get('repo_a', 'sha1'))?.conventions).toEqual(['real']);
  });

  it('forgets a repo on request, leaving the others', async () => {
    const intel = new RepoIntel(memStore(), 'https://noriq.test');
    await intel.put('repo_a', 'sha1', facts({ conventions: ['a'] }));
    await intel.put('repo_b', 'sha1', facts({ conventions: ['b'] }));
    await intel.forget('repo_a');
    expect(await intel.get('repo_a', 'sha1')).toBeNull();
    expect(await intel.get('repo_b', 'sha1')).not.toBeNull();
  });
});

// A cache that can fail a run is worse than no cache: the run would have worked without it.
describe('a broken cache costs latency and nothing else', () => {
  const broken: IntelStore = {
    read: async () => {
      throw new Error('corrupt');
    },
    write: async () => {
      throw new Error('read-only fs');
    },
  };

  // `null` and `[]` are valid JSON that would then throw on the first property read — and this
  // subsystem's whole contract is that a broken cache is a miss rather than an error.
  it('reads valid JSON of the wrong shape as a miss, not a throw', async () => {
    for (const bad of ['null', '[]', '"a string"', '42']) {
      const store: IntelStore = { read: async () => JSON.parse(bad), write: async () => {} };
      await expect(new RepoIntel(store, 'https://noriq.test').get('repo_a', 'sha1')).resolves.toBeNull();
    }
  });

  it('reads a corrupt store as a miss', async () => {
    expect(await new RepoIntel(broken, 'https://noriq.test').get('repo_a', 'sha1')).toBeNull();
  });

  it('surfaces a write failure to the caller rather than swallowing it', async () => {
    // Deliberately NOT caught here: the caller logs it and moves on, and a silent write failure
    // would leave every run paying for facts nobody could ever read.
    await expect(
      new RepoIntel(broken, 'https://noriq.test').put('repo_a', 'sha1', facts({ conventions: ['x'] })),
    ).rejects.toThrow();
  });
});

describe('rendering it into a brief', () => {
  it('renders nothing for a repo nobody has learned', () => {
    expect(renderRepoFacts(null)).toBe('');
    expect(renderRepoFacts(emptyFacts())).toBe('');
  });

  // The failure mode of a cache in a prompt is an agent trusting it over the repo in front of it.
  it('says these are notes, not authority, and that the code wins', () => {
    const out = renderRepoFacts(facts({ conventions: ['ESM only'] }));
    expect(out).toMatch(/notes from a previous run/);
    expect(out).toMatch(/not an authority/);
    expect(out).toMatch(/the code in front of you is the truth/);
  });

  it('omits the sections that are empty', () => {
    const out = renderRepoFacts(facts({ testCommands: ['npm run check'] }));
    expect(out).toContain('npm run check');
    expect(out).not.toMatch(/Start reading here/);
    expect(out).not.toMatch(/Conventions/);
  });
});

describe('hasFacts', () => {
  it('is false for the empty facts and true for anything at all', () => {
    expect(hasFacts(emptyFacts())).toBe(false);
    expect(hasFacts(facts({ layout: ['one line'] }))).toBe(true);
  });
});

// RUN-233: seeded entries are a weaker kind of hit than learned ones — `getEntry` is the seam
// that lets a caller (the supervisor's `mapPatternsIfWorthIt`) tell the two apart and decide
// whether a fresh write may replace what is here.
describe('origin (RUN-233)', () => {
  it('defaults a bare put() to learned', async () => {
    const intel = new RepoIntel(memStore(), 'https://noriq.test');
    await intel.put('repo_a', 'sha1', facts({ entryPoints: ['a.ts'] }));
    expect(await intel.getEntry('repo_a', 'sha1')).toMatchObject({ origin: 'learned' });
  });

  it('records a seeded write as seeded, and get() still returns bare facts', async () => {
    const intel = new RepoIntel(memStore(), 'https://noriq.test');
    await intel.put('repo_a', 'sha1', facts({ entryPoints: ['a.ts'] }), 'seeded');
    expect(await intel.getEntry('repo_a', 'sha1')).toMatchObject({ origin: 'seeded' });
    expect(await intel.get('repo_a', 'sha1')).toMatchObject({ entryPoints: ['a.ts'] });
  });

  it('reads an on-disk entry with no marker as learned, not seeded', async () => {
    // Every entry ever written before this task carried no `origin` field at all — the on-disk
    // shape RepoIntelEntry had until RUN-233. Absence must not silently make old, real facts
    // replaceable by a seed.
    const store = memStore();
    await store.write({
      'https://noriq.test': {
        repo_a: { ...facts({ conventions: ['old'] }), baseId: 'sha1', learnedAt: 'x' },
      },
    } as never);
    const intel = new RepoIntel(store, 'https://noriq.test');
    expect(await intel.getEntry('repo_a', 'sha1')).toMatchObject({ origin: 'learned' });
  });

  it('getEntry is a miss at a different base, exactly like get', async () => {
    const intel = new RepoIntel(memStore(), 'https://noriq.test');
    await intel.put('repo_a', 'sha1', facts({ conventions: ['x'] }), 'seeded');
    expect(await intel.getEntry('repo_a', 'sha2')).toBeNull();
  });
});

describe('the store seam', () => {
  it('is injectable, so nothing here touches a real home directory', async () => {
    const store: IntelStore = { read: vi.fn(async () => ({})), write: vi.fn(async () => {}) };
    await new RepoIntel(store, 'https://noriq.test').put('repo_a', 'sha1', facts({ layout: ['x'] }));
    expect(store.write).toHaveBeenCalled();
  });
});
