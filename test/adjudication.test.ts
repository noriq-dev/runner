// RUN-79: the cross-round adjudication ledger — the parsers, the merge, and the render.
import { describe, expect, it } from 'vitest';
import {
  type LedgerEntry,
  applyContestResponses,
  buildLedger,
  parseFindingResponses,
  parseFindings,
  reconciledEntry,
  renderContestRecord,
  renderLedger,
  renderRequirementOutcomes,
  requirementOutcomes,
  spinOffsHold,
  spinOffsOf,
  subclaimsOf,
  taskRefsIn,
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

  // The regression a terminal round of this task's own gestation caught: a fingerprint suffix on
  // the display changed every legacy claim over CLAIM_CAP. The display is the legacy cap, byte
  // for byte — identity rides the separate claimKey field instead (RUN-180).
  it('an over-cap claim parses to the exact pre-RUN-180 display — bare ellipsis, no suffix', () => {
    const [f] = parseFindings(`FINDING 1 [High] a.ts:1: ${'x'.repeat(300)}`);
    expect(f!.claim).toBe(`${'x'.repeat(239)}…`);
    expect(f!.claimKey).toBe('x'.repeat(300)); // the full normalized text, in a field of its own
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
    'FINDING 1 [High] src/gate.ts:12: the contest gate bundles two separately-answerable defects [sub-claims: 2]\n' +
    'FINDING 1a: the eligibility check accepts a response naming a nonexistent finding\n' +
    'FINDING 1b: the entry cap can drop a terminal finding before a PASS\n' +
    'VERDICT: FAIL';

  // The canonical set is claim TEXT in report order (the structural settlement): a letter is the
  // line's position, enforced a, b, c… by the parse, so nothing downstream ever stores one. The
  // `[sub-claims: 2]` certificate is consumed and STRIPPED — ledger identity carries prose alone.
  it('attaches lettered sub-claim lines to the finding their number names', () => {
    expect(parseFindings(REPORT)).toEqual([
      {
        id: 1,
        severity: 'High',
        requirements: [],
        location: 'src/gate.ts:12',
        claim: 'the contest gate bundles two separately-answerable defects',
        subclaims: [
          'the eligibility check accepts a response naming a nonexistent finding',
          'the entry cap can drop a terminal finding before a PASS',
        ],
      },
    ]);
  });

  // A CRLF report is the same report: line endings are normalized at the parse chokepoint,
  // because a stray `\r` sat exactly where the certificate's `$` and the strict shape's anchors
  // look — the numbered findings still parsed (multiline `$` forgives `\r`) while every
  // enumeration silently voided, a transport formatting fact defeating the format's own rules.
  it('a CRLF report keeps its enumeration — line endings are normalized at the chokepoint', () => {
    const out = parseFindings(REPORT.replaceAll('\n', '\r\n'));
    expect(out[0]!.claim).toBe('the contest gate bundles two separately-answerable defects');
    expect(out[0]!.subclaims).toEqual([
      'the eligibility check accepts a response naming a nonexistent finding',
      'the entry cap can drop a terminal finding before a PASS',
    ]);
  });

  it('a CRLF response block parses like its LF twin', () => {
    const out = parseFindingResponses(
      'FINDING 1a: CONTESTED src/x.ts:9 — covered\r\nFINDING 1b: FIXED b.ts:1 — done\r\n',
    );
    expect(out.map((r) => [r.subclaim, r.status, r.pointer])).toEqual([
      ['a', 'contested', 'src/x.ts:9'],
      ['b', 'fixed', 'b.ts:1'],
    ]);
  });

  // The completeness certificate is what closes the composed-malformation class the shape nets
  // cannot: a mangled line — whatever it mangles into, including shapes indistinguishable from
  // prose — is simply not counted, and the mismatch voids the whole enumeration.
  it('letters without a [sub-claims: n] certificate are never kept', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class\nFINDING 1a: half one\nFINDING 1b: half two',
    );
    expect(out[0]!.subclaims).toEqual([]);
    expect(out[0]!.claim).toBe('the class');
  });

  it('a certificate that does not match the parsed count voids — over and under', () => {
    for (const [decl, lines] of [
      ['3', 'FINDING 1a: half one\nFINDING 1b: half two'], // declared 3, one line mangled away
      ['1', 'FINDING 1a: half one\nFINDING 1b: half two'], // declared fewer than written
    ] as const) {
      const out = parseFindings(`FINDING 1 [High] a.ts:1: the class [sub-claims: ${decl}]\n${lines}`);
      expect(out[0]!.subclaims).toEqual([]);
      expect(out[0]!.claim).toBe('the class'); // the certificate is stripped even when it voids
    }
  });

  // The composed shapes only ABSENCE can see: a sibling whose letter survives solely as line
  // decoration (`(b) FINDING 1 — …`) wears no label a net can attribute — it reads as prose
  // quoting the record — so the certificate is what voids it: intended but unparsed → not
  // counted → the whole enumeration voids, never a kept subset. (Its spaced-label sibling,
  // `(b) FINDING 1 b — …`, is since caught by net four wherever it sits — see below.)
  it('a mangled sibling invisible to every net still voids — the certificate counts its absence', () => {
    const spaced = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: claim A\n' +
        '(b) FINDING 1 — claim B',
    );
    expect(spaced[0]!.subclaims).toEqual([]);
    const dupLabel = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 3]\n' +
        'FINDING 1a: claim A\n' +
        'FINDING 1b: claim B\n' +
        '(b) FINDING 1b — distinct claim C',
    );
    expect(dupLabel[0]!.subclaims).toEqual([]);
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
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
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
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: a well-formed sub-claim\n' +
        'FINDING 1aa: two letters',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subclaims).toEqual([]);
  });

  // A spaced label is a lettered-INTENT shape the strict form rejects, so the detector must see
  // it: invisible, it would coexist with a valid `FINDING 1a:` and the kept sibling would read as
  // the complete enumeration — the kept-subset escape through the detector, second edition.
  it('a spaced label (FINDING 1 b:) voids the WHOLE enumeration — a valid sibling must not survive it', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: a well-formed sub-claim\n' +
        'FINDING 1 b: the letter drifted off the number',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subclaims).toEqual([]);
  });

  // There is no malformed-label detector to slip past: every line whose first LETTERS are
  // `FINDING <n>` that is neither the numbered FINDING line nor the strict sub-claim shape voids
  // the enumeration. Each shape below is an edition of the escape a detector allowlist leaked
  // (spaced, parenthesized, trailing word-character, decorated, …) — and the point of classifying
  // instead of detecting is that the list below is examples, not the rule.
  it('any malformed label voids the enumeration — a valid sibling never survives as the whole', () => {
    for (const bad of [
      'FINDING 1-b: hyphenated letter',
      'FINDING 1.b: dotted letter',
      'FINDING 1(b): parenthesized letter',
      'FINDING 1_b: underscored letter',
      'FINDING 1b_: letter with a trailing underscore',
      'FINDING 1b2: letter with a trailing digit',
      'FINDING 1 (b): spaced and parenthesized letter',
      'FINDING 1 -- b: arbitrary junk before the letter',
      'FINDING 1', // a bare number line letters nothing and answers nothing
      // Markdown decoration is a letterless prefix, so the head net sees these — an anchor that
      // required line-start whitespace left `- FINDING 1b:` invisible, and the kept sibling read
      // as the complete enumeration (the kept-subset escape through the anchor itself).
      '- FINDING 1b: bulleted letter',
      '* FINDING 1b: starred letter',
      '> FINDING 1b: quoted letter',
      '**FINDING 1b:** bolded letter',
      '2. FINDING 1b: numbered-list letter',
      '  — FINDING 1b: em-dashed letter',
      // Decoration WEARING letters slips the head net (its prefix contains a letter), which was
      // the next edition of the same escape — so the near-colon token net catches the label
      // itself, anywhere in the line, and the two escapes do not compose inside its window.
      '(b) FINDING 1b: alphabetically decorated letter',
      '(b) FINDING 1 b: decorated AND spaced letter',
      '(b) FINDING 1(b): decorated AND parenthesized letter',
      'Note: FINDING 1b: a word before the token',
      'see FINDING 1b: quoting a sub-claim line mid-prose',
      // Decoration can also SWALLOW the colon — lettered prefix defeats the head net, no colon
      // defeats the token net — which is why the out-of-range label net exists: a label glued to
      // the number that names no recorded letter voids, colon or no colon.
      '(b) FINDING 1b — decorated letter with the colon swallowed',
      'see FINDING 1b — a letter no line recorded',
      'Note: FINDING 1b2 — mutated label, colon replaced',
      '(b) FINDING 1b_ — trailing junk, colon replaced',
    ]) {
      const out = parseFindings(
        `FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\nFINDING 1a: well-formed\n${bad}`,
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.subclaims).toEqual([]);
    }
  });

  // The boundary's other side, equally deliberate: a MID-SENTENCE mention has words before the
  // token and never voids. Reports narrate their findings by number — voiding on mention would
  // kill every enumeration in any report that explains itself, and a mention records nothing a
  // partial contest could clear, so leaving it harmless is the safe direction too.
  // Narration lives ABOVE the findings (the prompt's own instruction) or below the structural
  // lines — a mention by number there is harmless prose, exactly as before.
  it('a prose mention of FINDING <n> outside its zone does not void its enumeration', () => {
    const out = parseFindings(
      'The escape described in FINDING 1 is the subject of this report.\n' +
        'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 1b: half two',
    );
    expect(out[0]!.subclaims).toEqual(['half one', 'half two']);
  });

  it('narration below the next structural line is harmless — the zone ended there', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 1b: half two\n' +
        'VERDICT: FAIL\n' +
        'The escape described in FINDING 1 is the subject of this report.',
    );
    expect(out[0]!.subclaims).toEqual(['half one', 'half two']);
  });

  // The EMPTY ZONE: from the block's end to the next structural line, only blank lines may
  // appear. A mangled sibling is written into its own finding's territory; a stale certificate
  // excludes it by fiat, but position still sees it — ANY content line in the zone voids, even
  // innocent prose, because the two are indistinguishable by construction. A lost enumeration is
  // the safe degradation; a kept subset is the escape.
  it('a content line in the finding’s zone voids — even innocent prose', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 1b: half two\n' +
        'The escape described in FINDING 1 is the subject of this report.',
    );
    expect(out[0]!.subclaims).toEqual([]);
  });

  // The stale-certificate escape, closed by position: the certificate counts only the strict
  // line, so it certifies the subset as complete — but the mangled sibling sits in the finding's
  // own territory, where the zone rule voids the whole enumeration whatever the line mangled into
  // (`FINDING 1 b` is invisible to every net that spares prose).
  it('a stale certificate over a net-invisible mangled sibling voids — position proves the zone', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\n' +
        'FINDING 1a: recorded claim\n' +
        '(b) FINDING 1 — hidden claim, its letter surviving only as decoration',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subclaims).toEqual([]);
  });

  // …and a blank line cannot detach the sibling from its list (this round's live probe): the
  // zone runs to the next STRUCTURAL line, so blank-then-content is still content in the zone.
  it('a blank line cannot detach a mangled sibling — the whole zone must be empty', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\n' +
        'FINDING 1a: recorded claim\n' +
        '\n' +
        '(b) FINDING 1 — hidden claim, its letter surviving only as decoration',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subclaims).toEqual([]);
  });

  it('an ACCEPTANCE line closes the zone — reports answer criteria right after their findings', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 1b: half two\n' +
        'ACCEPTANCE 1: VERIFIED a.ts:1 covers it',
    );
    expect(out[0]!.subclaims).toEqual(['half one', 'half two']);
  });

  // The SPACED LABEL net, on the exact composition a gate of this task's own gestation mined:
  // decoration wearing a letter (slips the head net), the colon swallowed by a dash (slips the
  // near-colon net), the letter adrift of its number by a space (slips the glued-token net) —
  // and the whole line placed BELOW a structural line, outside every zone. A lone letter hard by
  // the number is a label wherever it sits; the stale certificate cannot bless the kept subset.
  it('a spaced lettered token past a structural line still voids — the composed probe', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\n' +
        'FINDING 1a: visible claim\n' +
        'ACCEPTANCE 1: VERIFIED a.ts:1 covers it\n' +
        '(b) FINDING 1 b — hidden claim',
    );
    expect(out[0]!.subclaims).toEqual([]);
  });

  it('spaced-label variants void outside the zone too — junk letters, brackets, any separator', () => {
    for (const bad of [
      'see FINDING 1 b — a letter adrift of its number',
      'FINDING 1 (b) — spaced and parenthesized, colon swallowed',
      '(b) FINDING 1 b2 — spaced junk label',
      '…as (b) FINDING 1 B — uppercase adrift',
      'see FINDING 1 ---------- b — the gap is unbounded, a length window is the next minable edge',
    ]) {
      const out = parseFindings(
        `FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\nFINDING 1a: half one\nVERDICT: FAIL\n${bad}`,
      );
      expect(out[0]!.subclaims).toEqual([]);
    }
  });

  // …while a mention whose next word is a real WORD stays harmless — a lone letter is the tell
  // (`a, b, c…` is what the format is made of); a following letter makes it prose. The lone
  // single-letter word ('…FINDING 1 a subtle leak…') is the deliberate cost, priced like every
  // other net cost: a dull single-claim degradation, never a kept subset.
  it('a mention followed by a real word does not trip the spaced-label net', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 1b: half two\n' +
        'VERDICT: FAIL\n' +
        'see FINDING 1 before merging; FINDING 1 holds either way — FINDING 1, in short, stands.',
    );
    expect(out[0]!.subclaims).toEqual(['half one', 'half two']);
  });

  // No in-range sparing: a recorded letter can be WORN by a distinct unrecorded claim, so a
  // lettered token off the finding's own lines always voids — narration names letters as `(a)`,
  // the form every render uses, or by claim text. Placed below VERDICT, outside the zone, so this
  // pins the NET alone: the lettered token itself is what voids.
  it('a lettered mention off the finding’s own lines voids — even in-range, even outside the zone', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 1b: half two\n' +
        'VERDICT: FAIL\n' +
        'Here FINDING 1a is contested while (b) stands on the same evidence.',
    );
    expect(out[0]!.subclaims).toEqual([]);
  });

  // The refutation of the spared-mention theory: a mangled sibling can wear a letter the
  // enumeration DOES record, and a certificate that counts only the strict line then blesses the
  // kept subset — the distinct second claim escaping unrecorded. The worn letter voids the whole.
  it('a distinct claim wearing a recorded letter voids — a stale certificate cannot keep the subset', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\n' +
        'FINDING 1a: first\n' +
        '(b) FINDING 1a — distinct second',
    );
    expect(out[0]!.subclaims).toEqual([]);
  });

  it('an out-of-range lettered mention voids — it is an intended sibling the nets could not read', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\n' +
        'FINDING 1a: half one\n' +
        'as FINDING 1c argues, the same gate leaks elsewhere too',
    );
    expect(out[0]!.subclaims).toEqual([]);
  });

  // The finding's OWN lines are the one place a lettered token is format rather than mutation: the
  // numbered FINDING line quoting its own letters (a claim ABOUT the format does exactly this) and
  // the strict lines themselves must not void the enumeration they are part of.
  it('a finding’s own head line quoting its letters does not void its enumeration', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the parse must keep FINDING 1a distinct [sub-claims: 2]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 1b: half two',
    );
    expect(out[0]!.subclaims).toEqual(['half one', 'half two']);
  });

  // …but another finding's line is not this finding's own: a lettered token there is narration
  // about it, prose-indistinguishable from a mangled sibling, and voids it like any other.
  it('a lettered token on ANOTHER finding’s strict line voids the finding it names', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: one [sub-claims: 1]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 2 [High] b.ts:1: two [sub-claims: 1]\n' +
        'FINDING 2a: overlaps the claim of FINDING 1a above',
    );
    expect(out[0]!.subclaims).toEqual([]); // voided by the token on 2's line
    expect(out[1]!.subclaims).toEqual(['overlaps the claim of FINDING 1a above']); // 2's own line records
  });

  // The label must start with a non-digit, so `FINDING 12` is a mention of finding 12 — never
  // finding 1 wearing label `2` — and a longer number cannot void a shorter one's enumeration.
  it('a mention of a longer finding number is not a label on the shorter one', () => {
    const out = parseFindings(
      'see FINDING 12 in the previous report for background\n' +
        'FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\n' +
        'FINDING 1a: half one',
    );
    expect(out[0]!.subclaims).toEqual(['half one']);
  });

  // The token net keys on a colon NEAR the number — label-intent — so a colon that is ordinary
  // sentence structure, further along the line, stays prose and spares the enumeration.
  it('a prose mention with a far-away colon does not void either', () => {
    const out = parseFindings(
      'See FINDING 1 for the full chain of evidence: it holds either way.\n' +
        'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 1b: half two',
    );
    expect(out[0]!.subclaims).toEqual(['half one', 'half two']);
  });

  // The report's own `ESCALATE STRUCTURAL FINDING <n>:` line is format-legal and asserts the
  // finding — it letters nothing and must not void the letters it escalates over.
  it('an ESCALATE STRUCTURAL line does not void the finding it escalates', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 1b: half two\n' +
        'ESCALATE STRUCTURAL FINDING 1: the promise leaks with no chokepoint — a.ts:1, b.ts:2, c.ts:3',
    );
    expect(out[0]!.subclaims).toEqual(['half one', 'half two']);
  });

  // The strict shapes are checked WITH their number: finding 2's sub-claim line whose claim text
  // quotes `FINDING 1:` is a recorder for 2 and a voider for 1 — never a recorder for 1.
  it('a sub-claim line mentioning another finding near-colon voids that finding, not itself', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: one [sub-claims: 2]\n' +
        'FINDING 1a: half one\n' +
        'FINDING 1b: half two\n' +
        'FINDING 2 [High] b.ts:1: two [sub-claims: 1]\n' +
        'FINDING 2a: overlaps FINDING 1: the same gate',
    );
    expect(out[0]!.subclaims).toEqual([]); // voided by the quoted near-colon token
    expect(out[1]!.subclaims).toEqual(['overlaps FINDING 1: the same gate']); // recorded for its own number
  });

  // The deliberate cost of the wider net: a PROSE line that happens to start `FINDING 1 rests…`
  // voids that finding's enumeration. Degrading to the single-claim finding is current behaviour
  // and always a correct way to record it; a kept subset is the escape. Never an error.
  it('a prose line starting FINDING <n> degrades the finding to single-claim, never to an error', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\n' +
        'FINDING 1a: a well-formed sub-claim\n' +
        'FINDING 1 rests on the same evidence either way',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subclaims).toEqual([]);
  });

  it('a duplicated letter voids the enumeration — a response naming it would be ambiguous', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: c [sub-claims: 2]\nFINDING 1a: first version\nFINDING 1a: second version',
    );
    expect(out[0]!.subclaims).toEqual([]);
  });

  // Letters are position (the settlement): a, b, c… in report order, no gaps, no reordering. A
  // label that breaks the sequence is an intended-but-invalid enumeration like a decorated one —
  // honouring it would make the letter carry information position does not, i.e. state.
  it('an out-of-sequence letter voids the enumeration', () => {
    for (const bad of [
      'FINDING 1b: starts at b\nFINDING 1a: then a', // reordered
      'FINDING 1a: first\nFINDING 1c: skips b', // a gap
      'FINDING 1b: only line, no a', // starts past a
    ]) {
      const out = parseFindings(`FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n${bad}`);
      expect(out[0]!.subclaims).toEqual([]);
    }
  });

  // Identity is claim text, so one claim under two letters is not separately answerable — the
  // whole enumeration degrades rather than leaving an ambiguous pair a response could split.
  it('the same claim under two letters voids the enumeration', () => {
    const out = parseFindings(
      'FINDING 1 [High] a.ts:1: the class [sub-claims: 2]\n' +
        'FINDING 1a: the same words\n' +
        'FINDING 1b: the same words',
    );
    expect(out[0]!.subclaims).toEqual([]);
  });

  // More separately-answerable claims than the cap is several findings — and the cap DROPS the
  // enumeration rather than slicing it: a kept (a)–(d) beside a silently cut (e) would let the
  // contest clear four letters while the fifth claim went unrecorded.
  it('more sub-claims than the cap drops the enumeration, not the tail', () => {
    const letters = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => `FINDING 1${l}: claim ${l}`).join('\n');
    const out = parseFindings(`FINDING 1 [High] a.ts:1: the class [sub-claims: 6]\n${letters}`);
    expect(out[0]!.subclaims).toEqual([]);
  });

  it('an enumeration at the cap is kept whole', () => {
    const letters = ['a', 'b', 'c', 'd'].map((l) => `FINDING 1${l}: claim ${l}`).join('\n');
    const out = parseFindings(`FINDING 1 [High] a.ts:1: the class [sub-claims: 4]\n${letters}`);
    expect(out[0]!.subclaims).toEqual(['claim a', 'claim b', 'claim c', 'claim d']);
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
  const SF = (id: number, subclaims: string[], location = `f${id}.ts:1`) => ({
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
  const AB = ['claim a', 'claim b'];

  // A RESPONSE letter is resolved at the fold boundary into the claim at that POSITION — the
  // report's own lettering, which the parse made positional — and dies there: the entry stores
  // claim text and adjudication only (the structural settlement).
  it('answers fold per sub-claim; the unaddressed one stays unanswered', () => {
    const led = buildLedger([], [SF(1, AB)], [SR(1, 'b', 'contested', 'x.ts:1')], 1);
    expect(led[0]!.subclaims.map((s) => [s.claim, s.status, s.pointer])).toEqual([
      ['claim a', 'unanswered', null],
      ['claim b', 'contested', 'x.ts:1'],
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
    expect(round2[0]!.subclaims.map((s) => [s.claim, s.status])).toEqual([
      ['claim a', 'contested'],
      ['claim b', 'unanswered'],
    ]);
  });

  // The settlement's own acceptance case: a fresh reviewer that re-letters or re-orders the same
  // claims changes NOTHING — identity is the claim's wording, letters are re-derived from the new
  // order, and every carried adjudication lands on the claim it answered.
  it('a re-ordered re-raise keeps every adjudication with its claim, not its letter', () => {
    const round1 = buildLedger([], [SF(1, AB)], [SR(1, 'b', 'contested', 'b.ts:9', 'refuted')], 1);
    const round2 = buildLedger(round1, [SF(1, ['claim b', 'claim a'])], [], 2);
    expect(round2[0]!.subclaims.map((s) => [s.claim, s.status])).toEqual([
      ['claim b', 'contested'], // now first — and still the rebutted one
      ['claim a', 'unanswered'],
    ]);
  });

  // May MISS, never INVENT: answers carry by the sub-claim's WORDING, not its letter — a fresh
  // reviewer that letters a genuinely different claim (a) must not inherit old (a)'s rebuttal.
  // The cost of the miss is a visibly unanswered sub-claim, which a builder can answer again.
  it('a re-raise whose lettered claims are different claims does not inherit the old answers', () => {
    const round1 = buildLedger([], [SF(1, AB)], [SR(1, 'a', 'contested', 'a.ts:9')], 1);
    const round2 = buildLedger(round1, [SF(1, ['an entirely different assertion'])], [], 2);
    // The new claim takes the first position with NO inherited answer; held 'claim a' — contested,
    // and no longer asserted by the new enumeration — is dropped as settled by both sides, while
    // held 'claim b', still unanswered, is carried rather than lost.
    expect(round2[0]!.subclaims).toEqual([
      { claim: 'an entirely different assertion', status: 'unanswered', pointer: null, reason: null },
      { claim: 'claim b', status: 'unanswered', pointer: null, reason: null },
    ]);
  });

  // The fold-level RUN-174 escape, closed: a re-raise that repeats only SOME held claims used to
  // replace the set wholesale, so an unanswered claim vanished exactly when the terminal round
  // enumerated the claims it cared about — and the candidacy gate can only keep standing what was
  // RECORDED. The uncovered unanswered claim now carries, still visibly standing, behind the new
  // enumeration in the record's order.
  it('a partial re-enumeration carries the held unanswered claim instead of dropping it', () => {
    const round1 = buildLedger([], [SF(1, AB)], [SR(1, 'b', 'contested', 'b.ts:9', 'refuted')], 1);
    // The terminal re-raise enumerates ONE claim — wording matching held 'claim b', whose rebuttal
    // carries — and says nothing about held 'claim a'.
    const round2 = buildLedger(round1, [SF(1, ['claim b'])], [], 2);
    expect(round2[0]!.subclaims).toEqual([
      { claim: 'claim b', status: 'contested', pointer: 'b.ts:9', reason: 'refuted' },
      { claim: 'claim a', status: 'unanswered', pointer: null, reason: null },
    ]);
  });

  // A held claim past this report's own lines stays answerable at the position the record shows
  // for it: the report re-lists only the first claim, and the builder's (b) — the second position,
  // which the report's single line does not shadow — lands on the held second claim.
  it('a carried sub-claim past the report’s lines is answerable at its record position', () => {
    const round1 = buildLedger([], [SF(1, AB)], [], 1);
    const round2 = buildLedger(
      round1,
      [SF(1, ['claim a'])], // re-raise repeats only the first claim…
      [SR(1, 'b', 'contested', 'late.ts:3', 'finally answered')], // …and the builder answers (b)
      2,
    );
    expect(round2[0]!.subclaims).toEqual([
      { claim: 'claim a', status: 'unanswered', pointer: null, reason: null },
      { claim: 'claim b', status: 'contested', pointer: 'late.ts:3', reason: 'finally answered' },
    ]);
  });

  // The union is capped, and the cap never slices: a union it cannot hold keeps the HELD set
  // whole and drops the new enumeration — all-or-nothing (the parse-side rule, one fold up),
  // because a sliced union is a kept subset the contest could clear around.
  it('a union past the ledger cap keeps the held set whole rather than slicing', () => {
    const claims = (tag: string) => ['a', 'b', 'c', 'd'].map((l) => `${tag} claim ${l}`);
    const round1 = buildLedger([], [SF(1, claims('one'))], [], 1);
    const round2 = buildLedger(round1, [SF(1, claims('two'))], [], 2); // union = 8, at the cap
    expect(round2[0]!.subclaims).toHaveLength(8);
    const round3 = buildLedger(round2, [SF(1, claims('three'))], [], 3); // union would be 12
    expect(round3[0]!.subclaims.map((s) => s.claim)).toEqual(round2[0]!.subclaims.map((s) => s.claim));
  });

  // …and standing whole must not cost this turn's answers: the builder — shown the record's
  // letters for standing claims — may be contesting one in the very fold that overflows. A letter
  // this round's enumeration shadows names the report in front of the builder instead (crediting
  // the held claim too would be inventing).
  it('the overflow fallback still credits this turn’s answer at the held claim’s position', () => {
    const claims = (tag: string) => ['a', 'b', 'c', 'd'].map((l) => `${tag} claim ${l}`);
    const round1 = buildLedger([], [SF(1, claims('one'))], [], 1);
    const round2 = buildLedger(round1, [SF(1, claims('two'))], [], 2); // the record now holds (a)–(h)
    const round3 = buildLedger(
      round2,
      [SF(1, claims('three'))], // overflow: the new enumeration is dropped, held set stands…
      [SR(1, 'e', 'contested', 'e.ts:9', 'answered at its record position')],
      3,
    );
    const byClaim = new Map(round3[0]!.subclaims.map((s) => [s.claim, s]));
    // (e) is the fifth record position — the first past the report's four lines: held[4].
    expect(byClaim.get('one claim a')).toMatchObject({ status: 'contested', pointer: 'e.ts:9' });
    // (a) is shadowed by this round's report — it names 'three claim a', never the held claim.
    expect(byClaim.get('two claim a')!.status).toBe('unanswered');
  });

  // The same crediting on the letterless-re-raise path: the held set is preserved AND the
  // builder's per-letter answer this turn lands on it — nothing shadows, so the letters ARE the
  // record's positions, which is what the contest record shows the builder.
  it('a letterless re-raise still folds a per-letter answer onto the held claims', () => {
    const round1 = buildLedger([], [SF(1, AB)], [], 1);
    const round2 = buildLedger(round1, [SF(1, [])], [SR(1, 'a', 'contested', 'a.ts:9', 'covered')], 2);
    expect(round2[0]!.subclaims.map((s) => [s.claim, s.status, s.pointer])).toEqual([
      ['claim a', 'contested', 'a.ts:9'],
      ['claim b', 'unanswered', null],
    ]);
  });

  // Truncation must not erase IDENTITY — and must not invent one either. The display is capped
  // with the LEGACY bare ellipsis, byte-identical (a suffix the reader did not write broke every
  // pre-RUN-180 over-cap claim's render), and the FULL normalized text rides a field of its own
  // (`key`), so two distinct long claims never alias (the bare-ellipsis cap aliased them onto one
  // text; sitting 5's 32-bit fingerprint collided — both INVENT) and (below) a verbatim re-raise
  // still recognises its own record instead of duplicating it.
  it('two distinct over-cap claims keep distinct identities — neither inherits the other’s answer', () => {
    const longReport = (tail: string) =>
      `FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\nFINDING 1a: ${'x'.repeat(250)}${tail}`;
    const [one] = parseFindings(longReport('ONE'));
    const [two] = parseFindings(longReport('TWO'));
    expect(one!.subclaims[0]).not.toEqual(two!.subclaims[0]); // raw in hand — identities exact
    const round1 = buildLedger([], [one!], [SR(1, 'a', 'contested', 'a.ts:9')], 1);
    // The record's display is the legacy cap and nothing else; the identity sits beside it whole.
    expect(round1[0]!.subclaims[0]!.claim).toBe(`${'x'.repeat(239)}…`);
    expect(round1[0]!.subclaims[0]!.key).toBe(`${'x'.repeat(250)}one`);
    const round2 = buildLedger(round1, [two!], [], 2);
    expect(round2[0]!.subclaims.map((s) => s.status)).toEqual(['unanswered']); // TWO never inherits ONE's answer
  });

  it('an exact re-raise of an over-cap claim recognises its held record — one row, answer carried', () => {
    const report = `FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\nFINDING 1a: ${'x'.repeat(250)}SAME`;
    const [f1] = parseFindings(report);
    const round1 = buildLedger([], [f1!], [SR(1, 'a', 'contested', 'a.ts:9')], 1);
    const [f2] = parseFindings(report); // the same wording, re-raised verbatim
    const round2 = buildLedger(round1, [f2!], [], 2);
    expect(round2[0]!.subclaims).toHaveLength(1); // one claim, one durable record — no duplicate row
    expect(round2[0]!.subclaims[0]).toMatchObject({ status: 'contested', pointer: 'a.ts:9' });
  });

  // Identity has no bound of its own — it is exactly the claim the reviewer wrote on one report
  // line — because any bound is a cliff: at bound+1 an exact re-raise stopped matching and a
  // partly answered record stopped carrying. One claim, one durable row, at any length.
  it('an exact re-raise of an arbitrarily long claim matches — one durable row, at any length', () => {
    const huge = `FINDING 1 [High] a.ts:1: the class [sub-claims: 1]\nFINDING 1a: ${'y'.repeat(1200)}`;
    const [f1] = parseFindings(huge);
    const round1 = buildLedger([], [f1!], [SR(1, 'a', 'contested', 'a.ts:9')], 1);
    expect(round1[0]!.subclaims[0]!.key).toBe('y'.repeat(1200)); // stored whole, never shortened
    const [f2] = parseFindings(huge);
    const round2 = buildLedger(round1, [f2!], [], 2);
    expect(round2[0]!.subclaims.map((s) => [s.status, s.pointer])).toEqual([['contested', 'a.ts:9']]);
  });

  // The same losslessness at PARENT grain — the cliff a gate of this task's own gestation mined:
  // a very long parent claim with no identity lost its partly answered record on an exact
  // LETTERLESS terminal re-raise, degrading the finding to the bare-contest path right before
  // candidacy. The claimKey carries whole, so the record survives the re-raise.
  it('an exact letterless re-raise of a very long parent claim keeps its partly answered record', () => {
    const parent = 'w'.repeat(1200);
    const [f1] = parseFindings(
      `FINDING 1 [High] a.ts:1: ${parent} [sub-claims: 2]\nFINDING 1a: half one\nFINDING 1b: half two`,
    );
    const round1 = buildLedger([], [f1!], [SR(1, 'a', 'contested', 'a.ts:9')], 1);
    const [f2] = parseFindings(`FINDING 1 [High] a.ts:1: ${parent}`); // letterless, wording exact
    const round2 = buildLedger(round1, [f2!], [], 2);
    expect(round2[0]!.subclaims.map((s) => [s.claim, s.status])).toEqual([
      ['half one', 'contested'],
      ['half two', 'unanswered'],
    ]);
  });

  // The PARENT claim's identity crosses the cap the same way (Finding.claimKey → entry.claimKey):
  // a verbatim over-cap re-raise is a wording match trustedCarry can trust, so the held sub-claim
  // record rides — where the display alone, capped to the shared ellipsis, could never say so.
  it('a verbatim re-raise of an over-cap parent claim keeps its held sub-claim record', () => {
    const report = `FINDING 1 [High] a.ts:1: ${'the gate '.repeat(40)}leaks [sub-claims: 1]\nFINDING 1a: half one`;
    const [f1] = parseFindings(report);
    expect(f1!.claim.endsWith('…')).toBe(true); // the display really was cut
    const round1 = buildLedger([], [f1!], [SR(1, 'a', 'contested', 'a.ts:9')], 1);
    const [f2] = parseFindings(report);
    const round2 = buildLedger(round1, [f2!], [], 2);
    expect(round2[0]!.subclaims.map((s) => [s.claim, s.status])).toEqual([['half one', 'contested']]);
  });

  it('a legacy bare-ellipsis persisted claim still never carries — two old long claims may alias', () => {
    const held: LedgerEntry = {
      id: 1,
      round: 1,
      severity: 'High',
      requirements: [],
      location: 'f1.ts:1',
      claim: 'the class',
      status: 'unanswered',
      pointer: null,
      reason: null,
      // As the ellipsis era persisted it: the tail — the identity — is gone.
      subclaims: [{ claim: `${'x'.repeat(239)}…`, status: 'unanswered', pointer: null, reason: null }],
    };
    const round2 = buildLedger([held], [SF(1, [`${'x'.repeat(250)}SAME`])], [], 2);
    // The re-raise takes its own row and the held row rides beside it, both visibly unanswered —
    // a duplicate is the documented cost of the lossy legacy cap; an invented carry never is.
    expect(round2[0]!.subclaims.map((s) => s.status)).toEqual(['unanswered', 'unanswered']);
    expect(round2[0]!.subclaims).toHaveLength(2);
  });

  // The carry key is the claim's FULL wording, not a 60-char prefix: two long claims that diverge
  // only past the prefix must not both inherit one rebuttal — an answer nobody gave to one of them.
  it('two distinct claims sharing a long prefix do not share a carried answer', () => {
    const prefix = 'the eligibility filter in contestTerminalFindings accepts a response naming ';
    const round1 = buildLedger(
      [],
      [SF(1, [`${prefix}a finding that does not exist`])],
      [SR(1, 'a', 'contested', 'a.ts:9')],
      1,
    );
    const round2 = buildLedger(round1, [SF(1, [`${prefix}an id from another round`])], [], 2);
    expect(round2[0]!.subclaims.map((s) => s.status)).toEqual(['unanswered']);
  });

  // The same prefix-aliasing refusal one level UP: matchIndex's prose rule keys ENTRIES on a
  // 60-char prefix (legacy identity, unchanged), but two long PARENT claims diverging past it can
  // be two real findings — so the held sub-claim record must not ride that match. Carrying it let
  // a distinct terminal finding inherit contested letters and reach the fresh look on contests
  // nobody made about it. The entry still merges (may-miss-never-invent governs the RECORD, and a
  // dropped record is a visible miss); the letters do not.
  it('a prefix-aliased parent claim does not hand its sub-claim record to a different claim', () => {
    const prefix = 'the candidacy gate in contestTerminalFindings clears a finding whose letters ';
    const round1 = buildLedger(
      [],
      [{ ...SF(1, AB), claim: `${prefix}were contested in an earlier round` }],
      [SR(1, 'a', 'contested', 'a.ts:9'), SR(1, 'b', 'contested', 'b.ts:9')],
      1,
    );
    const round2 = buildLedger(
      round1,
      [{ ...SF(1, []), claim: `${prefix}nobody ever raised against this claim` }],
      [],
      2,
    );
    expect(round2).toHaveLength(1); // entry identity: the prose prefix still matches, as it always did
    expect(round2[0]!.claim).toContain('nobody ever raised'); // the latest wording wins the entry…
    expect(round2[0]!.subclaims).toEqual([]); // …but the contested record does not transfer
  });

  // …while the trustworthy matches keep carrying: identical full wording, or the RUN-147
  // requirement key — a shared id at a specific location — which is how a paraphrased letterless
  // re-raise keeps its half-answered record (the RUN-174 protection this gate must not undo).
  it('a paraphrased re-raise sharing a requirement still carries the sub-claim record', () => {
    const round1 = buildLedger(
      [],
      [{ ...SF(1, AB), requirements: ['R-7'] }],
      [SR(1, 'a', 'contested', 'a.ts:9')],
      1,
    );
    const round2 = buildLedger(
      round1,
      [{ ...SF(1, []), claim: 'entirely new words for the same defect', requirements: ['R-7'] }],
      [],
      2,
    );
    expect(round2).toHaveLength(1);
    expect(round2[0]!.subclaims.map((s) => [s.claim, s.status])).toEqual([
      ['claim a', 'contested'],
      ['claim b', 'unanswered'],
    ]);
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
    expect(round2[0]!.subclaims.map((s) => [s.claim, s.status])).toEqual([
      ['claim a', 'contested'],
      ['claim b', 'unanswered'],
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

  // Byte-identity is a statement about the TEXT surfaces — what reviewers and humans are handed —
  // not about in-memory objects, which gained `subclaims` exactly as they gained `requirements`
  // at RUN-147 (the sanctioned additive-field precedent). This pins the rendered text for a
  // legacy entry to the exact pre-RUN-180 output, character for character.
  it('renders a legacy entry byte-identically to the pre-sub-claim output', () => {
    const [f] = parseFindings('FINDING 1 [High] src/a.ts:1: the guard is missing');
    const led = buildLedger([], [f!], parseFindingResponses('FINDING 1: CONTESTED src/a.ts:9 — covered'), 1);
    expect(renderLedger(led)).toBe(
      '  [round 1, High] src/a.ts:1 — the guard is missing\n' +
        '      → builder: CONTESTED (src/a.ts:9) — covered',
    );
  });

  // Degradation splits by grain, and the split is the safety direction (the parse chokepoint's
  // all-or-nothing rule at the other boundary where sub-claim state is born): a malformed ENTRY
  // voids the whole list to the single-claim entry — never the well-formed subset, which is
  // clearable around the claim it dropped — and a list longer than the fold can ever write voids
  // rather than slicing, for the same reason the cap never slices anywhere else.
  it('a malformed persisted entry voids the whole sub-claim list — never a kept subset', () => {
    expect(subclaimsOf({ subclaims: ['not-an-object', { claim: 'ok' }] })).toEqual([]);
    expect(subclaimsOf({ subclaims: [{ claim: 'ok' }, { letter: 'b' }] })).toEqual([]);
    const nine = Array.from({ length: 9 }, (_, i) => ({ claim: `c${i}` }));
    expect(subclaimsOf({ subclaims: nine })).toEqual([]); // over the cap: voided, never sliced
    expect(subclaimsOf({})).toEqual([]);
  });

  // A FIELD inside a well-formed entry still degrades field by field, and toward STANDING —
  // an unknown status reads 'unanswered', a non-identity key reads unmatchable — because a
  // field's fallback can only make the claim harder to clear.
  it('fields inside a well-formed persisted entry degrade toward the standing state', () => {
    expect(subclaimsOf({ subclaims: [{ claim: 'ok', status: 'bogus', key: 42 }] })).toEqual([
      { claim: 'ok', status: 'unanswered', pointer: null, reason: null },
    ]);
    expect(subclaimsOf({ subclaims: [{ claim: 'b…', key: '' }] })[0]!.key).toBeUndefined();
  });

  // A ledger persisted by the letter-era shape (this run's own prior sittings) loads too: the
  // claim is the identity, the stray letter field is ignored, and renders re-derive the labels.
  it('a letter-era persisted entry loads claim-keyed, its stored letters ignored', () => {
    const persisted = {
      subclaims: [
        { letter: 'c', claim: 'first by position', status: 'contested', pointer: 'x.ts:1', reason: 'r' },
        { letter: 'a', claim: 'second by position', status: 'unanswered', pointer: null, reason: null },
      ],
    };
    expect(subclaimsOf(persisted)).toEqual([
      { claim: 'first by position', status: 'contested', pointer: 'x.ts:1', reason: 'r' },
      { claim: 'second by position', status: 'unanswered', pointer: null, reason: null },
    ]);
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

// The contest turn's view of the record (RUN-180): letters are not state anywhere, so a standing
// sub-claim a letterless or narrowed terminal re-raise does not repeat has no letter the builder
// could otherwise know — the rendered record is what makes it answerable, and its positional
// letters are exactly the coordinates the fold resolves a response against.
describe('renderContestRecord (RUN-180)', () => {
  const SF = (id: number, subclaims: string[], location = `f${id}.ts:1`) => ({
    id,
    severity: 'High',
    requirements: [],
    location,
    claim: 'the class',
    subclaims,
  });

  it('renders each terminal finding’s sub-claims with position-derived letters and answers', () => {
    const terminal = SF(1, ['half one', 'half two']);
    const ledger = buildLedger(
      [],
      [terminal],
      [{ id: 1, subclaim: 'b', status: 'contested' as const, pointer: 'y.ts:3', reason: 'covered' }],
      3,
    );
    const out = renderContestRecord([terminal], ledger, 3);
    expect(out).toContain('FINDING 1:');
    expect(out).toContain('(a) half one — no answer recorded');
    expect(out).toContain('(b) half two — CONTESTED (y.ts:3)');
  });

  it('shows the carried claims of a letterless terminal re-raise — the letters the report lacks', () => {
    const round1 = buildLedger([], [SF(1, ['half one', 'half two'])], [], 1);
    const terminal = SF(1, []); // the terminal reviewer re-raises without the letters
    const ledger = buildLedger(round1, [terminal], [], 2);
    const out = renderContestRecord([terminal], ledger, 2);
    expect(out).toContain('(a) half one — no answer recorded');
    expect(out).toContain('(b) half two — no answer recorded');
  });

  it('is null when no terminal finding carries sub-claims — every pre-RUN-180 report', () => {
    const terminal = SF(1, []);
    const ledger = buildLedger([], [terminal], [], 1);
    expect(renderContestRecord([terminal], ledger, 1)).toBeNull();
  });

  it('reconciledEntry matches only the entry the fold wrote for this finding and round', () => {
    const terminal = SF(1, ['half one']);
    const ledger = buildLedger([], [terminal], [], 2);
    expect(reconciledEntry(ledger, terminal, 2)?.claim).toBe('the class');
    expect(reconciledEntry(ledger, terminal, 1)).toBeUndefined(); // another round's entry is not this one
    expect(reconciledEntry(ledger, { ...terminal, claim: 'reworded' }, 2)).toBeUndefined();
  });
});

// The contest turn lands on the RECORD (RUN-180): the builder was shown the reconciled entry's
// claims lettered by position, and the prompt calls that lettering authoritative — so the
// application resolves letters against the entry, never re-runs the union, and never reads the
// terminal report's own enumeration as the coordinate system.
describe('applyContestResponses', () => {
  const SF = (id: number, subclaims: string[]) => ({
    id,
    severity: 'High',
    requirements: [],
    location: `f${id}.ts:1`,
    claim: 'the class',
    subclaims,
  });
  const SR = (id: number, subclaim: string | null, pointer: string) => ({
    id,
    subclaim,
    status: 'contested' as const,
    pointer,
    reason: 'because',
  });

  it('resolves letters against the record even where the report’s own lettering diverges — overflow', () => {
    const claims = (tag: string) => ['a', 'b', 'c', 'd'].map((l) => `${tag} claim ${l}`);
    const round1 = buildLedger([], [SF(1, claims('one'))], [], 1);
    const round2 = buildLedger(round1, [SF(1, claims('two'))], [], 2); // the record holds (a)–(h)
    const terminal = SF(1, claims('three'));
    const raised = buildLedger(round2, [terminal], [], 3); // overflow: held set stands, report's claims dropped
    const held = [...claims('two'), ...claims('one')]; // round 2's union order: its own claims first
    expect(raised[0]!.subclaims.map((s) => s.claim)).toEqual(held);
    // The record showed (a)–(h) for the HELD claims; the builder contests every displayed letter.
    const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const answered = applyContestResponses(
      raised,
      [terminal],
      letters.map((l) => SR(1, l, `${l}.ts:1`)),
      3,
    );
    // Every answer lands on the claim the record displayed at that letter — none discarded against
    // the dropped report enumeration ('three claim …'), which is not in the record at all.
    expect(answered[0]!.subclaims.map((s) => [s.claim, s.status, s.pointer])).toEqual(
      held.map((c, i) => [c, 'contested', `${letters[i]}.ts:1`]),
    );
  });

  it('a bare response lands on the entry as whole-finding evidence and credits no letter', () => {
    const terminal = SF(1, ['half one', 'half two']);
    const raised = buildLedger([], [terminal], [], 3);
    const answered = applyContestResponses(raised, [terminal], [SR(1, null, 'whole.ts:1')], 3);
    expect(answered[0]!.status).toBe('contested');
    expect(answered[0]!.subclaims.every((s) => s.status === 'unanswered')).toBe(true);
  });

  it('a letter past the record resolves to nothing — a visible miss, never an invented credit', () => {
    const terminal = SF(1, ['half one']);
    const raised = buildLedger([], [terminal], [], 3);
    const answered = applyContestResponses(raised, [terminal], [SR(1, 'c', 'c.ts:1')], 3);
    expect(answered[0]!.subclaims.map((s) => s.status)).toEqual(['unanswered']);
  });

  it('the claim set is fixed at the terminal fold — a contest adds answers, never claims', () => {
    const terminal = SF(1, ['half one', 'half two']);
    const raised = buildLedger([], [terminal], [], 3);
    const answered = applyContestResponses(raised, [terminal], [SR(1, 'a', 'a.ts:1')], 3);
    expect(answered[0]!.subclaims.map((s) => [s.claim, s.status])).toEqual([
      ['half one', 'contested'],
      ['half two', 'unanswered'],
    ]);
  });

  it('a finding whose entry did not survive the fold has nothing to land on — it stands', () => {
    const terminal = SF(1, ['half one']);
    // No raise-time entry for this finding/round: the application must not invent one.
    const answered = applyContestResponses([], [terminal], [SR(1, 'a', 'a.ts:1')], 3);
    expect(answered).toEqual([]);
  });

  it('a single-claim entry takes the bare answer exactly as the fold always recorded it', () => {
    const terminal = SF(1, []);
    const raised = buildLedger([], [terminal], [], 3);
    const answered = applyContestResponses(raised, [terminal], [SR(1, null, 'a.ts:9')], 3);
    expect(answered[0]!.status).toBe('contested');
    expect(answered[0]!.pointer).toBe('a.ts:9');
    expect(answered[0]!.subclaims).toEqual([]);
  });
});

// RUN-188. A CONTESTED pointer may name a task — `task:<key>`, "real, out of scope, tracked
// THERE" — and the DAEMON checks it mechanically, because the judging reviewer holds no Noriq
// credential and never gets one (RUN-43). The fact rides the fold BESIDE the answer it qualifies,
// renders as data for the fresh reviewer, and on persisted ledgers degrades toward UNVERIFIED —
// the one direction that cannot credit a contest (may-miss-never-invent).
describe('spin-off task-pointer facts (RUN-188)', () => {
  const FACT = (ref: string, verified: boolean, detail = 'checked') => ({ ref, verified, detail });
  const F1 = {
    id: 1,
    severity: 'High',
    requirements: [],
    location: 'a.ts:1',
    claim: 'adjacent hardening the intent never named',
    subclaims: [] as string[],
  };
  const SF = (id: number, subclaims: string[]) => ({ ...F1, id, subclaims });

  describe('taskRefsIn', () => {
    it('reads the task:<ref> vocabulary out of a free-text pointer', () => {
      expect(taskRefsIn('task:RUN-201')).toEqual({ refs: ['RUN-201'], unreadable: 0 });
      expect(taskRefsIn('src/a.ts:9, task:RUN-201')).toEqual({ refs: ['RUN-201'], unreadable: 0 });
      expect(taskRefsIn('task:task_ms54mz39')).toEqual({ refs: ['task_ms54mz39'], unreadable: 0 });
    });

    // NOT a parse-format change: the pointer was always free text, and one that names no task —
    // every response written before RUN-188 — yields nothing and folds untouched.
    it('finds nothing in a pointer that names no task', () => {
      expect(taskRefsIn('src/a.ts:9')).toEqual({ refs: [], unreadable: 0 });
      expect(taskRefsIn('commit a672b25')).toEqual({ refs: [], unreadable: 0 });
      expect(taskRefsIn('')).toEqual({ refs: [], unreadable: 0 });
    });

    // The extraction NEVER reduces the set it hands the verifier: whatever it dropped would be a
    // task claim nothing downstream could refuse to credit. Deduping loses nothing (one ref, one
    // check); the volume cap lives in the verifier, priced as an unverified fact.
    it('dedupes but never caps — every named ref reaches the verifier', () => {
      expect(taskRefsIn('task:A-1 and task:A-1 and task:B-2')).toEqual({
        refs: ['A-1', 'B-2'],
        unreadable: 0,
      });
      expect(taskRefsIn('task:A-1 task:B-2 task:C-3 task:D-4 task:E-5').refs).toHaveLength(5);
    });

    // A task-claim token no reference can be read from is COUNTED, not dropped: a claim the
    // daemon cannot read is a claim it cannot verify, and "no task named" would credit it.
    it('counts unreadable task claims instead of reading them as no claim at all', () => {
      expect(taskRefsIn('task:')).toEqual({ refs: [], unreadable: 1 });
      expect(taskRefsIn('task: RUN-201')).toEqual({ refs: [], unreadable: 1 });
      expect(taskRefsIn('task:RUN-201, task:')).toEqual({ refs: ['RUN-201'], unreadable: 1 });
    });
  });

  describe('spinOffsHold', () => {
    // Vacuous over absence on purpose: the pre-RUN-188 world — a response naming no task, a
    // persisted ledger without the field, a daemon with no lookup wired — clears (or stands)
    // exactly as it always did.
    it('is vacuous over absent facts', () => {
      expect(spinOffsHold(undefined)).toBe(true);
      expect(spinOffsHold([])).toBe(true);
    });

    it('demands every named task verified once facts are present', () => {
      expect(spinOffsHold([FACT('RUN-201', true)])).toBe(true);
      expect(spinOffsHold([FACT('RUN-201', true), FACT('BOGUS', false)])).toBe(false);
    });
  });

  it('the fold carries a response’s facts beside the answer, and the render shows the daemon line', () => {
    const rs = {
      ...parseFindingResponses('FINDING 1: CONTESTED task:RUN-201 — real, out of scope, tracked there')[0]!,
      spinOffs: [FACT('RUN-201', true, 'exists — RUN-201: Harden the guard floor (filed from THIS run)')],
    };
    const led = buildLedger([], [F1], [rs], 1);
    expect(led[0]!.spinOffs).toEqual(rs.spinOffs);
    const out = renderLedger(led);
    expect(out).toContain('→ builder: CONTESTED (task:RUN-201) — real, out of scope, tracked there');
    expect(out).toContain(
      '→ daemon: task:RUN-201 verified — exists — RUN-201: Harden the guard floor (filed from THIS run)',
    );
  });

  it('an unverified fact renders NOT verified — the pointer is shown pointing at nothing', () => {
    const rs = {
      ...parseFindingResponses('FINDING 1: CONTESTED task:BOGUS — tracked there')[0]!,
      spinOffs: [FACT('BOGUS', false, 'no such task reachable from this runner')],
    };
    const out = renderLedger(buildLedger([], [F1], [rs], 1));
    expect(out).toContain('→ daemon: task:BOGUS NOT verified — no such task reachable from this runner');
  });

  it('facts land on the sub-claim whose letter the response named, not on its siblings', () => {
    const rs = {
      id: 1,
      subclaim: 'b',
      status: 'contested' as const,
      pointer: 'task:RUN-201',
      reason: 'tracked there',
      spinOffs: [FACT('RUN-201', false, 'no such task')],
    };
    const led = buildLedger([], [SF(1, ['claim a', 'claim b'])], [rs], 1);
    expect(led[0]!.subclaims[0]!.spinOffs).toBeUndefined();
    expect(led[0]!.subclaims[1]!.spinOffs).toEqual(rs.spinOffs);
    expect(renderLedger(led)).toContain('→ daemon: task:RUN-201 NOT verified — no such task');
  });

  it('a re-raise with no response keeps the held facts beside the held pointer', () => {
    const rs = {
      ...parseFindingResponses('FINDING 1: CONTESTED task:RUN-201 — tracked')[0]!,
      spinOffs: [FACT('RUN-201', true)],
    };
    const round2 = buildLedger(buildLedger([], [F1], [rs], 1), [F1], [], 2);
    expect(round2[0]!.status).toBe('contested');
    expect(round2[0]!.spinOffs).toEqual(rs.spinOffs);
  });

  // A daemon check qualifies the pointer it ran against: carrying it onto a NEW pointer would be
  // a verification nobody ran — the invented match, one field over.
  it('a fresh answer replaces the facts, even with none to give', () => {
    const first = {
      ...parseFindingResponses('FINDING 1: CONTESTED task:RUN-201 — tracked')[0]!,
      spinOffs: [FACT('RUN-201', true)],
    };
    const second = parseFindingResponses('FINDING 1: CONTESTED src/a.ts:9 — covered by the guard')[0]!;
    const round2 = buildLedger(buildLedger([], [F1], [first], 1), [F1], [second], 2);
    expect(round2[0]!.pointer).toBe('src/a.ts:9');
    expect(round2[0]!.spinOffs).toBeUndefined();
  });

  it('applyContestResponses moves the facts with the contest answers, per letter', () => {
    const terminal = SF(1, ['half one', 'half two']);
    const raised = buildLedger([], [terminal], [], 3);
    const answered = applyContestResponses(
      raised,
      [terminal],
      [
        {
          id: 1,
          subclaim: 'a',
          status: 'contested' as const,
          pointer: 'task:RUN-201',
          reason: 'tracked',
          spinOffs: [FACT('RUN-201', true)],
        },
        { id: 1, subclaim: 'b', status: 'contested' as const, pointer: 'x.ts:1', reason: 'covered' },
      ],
      3,
    );
    expect(answered[0]!.subclaims[0]!.spinOffs).toEqual([FACT('RUN-201', true)]);
    expect(answered[0]!.subclaims[1]!.spinOffs).toBeUndefined();
  });

  // The contest record must say WHICH carried contests the candidacy gate will refuse — a prompt
  // calling an unverified-pointer contest settled would fail the builder that followed it.
  it('renderContestRecord marks a carried contest whose task pointer did not verify', () => {
    const rs = {
      id: 1,
      subclaim: 'a',
      status: 'contested' as const,
      pointer: 'task:BOGUS',
      reason: 'tracked',
      spinOffs: [FACT('BOGUS', false, 'no such task')],
    };
    const round1 = buildLedger([], [SF(1, ['half one', 'half two'])], [rs], 1);
    const terminal = SF(1, []); // a letterless terminal re-raise: the record is the only lettering
    const raised = buildLedger(round1, [terminal], [], 3);
    const out = renderContestRecord([terminal], raised, 3);
    expect(out).toContain('(a) half one — CONTESTED (task:BOGUS) [its task pointer did NOT verify');
    expect(out).toContain('(b) half two — no answer recorded');
  });

  // The persisted-degradation twins (the RUN-180 suite's contract, for this field).
  it('a persisted record without the field loads with no facts — behavior unchanged', () => {
    expect(spinOffsOf({})).toBeUndefined();
    const sub = subclaimsOf({ subclaims: [{ claim: 'ok', status: 'contested' }] })[0]!;
    expect('spinOffs' in sub).toBe(false);
    expect(spinOffsHold(sub.spinOffs)).toBe(true);
  });

  it('a persisted fact field that cannot be read degrades toward UNVERIFIED — never absent', () => {
    for (const mangled of [
      'nope',
      [],
      ['not-an-object'],
      [{ ref: 'R-1' }], // no detail
      Array.from({ length: 9 }, (_, i) => FACT(`R-${i}`, true)), // more than a writer here can produce
    ]) {
      const facts = spinOffsOf({ spinOffs: mangled });
      expect(facts).toBeDefined();
      expect(spinOffsHold(facts)).toBe(false);
    }
    // A field inside a well-formed fact degrades the same direction: a non-boolean `verified`
    // reads false, because the fallback must only ever make the claim harder to clear.
    expect(spinOffsOf({ spinOffs: [{ ref: 'R-1', detail: 'd', verified: 'yes' }] })).toEqual([
      FACT('R-1', false, 'd'),
    ]);
    // The writer's true maximum — MAX_TASK_POINTERS checked facts plus the one saturation fact
    // that prices everything past them — still loads whole.
    const atMax = ['a', 'b', 'c'].map((r) => FACT(r, true)).concat(FACT('(unchecked)', false));
    expect(spinOffsOf({ spinOffs: atMax })).toEqual(atMax);
  });
});
