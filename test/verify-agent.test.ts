import { describe, expect, it } from 'vitest';
import { assembleVerifyPrompt, parseVerdict, verifyAgentComment } from '../src/verify-agent';

describe('assembleVerifyPrompt', () => {
  it('is adversarial, read-only, names the diff + verdict format + specs', () => {
    const p = assembleVerifyPrompt('The endpoint must reject unauthenticated requests with 401.', {
      parentAgentId: 'agt_daemon',
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
    expect(p).toContain('/verify skill');
    expect(p).toContain('reject unauthenticated requests'); // the specs
    expect(p).toContain('parentAgentId=agt_daemon');
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
