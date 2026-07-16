import { describe, expect, it } from 'vitest';
import { detectVcs, parseDvRepoList } from '../src/vcs/detect';

// Real `dv repo` output, verbatim from the machine this first ran on — including the header
// lines and the empty "Other:" section the parser must ignore.
const DV_REPO_OUTPUT = `Cloned Locally:
ThirdParty (dv.repo.3c9a67f5-eeb1-4819-8bc2-8048bfae16e9)(/var/home/mtuska/Diversion/ThirdParty)
Prototypes (dv.repo.9b64f374-baab-4819-bb25-dade9edb1ae9)(/var/home/mtuska/Diversion/Prototypes)
A (weird) name (dv.repo.aaaa)(/var/home/mtuska/Diversion/Weird)

Other:
`;

/** Models the Fedora-Atomic symlink measured live: $HOME says /home, dv says /var/home. */
const atomicRealpath = (p: string) => p.replace(/^\/home\//, '/var/home/');

describe('parseDvRepoList', () => {
  it('parses name/(repoId)/(path) lines and ignores the section headers', () => {
    const map = parseDvRepoList(DV_REPO_OUTPUT, (p) => p);
    expect(map.get('/var/home/mtuska/Diversion/ThirdParty')).toBe(
      'dv.repo.3c9a67f5-eeb1-4819-8bc2-8048bfae16e9',
    );
    expect(map.size).toBe(3);
  });

  it('anchors from the right, so parentheses in repo NAMES do not break the parse', () => {
    const map = parseDvRepoList(DV_REPO_OUTPUT, (p) => p);
    expect(map.get('/var/home/mtuska/Diversion/Weird')).toBe('dv.repo.aaaa');
  });
});

describe('detectVcs', () => {
  const deps = (over: { git?: string[]; dv?: string | Error }) => ({
    exists: (p: string) => (over.git ?? []).some((root) => p === `${root}/.git`),
    realpath: atomicRealpath,
    dvRepoList: async () => {
      if (over.dv instanceof Error) throw over.dv;
      return over.dv ?? '';
    },
  });

  it('.git at the root → git, without ever spawning dv', async () => {
    let dvAsked = false;
    const map = await detectVcs(['/repos/app'], {
      exists: (p) => p === '/repos/app/.git',
      realpath: (p) => p,
      dvRepoList: async () => {
        dvAsked = true;
        return '';
      },
    });
    expect(map.get('/repos/app')?.kind).toBe('git');
    // A machine full of git repos must not pay a dv spawn (or a warning) for detection.
    expect(dvAsked).toBe(false);
  });

  it('no .git + dv registry names the exact path → diversion, with the repo id', async () => {
    const map = await detectVcs(['/home/mtuska/Diversion/ThirdParty'], deps({ dv: DV_REPO_OUTPUT }));
    expect(map.get('/home/mtuska/Diversion/ThirdParty')).toMatchObject({
      kind: 'diversion',
      repoId: 'dv.repo.3c9a67f5-eeb1-4819-8bc2-8048bfae16e9',
    });
  });

  it('survives the /home → /var/home symlink: $HOME path, /var/home registry — measured live', async () => {
    // Without realpath on both sides, the operator's own repos are denied. This exact split
    // exists on the first machine this ran on (Fedora Atomic), and the same symlink already
    // broke the v0.2.0 CLI entry guard once.
    const map = await detectVcs(['/home/mtuska/Diversion/Prototypes'], deps({ dv: DV_REPO_OUTPUT }));
    expect(map.get('/home/mtuska/Diversion/Prototypes')?.kind).toBe('diversion');
  });

  it('.git wins INSIDE a Diversion workspace — the deliberate precedence, and it says why', async () => {
    // Diversion imports FROM git, so a git checkout in a workspace is plausible. Precedence
    // must be a decision with a reason in the log, not an iteration-order accident.
    const map = await detectVcs(
      ['/home/mtuska/Diversion/ThirdParty'],
      deps({ git: ['/home/mtuska/Diversion/ThirdParty'], dv: DV_REPO_OUTPUT }),
    );
    expect(map.get('/home/mtuska/Diversion/ThirdParty')).toMatchObject({
      kind: 'git',
      reason: expect.stringContaining('.git'),
    });
  });

  it('a sibling with a shared prefix is NOT claimed — exact paths only', async () => {
    const map = await detectVcs(['/home/mtuska/Diversion/ThirdParty2'], deps({ dv: DV_REPO_OUTPUT }));
    expect(map.get('/home/mtuska/Diversion/ThirdParty2')?.kind).toBe('git');
  });

  it('dv missing or its agent dead → git fallback, and the reason says the registry was unreachable', async () => {
    const map = await detectVcs(['/anywhere'], deps({ dv: new Error('spawn dv ENOENT') }));
    expect(map.get('/anywhere')).toMatchObject({
      kind: 'git',
      reason: expect.stringContaining('unreachable'),
    });
  });

  it('asks dv once for many roots, not once per root', async () => {
    let spawns = 0;
    await detectVcs(['/a', '/b', '/c'], {
      exists: () => false,
      realpath: (p) => p,
      dvRepoList: async () => {
        spawns += 1;
        return DV_REPO_OUTPUT;
      },
    });
    expect(spawns).toBe(1);
  });
});
