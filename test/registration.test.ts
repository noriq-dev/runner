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
    manifest: { key: 'AAA' } as never,
  },
  {
    id: 'repo_b',
    root: '/x/b',
    projectKey: 'BBB',
    name: 'b',
    defaultBranch: null,
    manifest: { key: 'BBB' } as never,
  },
];

describe('buildRegistration', () => {
  it('maps discovered repos to the wire payload with default kinds', () => {
    const reg = buildRegistration({ label: 'laptop', concurrency: 2, tools: ['claude'] }, repos);
    expect(reg.label).toBe('laptop');
    expect(reg.maxConcurrency).toBe(2);
    expect(reg.tools).toEqual(['claude']);
    expect(reg.kinds).toEqual(['scope', 'build', 'verify']);
    expect(reg.repos).toEqual([
      { id: 'repo_a', projectKey: 'AAA', name: 'a', defaultBranch: 'main' },
      { id: 'repo_b', projectKey: 'BBB', name: 'b', defaultBranch: null },
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
});
