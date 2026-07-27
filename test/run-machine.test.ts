import { describe, expect, it } from 'vitest';
import { RUN_STAGES, declaredTerminals, stage, stagesFor } from '../src/run-machine';
import { BUILTIN_WORKFLOWS } from '../src/workflow';

// RUN-131. The pipeline used to exist only as control flow across two ~400-line methods, so the
// ORDER of the stages and which of them a workflow ran could only be learned by reading both in
// full — and nothing could assert over either. These are the assertions that were impossible.

const names = (list: readonly { name: string }[]) => list.map((s) => s.name);
const wf = (name: keyof typeof BUILTIN_WORKFLOWS) => BUILTIN_WORKFLOWS[name];

describe('the run pipeline is an ordered, declared sequence', () => {
  it('runs in the one order the daemon depends on', () => {
    expect(names(RUN_STAGES)).toEqual(['prepare', 'execute', 'verify', 'review', 'integrate', 'settle']);
  });

  // Each of these orderings is a decision with a reason, not an accident of how the code grew.
  it('verifies before it reviews — the zero-token check screens what is worth an agent', () => {
    expect(names(RUN_STAGES).indexOf('verify')).toBeLessThan(names(RUN_STAGES).indexOf('review'));
  });

  it('reviews before it integrates — a rebase changes what BUILDS, never what the diff MEANS', () => {
    expect(names(RUN_STAGES).indexOf('review')).toBeLessThan(names(RUN_STAGES).indexOf('integrate'));
  });

  it('settles last, and settles always', () => {
    expect(RUN_STAGES.at(-1)?.name).toBe('settle');
    for (const w of Object.values(BUILTIN_WORKFLOWS)) {
      expect(names(stagesFor(w))).toContain('settle');
    }
  });

  it('declares every stage exactly once', () => {
    expect(new Set(names(RUN_STAGES)).size).toBe(RUN_STAGES.length);
  });
});

describe('which stages a workflow runs', () => {
  it('a build runs the whole pipeline', () => {
    expect(names(stagesFor(wf('build')))).toEqual([
      'prepare',
      'execute',
      'verify',
      'review',
      'integrate',
      'settle',
    ]);
  });

  // Neither produces a diff, so there is nothing to review and nothing to land. Previously this
  // was two `wf.produces` tests buried 200 lines apart.
  it('a scope run has nothing to review and nothing to land', () => {
    expect(names(stagesFor(wf('scope')))).toEqual(['prepare', 'execute', 'verify', 'settle']);
  });

  it('a verify run IS the reviewer — it does not spawn another one', () => {
    expect(names(stagesFor(wf('verify')))).toEqual(['prepare', 'execute', 'verify', 'settle']);
  });

  it('keys off workflow FLAGS, never a kind comparison (RUN-116/117)', () => {
    // A custom workflow (RUN-119) inherits a base's posture verbatim, so a build-based one runs a
    // build's stages no matter what it is called.
    const custom = { ...wf('build'), name: 'refactor' };
    expect(names(stagesFor(custom))).toEqual(names(stagesFor(wf('build'))));
  });
});

describe('what each stage declares', () => {
  it('names a purpose, its inputs and its outputs', () => {
    for (const s of RUN_STAGES) {
      expect(s.purpose.length).toBeGreaterThan(10);
      expect(s.inputs.length + s.outputs.length).toBeGreaterThan(0);
    }
  });

  // The floor that must never move: a stage is a role and a budget, never a permission escalation.
  // Only `review` runs a judging actor, and the write clamp — not this list — is what enforces it.
  it('only the review stage spawns a fresh judging actor', () => {
    expect(RUN_STAGES.filter((s) => s.actor === 'verify').map((s) => s.name)).toEqual(['review']);
  });

  it('names the stages that can spend the run budget, and the ones that provably cannot', () => {
    expect(RUN_STAGES.filter((s) => s.budget === 'run').map((s) => s.name)).toEqual([
      'execute',
      'review',
      'integrate',
    ]);
    // The deterministic floor is a COMMAND — zero tokens is the whole reason it runs first.
    expect(stage('verify').budget).toBe('none');
    expect(stage('settle').budget).toBe('none');
  });

  it('only the two stages with a hand-back loop declare a retry, and name what bounds it', () => {
    const retrying = RUN_STAGES.filter((s) => s.retry.kind !== 'none');
    expect(names(retrying)).toEqual(['verify', 'review']);
    for (const s of retrying) expect(s.retry).toHaveProperty('boundedBy');
  });

  // The complete set of ways a run can fail — a fact that previously existed nowhere, because each
  // reason was assigned at the point it happened and never collected.
  it('collects every terminal reason the pipeline can produce', () => {
    expect(declaredTerminals()).toEqual(
      expect.arrayContaining([
        'no_changes',
        'lock',
        'lock:unchecked',
        'verify',
        'verify_agent',
        'review',
        'review:no-verdict',
        'land:conflict',
        'land:verify',
        'land:error',
      ]),
    );
  });

  // Settling carries exactly ONE gate, and it is there for a reason rather than by accident: a
  // verify run's own output IS its verdict, and that output is only final once the session that
  // wrote it is closed — which is the first thing settling does.
  it('settling gates on nothing but the verify actor grading its own closed session', () => {
    expect(stage('settle').terminal).toEqual(['verify_agent']);
    expect(stage('verify').terminal).not.toContain('verify_agent');
  });

  it('stage() refuses a name that is not in the sequence', () => {
    expect(() => stage('publish' as never)).toThrow(/no such run stage/);
  });
});
