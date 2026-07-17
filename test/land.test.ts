import { describe, expect, it } from 'vitest';
import { assembleConflictPrompt, parseResolution } from '../src/land';

describe('assembleConflictPrompt', () => {
  const base = { conflicts: ['src/a.ts', 'src/b.ts'], landBranch: 'noriq/integration' };

  it('names the target, the files, and the RESOLVED protocol', () => {
    const p = assembleConflictPrompt({ ...base, task: { key: 'RUN-9', title: 'do a thing', body: null } });
    expect(p).toContain('noriq/integration');
    expect(p).toContain('src/a.ts');
    expect(p).toContain('src/b.ts');
    expect(p).toContain('RUN-9 — do a thing');
    expect(p).toContain('RESOLVED: YES');
    expect(p).toContain('RESOLVED: NO');
    // The universal diff3 conflict markers ARE backend-neutral — keep them.
    expect(p).toContain('<<<<<<<');
  });

  it('is VCS-neutral: no git verb an agent could take literally on a non-git backend', () => {
    const p = assembleConflictPrompt(base);
    // "rebase" and "git rebase --continue" were git-only; the integration outcome is the
    // contract across git/Perforce/Diversion, not the verb (see vcs/types.ts).
    expect(p).not.toMatch(/rebase/i);
    expect(p).not.toMatch(/git /);
    expect(p).not.toMatch(/worktree/i);
    expect(p).toMatch(/integration is IN PROGRESS/);
  });

  it('appends the verify command only when the repo configures one', () => {
    expect(assembleConflictPrompt({ ...base, verifyCmd: 'npm run check' })).toContain('npm run check');
    expect(assembleConflictPrompt(base)).not.toMatch(/When the files are resolved, run/);
  });
});

describe('parseResolution', () => {
  it('reads the final RESOLVED line; absent/ambiguous ⇒ NO (fail-closed)', () => {
    expect(parseResolution('done\nRESOLVED: YES')).toBe(true);
    expect(parseResolution('RESOLVED: NO')).toBe(false);
    expect(parseResolution('RESOLVED: YES\nwait, actually\nRESOLVED: NO')).toBe(false); // last wins
    expect(parseResolution('I think it is fine')).toBe(false); // no verdict ⇒ NO
  });
});
