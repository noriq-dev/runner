// RUN-79: the cross-round adjudication ledger — the parsers, the merge, and the render.
import { describe, expect, it } from 'vitest';
import {
  type LedgerEntry,
  buildLedger,
  parseFindingResponses,
  parseFindings,
  renderLedger,
  renderRequirementOutcomes,
  requirementOutcomes,
} from '../src/adjudication';

describe('parseFindings', () => {
  it('extracts numbered findings with severity, location, claim', () => {
    const out = parseFindings(
      'Some prose above.\n' +
        'FINDING 1 [High] src/init-project.ts:357: detectVcs runs on every init\n' +
        'FINDING 2 [Medium] src/foo.ts:92: npm assumed for every project\n' +
        'VERDICT: FAIL',
    );
    // No requirement bracket → `requirements: []`. Every finding written before RUN-147 and every
    // task that names no requirements lands here, and must parse exactly as it always did.
    expect(out).toEqual([
      {
        id: 1,
        severity: 'High',
        requirements: [],
        location: 'src/init-project.ts:357',
        claim: 'detectVcs runs on every init',
      },
      {
        id: 2,
        severity: 'Medium',
        requirements: [],
        location: 'src/foo.ts:92',
        claim: 'npm assumed for every project',
      },
    ]);
  });

  it('tolerates a missing location and odd severity tags', () => {
    const out = parseFindings('FINDING 1 [P1] : the whole approach is wrong');
    expect(out).toEqual([
      { id: 1, severity: 'P1', requirements: [], location: '', claim: 'the whole approach is wrong' },
    ]);
  });

  it('a report with no FINDING lines yields nothing — degrades to today (no ledger)', () => {
    expect(parseFindings('The error path is untested.\nVERDICT: FAIL')).toEqual([]);
  });

  it('a duplicated finding number keeps the first', () => {
    const out = parseFindings('FINDING 1 [High] a.ts:1: first\nFINDING 1 [Low] b.ts:2: second');
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toBe('first');
  });
});

describe('parseFindingResponses', () => {
  it('parses FIXED/CONTESTED with a pointer and reason split on the em dash', () => {
    const out = parseFindingResponses(
      'I addressed them.\n' +
        'FINDING 1: FIXED src/foo.ts:92 — made detection package-manager-aware\n' +
        'FINDING 2: CONTESTED src/init.ts:164, commit a672b25 — pre-existing, explicit consent\n',
    );
    expect(out).toEqual([
      { id: 1, status: 'fixed', pointer: 'src/foo.ts:92', reason: 'made detection package-manager-aware' },
      {
        id: 2,
        status: 'contested',
        pointer: 'src/init.ts:164, commit a672b25',
        reason: 'pre-existing, explicit consent',
      },
    ]);
  });

  it('a hyphen inside a path does not split pointer from reason', () => {
    const out = parseFindingResponses('FINDING 1: FIXED src/multi-turn.ts:10 — fixed it');
    expect(out[0]).toEqual({ id: 1, status: 'fixed', pointer: 'src/multi-turn.ts:10', reason: 'fixed it' });
  });

  it('a response with no separator keeps the whole tail as the pointer', () => {
    expect(parseFindingResponses('FINDING 3: CONTESTED test/x.test.ts:194')[0]).toEqual({
      id: 3,
      status: 'contested',
      pointer: 'test/x.test.ts:194',
      reason: '',
    });
  });

  it('no block → no responses (findings then carry as unanswered)', () => {
    expect(parseFindingResponses('Fixed everything, trust me.')).toEqual([]);
  });
});

describe('buildLedger', () => {
  const F = (id: number, claim: string, location = `f${id}.ts:1`, requirements: string[] = []) => ({
    id,
    severity: 'High',
    requirements,
    location,
    claim,
  });

  it('pairs findings to responses by id; a missing response is unanswered', () => {
    const led = buildLedger(
      [],
      [F(1, 'a'), F(2, 'b')],
      [{ id: 1, status: 'contested', pointer: 'x.ts:1', reason: 'nope' }],
      1,
    );
    expect(led.map((e) => [e.id, e.status, e.pointer])).toEqual([
      [1, 'contested', 'x.ts:1'],
      [2, 'unanswered', null],
    ]);
  });

  it('a re-raised finding UPDATES its entry, it does not duplicate — the settled stays one row', () => {
    const round1 = buildLedger(
      [],
      [F(1, 'detectVcs runs on every init')],
      [{ id: 1, status: 'contested', pointer: 'commit 11f19c8', reason: 'pre-existing' }],
      1,
    );
    // Round 2 re-raises the same finding (same location + claim), builder answers again.
    const round2 = buildLedger(
      round1,
      [F(1, 'detectVcs runs on every init')],
      [{ id: 1, status: 'contested', pointer: 'commit 11f19c8, brief', reason: 'still pre-existing' }],
      2,
    );
    expect(round2).toHaveLength(1); // not duplicated
    expect(round2[0]!.round).toBe(2); // latest adjudication wins
    expect(round2[0]!.pointer).toBe('commit 11f19c8, brief');
  });

  // RUN-147, and the reason requirement ids exist at all. Each round is a FRESH reviewer that never
  // saw the last one's wording, so it paraphrases by construction — the prose key missed, the
  // builder's evidence-backed rebuttal was lost, and the round went on relitigating a settled point.
  it('a REWORDED finding against the same requirement is a re-raise, not a new entry', () => {
    const round1 = buildLedger(
      [],
      [F(1, 'detectVcs runs on every init', 'src/init.ts:357', ['R-7'])],
      [{ id: 1, status: 'contested', pointer: 'commit 11f19c8', reason: 'pre-existing' }],
      1,
    );
    const round2 = buildLedger(
      round1,
      // Same requirement, same place, entirely different words.
      [F(1, 'VCS detection fires unconditionally at startup', 'src/init.ts:357', ['R-7'])],
      [],
      2,
    );
    expect(round2).toHaveLength(1);
    expect(round2[0]!.claim).toBe('VCS detection fires unconditionally at startup'); // newest wording
    expect(round2[0]!.round).toBe(2);
  });

  // Without the id, the same rewording is a different finding — which is the behaviour every task
  // that names no requirements still gets, and it must not change.
  it('a rewording with no requirement id still appends, exactly as before', () => {
    const round1 = buildLedger([], [F(1, 'detectVcs runs on every init', 'src/init.ts:357')], [], 1);
    const round2 = buildLedger(round1, [F(1, 'VCS detection fires at startup', 'src/init.ts:357')], [], 2);
    expect(round2).toHaveLength(2);
  });

  // A requirement is usually met in several places, and two defects against it in different files
  // are two findings. Keying on the requirement ALONE would silently merge them.
  it('keeps two findings against one requirement in different places apart', () => {
    const led = buildLedger([], [F(1, 'a', 'src/a.ts:1', ['R-7']), F(2, 'b', 'src/b.ts:1', ['R-7'])], [], 1);
    expect(led).toHaveLength(2);
  });

  // A reviewer listing the same requirements in the other order is naming the same thing.
  it('is insensitive to the order requirements are listed in', () => {
    const round1 = buildLedger([], [F(1, 'x', 'a.ts:1', ['R-1', 'R-2'])], [], 1);
    const round2 = buildLedger(round1, [F(1, 'y', 'a.ts:1', ['R-2', 'R-1'])], [], 2);
    expect(round2).toHaveLength(1);
  });

  it('a genuinely new finding appends', () => {
    const led = buildLedger([...buildLedger([], [F(1, 'a')], [], 1)], [F(2, 'b')], [], 2);
    expect(led.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe('parsing the requirement bracket (RUN-147)', () => {
  it('reads the ids and leaves location and claim untouched', () => {
    const [f] = parseFindings('FINDING 1 [High] [R-7, R-9] src/a.ts:12: the claim');
    expect(f).toEqual({
      id: 1,
      severity: 'High',
      requirements: ['R-7', 'R-9'],
      location: 'src/a.ts:12',
      claim: 'the claim',
    });
  });

  // A model will use whichever separator it feels like; rejecting one spelling would silently drop
  // the association and give back the pre-RUN-147 behaviour with none of the warning.
  it.each(['R-7,R-9', 'R-7; R-9', 'R-7 R-9'])('accepts %s as two ids', (raw) => {
    expect(parseFindings(`FINDING 1 [High] [${raw}] a.ts:1: x`)[0]!.requirements).toEqual(['R-7', 'R-9']);
  });

  // The bracket is optional and must stay so: every finding written before this, and every task
  // that names no requirements, has to parse byte-identically rather than fail to match.
  it('is optional — a finding without it parses as it always did', () => {
    const [f] = parseFindings('FINDING 1 [High] src/a.ts:12: the claim');
    expect(f).toMatchObject({ requirements: [], location: 'src/a.ts:12', claim: 'the claim' });
  });

  // A finding threatening a dozen requirements has named a theme, not a requirement.
  it('caps how many one finding may name', () => {
    const many = Array.from({ length: 12 }, (_, i) => `R-${i}`).join(', ');
    expect(parseFindings(`FINDING 1 [High] [${many}] a.ts:1: x`)[0]!.requirements).toHaveLength(6);
  });
});

describe('what the run can say per requirement (RUN-147)', () => {
  const entry = (requirements: string[], status: LedgerEntry['status']): LedgerEntry => ({
    id: 1,
    round: 1,
    severity: 'High',
    requirements,
    location: 'a.ts:1',
    claim: 'x',
    status,
    pointer: null,
    reason: null,
  });

  it('separates still-standing from raised-and-fixed', () => {
    const out = requirementOutcomes(
      ['R-1', 'R-2', 'R-3'],
      [entry(['R-1'], 'contested'), entry(['R-2'], 'fixed')],
    );
    expect(out.map((o) => [o.requirement, o.standing.length, o.fixed.length])).toEqual([
      ['R-1', 1, 0],
      ['R-2', 0, 1],
      ['R-3', 0, 0],
    ]);
  });

  // An unanswered finding is still standing — the builder never rebutted it.
  it('counts an unanswered finding as standing', () => {
    expect(requirementOutcomes(['R-1'], [entry(['R-1'], 'unanswered')])[0]!.standing).toHaveLength(1);
  });

  // The wording has to be careful: nobody raising a finding is not the same as anyone checking it.
  // "Met" here would be the unevidenced pass RUN-145 exists to refuse, one field along.
  it('does not claim a requirement was MET just because nothing was raised against it', () => {
    const out = renderRequirementOutcomes(requirementOutcomes(['R-1'], []));
    expect(out).toMatch(/no finding was raised against it/);
    expect(out).not.toMatch(/\bmet\b/i);
  });

  it('renders nothing when the task named no requirements', () => {
    expect(renderRequirementOutcomes(requirementOutcomes([], []))).toBe('');
  });
});

describe('renderLedger', () => {
  it('renders each entry with the builder claim as a checkable pointer, not prose', () => {
    const entries: LedgerEntry[] = [
      {
        id: 1,
        round: 1,
        severity: 'High',
        requirements: [],
        location: 'src/init-project.ts:357',
        claim: 'detectVcs runs on every init',
        status: 'contested',
        pointer: 'commit 11f19c8',
        reason: 'pre-existing, added by RUN-60',
      },
    ];
    const out = renderLedger(entries);
    expect(out).toContain('[round 1, High] src/init-project.ts:357 — detectVcs runs on every init');
    expect(out).toContain('builder: CONTESTED (commit 11f19c8) — pre-existing, added by RUN-60');
  });

  it('an unanswered entry tells the reviewer to judge it fresh', () => {
    const out = renderLedger([
      {
        id: 1,
        round: 1,
        severity: 'Low',
        requirements: [],
        location: 'a.ts:1',
        claim: 'x',
        status: 'unanswered',
        pointer: null,
        reason: null,
      },
    ]);
    expect(out).toMatch(/no response recorded — judge it fresh/);
  });
});
