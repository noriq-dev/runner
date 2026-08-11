import { ExecutionSpec, type ExecutionSpecInput } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import {
  MAX_ACCEPTANCE_ITEMS,
  acceptanceOverflow,
  acceptanceSummary,
  describeCommandObservation,
  enumerateAcceptance,
  failedAcceptance,
  reconcileAcceptance,
  renderAcceptanceChecklist,
  renderAcceptanceReport,
  unverifiedAcceptance,
  withDaemonObservations,
} from '../src/acceptance';
import { judgeWithAcceptance } from '../src/verify-agent';

// RUN-145. A gate used to answer the definition of done in prose, which hid the one case worth
// naming: the criterion nobody actually checked. The code that would satisfy it is there, so the
// report says PASS — and nothing established that it DOES what the criterion claims.

const spec = (over: ExecutionSpecInput = {}) => ExecutionSpec.parse(over);
const truths = (...t: string[]) => spec({ acceptance: { observableTruths: t } });
const outcomes = (report: { entries: Array<{ outcome: string }> }) => report.entries.map((e) => e.outcome);

describe('enumerating a spec’s criteria', () => {
  it('numbers truths, then artifacts, then links — the order the numbers mean', () => {
    const items = enumerateAcceptance(
      spec({
        acceptance: {
          observableTruths: ['the daemon reaps orphans on start'],
          artifacts: [{ path: 'src/a.ts', provides: 'the seam', exports: ['run', 'stop'] }],
          links: [{ from: 'cli.ts', to: 'daemon.ts', via: 'import' }],
        },
      }),
    );
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      [1, 'truth'],
      [2, 'artifact'],
      [3, 'link'],
    ]);
    expect(items[1]!.text).toBe('src/a.ts exists and provides the seam, exporting run, stop');
    expect(items[2]!.text).toBe('cli.ts reaches daemon.ts via import');
  });

  // A criterion containing a newline would split into a line that parses as nothing plus a stray
  // fragment — every wire format here is one line per item.
  it('flattens a multi-line criterion onto one line', () => {
    const [item] = enumerateAcceptance(truths('it builds\nand it runs'));
    expect(item!.text).toBe('it builds and it runs');
  });

  // …but ONLY newlines. The builder is briefed with the criterion verbatim, so collapsing runs of
  // spaces would hand the gate a different sentence and grade the work against the rewrite.
  it('leaves significant internal spacing alone', () => {
    const [item] = enumerateAcceptance(truths('prints exactly `a  b`'));
    expect(item!.text).toBe('prints exactly `a  b`');
  });

  // A blank criterion would occupy a number, arrive as an empty line, and come back unverified
  // forever — an item nobody can answer permanently degrades every report the spec appears in.
  it('drops an empty criterion rather than giving it a number', () => {
    const items = enumerateAcceptance(truths('  ', 'it builds'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 1, text: 'it builds' });
  });

  it('has nothing to enumerate for a spec with no criteria, or no spec', () => {
    expect(enumerateAcceptance(spec({ discretion: ['naming'] }))).toEqual([]);
    expect(enumerateAcceptance(null)).toEqual([]);
  });

  // A checklist that silently stops reads as a complete contract that happens to be short.
  it('caps the list and reports what did not fit', () => {
    const many = truths(...Array.from({ length: MAX_ACCEPTANCE_ITEMS + 7 }, (_, i) => `truth ${i}`));
    expect(enumerateAcceptance(many)).toHaveLength(MAX_ACCEPTANCE_ITEMS);
    expect(acceptanceOverflow(many)).toBe(7);
    // Counted from the criteria that SURVIVE enumeration, not from the raw arrays: blank entries
    // would otherwise manufacture an overflow and tell a gate its complete list was incomplete.
    expect(acceptanceOverflow(truths('one', '  '))).toBe(0);
    expect(renderAcceptanceChecklist(enumerateAcceptance(many), acceptanceOverflow(many))).toMatch(
      /and 7 more criteria this spec names that did not fit/,
    );
  });
});

describe('reconciling what a gate reported', () => {
  const items = enumerateAcceptance(truths('it builds', 'it reaps orphans', 'it never pushes'));

  it('pairs an answer to its criterion by number', () => {
    const r = reconcileAcceptance(items, 'ACCEPTANCE 2: VERIFIED src/worktree.ts:88, reapOrphans test');
    expect(r.entries[1]).toMatchObject({
      id: 2,
      outcome: 'verified',
      evidence: 'src/worktree.ts:88, reapOrphans test',
    });
  });

  // THE rule. A criterion falling out of the report unnoticed is the failure this whole module
  // exists for, and defaulting the unmentioned to "fine" would rebuild it exactly.
  it('records a criterion the gate never mentioned as unverified, not as passed', () => {
    const r = reconcileAcceptance(items, 'ACCEPTANCE 1: VERIFIED tsc --noEmit is clean');
    expect(outcomes(r)).toEqual(['verified', 'behaviour-unverified', 'behaviour-unverified']);
    expect(r.entries[1]!.evidence).toMatch(/did not report on this criterion/);
  });

  // "It is verified" with nothing pointed at is a restatement of the criterion, and a restatement
  // reading as a check is the thing being fixed. An empty-string test alone would let the shrug
  // answers through, and those are the same unevidenced pass wearing punctuation.
  it.each(['ACCEPTANCE 1: VERIFIED', 'ACCEPTANCE 1: VERIFIED —', 'ACCEPTANCE 1: VERIFIED n/a'])(
    'demotes %s, which points at nothing',
    (line) => {
      const r = reconcileAcceptance(items, line);
      expect(r.entries[0]!.outcome).toBe('behaviour-unverified');
      expect(r.entries[0]!.evidence).toMatch(/pointed at nothing/);
    },
  );

  it('accepts a terse pointer that IS a pointer', () => {
    expect(reconcileAcceptance(items, 'ACCEPTANCE 1: VERIFIED a.ts').entries[0]!.outcome).toBe('verified');
  });

  // The demotion is directional. Rounding a "no" up to "did not check" is the wrong way, by
  // exactly the argument that makes demoting an unevidenced pass right.
  it('does NOT demote an unevidenced FAILED — a refusal to certify is still a refusal', () => {
    const r = reconcileAcceptance(items, 'ACCEPTANCE 1: FAILED');
    expect(r.entries[0]!.outcome).toBe('failed');
  });

  // A model produces whichever spelling its training leaned toward. Refusing one would discard a
  // correctly-reasoned answer over an `o` — and do it silently, since the line would simply fail
  // to match and the item would come back unaddressed.
  it.each(['BEHAVIOUR-UNVERIFIED', 'BEHAVIOR-UNVERIFIED', 'behaviour unverified', 'Behavior_Unverified'])(
    'accepts %s',
    (token) => {
      const r = reconcileAcceptance(items, `ACCEPTANCE 3: ${token} the code is there, nothing runs it`);
      expect(r.entries[2]).toMatchObject({
        outcome: 'behaviour-unverified',
        evidence: 'the code is there, nothing runs it',
      });
    },
  );

  it('tells human-needed apart from unverified — one is finishable work, the other is not', () => {
    const r = reconcileAcceptance(
      items,
      'ACCEPTANCE 3: HUMAN-NEEDED it is a claim about the deployed worker',
    );
    expect(r.entries[2]!.outcome).toBe('human-needed');
  });

  // A gate that invents item 9 for a 3-item spec has lost the checklist; keeping the line would
  // put an assertion in the record with no criterion attached to it.
  it('drops an answer to a number no criterion has', () => {
    const r = reconcileAcceptance(items, 'ACCEPTANCE 9: FAILED something I imagined');
    expect(failedAcceptance(r)).toEqual([]);
    expect(r.entries).toHaveLength(3);
  });

  // Position is the wrong tiebreak and BOTH positional rules are exploitable: a fenced draft
  // followed by the real answer beats first-wins, a trailing restatement beats last-wins. Picking
  // by outcome is order-independent and fails the way this codebase already chose — a false FAIL
  // costs one more look, a false PASS ships broken code.
  it.each([
    ['ACCEPTANCE 1: FAILED a.ts:1\nACCEPTANCE 1: VERIFIED a.ts:1', 'failed'],
    ['ACCEPTANCE 1: VERIFIED a.ts:1\nACCEPTANCE 1: FAILED a.ts:1', 'failed'],
    ['ACCEPTANCE 1: VERIFIED a.ts:1\nACCEPTANCE 1: HUMAN-NEEDED it is deployed', 'human-needed'],
  ])('takes the least-passing answer when a criterion is answered twice', (text, expected) => {
    expect(reconcileAcceptance(items, text).entries[0]!.outcome).toBe(expected);
  });

  // The concrete case: a draft inside a fenced block, then the real answer. Under first-wins the
  // draft was permanent and the run passed a criterion the report plainly marked failed.
  it('is not fooled by an answer drafted in a code fence', () => {
    const r = reconcileAcceptance(
      items,
      '```\nACCEPTANCE 1: VERIFIED draft.ts:1\n```\n\nOn a closer look:\nACCEPTANCE 1: FAILED real.ts:2',
    );
    expect(r.entries[0]!.outcome).toBe('failed');
  });

  // Every strictness about the LINE fails in one direction: an unmatched line is recorded as
  // unaddressed, which a PASS is allowed to stand over — so a report that clearly marks a criterion
  // failed, as a bullet or after a label, would have been passed by the daemon.
  it.each([
    '- ACCEPTANCE 1: FAILED a.ts:1',
    '  * ACCEPTANCE 1: FAILED a.ts:1',
    '> ACCEPTANCE 1: FAILED a.ts:1',
    'ACCEPTANCE 1. FAILED a.ts:1',
    'ACCEPTANCE 1) FAILED a.ts:1',
  ])('reads a FAILED answer written as %s', (line) => {
    expect(reconcileAcceptance(items, line).entries[0]!.outcome).toBe('failed');
  });

  it('ignores prose around the lines, so a report may reason before it answers', () => {
    const r = reconcileAcceptance(
      items,
      'I read the diff and it mostly holds.\n\n  ACCEPTANCE 1: VERIFIED src/a.ts:4\n\nVERDICT: PASS',
    );
    expect(r.entries[0]!.outcome).toBe('verified');
  });

  it('summarises the whole contract, not the part that was answered', () => {
    const r = reconcileAcceptance(items, 'ACCEPTANCE 1: VERIFIED a.ts:1\nACCEPTANCE 2: FAILED b.ts:2');
    expect(acceptanceSummary(r)).toBe('1 verified, 1 failed, 1 unverified, 0 need a human (of 3)');
    expect(unverifiedAcceptance(r).map((e) => e.id)).toEqual([3]);
  });
});

describe('the verdict and the evidence together', () => {
  const items = enumerateAcceptance(truths('it builds', 'it reaps orphans'));

  // A report that answers its own question twice has not passed anything, and reading it as PASS
  // is not a decision anybody made — it falls out of which parser ran last.
  it('overrides a PASS the report’s own criteria contradict', () => {
    const v = judgeWithAcceptance('ACCEPTANCE 2: FAILED nothing reaps on start\nVERDICT: PASS', items);
    expect(v.verdict).toBe('fail');
    expect(v.passed).toBe(false);
    expect(v.findings).toMatch(/the daemon overrode this PASS/);
    // The criterion is named, or the override is an assertion the reader cannot check.
    expect(v.findings).toMatch(/it reaps orphans/);
  });

  // Most specs are half-written. Failing every build with a truth nobody could evidence would make
  // the field a tripwire rather than a contract — the gaps are RUN-146's input, not a gate.
  it('lets a PASS stand over merely unverified criteria, and records them', () => {
    const v = judgeWithAcceptance('ACCEPTANCE 1: VERIFIED tsc is clean\nVERDICT: PASS', items);
    expect(v.passed).toBe(true);
    expect(unverifiedAcceptance(v.acceptance!).map((e) => e.id)).toEqual([2]);
  });

  // RUN-72's separation is load-bearing: 'unknown' means the gate never rendered a judgment, and a
  // half-written report from a killed process is exactly the case it protects. Converting that into
  // a verdict about the DIFF would blame the work for an infrastructure failure.
  it('leaves an unknown verdict unknown even alongside a failed criterion', () => {
    const v = judgeWithAcceptance('ACCEPTANCE 1: FAILED a.ts:1', items);
    expect(v.verdict).toBe('unknown');
    expect(failedAcceptance(v.acceptance!)).toHaveLength(1);
  });

  // A FAIL needs no help from the evidence, and rewriting its findings would bury the reviewer's
  // own report under a scorecard.
  it('leaves a FAIL alone', () => {
    const v = judgeWithAcceptance('ACCEPTANCE 1: FAILED a.ts:1\nVERDICT: FAIL because of finding 1', items);
    expect(v.verdict).toBe('fail');
    expect(v.findings).not.toMatch(/overrode/);
  });

  // Most runs carry no spec at all, and those gates must behave exactly as they did before.
  it('is the plain verdict when there are no criteria to answer', () => {
    const v = judgeWithAcceptance('VERDICT: PASS', []);
    expect(v).toMatchObject({ verdict: 'pass', passed: true });
    expect(v.acceptance).toBeUndefined();
  });
});

describe('the report a human reads', () => {
  // A reader scanning a comment is looking for what is wrong; spec order buries it under whatever
  // happened to be checkable.
  it('puts what is wrong first, keeping the numbers so it stays addressable', () => {
    const items = enumerateAcceptance(truths('one', 'two', 'three', 'four'));
    const out = renderAcceptanceReport(
      reconcileAcceptance(
        items,
        [
          'ACCEPTANCE 1: VERIFIED a.ts:1',
          'ACCEPTANCE 2: HUMAN-NEEDED it is about the deployed worker',
          'ACCEPTANCE 3: FAILED c.ts:3',
        ].join('\n'),
      ),
    );
    const order = [...out.matchAll(/\*\*(\d)\.\*\*/g)].map((m) => Number(m[1]));
    expect(order).toEqual([3, 4, 2, 1]); // failed, unverified, human-needed, verified
    expect(out).toMatch(/1 verified, 1 failed, 1 unverified, 1 need a human \(of 4\)/);
  });

  it('renders nothing for a run that had no criteria', () => {
    expect(renderAcceptanceReport({ entries: [] })).toBe('');
  });

  it('shows a daemon command as a separate fact without reclassifying a matching criterion', () => {
    const report = reconcileAcceptance(enumerateAcceptance(truths('npm run check passes')), 'VERDICT: PASS');
    const before = structuredClone(report.entries);
    const observed = {
      site: 'landing' as const,
      cmd: 'npm run check',
      passed: true,
      exitCode: 0,
      timedOut: false,
      attempts: 1,
    };

    const enriched = withDaemonObservations(report, [observed]);
    const out = renderAcceptanceReport(enriched);

    expect(enriched.entries).toEqual(before);
    expect(enriched.entries[0]!.outcome).toBe('behaviour-unverified');
    expect(acceptanceSummary(enriched)).toContain('1 unverified');
    expect(out).toContain('**Daemon observations**');
    expect(out).toContain('[landing] npm run check — passed');
    expect(out).toContain('they do not reclassify the reviewer verdicts');
    expect(describeCommandObservation(observed)).toBe('[landing] npm run check — passed');
  });
});
