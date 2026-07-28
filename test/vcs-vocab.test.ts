import { describe, expect, it } from 'vitest';
import { VCS_VOCAB, vocabFor } from '../src/vcs/vocab';

describe('VcsVocab — the setup lexicon per backend (RUN-84)', () => {
  it('every kind names itself, so a lookup can never silently return the wrong entry', () => {
    for (const [key, vocab] of Object.entries(VCS_VOCAB)) {
      expect(vocab.kind).toBe(key);
    }
  });

  it('git speaks git: rebase, a pushable remote, and a git commit', () => {
    const g = VCS_VOCAB.git;
    expect(g.integratedAdj).toBe('rebased');
    expect(g.conflictAdj).toBe('rebase');
    expect(g.agentResolvesConflicts).toBe(true);
    expect(g.landingReachesRemote).toBe(true);
    expect(g.auditHint).toBe('git log origin/main..main');
    expect(g.commitMarker('.noriq/project.toml')).toBe(
      'git add .noriq/project.toml && git commit -m "Add Noriq marker"',
    );
  });

  it('Diversion has no rebase, no separate push, and no agent-side conflict resolution', () => {
    const d = VCS_VOCAB.diversion;
    expect(d.integratedAdj).toBe('merged');
    // Conflicts live server-side (a resolveUrl, not editable paths) — the wizard must not offer
    // the build agent a job the backend cannot run.
    expect(d.agentResolvesConflicts).toBe(false);
    // publish already reached the server; share no-ops — there is no local landing to push.
    expect(d.landingReachesRemote).toBe(false);
    expect(d.auditHint).toBeUndefined();
    expect(d.commitMarker('.noriq/project.toml')).toBe('dv commit -a -m "Add Noriq marker"');
  });

  it('Perforce lands to a stream, resolves headless, and submits — but never pushes a remote', () => {
    const p = VCS_VOCAB.perforce;
    expect(p.targetNoun).toBe('stream');
    expect(p.integratedAdj).toBe('merged');
    expect(p.agentResolvesConflicts).toBe(true); // p4 resolve runs headless
    expect(p.landingReachesRemote).toBe(false); // submit already reached the depot
    expect(p.commitMarker('.noriq/project.toml')).toBe(
      'p4 add .noriq/project.toml && p4 submit -d "Add Noriq marker"',
    );
  });

  it('an undetected repo falls back to git — the pre-RUN-84 behaviour, unchanged', () => {
    expect(vocabFor(undefined)).toBe(VCS_VOCAB.git);
    expect(vocabFor('diversion')).toBe(VCS_VOCAB.diversion);
  });
});
