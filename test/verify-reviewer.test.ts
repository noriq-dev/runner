import { ProjectManifest, VerifySpec } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../src/verify-agent';
import {
  assembleReviewerPrompt,
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
    expect(m.verify?.agent).toEqual({ tool: null, model: null, effort: null, maxRounds: 2 });
  });

  it('both parse, with the reviewer keeping its own model/effort', () => {
    const m = ProjectManifest.parse({
      ...base,
      verify: { cmd: 'npm test', agent: { model: 'claude-opus-4-8', effort: 'high', maxRounds: 1 } },
    });
    expect(m.verify?.cmd).toBe('npm test');
    expect(m.verify?.agent).toEqual({ tool: null, model: 'claude-opus-4-8', effort: 'high', maxRounds: 1 });
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
  it('is adversarial, read-only, and carries the intent and the diff command', () => {
    const p = assembleReviewerPrompt({
      intent: 'RUN-9 — make the thing work',
      diffCmd: 'git diff abc...HEAD',
      verifyCmd: 'npm test',
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

  it('points at the working tree when there is no diff command (live VCS backends)', () => {
    const p = assembleReviewerPrompt({ intent: 'x' });
    expect(p).toMatch(/modified files in this working tree/);
    expect(p).not.toContain('git diff');
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
});
