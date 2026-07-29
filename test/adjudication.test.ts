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
  subclaimsOf,
} from '../src/adjudication';

describe('parseFindings', () => {
  it('extracts numbered findings with severity, location, claim', () => {
    const out = parseFindings(
      'Some prose above.\n' +
        'FINDING 1 [High] src/init-project.ts:357: detectVcs runs on every init\n' +
        'FINDING 2 [Medium] src/foo.ts:92: npm assumed for every project\n' +
        'VERDICT: FAIL',
    );
    // No requirement bracket → `requirements: []`, no sub-claim lines → `subclaims: []`. Every
    // finding written before RUN-147/RUN-180 and every task that names no requirements lands here,
    // and must parse exactly as it always did.
    expect(out).toEqual([
      {
        id: 1,
        severity: 'High',
        requirements: [],
        location: 'src/init-project.ts:357',
        claim: 'detectVcs runs on every init',
        subclaims: [],
      },
      {
        id: 2,
        severity: 'Medium',
        requirements: [],
        location: 'src/foo.ts:92',
        claim: 'npm assumed for every project',
        subclaims: [],
      },
    ]);
  });

  it('tolerates a missing location and odd severity tags', () => {
    const out = parseFindings('FINDING 1 [P1] : the whole approach is wrong');
    expect(out).toEqual([
      {
        id: 1,
        severity: 'P1',
        requirements: [],
        location: '',
        claim: 'the whole approach is wrong',
        subclaims: [],
      },
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
    // `subclaim: null` is the whole-finding form — every response written before RUN-180.
    expect(out).toEqual([
      {
        id: 1,
        subclaim: null,
        status: 'fixed',
        pointer: 'src/foo.ts:92',
        reason: 'made detection package-manager-aware',
      },
      {
        id: 2,
        subclaim: null,
        status: 'contested',
        pointer: 'src/init.ts:164, commit a672b25',
        reason: 'pre-existing, explicit consent',
      },
    ]);
  });

  it('a hyphen inside a path does not split pointer from reason', () => {
    const out = parseFindingResponses('FINDING 1: FIXED src/multi-turn.ts:10 — fixed it');
    expect(out[0]).toEqual({
      id: 1,
      subclaim: null,
      status: 'fixed',
      pointer: 'src/multi-turn.ts:10',
      reason: 'fixed it',
    });
  });

  it('a response with no separator keeps the whole tail as the pointer', () => {
    expect(parseFindingResponses('FINDING 3: CONTESTED test/x.test.ts:194')[0]).toEqual({
      id: 3,
      subclaim: null,
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
    subclaims: [],
  });
  /** The whole-finding response form (`subclaim: null`) — every response written before RUN-180. */
  const R = (id: number, status: 'fixed' | 'contested', pointer: string, reason: string) => ({
    id,
    subclaim: null,
    status,
    pointer,
    reason,
  });

  it('pairs findings to responses by id; a missing response is unanswered', () => {
    const led = buildLedger([], [F(1, 'a'), F(2, 'b')], [R(1, 'contested', 'x.ts:1', 'nope')], 1);
    expect(led.map((e) => [e.id, e.status, e.pointer])).toEqual([
      [1, 'contested', 'x.ts:1'],
      [2, 'unanswered', null],
    ]);
  });

  it('a re-raised finding UPDATES its entry, it does not duplicate — the settled stays one row', () => {
    const round1 = buildLedger(
      [],
      [F(1, 'detectVcs runs on every init')],
      [R(1, 'contested', 'commit 11f19c8', 'pre-existing')],
      1,
    );
    // Round 2 re-raises the same finding (same location + claim), builder answers again.
    const round2 = buildLedger(
      round1,
      [F(1, 'detectVcs runs on every init')],
      [R(1, 'contested', 'commit 11f19c8, brief', 'still pre-existing')],
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
      [R(1, 'contested', 'commit 11f19c8', 'pre-existing')],
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

  // The failure that decides the whole design. A cross-cutting finding carries NO location, so
  // matching on the requirement alone would collapse every cross-cutting finding about one
  // requirement into a single row — and a merge destroys a real finding, where a missed match only
  // costs a duplicate row. Requirement matching demands a specific location for exactly this.
  it('never merges two cross-cutting findings that share a requirement', () => {
    const led = buildLedger(
      [],
      [F(1, 'the whole permission model leaks', '', ['R-7']), F(2, 'budgets are not enforced', '', ['R-7'])],
      [],
      1,
    );
    expect(led).toHaveLength(2);
  });

  // A re-raise that drops the tag must not drop the association — the requirement is a fact about
  // the DEFECT, not about this round's wording, and losing it sends the next match back to prose.
  it('keeps a requirement the entry already carried when a re-raise omits it', () => {
    const round1 = buildLedger([], [F(1, 'x', 'a.ts:1', ['R-7'])], [], 1);
    const round2 = buildLedger(round1, [F(1, 'x', 'a.ts:1')], [], 2);
    expect(round2).toHaveLength(1);
    expect(round2[0]!.requirements).toEqual(['R-7']);
  });

  // Findings are now recorded when RAISED, before any response can exist — so a re-raise carrying
  // no response is the common path, and resetting the entry to 'unanswered' there would throw away
  // the very rebuttal this ledger exists to carry.
  it('keeps the builder’s existing adjudication when a re-raise brings no response', () => {
    const round1 = buildLedger(
      [],
      [F(1, 'x', 'a.ts:1', ['R-7'])],
      [R(1, 'contested', 'commit abc', 'pre-existing')],
      1,
    );
    const round2 = buildLedger(round1, [F(1, 'x reworded', 'a.ts:1', ['R-7'])], [], 2);
    expect(round2[0]).toMatchObject({ status: 'contested', pointer: 'commit abc' });
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
      subclaims: [],
    });
  });

  it.each(['R-7,R-9', 'R-7; R-9', 'R-7 , R-9'])('accepts %s as two ids', (raw) => {
    expect(parseFindings(`FINDING 1 [High] [${raw}] a.ts:1: x`)[0]!.requirements).toEqual(['R-7', 'R-9']);
  });

  // NOT whitespace. The contract puts no shape on a requirement id (RUN-134), so `Customer login`
  // is a legal one and splitting on spaces would shred it into two that match nothing. A
  // space-separated bracket yields one odd id, which the summary reports as unrecognised rather
  // than dropping — visible beats silent.
  it('keeps a multi-word requirement id whole', () => {
    expect(parseFindings('FINDING 1 [High] [Customer login] a.ts:1: x')[0]!.requirements).toEqual([
      'Customer login',
    ]);
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
    subclaims: [],
  });

  it('separates still-standing from raised-and-settled', () => {
    const { outcomes } = requirementOutcomes(
      ['R-1', 'R-2', 'R-3'],
      [entry(['R-1'], 'contested'), entry(['R-2'], 'fixed')],
    );
    expect(outcomes.map((o) => [o.requirement, o.standing.length, o.resolved.length])).toEqual([
      ['R-1', 1, 0],
      ['R-2', 0, 1],
      ['R-3', 0, 0],
    ]);
  });

  // An unanswered finding is still standing — the builder never rebutted it.
  it('counts an unanswered finding as standing', () => {
    const { outcomes } = requirementOutcomes(['R-1'], [entry(['R-1'], 'unanswered')]);
    expect(outcomes[0]!.standing).toHaveLength(1);
  });

  // On a PASS the gate read every prior finding AND its rebuttal and cleared the work anyway — that
  // is the adjudication. Reporting a contested finding as an open defect would have the run
  // contradict its own verdict, on exactly the runs nobody reads carefully.
  it('reports nothing as standing once the gate passed', () => {
    const { outcomes } = requirementOutcomes(
      ['R-1'],
      [entry(['R-1'], 'contested'), entry(['R-1'], 'unanswered')],
      { passed: true },
    );
    expect(outcomes[0]!.standing).toHaveLength(0);
    expect(outcomes[0]!.resolved).toHaveLength(2);
  });

  // Discarding an id nobody declared reports "no finding was recorded" about a requirement a
  // finding explicitly named — the most confidently wrong thing this summary could say.
  it('surfaces a requirement id the spec never declared instead of dropping it', () => {
    const report = requirementOutcomes(['R-7'], [entry(['R-77'], 'unanswered')]);
    expect(report.unrecognised).toEqual(['R-77']);
    expect(renderRequirementOutcomes(report)).toMatch(/does not declare as a requirement/);
  });

  // Two careful words. Not "met" — nobody objecting is not the same as anyone checking, which is
  // the unevidenced pass RUN-145 refuses, one field along. And not "raised" — the ledger is
  // bounded, so this can only speak for what survived it.
  it('claims neither that a requirement was MET nor that nothing was ever raised', () => {
    const out = renderRequirementOutcomes(requirementOutcomes(['R-1'], []));
    expect(out).toMatch(/no finding was recorded against it/);
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
        subclaims: [],
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
        subclaims: [],
      },
    ]);
    expect(out).toMatch(/no response recorded — judge it fresh/);
  });
});

// RUN-180. The collapse rule (RUN-89/90) made a finding the unit the builder answers — and a
// bundled finding answerable in halves while recorded as answered as a whole. Sub-claims give the
// halves their own lines: `FINDING 1a: <claim>` under the FINDING line, `FINDING 1a: CONTESTED …`
// in the RESPONSE block, and an unaddressed letter STANDS instead of riding its siblings' answer.
describe('parsing sub-claims (RUN-180)', () => {
  const REPORT =
    'FINDING 1 [High] src/gate.ts:12: the contest gate bundles two separately-answerable defects\n' +
    'FINDING 1a: the eligibility check accepts a response naming a nonexistent finding\n' +
    'FINDING 1b: the entry cap can drop a terminal finding before a PASS\n' +
    'VERDICT: FAIL';

  it('attaches lettered sub-claim lines to the finding their number names', () => {
    expect(parseFindings(REPORT)).toEqual([
      {
        id: 1,
        severity: 'High',
        requirements: [],
        location: 'src/gate.ts:12',
        claim: 'the contest gate bundles two separately-answerable defects',
        subclaims: [
          { letter: 'a', claim: 'the eligibility check accepts a response naming a nonexistent finding' },
          { letter: 'b', claim: 'the entry cap can drop a terminal finding before a PASS' },
        ],
      },
    ]);
  });

  // Malformed enumeration degrades to the single-claim finding, never to an unparsed line — the
  // only acceptable failure mode for a format a model writes (the RUN-147 bracket's rule).
  it('ignores a sub-claim line whose number matches no finding', () => {
    const out = parseFindings('FINDING 1 [High] a.ts:1: the claim\nFINDING 2a: an orphaned letter');
    expect(out).toHaveLength(1);
    expect(out[0]!.subclaims).toEqual([]);
  });

  // ALL-OR-NOTHING, not keep-the-good-half: the candidacy gate asks "was every sub-claim
  // contested?" of the sub-claims that were RECORDED, so a kept (a) beside a dropped malformed (b)
  // could clear the finding on (a) alone while (b) was never entered — the RUN-174 escape reborn.
  // One bad line voids the enumeration and the finding stays the single answerable claim it
  // always was.
  it('a valid letter beside a malformed one degrades the WHOLE finding to single-claim', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class\n' +
        'FINDING 1a: a well-formed sub-claim\n' +
        'FINDING 1b — malformed, a dash where the colon must be',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subclaims).toEqual([]);
  });

  // The detector matches one-or-more letters so a malformed multi-letter form cannot slip past it:
  // a shape the detector cannot see is a shape it cannot void, and `1aa` beside a valid `1a` would
  // otherwise keep the well-formed subset — the kept-subset escape through the detector itself.
  it('a malformed multi-letter line (FINDING 1aa) voids the enumeration like any other bad line', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class\nFINDING 1a: a well-formed sub-claim\nFINDING 1aa: two letters',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subclaims).toEqual([]);
  });

  // A spaced label is a lettered-INTENT shape the strict form rejects, so the detector must see
  // it: invisible, it would coexist with a valid `FINDING 1a:` and the kept sibling would read as
  // the complete enumeration — the kept-subset escape through the detector, second edition.
  it('a spaced label (FINDING 1 b:) voids the WHOLE enumeration — a valid sibling must not survive it', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class\n' +
        'FINDING 1a: a well-formed sub-claim\n' +
        'FINDING 1 b: the letter drifted off the number',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subclaims).toEqual([]);
  });

  // The detector reads lettered INTENT — any junk between the number and the letters — rather
  // than an allowlist of separators, which would leak per punctuation mark: each shape below is a
  // label the strict form rejects, and every one must void rather than leave the valid sibling
  // standing as the complete enumeration.
  it('punctuated labels void the enumeration the same way, whatever the junk between', () => {
    for (const bad of [
      'FINDING 1-b: hyphenated letter',
      'FINDING 1.b: dotted letter',
      'FINDING 1(b): parenthesized letter',
      'FINDING 1_b: underscored letter',
      'FINDING 1 (b): spaced and parenthesized letter',
      'FINDING 1 -- b: arbitrary junk before the letter',
    ]) {
      const out = parseFindings(`FINDING 1 [High] a.ts:1: the class\nFINDING 1a: well-formed\n${bad}`);
      expect(out).toHaveLength(1);
      expect(out[0]!.subclaims).toEqual([]);
    }
  });

  // The deliberate cost of the wider net: a PROSE line that happens to start `FINDING 1 rests…`
  // voids that finding's enumeration. Degrading to the single-claim finding is current behaviour
  // and always a correct way to record it; a kept subset is the escape. Never an error.
  it('a prose line starting FINDING <n> degrades the finding to single-claim, never to an error', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class\n' +
        'FINDING 1a: a well-formed sub-claim\n' +
        'FINDING 1 rests on the same evidence either way',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subclaims).toEqual([]);
  });

  it('a duplicated letter voids the enumeration — a response naming it would be ambiguous', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: c\nFINDING 1a: first version\nFINDING 1a: second version',
    );
    expect(out[0]!.subclaims).toEqual([]);
  });

  // More separately-answerable claims than the cap is several findings — and the cap DROPS the
  // enumeration rather than slicing it: a kept (a)–(d) beside a silently cut (e) would let the
  // contest clear four letters while the fifth claim went unrecorded.
  it('more sub-claims than the cap drops the enumeration, not the tail', () => {
    const letters = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => `FINDING 1${l}: claim ${l}`).join('\n');
    const out = parseFindings(`FINDING 1 [High] a.ts:1: the class\n${letters}`);
    expect(out[0]!.subclaims).toEqual([]);
  });

  it('an enumeration at the cap is kept whole', () => {
    const letters = ['a', 'b', 'c', 'd'].map((l) => `FINDING 1${l}: claim ${l}`).join('\n');
    const out = parseFindings(`FINDING 1 [High] a.ts:1: the class\n${letters}`);
    expect(out[0]!.subclaims.map((s) => s.letter)).toEqual(['a', 'b', 'c', 'd']);
  });

  // A sub-claim line never leaks into the finding list, and a report with none parses as it
  // always did — byte-identical legacy behaviour on both sides of the extension.
  it('sub-claim lines are not findings and do not disturb finding numbering', () => {
    expect(parseFindings(REPORT).map((f) => f.id)).toEqual([1]);
  });

  it('parses a per-sub-claim RESPONSE line, letter lowercased', () => {
    const out = parseFindingResponses('FINDING 1A: CONTESTED src/x.ts:9 — the id filter covers this');
    expect(out).toEqual([
      {
        id: 1,
        subclaim: 'a',
        status: 'contested',
        pointer: 'src/x.ts:9',
        reason: 'the id filter covers this',
      },
    ]);
  });

  it('a bare response and lettered responses to the same finding are distinct answers', () => {
    const out = parseFindingResponses(
      'FINDING 1: CONTESTED whole.ts:1 — as a whole\n' +
        'FINDING 1a: CONTESTED a.ts:1 — half one\n' +
        'FINDING 1b: FIXED b.ts:1 — half two',
    );
    expect(out.map((r) => [r.subclaim, r.status])).toEqual([
      [null, 'contested'],
      ['a', 'contested'],
      ['b', 'fixed'],
    ]);
  });
});

describe('folding partial answers into the ledger (RUN-180)', () => {
  const SF = (id: number, subclaims: { letter: string; claim: string }[], location = `f${id}.ts:1`) => ({
    id,
    severity: 'High',
    requirements: [],
    location,
    claim: 'the class',
    subclaims,
  });
  const SR = (
    id: number,
    subclaim: string | null,
    status: 'fixed' | 'contested',
    pointer: string,
    reason = 'because',
  ) => ({ id, subclaim, status, pointer, reason });
  const AB = [
    { letter: 'a', claim: 'claim a' },
    { letter: 'b', claim: 'claim b' },
  ];

  it('answers fold per sub-claim; the unaddressed one stays unanswered', () => {
    const led = buildLedger([], [SF(1, AB)], [SR(1, 'b', 'contested', 'x.ts:1')], 1);
    expect(led[0]!.subclaims.map((s) => [s.letter, s.status, s.pointer])).toEqual([
      ['a', 'unanswered', null],
      ['b', 'contested', 'x.ts:1'],
    ]);
    expect(led[0]!.status).toBe('unanswered'); // no whole-finding response was given
  });

  // The RUN-174 escape in miniature: a whole-finding answer must not read as answering the
  // letters. It is recorded — it is evidence — but each sub-claim keeps its own state.
  it('a bare response is recorded on the entry and credits NO sub-claim', () => {
    const led = buildLedger([], [SF(1, AB)], [SR(1, null, 'contested', 'whole.ts:1')], 1);
    expect(led[0]!.status).toBe('contested');
    expect(led[0]!.subclaims.every((s) => s.status === 'unanswered')).toBe(true);
  });

  it('a re-raise with the same sub-claim wording carries the earlier answers forward', () => {
    const round1 = buildLedger([], [SF(1, AB)], [SR(1, 'a', 'contested', 'a.ts:9', 'covered')], 1);
    const round2 = buildLedger(round1, [SF(1, AB)], [], 2);
    expect(round2).toHaveLength(1);
    expect(round2[0]!.subclaims.map((s) => [s.letter, s.status])).toEqual([
      ['a', 'contested'],
      ['b', 'unanswered'],
    ]);
  });

  // May MISS, never INVENT: answers carry by the sub-claim's WORDING, not its letter — a fresh
  // reviewer that letters a genuinely different claim (a) must not inherit old (a)'s rebuttal.
  // The cost of the miss is a visibly unanswered sub-claim, which a builder can answer again.
  it('a re-raise whose lettered claims are different claims does not inherit the old answers', () => {
    const round1 = buildLedger([], [SF(1, AB)], [SR(1, 'a', 'contested', 'a.ts:9')], 1);
    const round2 = buildLedger(
      round1,
      [SF(1, [{ letter: 'a', claim: 'an entirely different assertion' }])],
      [],
      2,
    );
    expect(round2[0]!.subclaims).toEqual([
      {
        letter: 'a',
        claim: 'an entirely different assertion',
        status: 'unanswered',
        pointer: null,
        reason: null,
      },
    ]);
  });

  // A TRUNCATED claim is a prefix wearing an identity: two distinct over-cap claims cap to the
  // same text, so carrying across that match would answer a claim nobody answered. The cost of
  // refusing is a visibly unanswered sub-claim on an over-long claim — a miss, never an invention.
  it('a truncated claim never carries an answer — two long claims must not share one', () => {
    const longReport = (tail: string) =>
      `FINDING 1 [High] a.ts:1: the class\nFINDING 1a: ${'x'.repeat(250)}${tail}`;
    const [one] = parseFindings(longReport('ONE'));
    const [two] = parseFindings(longReport('TWO'));
    expect(one!.subclaims[0]!.claim).toEqual(two!.subclaims[0]!.claim); // capped to the same text…
    const round1 = buildLedger([], [one!], [SR(1, 'a', 'contested', 'a.ts:9')], 1);
    const round2 = buildLedger(round1, [two!], [], 2);
    expect(round2[0]!.subclaims.map((s) => s.status)).toEqual(['unanswered']); // …but never carried
  });

  // The carry key is the claim's FULL wording, not a 60-char prefix: two long claims that diverge
  // only past the prefix must not both inherit one rebuttal — an answer nobody gave to one of them.
  it('two distinct claims sharing a long prefix do not share a carried answer', () => {
    const prefix = 'the eligibility filter in contestTerminalFindings accepts a response naming ';
    const one = { letter: 'a', claim: `${prefix}a finding that does not exist` };
    const other = { letter: 'a', claim: `${prefix}an id from another round` };
    const round1 = buildLedger([], [SF(1, [one])], [SR(1, 'a', 'contested', 'a.ts:9')], 1);
    const round2 = buildLedger(round1, [SF(1, [other])], [], 2);
    expect(round2[0]!.subclaims.map((s) => s.status)).toEqual(['unanswered']);
  });

  // The settlement read (requirementOutcomes) uses the RECONCILED sub-claim state: every letter
  // FIXED is a resolved finding even though no bare response ever set the entry-level status —
  // and a bare FIXED over unanswered letters settles nothing, which is the escape.
  it('a finding whose every sub-claim is FIXED reports as resolved, not standing', () => {
    const led = buildLedger(
      [],
      [{ ...SF(1, AB), requirements: ['R-7'] }],
      [SR(1, 'a', 'fixed', 'a.ts:9'), SR(1, 'b', 'fixed', 'b.ts:9')],
      1,
    );
    const { outcomes } = requirementOutcomes(['R-7'], led);
    expect(outcomes[0]!.standing).toHaveLength(0);
    expect(outcomes[0]!.resolved).toHaveLength(1);
  });

  it('a bare FIXED over unanswered sub-claims does NOT settle the finding', () => {
    const led = buildLedger(
      [],
      [{ ...SF(1, AB), requirements: ['R-7'] }],
      [SR(1, null, 'fixed', 'whole.ts:1')],
      1,
    );
    const { outcomes } = requirementOutcomes(['R-7'], led);
    expect(outcomes[0]!.standing).toHaveLength(1);
  });

  it('a re-raise that drops the enumeration keeps the held sub-claims and their answers', () => {
    const round1 = buildLedger([], [SF(1, AB)], [SR(1, 'a', 'contested', 'a.ts:9')], 1);
    const round2 = buildLedger(round1, [SF(1, [])], [], 2);
    expect(round2[0]!.subclaims.map((s) => [s.letter, s.status])).toEqual([
      ['a', 'contested'],
      ['b', 'unanswered'],
    ]);
  });

  // A persisted ledger predates sub-claims (parks, continuation seeds), and a hand-edited one can
  // hold anything — normalise on read, never crash a continuation (the reqsOf pattern).
  it('a persisted entry without sub-claim fields loads and behaves as a single-claim entry', () => {
    const legacy = {
      id: 1,
      round: 1,
      severity: 'High',
      requirements: [],
      location: 'f1.ts:1',
      claim: 'the class',
      status: 'contested',
      pointer: 'x.ts:1',
      reason: 'held',
    } as unknown as LedgerEntry; // as JSON.parse would hand it over: no `subclaims` at runtime
    expect(subclaimsOf(legacy)).toEqual([]);
    expect(renderLedger([legacy])).toContain('builder: CONTESTED (x.ts:1)');
    const merged = buildLedger([legacy], [SF(1, AB)], [], 2);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.subclaims.map((s) => s.status)).toEqual(['unanswered', 'unanswered']);
  });

  it('normalises a malformed persisted sub-claim list field by field instead of crashing', () => {
    const mangled = {
      subclaims: ['not-an-object', { letter: 'a', claim: 'ok', status: 'bogus' }, { letter: 1 }],
    };
    expect(subclaimsOf(mangled)).toEqual([
      { letter: 'a', claim: 'ok', status: 'unanswered', pointer: null, reason: null },
    ]);
    expect(subclaimsOf({})).toEqual([]);
  });

  it('renderLedger names the sub-claim that STANDS instead of reading the finding as answered', () => {
    const led = buildLedger(
      [],
      [SF(1, AB)],
      [SR(1, 'b', 'contested', 'x.ts:1', 'the slice keeps the most recent')],
      1,
    );
    const out = renderLedger(led);
    expect(out).toContain('(a) claim a');
    expect(out).toMatch(/\(a\) claim a\n\s+→ builder: no response recorded — this sub-claim STANDS/);
    expect(out).toContain('(b) claim b');
    expect(out).toContain('CONTESTED (x.ts:1) — the slice keeps the most recent');
  });

  it('the per-requirement report says which sub-claims stand, not a whole-row [unanswered]', () => {
    const led = buildLedger(
      [],
      [{ ...SF(1, AB), requirements: ['R-7'] }],
      [SR(1, 'b', 'contested', 'x.ts:1')],
      1,
    );
    const out = renderRequirementOutcomes(requirementOutcomes(['R-7'], led));
    expect(out).toContain('(a) unanswered');
    expect(out).toContain('(b) contested');
  });
});
