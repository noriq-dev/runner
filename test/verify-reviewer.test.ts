import { ProjectManifest, VerifySpec } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { parseVerdict, readEscalation } from '../src/verify-agent';
import {
  assembleReviewerPrompt,
  reviewerEscalationComment,
  reviewerFeedbackPrompt,
  reviewerRejectionComment,
} from '../src/verify-reviewer';

describe('the [verify] choice (RUN-61) — schema', () => {
  const base = { key: 'PROJ' };

  it('cmd-only parses (the pre-RUN-61 shape, unchanged)', () => {
    const m = ProjectManifest.parse({ ...base, verify: { cmd: 'npm test' } });
    expect(m.verify?.cmd).toBe('npm test');
    expect(m.verify?.agent).toBeNull();
  });

  it('agent-only parses — a reviewer with no deterministic floor is a real choice', () => {
    const m = ProjectManifest.parse({ ...base, verify: { agent: {} } });
    expect(m.verify?.cmd).toBeNull();
    expect(m.verify?.agent).toEqual({ agent: null, tool: null, model: null, effort: null, maxRounds: 2 });
  });

  it('both parse, with the reviewer keeping its own model/effort', () => {
    const m = ProjectManifest.parse({
      ...base,
      verify: { cmd: 'npm test', agent: { model: 'claude-opus-4-8', effort: 'high', maxRounds: 1 } },
    });
    expect(m.verify?.cmd).toBe('npm test');
    expect(m.verify?.agent).toEqual({
      agent: null,
      tool: null,
      model: 'claude-opus-4-8',
      effort: 'high',
      maxRounds: 1,
    });
  });

  it('a [verify] section with NEITHER is refused — silence must not read as a gate', () => {
    expect(() => VerifySpec.parse({})).toThrow(/cmd|agent|omitted/);
    expect(() => ProjectManifest.parse({ ...base, verify: {} })).toThrow();
  });

  it('omitting [verify] entirely still means no verify stage', () => {
    expect(ProjectManifest.parse(base).verify).toBeNull();
  });
});

describe('assembleReviewerPrompt', () => {
  // On a landing repo the deterministic command runs AFTER the review, against the rebased result
  // (`stages/verify.ts` skips it when `[land]` is configured). The reviewer used to be told it
  // "already passed" regardless — a false premise handed to a gate that is also told not to re-run
  // it, so it had no way to find out (RUN-177).
  it('does not claim the deterministic check passed when it has not run yet', () => {
    const p = assembleReviewerPrompt({
      intent: 'RUN-9 — make the thing work',
      diffCmd: 'git diff abc...HEAD',
      verifyPending: 'npm run check',
    });
    expect(p).toContain('npm run check');
    expect(p).not.toMatch(/already passed/);
    expect(p).toMatch(/has NOT run yet/);
    // Still told not to burn turns on it — the point was never to invite a re-run.
    expect(p).toMatch(/do not re-run it here/i);
  });

  it('says nothing about a deterministic check when the repo configures none', () => {
    const p = assembleReviewerPrompt({ intent: 'x', diffCmd: 'git diff a...HEAD' });
    expect(p).not.toMatch(/already passed/);
    expect(p).not.toMatch(/has NOT run yet/);
  });

  it('is adversarial, read-only, and carries the intent and the diff command', () => {
    const p = assembleReviewerPrompt({
      intent: 'RUN-9 — make the thing work',
      diffCmd: 'git diff abc...HEAD',
      verifyPassed: 'npm test',
    });
    expect(p).toMatch(/INDEPENDENT, adversarial/);
    expect(p).toMatch(/Do NOT modify any files/);
    expect(p).toContain('git diff abc...HEAD');
    expect(p).toContain('RUN-9 — make the thing work');
    // Told the floor already passed so it does not burn its turns re-running the suite.
    expect(p).toContain('npm test');
    expect(p).toMatch(/already passed/);
    expect(p).toMatch(/VERDICT: PASS/);
    expect(p).toMatch(/VERDICT: FAIL/);
  });

  it('has no identity block and no MCP mention — the reviewer holds no credential', () => {
    const p = assembleReviewerPrompt({ intent: 'x' });
    expect(p).not.toMatch(/set_agent_identity/);
    expect(p).not.toMatch(/MCP/);
    expect(p).toMatch(/no project-management access/);
  });

  // RUN-154. This is the actor being asked "does this look like this repo's code?" while being
  // told nothing about what this repo's code looks like. Names only — the diff already owns its
  // context, and a reviewer is read-only by definition, so a named file is one it can just read.
  it("carries the repo's own orientation, by name", () => {
    const p = assembleReviewerPrompt({
      intent: 'x',
      repoContext:
        "\n\nThis repo says of itself:\n- This repo's rules are written down in: CLAUDE.md — read them before judging the diff against them",
    });
    expect(p).toContain('This repo says of itself:');
    expect(p).toContain('CLAUDE.md');
    expect(p).toMatch(/before judging the diff/);
    expect(p.indexOf('This repo says of itself:')).toBeLessThan(p.indexOf('Intent to review against'));
  });

  it('renders exactly as before when the repo declares nothing', () => {
    const p = assembleReviewerPrompt({ intent: 'x' });
    expect(p).not.toContain('This repo says of itself');
    expect(p).toMatch(/VERDICT: PASS/);
  });

  it('points at the working tree when there is no diff command (live VCS backends)', () => {
    const p = assembleReviewerPrompt({ intent: 'x' });
    expect(p).toMatch(/modified files in this working tree/);
    expect(p).not.toContain('git diff');
  });

  it('scopes the review to the CHANGE, not the whole file (RUN-76)', () => {
    const p = assembleReviewerPrompt({ intent: 'x' });
    // Pre-existing code is context, not a target — this is what stops a fresh reviewer
    // flagging code the change never touched (the VCS-detection / clobber re-raises).
    expect(p).toMatch(/Only what THIS change introduces is under review/);
    expect(p).toMatch(/not this author's to answer for/);
    expect(p).toMatch(/CONTEXT/);
  });

  it('treats the intent as a floor, not a ceiling — extra behavior is not a defect (RUN-76)', () => {
    const p = assembleReviewerPrompt({ intent: 'x' });
    expect(p).toMatch(/not a ceiling/);
    expect(p).toMatch(/Behavior BEYOND the intent is not a defect/);
    expect(p).toMatch(/superseded/);
    // And the anti-manufacturing line so an empty report can honestly PASS.
    expect(p).toMatch(/manufacture a finding/i);
  });

  it('excuses requirements that live in another repo/service, but not broken contracts (RUN-78)', () => {
    const p = assembleReviewerPrompt({ intent: 'x' });
    // A cross-repo/service requirement is follow-up, not a verdict-driving finding — this is
    // what stops a standalone-repo run failing over server-side surfaces it can never carry.
    expect(p).toMatch(/another repository/);
    expect(p).toMatch(/not a finding and must not drive the verdict/i);
    // But integration the change PARTICIPATES in stays in scope — the rule is not a loophole.
    expect(p).toMatch(/PARTICIPATES in is still yours/);
    expect(p).toMatch(/never a bug that reaches elsewhere/);
  });

  it('asks for numbered findings so the builder can answer each by number (RUN-79)', () => {
    const p = assembleReviewerPrompt({ intent: 'x' });
    expect(p).toMatch(/FINDING <n> \[<severity>\] <file:line>: <one-sentence claim>/);
  });

  it('no PRIOR ADJUDICATIONS section on the first look (empty/absent ledger) (RUN-79)', () => {
    expect(assembleReviewerPrompt({ intent: 'x' })).not.toMatch(/PRIOR ADJUDICATIONS/);
    expect(assembleReviewerPrompt({ intent: 'x', ledger: [] })).not.toMatch(/PRIOR ADJUDICATIONS/);
  });

  it('renders the ledger with the verify-don’t-trust frame when findings were adjudicated (RUN-79)', () => {
    const p = assembleReviewerPrompt({
      intent: 'x',
      ledger: [
        {
          id: 1,
          round: 1,
          severity: 'High',
          requirements: [],
          location: 'src/init.ts:357',
          claim: 'detectVcs runs on every init',
          status: 'contested',
          pointer: 'commit 11f19c8',
          reason: 'pre-existing, added by RUN-60',
          subclaims: [],
        },
      ],
    });
    expect(p).toMatch(/PRIOR ADJUDICATIONS/);
    // The framing: claim not fact, verify the pointer, don't relitigate what holds up.
    expect(p).toMatch(/builder's CLAIM/);
    expect(p).toMatch(/verify the pointer against the diff yourself/i);
    expect(p).toMatch(/Re-raise a CONTESTED finding only if you can show/);
    // The entry itself, with the checkable pointer.
    expect(p).toContain('detectVcs runs on every init');
    expect(p).toContain('CONTESTED (commit 11f19c8)');
  });

  // RUN-175. The token has to be at least as hard to earn as RUN-90's prose — a reviewer that can
  // end a run in one word will — so the prompt states the evidence bar, the demotion, and the cost.
  it('teaches the escalation token, gated on the structural evidence bar (RUN-175)', () => {
    const p = assembleReviewerPrompt({ intent: 'x' });
    expect(p).toContain('ESCALATE STRUCTURAL FINDING <n>');
    expect(p).toMatch(/only when — the full evidence bar above is met/);
    expect(p).toMatch(/demotes the line to an ordinary FAIL/);
    expect(p).toMatch(/three distinct file:line instances/);
    expect(p).toMatch(/never because a problem feels systemic/);
    // A bounded class must stay a listed class — the token is not a louder FAIL.
    expect(p).toMatch(/BOUNDED class is never an escalation/);
    // …and the daemon's parser honours the exact line the prompt teaches.
    const taught = [
      'FINDING 1 [High] src/a.ts:1: the promise leaks — src/b.ts:2, src/c.ts:3',
      'ESCALATE STRUCTURAL FINDING 1: the floor has no single enforcement point — src/a.ts:1, src/b.ts:2, src/c.ts:3',
      'VERDICT: FAIL',
    ].join('\n');
    expect(readEscalation(taught).escalation?.findingId).toBe(1);
  });

  // RUN-231: the verified context pack, rendered through the reviewer-audience quoted-evidence
  // frame, must precede the daemon's own ACCEPTANCE/VERDICT instructions — the same ordering
  // `repoContext` already gets, checked here by INDEX rather than mere presence, since the actual
  // insertion point (`{{context}}{{memory}}{{#acceptance}}`) is what has to deliver it, not intent.
  it('carries the memory block BEFORE acceptance/verdict instructions, by index (RUN-231)', () => {
    const p = assembleReviewerPrompt({
      intent: 'x',
      memory: '\n\nQUOTED FROM PROJECT MEMORY — MEMORY-MARKER',
      acceptance: [{ id: 1, kind: 'truth', text: 'must do the thing' }],
    });
    expect(p).toContain('MEMORY-MARKER');
    const memoryIdx = p.indexOf('MEMORY-MARKER');
    expect(memoryIdx).toBeLessThan(p.indexOf('ACCEPTANCE CRITERIA'));
    expect(memoryIdx).toBeLessThan(p.lastIndexOf('VERDICT: PASS'));
    expect(memoryIdx).toBeLessThan(p.lastIndexOf('End your response'));
  });

  it('renders nothing extra when no pack was retrieved', () => {
    const p = assembleReviewerPrompt({ intent: 'x' });
    expect(p).not.toContain('QUOTED FROM PROJECT MEMORY');
  });

  it('its verdict line round-trips through the shared parser', () => {
    // The reviewer and the dispatched verify kind share one protocol — a drift here would
    // make every reviewer verdict read as 'unknown', i.e. a permanent FAIL.
    expect(parseVerdict('findings...\nVERDICT: PASS').passed).toBe(true);
    expect(parseVerdict('findings...\nVERDICT: FAIL').passed).toBe(false);
    expect(parseVerdict('I looked and it seems fine?').verdict).toBe('unknown');
  });
});

describe('reviewer feedback + rejection surfaces', () => {
  it('hands the report to the builder and says a FRESH reviewer looks again', () => {
    const p = reviewerFeedbackPrompt('- the error path is untested', 1, 2);
    expect(p).toContain('- the error path is untested');
    expect(p).toMatch(/fresh reviewer/);
    expect(p).not.toMatch(/last attempt/);
  });

  it('says so on the final round', () => {
    expect(reviewerFeedbackPrompt('findings', 2, 2)).toMatch(/last attempt/);
  });

  it('the rejection comment names the rounds spent', () => {
    expect(reviewerRejectionComment('findings', 2)).toMatch(/after 2 fix rounds/);
    expect(reviewerRejectionComment('findings', 0)).not.toMatch(/after/);
  });

  // RUN-175. The human's next move differs from a rejection — re-dispatch around a chokepoint,
  // not "read the findings and try again" — so the diagnosis leads and the evidence shows.
  it('the escalation comment leads with the diagnosis and shows the cited instances (RUN-175)', () => {
    const c = reviewerEscalationComment(
      {
        findingId: 3,
        diagnosis: 'the write floor has no single enforcement point',
        instances: ['src/a.ts:10', 'src/b.ts:20', 'src/c.ts:30'],
      },
      'FINDING 3 [High] src/a.ts:10: the floor leaks\nVERDICT: FAIL',
      1,
    );
    expect(c).toMatch(/STRUCTURALLY unconvergeable after 1 fix round/);
    expect(c).toContain('finding 3: the write floor has no single enforcement point');
    expect(c).toContain('src/a.ts:10, src/b.ts:20, src/c.ts:30');
    expect(c).toMatch(/stopped the remaining fix rounds/);
    expect(c).toMatch(/re-dispatch the task around one/);
    expect(c).toContain('the floor leaks'); // the report itself still rides along
  });

  it('the escalation comment says so when the FIRST look ended the run — no rounds were spent', () => {
    const c = reviewerEscalationComment(
      { findingId: 1, diagnosis: 'd', instances: ['a.ts:1', 'b.ts:2', 'c.ts:3'] },
      'findings',
      0,
    );
    expect(c).toMatch(/on its first look/);
    expect(c).not.toMatch(/after 0 fix/);
  });

  it('requires a structured RESPONSE block so the next reviewer can adjudicate (RUN-79)', () => {
    const p = reviewerFeedbackPrompt('FINDING 1 [High] a.ts:1: x', 1, 2);
    expect(p).toMatch(/RESPONSE block/);
    expect(p).toMatch(/FINDING <n>: FIXED <file:line>/);
    expect(p).toMatch(/FINDING <n>: CONTESTED/);
    // The pointer must be checkable or the finding is re-raised — that is the whole contract.
    expect(p).toMatch(/re-raised/);
  });
});
