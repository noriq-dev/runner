import { describe, expect, it } from 'vitest';
import type { AcceptanceItem, AcceptanceOutcome, AcceptanceReport } from '../src/acceptance';
import type { Finding } from '../src/adjudication';
import { buildRepairSpec, renderRepairSpec } from '../src/repair';

// RUN-146. A reviewer's report is an argument; the builder's question is "what must be true when I
// stop?". The daemon already holds that as data (RUN-145), so the hand-back leads with it.

const item = (id: number, text: string): AcceptanceItem => ({ id, kind: 'truth', text });
const report = (...rows: Array<[number, string, AcceptanceOutcome, string]>): AcceptanceReport => ({
  entries: rows.map(([id, text, outcome, evidence]) => ({
    id,
    outcome,
    evidence,
    item: item(id, text),
  })),
});
const finding = (id: number, location: string, claim = 'something'): Finding => ({
  id,
  severity: 'High',
  location,
  claim,
});

describe('what is still outstanding', () => {
  // THE distinction, and the one prose cannot make. Told only "these criteria are not satisfied", a
  // builder rewrites working code to satisfy a gate that merely could not see it — a wasted round
  // and a worse diff.
  it('separates code that is wrong from code nothing exercised, and says what each needs', () => {
    const spec = buildRepairSpec(
      report(
        [1, 'it reaps orphans on start', 'failed', 'nothing reaps'],
        [2, 'it never pushes', 'behaviour-unverified', 'no test covers it'],
      ),
      [],
    )!;
    const out = renderRepairSpec(spec);
    expect(out).toMatch(/NOT SATISFIED[\s\S]*Change the code[\s\S]*it reaps orphans on start/);
    expect(out).toMatch(/NOT ESTABLISHED[\s\S]*usually NOT a code defect/);
    expect(out).toMatch(/prefer making it demonstrable/);
    // …and the escape hatch, or the instruction becomes "never fix an unverified criterion".
    expect(out).toMatch(/then it IS a defect: fix the code/);
  });

  // "Add a test that covers it" is satisfied by a characterization test asserting whatever the code
  // does today — which closes the criterion, passes the next gate, and ships the bug with a green
  // test guarding it. Worse than leaving it unverified, because now nobody looks again.
  it('refuses a test that merely records current behaviour as evidence', () => {
    const out = renderRepairSpec(
      buildRepairSpec(report([1, 'it never pushes', 'behaviour-unverified', 'nothing covers it']), [])!,
    );
    expect(out).toMatch(/shows the criterion HOLDS as written/);
    expect(out).toMatch(/would fail if the code stopped producing it/);
    expect(out).toMatch(/merely records what the code does today is not evidence/);
  });

  // Spending a bounded fix round on something no amount of code reaches is the round gone.
  it('names what is not the builder’s to fix, so the round is not spent discovering it', () => {
    const out = renderRepairSpec(
      buildRepairSpec(report([1, 'the deployed worker restarts', 'human-needed', 'not reachable here']), [])!,
    );
    expect(out).toMatch(/NOT YOURS THIS ROUND/);
    expect(out).toMatch(/Do not spend the round on them/);
  });

  // The next gate re-checks everything, not just the outstanding items — so "fix this" without
  // "keep that" is an invitation to trade one failure for another.
  it('counts what already passed rather than listing it', () => {
    const out = renderRepairSpec(
      buildRepairSpec(
        report(
          [1, 'it builds', 'verified', 'tsc clean'],
          [2, 'it lints', 'verified', 'biome clean'],
          [3, 'it reaps', 'failed', 'nothing reaps'],
        ),
        [],
      )!,
    );
    expect(out).toMatch(/2 other criteria are already satisfied/);
    expect(out).toMatch(/the next gate checks all of them again/);
    expect(out).not.toContain('it builds'); // counted, not re-listed
  });

  // RUN-79 asks a reviewer to collapse an invariant into ONE finding anchored at one line, citing
  // the other leak sites inside that line — so reading only the anchor lists exactly one file for
  // the finding shape that touches the most.
  it('picks up the sites cited inside a claim, not only the anchor', () => {
    const spec = buildRepairSpec(report([1, 'x', 'failed', 'y']), [
      finding(1, 'src/a.ts:8', 'the same invariant leaks in src/b.ts:12 and src/c.ts too'),
    ])!;
    expect(spec.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  // Scanning prose is looser than reading a location field, so it takes only tokens with a real
  // separator — the alternative turns "e.g." and a version number into files to go and look at.
  it('does not turn prose into a file', () => {
    const spec = buildRepairSpec(report([1, 'x', 'failed', 'y']), [
      finding(1, '', 'this is wrong, e.g. in v1.2 of the schema, per RFC 7231'),
    ])!;
    expect(spec.files).toEqual([]);
  });

  it('gathers the files the findings name, deduped and in citation order', () => {
    const spec = buildRepairSpec(report([1, 'it reaps', 'failed', 'nothing reaps']), [
      finding(1, 'src/land.ts:88'),
      finding(2, 'src/verify.ts:12'),
      finding(3, 'src/land.ts:140'),
    ])!;
    expect(spec.files).toEqual(['src/land.ts', 'src/verify.ts']);
    expect(renderRepairSpec(spec)).toMatch(/Files the report names: src\/land\.ts, src\/verify\.ts/);
  });

  // A line number goes stale the instant the builder edits, and a stale one reads as precision it
  // does not have. Stripping a TRAILING :line, not splitting at the first colon — the latter cut a
  // Windows path down to its drive letter and truncated any filename containing one.
  it.each([
    ['src/a.ts:88:14', 'src/a.ts'],
    ['src/a.ts:88', 'src/a.ts'],
    ['src/a.ts', 'src/a.ts'],
    ['C:\\repo\\src\\a.ts:12', 'C:\\repo\\src\\a.ts'],
    ['src/a:b.ts:12', 'src/a:b.ts'],
    ['dir with space/a.ts:12', 'dir with space/a.ts'],
    ['`src/a.ts:12`', 'src/a.ts'],
  ])('reads %s as %s', (location, expected) => {
    const r = report([1, 'x', 'failed', 'y']);
    expect(buildRepairSpec(r, [finding(1, location)])!.files).toEqual([expected]);
  });

  // A cross-cutting finding has no location, and prose in that field is not a path.
  it('ignores a location that is not a path', () => {
    const spec = buildRepairSpec(report([1, 'x', 'failed', 'y']), [
      finding(1, ''),
      finding(2, 'the whole permission model'),
      finding(3, 'src/ok.ts'),
    ])!;
    expect(spec.files).toEqual(['src/ok.ts']);
  });

  it('caps a runaway file list, and SAYS it capped it', () => {
    const spec = buildRepairSpec(
      report([1, 'x', 'failed', 'y']),
      Array.from({ length: 30 }, (_, i) => finding(i, `src/f${i}.ts:1`)),
    )!;
    expect(spec.files).toHaveLength(12);
    // A truncated list read as exhaustive is worse than no list — the builder concludes the repair
    // is scoped to twelve files when the report named thirty.
    expect(spec.filesOmitted).toBe(18);
    expect(renderRepairSpec(spec)).toMatch(/and 18 more it names beyond these/);
  });

  // A run whose task carries no criteria must hand back exactly what it handed back before — not a
  // block telling it there is nothing to report. The file list cannot carry the block on its own
  // either: every FINDING line the builder is about to read already names its file, so a bare list
  // under a definition-of-done heading is duplication wearing an authority it does not have.
  it('is null when no criterion is outstanding', () => {
    expect(buildRepairSpec(undefined, [])).toBeNull();
    expect(buildRepairSpec({ entries: [] }, [])).toBeNull();
    expect(buildRepairSpec(report([1, 'it builds', 'verified', 'tsc clean']), [])).toBeNull();
    // …not even to carry the files.
    expect(buildRepairSpec(undefined, [finding(1, 'src/a.ts:1')])).toBeNull();
  });

  // A finding names a defect at a line; a criterion names an outcome. Nothing in either says which
  // threatens which, and a guessed association is a confident wrong answer in front of the builder.
  // RUN-147 is where requirement ids make the join real.
  it('does not invent a mapping between findings and criteria', () => {
    const spec = buildRepairSpec(report([1, 'it reaps orphans', 'failed', 'nothing reaps']), [
      finding(1, 'src/unrelated.ts:3', 'a naming nit'),
    ])!;
    const out = renderRepairSpec(spec);
    // The criterion carries the GATE's own words about it, never the finding's.
    expect(out).toContain('the gate said: nothing reaps');
    expect(out).not.toContain('a naming nit');
  });
});
