import { describe, expect, it } from 'vitest';
import { assembleVerifyPrompt, parseVerdict, readEscalation, verifyAgentComment } from '../src/verify-agent';

describe('assembleVerifyPrompt', () => {
  it('is adversarial, read-only, names the diff + verdict format + specs', () => {
    const p = assembleVerifyPrompt('The endpoint must reject unauthenticated requests with 401.', {
      agent: { agentId: 'agt_verifier', label: 'verify-abc123' },
      server: 'https://s',
      diffCmd: 'git diff main...HEAD',
    });
    expect(p).toMatch(/INDEPENDENT|adversarial/i);
    expect(p).toMatch(/did NOT write/i);
    expect(p).toMatch(/read-only/i);
    expect(p).toMatch(/Do NOT modify/i);
    expect(p).toContain('git diff main...HEAD');
    expect(p).toMatch(/weakened|deleted|skipped/i); // the test-gaming warning
    expect(p).toContain('VERDICT: PASS');
    expect(p).toContain('VERDICT: FAIL');
    expect(p).toContain('reject unauthenticated requests'); // the specs
    // Authorship separation is the point of this gate, so WHICH actor filed the verdict must
    // be a fact the daemon knows — not a name the model was asked to register for itself.
    expect(p).toContain('agt_verifier');
    expect(p).toMatch(/do NOT call set_agent_identity/);
    // VCS-neutral: no git verb, no Claude-only skill reference leaks into the prompt.
    expect(p).not.toMatch(/\/verify skill/);
  });

  // RUN-154. The verifier is the actor asked whether a diff satisfies THIS repo's intent, and it
  // was the only one told nothing about what this repo is. Names only: its context already carries
  // the diff, so inlining documents on top would crowd out the subject under review.
  it("carries the repo's own orientation, by name", () => {
    const p = assembleVerifyPrompt('spec', {
      agent: { agentId: 'agt_v', label: 'verify-x' },
      server: 'https://s',
      repoContext: '\n\nThis repo says of itself:\n- Conventions (non-negotiable): ESM only',
    });
    expect(p).toContain('This repo says of itself:');
    expect(p).toContain('ESM only');
    // Before the specs, after the verdict instruction — reference first, the ask last.
    expect(p.indexOf('This repo says of itself:')).toBeLessThan(p.indexOf('Task specs'));
  });

  it('renders exactly as before when the repo declares nothing', () => {
    const bare = assembleVerifyPrompt('spec', {
      agent: { agentId: 'agt_v', label: 'verify-x' },
      server: 'https://s',
    });
    expect(bare).not.toContain('This repo says of itself');
    expect(bare).toMatch(/VERDICT: PASS/);
  });

  it('points at the workspace files when the backend has no diff command (non-git)', () => {
    const p = assembleVerifyPrompt('spec', {
      agent: { agentId: 'agt_v', label: 'verify-x' },
      server: 'https://s',
      // diffCmd absent → a live backend (Perforce/Diversion) with no `git diff`
    });
    expect(p).not.toMatch(/git diff/);
    expect(p).toMatch(/modified files in this workspace/i);
  });

  it('scopes the verdict to the change and keeps ambiguous-FAIL for in-scope code only (RUN-76)', () => {
    const p = assembleVerifyPrompt('the endpoint must reject bad tokens', {
      agent: { agentId: 'agt_v', label: 'verify-x' },
      server: 'https://s',
      diffCmd: 'git diff main...HEAD',
    });
    expect(p).toMatch(/Only what THIS change introduces is under review/);
    expect(p).toMatch(/not this diff's to answer for/);
    expect(p).toMatch(/not a ceiling/);
    // The strict posture survives, but bounded to what the diff changed.
    expect(p).toMatch(/when the evidence about such code is ambiguous, FAIL/);
    expect(p).toMatch(/not for pre-existing code/);
  });

  it('excuses specs that live in another repo/service, but not broken contracts (RUN-78)', () => {
    const p = assembleVerifyPrompt('spec', {
      agent: { agentId: 'agt_v', label: 'verify-x' },
      server: 'https://s',
      diffCmd: 'git diff main...HEAD',
    });
    expect(p).toMatch(/another repository/);
    expect(p).toMatch(/not a finding and must not drive the verdict/i);
    expect(p).toMatch(/PARTICIPATES in is still yours/);
    expect(p).toMatch(/never a bug that reaches elsewhere/);
  });
});

describe('parseVerdict', () => {
  it('parses PASS / FAIL, defaults ambiguous to unknown', () => {
    expect(parseVerdict('looks good\nVERDICT: PASS')).toMatchObject({ verdict: 'pass', passed: true });
    expect(parseVerdict('found a weakened test\nVERDICT: FAIL')).toMatchObject({
      verdict: 'fail',
      passed: false,
    });
    expect(parseVerdict('i am not sure')).toMatchObject({ verdict: 'unknown', passed: false });
  });

  it('is case-insensitive and the LAST verdict wins', () => {
    expect(parseVerdict('VERDICT: fail (draft)\n\nfinal: verdict: pass').verdict).toBe('pass');
  });

  it('keeps the findings text', () => {
    const v = parseVerdict('the auth check is missing on line 42\nVERDICT: FAIL');
    expect(v.findings).toContain('line 42');
  });
});

// RUN-175. A token is easier to emit than RUN-90's evidenced paragraph, and a reviewer that can
// end a run in one word will — so the gate is mechanical and every check fails toward today's
// behaviour: demoted means the run proceeds as the ordinary FAIL the report already is.
describe('readEscalation (RUN-175)', () => {
  const STRUCTURAL = [
    'The write floor leaks at every permission site, through unlike mechanisms.',
    'FINDING 1 [High] src/supervisor.ts:120: the write floor is re-derived per site — also src/stages/plan.ts:33 and src/land.ts:78',
    'ESCALATE STRUCTURAL FINDING 1: no single chokepoint enforces the write floor — src/supervisor.ts:120, src/stages/plan.ts:33, src/land.ts:78',
    'VERDICT: FAIL',
  ].join('\n');

  it('a report with no token reads as exactly nothing — no escalation, no demotion', () => {
    expect(readEscalation('FINDING 1 [High] a.ts:1: bad\nVERDICT: FAIL')).toEqual({
      escalation: null,
      demoted: null,
    });
    expect(readEscalation('all good\nVERDICT: PASS')).toEqual({ escalation: null, demoted: null });
  });

  it('honours an evidenced token on a FAIL: the named finding, the diagnosis, the distinct instances', () => {
    const r = readEscalation(STRUCTURAL);
    expect(r.demoted).toBeNull();
    expect(r.escalation).toMatchObject({ findingId: 1 });
    expect(r.escalation?.diagnosis).toContain('no single chokepoint');
    expect(r.escalation?.instances).toEqual([
      'src/supervisor.ts:120',
      'src/stages/plan.ts:33',
      'src/land.ts:78',
    ]);
  });

  it('is forgiving about the syntax around the claim, like EVIDENCE_RE', () => {
    const r = readEscalation(
      [
        'FINDING 2 [High] src/a.ts:1: the promise leaks — src/b.ts:2, src/c.ts:3',
        '- escalate structural 2. the floor has no enforcement point — src/a.ts:1, src/b.ts:2, src/c.ts:3',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    expect(r.escalation?.findingId).toBe(2);
  });

  it('demotes a token naming a finding the report never raised', () => {
    const r = readEscalation(
      [
        'FINDING 1 [High] src/a.ts:1: bad',
        'ESCALATE STRUCTURAL FINDING 9: broken — src/a.ts:1, src/b.ts:2, src/c.ts:3',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    expect(r.escalation).toBeNull();
    expect(r.demoted).toMatch(/FINDING 9/);
  });

  it('demotes a token below the instance floor — and the same site cited thrice is ONE instance', () => {
    const r = readEscalation(
      [
        'FINDING 1 [High] src/a.ts:10: bad at src/a.ts:10',
        'ESCALATE STRUCTURAL FINDING 1: everything is broken — src/a.ts:10, src/a.ts:10',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    expect(r.escalation).toBeNull();
    expect(r.demoted).toMatch(/floor is 3/);
  });

  it('demotes a diagnosis that cites instances but names no promise in words', () => {
    const r = readEscalation(
      [
        'FINDING 1 [High] src/a.ts:1: bad',
        'ESCALATE STRUCTURAL FINDING 1: src/a.ts:1, src/b.ts:2, src/c.ts:3',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    expect(r.escalation).toBeNull();
    expect(r.demoted).toMatch(/names no broken promise/);
  });

  it('demotes a one-word shrug beside three real citations — a diagnosis is a sentence, not a word', () => {
    // The reviewer round-1 catch: `bad` plus three file references cleared the old alphanumeric
    // bar. The diagnosis is the deliverable — it is the sentence a human re-dispatches around —
    // so a token whose prose could not name an invariant is demoted, however well it cites.
    const r = readEscalation(
      [
        'FINDING 1 [High] src/a.ts:1: bad',
        'ESCALATE STRUCTURAL FINDING 1: bad — src/a.ts:1, src/b.ts:2, src/c.ts:3',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    expect(r.escalation).toBeNull();
    expect(r.demoted).toMatch(/a sentence naming the invariant/);
  });

  it('demotes instances that all sit in ONE file — unlike mechanisms cannot live in one place', () => {
    // Three sites a single file-local fix could close are the BOUNDED case wearing the token.
    const r = readEscalation(
      [
        'FINDING 1 [High] src/a.ts:1: the floor drops at src/a.ts:22 and src/a.ts:47 as well',
        'ESCALATE STRUCTURAL FINDING 1: no single check enforces the floor — src/a.ts:1, src/a.ts:22, src/a.ts:47',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    expect(r.escalation).toBeNull();
    expect(r.demoted).toMatch(/one file/);
  });

  it('never converts a PASS — a token on a passing report is ignored, with the reason surfaced', () => {
    const r = readEscalation(STRUCTURAL.replace('VERDICT: FAIL', 'VERDICT: PASS'));
    expect(r.escalation).toBeNull();
    expect(r.demoted).toMatch(/not FAIL/);
    // …and the verdict itself is untouched by the token's presence.
    expect(parseVerdict(STRUCTURAL.replace('VERDICT: FAIL', 'VERDICT: PASS')).passed).toBe(true);
  });

  it('rides on no judgment: a report with no VERDICT line cannot escalate', () => {
    const r = readEscalation(STRUCTURAL.replace('VERDICT: FAIL', ''));
    expect(r.escalation).toBeNull();
    expect(r.demoted).toMatch(/not FAIL/);
  });

  it('counts a bare number pair as a time, not a site', () => {
    // "12:30" has no path-shaped left side, so it cannot pad the instance count.
    const r = readEscalation(
      [
        'FINDING 1 [High] src/a.ts:1: bad',
        'ESCALATE STRUCTURAL FINDING 1: broken since 12:30 and again at 14:45 — src/a.ts:1',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    expect(r.escalation).toBeNull();
    expect(r.demoted).toMatch(/floor is 3/);
  });
});

describe('verifyAgentComment', () => {
  it('surfaces a FAIL verdict', () => {
    const c = verifyAgentComment({ verdict: 'fail', passed: false, findings: 'test deleted' });
    expect(c).toMatch(/does NOT satisfy/);
    expect(c).toContain('test deleted');
  });
  it('surfaces an unknown verdict as a FAIL', () => {
    expect(verifyAgentComment({ verdict: 'unknown', passed: false, findings: 'x' })).toMatch(
      /no clear verdict/,
    );
  });
});
