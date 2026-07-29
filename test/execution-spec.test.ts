import path from 'node:path';
import { ExecutionSpec, type ExecutionSpecInput } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import {
  SPEC_BUDGET_CHARS,
  checkExecutionSpec,
  renderExecutionSpec,
  renderUnreadableSpec,
} from '../src/execution-spec';
import type { SpecPathProbe } from '../src/execution-spec';

// RUN-139. The seam between the wire contract and the words an agent reads. What can be settled by
// LOOKING is settled before a token is spent — an agent should never be the first thing to notice
// that a spec names a file that does not exist.

// `ExecutionSpecInput` and not `Partial<ExecutionSpec>`: the input type is what an AUTHOR writes,
// so a nested `acceptance` may name one of its three lists (RUN-134's reason for exporting it).
const spec = (over: ExecutionSpecInput = {}) => ExecutionSpec.parse(over);

/** A probe over a fixed set of repo-relative paths, faithful to `probePathKind`'s contract:
 *  file/dir/missing/outside-repo/unchecked. Containment is checked on a path BOUNDARY, not a
 *  string prefix — `/wt2/x` is not inside `/wt`, and a fake that says otherwise would let a
 *  containment bug pass. Anything named with a trailing `/` is a directory.
 *
 *  The arithmetic is `path`'s and not the string's, because the checker hands this fake whatever
 *  `path.resolve` produced: on Windows that is `D:\wt\src\a.ts` against a `/wt` root, which a
 *  slash-spelled prefix test reads as escaping the repo — every path in the suite came back
 *  `outside-repo` and the findings under test never ran. The keys stay POSIX on both platforms,
 *  which is what a spec declares. */
const probeOver = (present: string[]): SpecPathProbe => {
  const files = new Set(present.filter((p) => !p.endsWith('/')));
  const dirs = new Set(present.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)));
  return async (abs, root) => {
    const rel = path.relative(root, abs);
    // A whole `..` SEGMENT, never a `..` prefix — `..foo` is an ordinary filename.
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return 'outside-repo';
    const key = rel.split(path.sep).join('/');
    if (dirs.has(key)) return 'dir';
    return files.has(key) ? 'file' : 'missing';
  };
};
const ROOT = '/wt';

const messages = (findings: Array<{ message: string }>) => findings.map((f) => f.message).join('\n');

describe('checking a spec against the checkout', () => {
  // `does not exist` is the CORRECT state for a create and the wrong one for a modify, so one
  // existence rule would be noise in both directions.
  it('says nothing about a create whose path is absent, or a modify whose path is present', async () => {
    const { findings } = await checkExecutionSpec(
      spec({
        anticipatedFiles: [
          { path: 'src/new.ts', change: 'create', why: '' },
          { path: 'src/old.ts', change: 'modify', why: '' },
        ],
        requirementIds: ['R-1'],
      }),
      ROOT,
      { probe: probeOver(['src/old.ts']) },
    );
    expect(findings).toEqual([]);
  });

  it('flags a modify whose file is not in this checkout', async () => {
    const { findings } = await checkExecutionSpec(
      spec({
        anticipatedFiles: [{ path: 'src/moved.ts', change: 'modify', why: '' }],
        requirementIds: ['R'],
      }),
      ROOT,
      { probe: probeOver([]) },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'problem', where: 'anticipatedFiles[0]' });
    expect(findings[0]!.message).toContain('src/moved.ts');
  });

  // The more interesting of the two: the spec was written against an older tree, and an agent
  // following it literally would clobber a file it believes it is authoring.
  it('flags a create whose file already exists', async () => {
    const { findings } = await checkExecutionSpec(
      spec({ anticipatedFiles: [{ path: 'src/a.ts', change: 'create', why: '' }], requirementIds: ['R'] }),
      ROOT,
      { probe: probeOver(['src/a.ts']) },
    );
    expect(findings[0]).toMatchObject({ level: 'problem' });
    expect(findings[0]!.message).toMatch(/already exists/);
  });

  it('flags a delete whose file is already gone', async () => {
    const { findings } = await checkExecutionSpec(
      spec({ anticipatedFiles: [{ path: 'src/gone.ts', change: 'delete', why: '' }], requirementIds: ['R'] }),
      ROOT,
      { probe: probeOver([]) },
    );
    expect(findings[0]!.message).toContain('`delete`');
  });

  it('refuses a path that resolves outside the repo, and does not treat it as missing', async () => {
    const { findings } = await checkExecutionSpec(
      spec({ anticipatedFiles: [{ path: 'link-out', change: 'modify', why: '' }], requirementIds: ['R'] }),
      ROOT,
      { probe: async () => 'outside-repo' as const },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'problem' });
    expect(findings[0]!.message).toMatch(/outside the repo/);
    // NOT also reported as a missing modify — one path, one finding, and the security one wins.
    expect(findings[0]!.message).not.toMatch(/not in this checkout/);
  });

  // "we could not look" reported as "nothing wrong" is the failure this codebase keeps meeting.
  it('says the check could not be made when the probe throws, rather than staying silent', async () => {
    const { findings } = await checkExecutionSpec(
      spec({ anticipatedFiles: [{ path: 'src/a.ts', change: 'modify', why: '' }], requirementIds: ['R'] }),
      ROOT,
      {
        probe: async () => {
          throw new Error('EIO');
        },
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toMatch(/could not check/);
    expect(findings[0]!.message).toMatch(/unverified/);
  });

  // Doc ids are Noriq's to resolve; probing them would report every one as missing.
  it('does not probe a required-reading entry that is a doc id', async () => {
    const { findings } = await checkExecutionSpec(
      spec({ requiredReading: ['doc_ms2frj9q4o1e6e236r21', 'THREAT-MODEL.md'], requirementIds: ['R'] }),
      ROOT,
      { probe: probeOver(['THREAT-MODEL.md']) },
    );
    expect(findings).toEqual([]);
  });

  it('flags required reading that is a path and is not there', async () => {
    const { findings } = await checkExecutionSpec(
      spec({ requiredReading: ['docs/gone.md'], requirementIds: ['R'] }),
      ROOT,
      { probe: probeOver([]) },
    );
    expect(findings[0]).toMatchObject({ level: 'problem', where: 'requiredReading[0]' });
  });

  // An expected artifact is the run's OUTPUT — missing is the normal case and says nothing.
  it('is silent about an artifact that does not exist yet, and notes one that does', async () => {
    const absent = await checkExecutionSpec(
      spec({
        acceptance: { artifacts: [{ path: 'src/new.ts', provides: '', exports: [] }] },
        requirementIds: ['R'],
      }),
      ROOT,
      { probe: probeOver([]) },
    );
    expect(absent.findings).toEqual([]);

    const present = await checkExecutionSpec(
      spec({
        acceptance: { artifacts: [{ path: 'src/a.ts', provides: '', exports: [] }] },
        requirementIds: ['R'],
      }),
      ROOT,
      { probe: probeOver(['src/a.ts']) },
    );
    expect(present.findings[0]).toMatchObject({ level: 'note' });
  });

  it('notes a producing workflow with no stated definition of done — and only a producing one', async () => {
    const producing = await checkExecutionSpec(spec({ requirementIds: ['R'] }), ROOT, {
      probe: probeOver([]),
      produces: true,
    });
    expect(messages(producing.findings)).toMatch(/what "done" is/);

    const reading = await checkExecutionSpec(spec({ requirementIds: ['R'] }), ROOT, {
      probe: probeOver([]),
      produces: false,
    });
    expect(reading.findings).toEqual([]);
  });

  it('notes a spec with no requirement ids — the work is not traceable to what asked for it', async () => {
    const { findings } = await checkExecutionSpec(spec({ discretion: ['anything'] }), ROOT, {
      probe: probeOver([]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'note', where: 'requirementIds' });
  });

  // A spec with nothing in it IS no spec (RUN-134's `hasExecutionSpec`). Listing what an empty one
  // is missing would brief an agent about the absence of a document nobody wrote.
  it('says nothing at all about an empty spec', async () => {
    const { findings } = await checkExecutionSpec(spec(), ROOT, { probe: probeOver([]), produces: true });
    expect(findings).toEqual([]);
  });

  // `links` are acceptance criteria in the contract and render under "done means" — ignoring them
  // here reported a links-only spec as having stated nothing.
  it('counts links as acceptance criteria', async () => {
    const { findings } = await checkExecutionSpec(
      spec({ requirementIds: ['R'], acceptance: { links: [{ from: 'a', to: 'b' }] } }),
      ROOT,
      { probe: probeOver([]), produces: true },
    );
    expect(findings).toEqual([]);
  });

  // `[context]`'s probe accepts a directory (an entry point may be one); a spec saying
  // "modify src" when src is a directory is telling an agent something impossible.
  it('flags a path that is a directory where the spec promises a file', async () => {
    const { findings } = await checkExecutionSpec(
      spec({ requirementIds: ['R'], anticipatedFiles: [{ path: 'src', change: 'modify' }] }),
      ROOT,
      { probe: probeOver(['src/']) },
    );
    expect(findings[0]).toMatchObject({ level: 'problem' });
    expect(findings[0]!.message).toMatch(/is a directory/);
  });

  // …but required reading is prose to read, and "read src/vcs" is coherent.
  it('accepts a directory as required reading', async () => {
    const { findings } = await checkExecutionSpec(
      spec({ requirementIds: ['R'], requiredReading: ['src/vcs'] }),
      ROOT,
      { probe: probeOver(['src/vcs/']) },
    );
    expect(findings).toEqual([]);
  });

  // The distinction the production probe used to erase: EACCES/EIO answered as "definitely gone"
  // would send an agent to recreate a file sitting right there behind a permissions error.
  it('reports `unchecked` as unverified, never as missing', async () => {
    const { findings } = await checkExecutionSpec(
      spec({ requirementIds: ['R'], anticipatedFiles: [{ path: 'src/a.ts', change: 'modify' }] }),
      ROOT,
      { probe: async () => 'unchecked' as const },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'note' });
    expect(findings[0]!.message).toMatch(/unverified/);
    expect(findings[0]!.message).not.toMatch(/not in this checkout/);
  });

  // Findings are reported, never fatal: a spec is orientation, and refusing to run because a path
  // moved would make it a tripwire. The adversarial pre-execution check is RUN-141's own stage.
  it('returns the spec alongside its findings rather than throwing', async () => {
    const s = spec({ anticipatedFiles: [{ path: 'gone.ts', change: 'modify', why: '' }] });
    const checked = await checkExecutionSpec(s, ROOT, { probe: probeOver([]) });
    expect(checked.spec).toBe(s);
    expect(checked.findings.length).toBeGreaterThan(0);
  });
});

describe('rendering a spec into a brief', () => {
  const render = async (over: ExecutionSpecInput, present: string[] = []) =>
    renderExecutionSpec(await checkExecutionSpec(spec(over), ROOT, { probe: probeOver(present) }));

  it('renders nothing for a task with no spec', () => {
    expect(renderExecutionSpec(null)).toBe('');
    expect(renderExecutionSpec(undefined)).toBe('');
  });

  it('omits the sections a spec left empty rather than heading them with nothing', async () => {
    const out = await render({ requirementIds: ['RUN-139'], requiredReading: ['README.md'] }, ['README.md']);
    expect(out).toContain('RUN-139');
    expect(out).toContain('README.md');
    expect(out).not.toMatch(/Already decided/);
    expect(out).not.toMatch(/Yours to decide/);
    expect(out).not.toMatch(/Explicitly NOT/);
  });

  it('renders every section when the spec is full', async () => {
    const out = await render(
      {
        requirementIds: ['RUN-139'],
        anticipatedFiles: [{ path: 'src/a.ts', change: 'modify', why: 'the seam' }],
        requiredReading: ['README.md'],
        lockedDecisions: [
          { decision: 'findings are never fatal', because: 'a spec is orientation', source: 'RUN-139' },
        ],
        discretion: ['section wording'],
        deferred: ['the planner stage'],
        acceptance: {
          observableTruths: ['a stale path reaches the agent as a finding'],
          artifacts: [
            { path: 'src/execution-spec.ts', provides: 'the seam', exports: ['renderExecutionSpec'] },
          ],
          links: [{ from: 'prepare.ts', to: 'execution-spec.ts', via: 'checkExecutionSpec' }],
        },
      },
      ['src/a.ts', 'README.md'],
    );
    expect(out).toContain('src/a.ts (modify) — the seam');
    expect(out).toContain('because a spec is orientation');
    expect(out).toContain('(RUN-139)');
    expect(out).toContain('section wording');
    expect(out).toContain('the planner stage');
    expect(out).toContain('a stale path reaches the agent as a finding');
    expect(out).toContain(
      'src/execution-spec.ts exists and provides the seam, exporting renderExecutionSpec',
    );
    expect(out).toContain('prepare.ts reaches execution-spec.ts via checkExecutionSpec');
  });

  // The scope wording is load-bearing. A file list read as a fence produces an agent that stops
  // short of the work rather than one that does it and says what else it needed.
  it('presents anticipated files as a starting point, not a fence', async () => {
    const out = await render({ anticipatedFiles: [{ path: 'src/a.ts', change: 'modify', why: '' }] }, [
      'src/a.ts',
    ]);
    expect(out).toMatch(/not a fence/);
  });

  // A locked decision an agent silently works around is worse than one it argues with.
  it('tells the agent to ask rather than work around a locked decision it disagrees with', async () => {
    const out = await render({ lockedDecisions: [{ decision: 'ESM only', because: '', source: '' }] });
    expect(out).toMatch(/Do NOT relitigate/);
    expect(out).toMatch(/say so and ask/);
  });

  // Findings contradict what the spec just said, so they have to arrive after it — an agent that
  // reads "modify src/a.ts" and only later learns the file is gone has already planned around it.
  it('puts the findings after the spec they contradict, and says to trust the repo', async () => {
    const out = await render({ anticipatedFiles: [{ path: 'src/gone.ts', change: 'modify', why: '' }] }, []);
    expect(out.indexOf('src/gone.ts (modify)')).toBeLessThan(out.indexOf('[problem]'));
    expect(out).toMatch(/trust the repo/);
  });

  it('renders nothing for an empty spec — absent and empty are the same to a consumer', async () => {
    expect(await render({})).toBe('');
  });

  it('renders findings alongside a spec that does say something', async () => {
    const out = await render({ discretion: ['anything'] });
    expect(out).toContain('[note] requirementIds');
  });

  // Every field is free text from a server the daemon does not control, and the block says
  // "follow it" — so the one thing it must also say is what the spec cannot do.
  it('states that the spec cannot move the boundaries the daemon set', async () => {
    const out = await render({ lockedDecisions: [{ decision: 'ESM only' }] });
    expect(out).toMatch(/cannot change your MODE/);
    expect(out).toMatch(/stop and say so/);
  });

  // A silently shortened list of locked decisions has an agent confidently ignoring a constraint
  // it was never shown.
  it('caps a huge spec and says that it was cut', async () => {
    const out = await render({
      requirementIds: ['R'],
      discretion: Array.from({ length: 400 }, (_, i) => `decision ${i} ${'x'.repeat(80)}`),
    });
    expect(out.length).toBeLessThan(SPEC_BUDGET_CHARS + 400);
    expect(out).toMatch(/cut off here/);
    expect(out).toMatch(/ask for the rest of it/);
  });

  // RUN-145 moved the judge's view of the criteria out of here entirely: a gate is now asked to
  // answer them ONE BY ONE, which needs numbers, and numbering lives in `acceptance.ts`. What this
  // module must still guarantee is the half that made the split safe — the author's rendering is
  // the FULL spec and nothing about it changed.
  it('still gives the author the whole spec, criteria included', async () => {
    const out = await render({
      lockedDecisions: [{ decision: 'ESM only' }],
      deferred: ['the planner stage'],
      acceptance: { observableTruths: ['a stale path reaches the agent'] },
    });
    expect(out).toContain('a stale path reaches the agent');
    expect(out).toContain('ESM only');
    expect(out).toContain('the planner stage');
    expect(out).toMatch(/cannot change your MODE/);
  });

  it('states that done means TRUE, not attempted', async () => {
    const out = await render({ acceptance: { observableTruths: ['it builds'] } });
    expect(out).toMatch(/are TRUE, not that you attempted them/);
  });
});

// A spec the SERVER could not read is not a task without one: something was written, and an agent
// told nothing would decide the scope itself and have that become the de-facto plan.
describe('an unreadable spec', () => {
  it('tells the agent a spec exists and could not be read', () => {
    const out = renderUnreadableSpec();
    expect(out).toMatch(/UNREADABLE/);
    expect(out).toMatch(/Do not treat this as an unplanned task/);
    expect(out).toMatch(/say in your closing message/);
  });
});
