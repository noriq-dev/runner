import type { PermissionProfile } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { BUILTIN_WORKFLOWS, type Workflow, clampPermissionToWorkflow, workflowFor } from '../src/workflow';

const profile = (over: Partial<PermissionProfile> = {}): PermissionProfile => ({
  write: false,
  network: 'restricted',
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

  it('clamps ONLY write — deny/allow/network/auto pass through', () => {
    const p = profile({ write: true, deny: ['Bash'], network: 'full', auto: true });
    const clamped = clampPermissionToWorkflow(p, workflowFor('scope'));
    expect(clamped).toEqual({ ...p, write: false });
  });
});
