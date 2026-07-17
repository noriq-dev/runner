// RUN-79: the cross-round adjudication ledger — the parsers, the merge, and the render.
import { describe, expect, it } from 'vitest';
import {
  type LedgerEntry,
  buildLedger,
  parseFindingResponses,
  parseFindings,
  renderLedger,
} from '../src/adjudication';

describe('parseFindings', () => {
  it('extracts numbered findings with severity, location, claim', () => {
    const out = parseFindings(
      'Some prose above.\n' +
        'FINDING 1 [High] src/init-project.ts:357: detectVcs runs on every init\n' +
        'FINDING 2 [Medium] src/foo.ts:92: npm assumed for every project\n' +
        'VERDICT: FAIL',
    );
    expect(out).toEqual([
      { id: 1, severity: 'High', location: 'src/init-project.ts:357', claim: 'detectVcs runs on every init' },
      { id: 2, severity: 'Medium', location: 'src/foo.ts:92', claim: 'npm assumed for every project' },
    ]);
  });

  it('tolerates a missing location and odd severity tags', () => {
    const out = parseFindings('FINDING 1 [P1] : the whole approach is wrong');
    expect(out).toEqual([{ id: 1, severity: 'P1', location: '', claim: 'the whole approach is wrong' }]);
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
  const F = (id: number, claim: string, location = `f${id}.ts:1`) => ({
    id,
    severity: 'High',
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

  it('a genuinely new finding appends', () => {
    const led = buildLedger([...buildLedger([], [F(1, 'a')], [], 1)], [F(2, 'b')], [], 2);
    expect(led.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe('renderLedger', () => {
  it('renders each entry with the builder claim as a checkable pointer, not prose', () => {
    const entries: LedgerEntry[] = [
      {
        id: 1,
        round: 1,
        severity: 'High',
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
