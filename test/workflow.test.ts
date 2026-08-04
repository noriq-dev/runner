import type { PermissionProfile } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { stagesFor } from '../src/run-machine';
import {
  BUILTIN_WORKFLOWS,
  type Workflow,
  clampPermissionToWorkflow,
  resolveWorkflow,
  runWorkflow,
  stageOf,
  workflowFor,
} from '../src/workflow';

const profile = (over: Partial<PermissionProfile> = {}): PermissionProfile => ({
  write: false,
  allow: [],
  deny: [],
  auto: false,
  ...over,
});

describe('built-in workflows (RUN-116)', () => {
  it('scope: read-only exploration that produces a plan, no gates', () => {
    expect(workflowFor('scope')).toEqual<Workflow>({
      id: 'scope',
      promptShape: 'scope',
      worktreeWritable: false,
      produces: false,
      verifyActor: false,
      usesPlanBase: false,
      // RUN-132: the same pipeline `appliesTo` computed, now declared. Nothing to review and
      // nothing to land — a scope run produces a plan, not a diff.
      stages: [
        { name: 'prepare', role: 'none', agent: null },
        { name: 'execute', role: 'run', agent: null },
        { name: 'verify', role: 'none', agent: null },
        { name: 'settle', role: 'none', agent: null },
      ],
    });
  });

  it('build: the only workflow that writes a writable tree and produces landable edits', () => {
    const b = workflowFor('build');
    expect(b.produces).toBe(true);
    expect(b.worktreeWritable).toBe(true);
    expect(b.verifyActor).toBe(false);
    expect(b.usesPlanBase).toBe(true);
  });

  it('verify: a writable tree (runs the suite) but never edits, and judges rather than produces', () => {
    const v = workflowFor('verify');
    expect(v.verifyActor).toBe(true);
    expect(v.produces).toBe(false); // judges, does not land
    expect(v.worktreeWritable).toBe(true); // needs to run the suite
    expect(v.usesPlanBase).toBe(true);
  });

  it('exactly one workflow produces, exactly one is a verify actor (the kinds are disjoint)', () => {
    const all = Object.values(BUILTIN_WORKFLOWS);
    expect(all.filter((w) => w.produces)).toHaveLength(1);
    expect(all.filter((w) => w.verifyActor)).toHaveLength(1);
    // only scope is worktree-read-only
    expect(all.filter((w) => !w.worktreeWritable).map((w) => w.id)).toEqual(['scope']);
  });
});

describe('resolveWorkflow — repo-defined workflows (RUN-119)', () => {
  const M = (workflows: Record<string, { base: 'scope' | 'build' | 'verify'; prompt: string | null }>) =>
    ({ workflows }) as Parameters<typeof resolveWorkflow>[1];

  it('resolves a built-in kind id to its built-in workflow', () => {
    expect(resolveWorkflow('build', M({}))).toEqual(BUILTIN_WORKFLOWS.build);
  });

  it('a custom workflow inherits its base posture, keeps its own id + prompt', () => {
    const wf = resolveWorkflow('docs', M({ docs: { base: 'scope', prompt: 'explain-the-area' } }));
    expect(wf).toMatchObject({
      id: 'docs',
      promptShape: 'scope', // inherited from base
      worktreeWritable: false, // read-only, because scope is
      produces: false,
      promptRef: 'explain-the-area',
    });
  });

  it('a project definition wins over the bundled name but still inherits its declared base', () => {
    const wf = resolveWorkflow('build', M({ build: { base: 'scope', prompt: null } }));
    expect(wf).toMatchObject({ id: 'build', promptShape: 'scope', produces: false });
  });

  it('returns undefined for an id that names neither a kind nor a defined workflow', () => {
    expect(resolveWorkflow('nope', M({}))).toBeUndefined();
  });

  it('a custom build-based workflow keeps the producing posture (write floor unaffected)', () => {
    const wf = resolveWorkflow('hotfix', M({ hotfix: { base: 'build', prompt: null } }));
    expect(wf?.produces).toBe(true);
    expect(clampPermissionToWorkflow({ write: true } as never, wf as Workflow).write).toBe(true);
  });
});

describe('clampPermissionToWorkflow — the workflow-independent write floor (RUN-118)', () => {
  it('a producing workflow (build) keeps its declared profile verbatim', () => {
    const p = profile({ write: true, allow: ['Bash(npm test:*)'] });
    expect(clampPermissionToWorkflow(p, workflowFor('build'))).toBe(p);
  });

  it('forces write OFF for a non-producing workflow, even when the manifest granted it', () => {
    // A hostile/misconfigured [permissions.verify].write = true cannot make a verify run editable —
    // authorship separation is not a manifest's to opt out of.
    const granted = profile({ write: true });
    expect(clampPermissionToWorkflow(granted, workflowFor('verify')).write).toBe(false);
    expect(clampPermissionToWorkflow(granted, workflowFor('scope')).write).toBe(false);
  });

  it('leaves an already read-only profile untouched (no needless copy)', () => {
    const p = profile({ write: false });
    expect(clampPermissionToWorkflow(p, workflowFor('verify'))).toBe(p);
  });

  it('clamps ONLY write — deny/allow/auto pass through', () => {
    const p = profile({ write: true, deny: ['Bash'], auto: true });
    const clamped = clampPermissionToWorkflow(p, workflowFor('scope'));
    expect(clamped).toEqual({ ...p, write: false });
  });
});

// RUN-132. A workflow now carries its own stage list. What a repo may do with it is bounded twice:
// `resolveWorkflow` clamps on the way in, and `stagesFor` intersects with `appliesTo` on the way
// out — so the surface these tests describe is safe before the TOML field that will feed it exists.
describe('a workflow carries its pipeline (RUN-132)', () => {
  const M = (workflows: Record<string, { base: 'scope' | 'build' | 'verify'; prompt: string | null }>) =>
    ({ workflows }) as Parameters<typeof resolveWorkflow>[1];

  it('every built-in declares the spine, and omitting it changes nothing', () => {
    for (const w of Object.values(BUILTIN_WORKFLOWS)) {
      const declared = w.stages.map((s) => s.name);
      // Without prepare there is no workspace or identity; without execute there is no agent;
      // verify holds the checkpoint, the lock floor and the landing decision; without settle the
      // outcome never becomes durable and the run's locks never release.
      expect(declared).toEqual(expect.arrayContaining(['prepare', 'execute', 'verify', 'settle']));
      // And it is a floor rather than a habit: strip the declaration to nothing and the spine still
      // runs. `stagesFor` unions the mandatory stages back in — see run-machine.test.ts.
      const stripped = { ...w, stages: [] };
      expect(stagesFor(stripped).map((s) => s.name)).toEqual(
        expect.arrayContaining(['prepare', 'execute', 'verify', 'settle']),
      );
    }
  });

  it('only build declares the two stages that judge and land', () => {
    const declaring = (name: string) =>
      Object.values(BUILTIN_WORKFLOWS)
        .filter((w) => w.stages.some((s) => s.name === name))
        .map((w) => w.id);
    expect(declaring('review')).toEqual(['build']);
    expect(declaring('integrate')).toEqual(['build']);
  });

  it('no built-in names a coordinate — every stage inherits, which is why nothing moved', () => {
    for (const w of Object.values(BUILTIN_WORKFLOWS)) {
      expect(w.stages.every((s) => s.agent === null)).toBe(true);
    }
  });

  // Today `WorkflowDef` is `base` + `prompt`, so a custom workflow's list IS its base's. The
  // clamp still runs over it, which is what makes wiring the manifest field a one-line change.
  it('a custom workflow inherits its base pipeline verbatim', () => {
    const wf = resolveWorkflow('docs', M({ docs: { base: 'scope', prompt: null } }));
    expect(wf?.stages).toEqual(BUILTIN_WORKFLOWS.scope.stages);
    const hotfix = resolveWorkflow('hotfix', M({ hotfix: { base: 'build', prompt: null } }));
    expect(hotfix?.stages).toEqual(BUILTIN_WORKFLOWS.build.stages);
  });

  it('stageOf answers what a workflow declared, and nothing for a stage it does not run', () => {
    expect(stageOf(workflowFor('build'), 'review')).toEqual({
      name: 'review',
      role: 'verify',
      agent: null,
    });
    expect(stageOf(workflowFor('scope'), 'review')).toBeUndefined();
    expect(stageOf(workflowFor('scope'), 'integrate')).toBeUndefined();
  });
});

describe('runWorkflow — the workflow a run actually executes (RUN-132)', () => {
  const M = (workflows: Record<string, { base: 'scope' | 'build' | 'verify'; prompt: string | null }>) =>
    ({ workflows }) as Parameters<typeof resolveWorkflow>[1];
  const run = (kind: 'scope' | 'build' | 'verify', workflow: string | null = null) =>
    ({ kind, workflow }) as Parameters<typeof runWorkflow>[0];

  it('a legacy dispatch with no workflow gets its kind’s built-in', () => {
    expect(runWorkflow(run('build'), M({}))).toEqual(BUILTIN_WORKFLOWS.build);
  });

  it('a named workflow wins, carrying its own id and pipeline', () => {
    const wf = runWorkflow(run('scope', 'docs'), M({ docs: { base: 'scope', prompt: 'x' } }));
    expect(wf.id).toBe('docs');
    expect(wf.promptRef).toBe('x');
    expect(wf.stages).toEqual(BUILTIN_WORKFLOWS.scope.stages);
    expect(stagesFor(wf).map((s) => s.name)).toEqual(stagesFor(BUILTIN_WORKFLOWS.scope).map((s) => s.name));
  });

  // A prototype name is a real dispatch value, and `'toString' in BUILTIN_WORKFLOWS` is TRUE — so a
  // membership test written with `in` hands back `Object.prototype.toString` cast to a Workflow.
  // Everything downstream then reads `wf.stages` off a function and throws.
  it('a prototype property name is not a workflow', () => {
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(resolveWorkflow(name, M({}))).toBeUndefined();
      expect(runWorkflow(run('build', name), M({}))).toEqual(BUILTIN_WORKFLOWS.build);
    }
  });

  it('a custom workflow naming a prototype property as its BASE is refused', () => {
    const hostile = { evil: { base: 'toString' as never, prompt: null } };
    expect(resolveWorkflow('evil', M(hostile))).toBeUndefined();
    expect(runWorkflow(run('scope', 'evil'), M(hostile))).toEqual(BUILTIN_WORKFLOWS.scope);
  });

  // Unreachable for a wire-validated dispatch, but the DIRECTION is the point: an unrecognised kind
  // answers with the narrowest posture, not the nearest one.
  it('an unrecognised kind falls back to scope, never to something that writes', () => {
    const bogus = runWorkflow(run('deploy' as never), M({}));
    expect(bogus).toEqual(BUILTIN_WORKFLOWS.scope);
    expect(bogus.produces).toBe(false);
  });

  // The escalation this must not permit: a dispatch naming a workflow the repo did not define
  // cannot invent a posture. It falls back to the kind the daemon already decided.
  it('an undefined workflow name falls back to the run’s kind, never to a guess', () => {
    expect(runWorkflow(run('scope', 'nope'), M({}))).toEqual(BUILTIN_WORKFLOWS.scope);
  });

  it('a loaded name colliding with a built-in resolves through its base posture', () => {
    const wf = runWorkflow(run('scope', 'build'), M({ build: { base: 'scope', prompt: null } }));
    expect(wf).toMatchObject({ id: 'build', promptShape: 'scope', produces: false });
  });

  it('a per-dispatch catalog carries prompt source identity into the resolved workflow', () => {
    const source = '/repo/.noriq/workflows/docs.md';
    const wf = resolveWorkflow('docs', {
      definitions: {
        docs: {
          base: 'scope',
          prompt: 'read {{brief}}',
          promptSource: source,
          description: null,
          source: '/repo/.noriq/workflows/docs.toml',
          tier: 'project-file',
        },
      },
    });
    expect(wf).toMatchObject({ promptShape: 'scope', promptRef: 'read {{brief}}', promptSource: source });
  });
});
