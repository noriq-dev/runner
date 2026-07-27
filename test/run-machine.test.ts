import { describe, expect, it } from 'vitest';
import {
  RUN_STAGES,
  type StageName,
  clampStagesToWorkflow,
  declaredTerminals,
  stage,
  stagesFor,
} from '../src/run-machine';
import { BUILTIN_WORKFLOWS, type Workflow } from '../src/workflow';

// RUN-131. The pipeline used to exist only as control flow across two ~400-line methods, so the
// ORDER of the stages and which of them a workflow ran could only be learned by reading both in
// full — and nothing could assert over either. These are the assertions that were impossible.

const names = (list: readonly { name: string }[]) => list.map((s) => s.name);
const wf = (name: keyof typeof BUILTIN_WORKFLOWS) => BUILTIN_WORKFLOWS[name];

describe('the run pipeline is an ordered, declared sequence', () => {
  it('runs in the one order the daemon depends on', () => {
    expect(names(RUN_STAGES)).toEqual([
      'prepare',
      'plan',
      'pattern-map',
      'execute',
      'verify',
      'review',
      'integrate',
      'settle',
    ]);
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
      'plan',
      'pattern-map',
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
  // `plan` and `review` run a fresh READ-ONLY actor — the planner writes a spec, not code — and the
  // write clamp, not this list, is what enforces that.
  it('names every stage that spawns a fresh read-only actor', () => {
    expect(RUN_STAGES.filter((s) => s.actor === 'verify').map((s) => s.name)).toEqual([
      'plan',
      'pattern-map',
      'review',
    ]);
  });

  it('names the stages that can spend the run budget, and the ones that provably cannot', () => {
    expect(RUN_STAGES.filter((s) => s.budget === 'run').map((s) => s.name)).toEqual([
      'plan',
      'pattern-map',
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

// RUN-132. Which stages a run executes was `appliesTo` and nothing else — a fact the machine
// computed, that no workflow could shape. A workflow declares its list now, and the interesting
// property is the ASYMMETRY: a declaration narrows and never widens, and it never reorders.
describe('a workflow declares its stages, and the machine floors the declaration', () => {
  const withStages = (base: Workflow, names: StageName[]): Workflow => ({
    ...base,
    stages: names.map((name) => ({ name, role: 'none' as const, agent: null })),
  });

  // Spelled out rather than compared against `w.stages` — comparing the declaration to itself
  // would pass no matter what either side said. These are the lists RUN-131's `appliesTo` filter
  // produced, written down, which is what makes RUN-132 a no-op on today's behaviour.
  it('the built-ins run exactly what appliesTo used to compute', () => {
    expect(names(stagesFor(wf('scope')))).toEqual(['prepare', 'execute', 'verify', 'settle']);
    expect(names(stagesFor(wf('verify')))).toEqual(['prepare', 'execute', 'verify', 'settle']);
    expect(names(stagesFor(wf('build')))).toEqual([
      'prepare',
      'plan',
      'pattern-map',
      'execute',
      'verify',
      'review',
      'integrate',
      'settle',
    ]);
    // …and each one's own declaration agrees with what it runs, so neither can drift alone.
    for (const w of Object.values(BUILTIN_WORKFLOWS)) {
      expect(names(stagesFor(w))).toEqual(w.stages.map((s) => s.name));
    }
  });

  // The declaration surface is "which OPTIONAL stages" — the four the run's correctness rests on
  // run whether or not a workflow names them. Without this the comment saying settle is
  // non-optional would be the only thing enforcing it.
  it('a workflow cannot decline a mandatory stage by omitting it', () => {
    // Declares ONLY `review`. The four mandatory stages come back anyway; `integrate` — the other
    // optional one — is the only thing the omission actually dropped.
    const stripped = withStages(wf('build'), ['review']);
    expect(names(stagesFor(stripped))).toEqual(['prepare', 'execute', 'verify', 'review', 'settle']);
  });

  it('declaring NOTHING still runs the spine — an empty list is not an empty run', () => {
    const empty = withStages(wf('build'), []);
    expect(names(stagesFor(empty))).toEqual(['prepare', 'execute', 'verify', 'settle']);
    // settle above all: it is where the outcome becomes durable and the locks release.
    expect(names(stagesFor(empty))).toContain('settle');
  });

  it('marks exactly the stages a workflow may decline', () => {
    expect(RUN_STAGES.filter((s) => s.optional).map((s) => s.name)).toEqual([
      'plan',
      'pattern-map',
      'review',
      'integrate',
    ]);
  });

  it('a workflow can DROP an optional stage — review is the declinable one', () => {
    const noReview = withStages(wf('build'), ['prepare', 'execute', 'verify', 'integrate', 'settle']);
    expect(names(stagesFor(noReview))).toEqual(['prepare', 'execute', 'verify', 'integrate', 'settle']);
  });

  // The half that must never work: a posture that produces nothing cannot declare its way into
  // landing a diff. `appliesTo` is the floor, and a declaration is intersected with it.
  it('a non-producing workflow CANNOT declare its way into review or integrate', () => {
    const greedy = withStages(wf('scope'), [
      'prepare',
      'plan',
      'pattern-map',
      'execute',
      'verify',
      'review',
      'integrate',
      'settle',
    ]);
    expect(names(stagesFor(greedy))).toEqual(['prepare', 'execute', 'verify', 'settle']);
  });

  // Landing before judging is landing unreviewed. A workflow names WHICH stages, never in what
  // sequence — the order comes from RUN_STAGES on the way out.
  it('a declaration cannot reorder the pipeline, only choose from it', () => {
    const inverted = withStages(wf('build'), [
      'settle',
      'integrate',
      'review',
      'verify',
      'execute',
      'pattern-map',
      'plan',
      'prepare',
    ]);
    expect(names(stagesFor(inverted))).toEqual(names(stagesFor(wf('build'))));
  });

  it('an unknown stage name is dropped rather than trusted', () => {
    const bogus = {
      ...wf('build'),
      stages: [{ name: 'publish' as never, role: 'run' as const, agent: null }],
    };
    expect(clampStagesToWorkflow(bogus.stages, bogus)).toEqual([]);
  });
});

describe('clampStagesToWorkflow: the machine owns the actor, the declaration owns the choice', () => {
  it('drops a stage this posture may not run', () => {
    const declared = [
      { name: 'verify' as const, role: 'none' as const, agent: null },
      { name: 'integrate' as const, role: 'run' as const, agent: null },
    ];
    expect(clampStagesToWorkflow(declared, wf('scope')).map((s) => s.name)).toEqual(['verify']);
    expect(clampStagesToWorkflow(declared, wf('build')).map((s) => s.name)).toEqual(['verify', 'integrate']);
  });

  // `role` grants nothing on its own — the posture that reaches a spawn is the permission clamp's,
  // floored again inside startAgent (RUN-158). It is overwritten anyway, and in BOTH directions.
  it('overwrites a role WIDER than the machine’s own actor', () => {
    const declared = [{ name: 'review' as const, role: 'run' as const, agent: null }];
    expect(clampStagesToWorkflow(declared, wf('build'))[0]?.role).toBe('verify'); // not 'run'
  });

  it('overwrites an UNDERSTATED one too — the stage spawns what the machine says regardless', () => {
    // `review: none` would read as "this workflow spawns no judge" while the stage goes on spawning
    // the verify actor. A descriptor lying in the safe direction is still a descriptor lying, and it
    // is how a reader learns the wrong invariant.
    const declared = [{ name: 'review' as const, role: 'none' as const, agent: null }];
    expect(clampStagesToWorkflow(declared, wf('build'))[0]?.role).toBe('verify');
  });

  it('carries the declared coordinate through untouched — it picks a model, not a posture', () => {
    const declared = [{ name: 'review' as const, role: 'run' as const, agent: 'codex.gpt-5_6-sol.high' }];
    expect(clampStagesToWorkflow(declared, wf('build'))[0]).toEqual({
      name: 'review',
      role: 'verify', // the machine's, whatever was declared
      agent: 'codex.gpt-5_6-sol.high', // untouched
    });
  });

  it('is the identity on every built-in — they already say what the machine says', () => {
    for (const w of Object.values(BUILTIN_WORKFLOWS)) {
      expect(clampStagesToWorkflow(w.stages, w)).toEqual(w.stages);
    }
  });
});
