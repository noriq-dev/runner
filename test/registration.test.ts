import { describe, expect, it } from 'vitest';
import type { DiscoveredRepo } from '../src/discovery';
import { buildRegistration } from '../src/registration';

const repos: DiscoveredRepo[] = [
  {
    id: 'repo_a',
    root: '/x/a',
    projectKey: 'AAA',
    name: 'a',
    defaultBranch: 'main',
    // The board lock (RUN-71) travels from the marker to the wire — the server resolves
    // the NAME, the daemon never sees a board id.
    manifest: { key: 'AAA', board: 'Runner' } as never,
  },
  {
    id: 'repo_b',
    root: '/x/b',
    projectKey: 'BBB',
    name: 'b',
    defaultBranch: null,
    manifest: { key: 'BBB', board: null } as never,
  },
];

describe('buildRegistration', () => {
  it('maps discovered repos to the wire payload with default kinds', () => {
    const reg = buildRegistration({ label: 'laptop', concurrency: 2, tools: ['claude'] }, repos);
    expect(reg.label).toBe('laptop');
    expect(reg.maxConcurrency).toBe(2);
    expect(reg.tools).toEqual(['claude']);
    expect(reg.kinds).toEqual(['scope', 'build', 'verify']);
    // A repo with no custom definitions still advertises the three built-ins (RUN-195): the
    // list the server shows is exactly the list a dispatch can resolve, and every repo
    // resolves scope/build/verify.
    const builtins = [
      { name: 'build', base: 'build' },
      { name: 'scope', base: 'scope' },
      { name: 'verify', base: 'verify' },
    ];
    expect(reg.repos).toEqual([
      {
        id: 'repo_a',
        projectKey: 'AAA',
        board: 'Runner',
        name: 'a',
        defaultBranch: 'main',
        workflows: builtins,
      },
      { id: 'repo_b', projectKey: 'BBB', board: null, name: 'b', defaultBranch: null, workflows: builtins },
    ]);
    expect('runnerId' in reg).toBe(false); // omitted on first registration
  });

  it('includes runnerId on re-registration and honors explicit kinds', () => {
    const reg = buildRegistration(
      { label: 'l', concurrency: 1, tools: [], kinds: ['build'], runnerId: 'rnr_1' },
      [],
    );
    expect(reg.runnerId).toBe('rnr_1');
    expect(reg.kinds).toEqual(['build']);
    expect(reg.repos).toEqual([]);
  });

  it('advertises manifest workflows as {name, base, description?} beside the built-ins (RUN-195)', () => {
    const withWorkflows: DiscoveredRepo[] = [
      {
        id: 'repo_w',
        root: '/x/w',
        projectKey: 'WWW',
        name: 'w',
        defaultBranch: 'main',
        manifest: {
          key: 'WWW',
          board: null,
          workflows: {
            docs: { base: 'scope', prompt: 'survey it', stages: null, description: 'survey the repo' },
            hotfix: { base: 'build', prompt: null, stages: null, description: null },
          },
        } as never,
      },
    ];
    const reg = buildRegistration({ label: 'l', concurrency: 1, tools: ['claude'] }, withWorkflows);
    // The base rides the wire as advertise-only metadata now (PLNR-240) — the daemon still
    // resolves a selected name to its posture locally (effectiveKind, RUN-126). A declared
    // description is preserved; an absent one is OMITTED, not sent null.
    expect(reg.repos[0]?.workflows).toEqual([
      { name: 'build', base: 'build' },
      { name: 'docs', base: 'scope', description: 'survey the repo' },
      { name: 'hotfix', base: 'build' },
      { name: 'scope', base: 'scope' },
      { name: 'verify', base: 'verify' },
    ]);
  });

  it('advertises the merged catalog exactly once per name, shadowing included, without prompt bytes', () => {
    const catalogs = new Map([
      [
        '/x/a',
        {
          definitions: {
            local: {
              base: 'build' as const,
              prompt: 'secret machine-local text',
              promptSource: '/home/me/.noriq/workflows/local.toml',
              description: 'machine-local build variant',
              source: '/home/me/.noriq/workflows/local.toml',
              tier: 'user-file' as const,
            },
            docs: {
              base: 'scope' as const,
              prompt: 'project text',
              promptSource: '/x/a/.noriq/workflows/docs.toml',
              description: null,
              source: '/x/a/.noriq/workflows/docs.toml',
              tier: 'project-file' as const,
            },
            // Shadows the bundled name (resolveWorkflow gives the loaded definition precedence),
            // so the advertised entry must carry the WINNING metadata — and only once.
            build: {
              base: 'scope' as const,
              prompt: null,
              promptSource: null,
              description: 'read-only build drill',
              source: '/x/a/.noriq/workflows/build.toml',
              tier: 'project-file' as const,
            },
          },
        },
      ],
    ]);
    const reg = buildRegistration({ label: 'l', concurrency: 1, tools: [] }, repos, catalogs);
    expect(reg.repos[0]?.workflows).toEqual([
      { name: 'build', base: 'scope', description: 'read-only build drill' },
      { name: 'docs', base: 'scope' },
      { name: 'local', base: 'build', description: 'machine-local build variant' },
      { name: 'scope', base: 'scope' },
      { name: 'verify', base: 'verify' },
    ]);
    // Prompt text and local source identity are daemon-local — none of it may cross the wire.
    const serialized = JSON.stringify(reg.repos[0]);
    expect(serialized).not.toContain('secret machine-local text');
    expect(serialized).not.toContain('project text');
    expect(serialized).not.toContain('.noriq/workflows');
    expect(serialized).not.toContain('/home/me');
    expect(serialized).not.toContain('tier');
    expect(serialized).not.toContain('promptSource');
    // A repo without a loaded catalog for its root still advertises the built-ins.
    expect(reg.repos[1]?.workflows).toEqual([
      { name: 'build', base: 'build' },
      { name: 'scope', base: 'scope' },
      { name: 'verify', base: 'verify' },
    ]);
  });

  it('advertises the coordinate catalog per installed tool (RUN-115)', () => {
    const reg = buildRegistration({ label: 'l', concurrency: 1, tools: ['claude', 'codex'] }, []);
    const claude = reg.agents.find((a) => a.tool === 'claude');
    const codex = reg.agents.find((a) => a.tool === 'codex');
    expect(claude?.models).toContain('claude-opus-4-8');
    expect(claude?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // codex advertises no effort above its own high — it cannot distinguish xhigh/max
    expect(codex?.efforts).toEqual(['low', 'medium', 'high']);
    // a runner with no tools advertises no agents
    expect(buildRegistration({ label: 'l', concurrency: 1, tools: [] }, []).agents).toEqual([]);
  });
});

describe('version reporting (RUN-36)', () => {
  it('registration carries the release version, from package.json', async () => {
    // Not a hand-typed literal. src/version.ts used to hardcode it under a "bump in lockstep"
    // comment while the build injected nothing, so a published bundle could report a version
    // the package wasn't. A version that can lie is worse than none: RUN-37 compares against
    // it, and the server uses it to decide whether a runner is too old to trust.
    const { VERSION } = await import('../src/version');
    const pkg = JSON.parse(
      await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);

    const reg = buildRegistration({ label: 'l', concurrency: 1, tools: ['claude'] }, []);
    expect(reg.version).toBe(pkg.version);
  });
});
