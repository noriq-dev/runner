import { describe, expect, it } from 'vitest';
import { assembleVerifyPrompt, parseVerdict, verifyAgentComment } from '../src/verify-agent';

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

  it('points at the workspace files when the backend has no diff command (non-git)', () => {
    const p = assembleVerifyPrompt('spec', {
      agent: { agentId: 'agt_v', label: 'verify-x' },
      server: 'https://s',
      // diffCmd absent → a live backend (Perforce/Diversion) with no `git diff`
    });
    expect(p).not.toMatch(/git diff/);
    expect(p).toMatch(/modified files in this workspace/i);
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
