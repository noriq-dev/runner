import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IntelligenceDurationMs } from '@noriq-dev/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../src/stage-timing';
import {
  type VerifyExec,
  runVerify,
  timedVerify,
  verifyFailureComment,
  verifyNotApplicable,
} from '../src/verify';

const fakeExec =
  (exitCode: number | null, output: string, timedOut = false): VerifyExec =>
  async () => ({ exitCode, output, timedOut });

describe('runVerify', () => {
  it('passes on a clean exit', async () => {
    const r = await runVerify({ cmd: 'x' }, '/wt', { exec: fakeExec(0, 'ok') });
    expect(r).toEqual({ passed: true, exitCode: 0, output: 'ok', timedOut: false });
  });

  it('fails on a non-zero exit', async () => {
    const r = await runVerify({ cmd: 'x' }, '/wt', { exec: fakeExec(1, 'boom') });
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it('fails on a timeout regardless of exit code', async () => {
    const r = await runVerify({ cmd: 'x', timeoutSeconds: 1 }, '/wt', { exec: fakeExec(0, 'partial', true) });
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(true);
  });
});

// RUN-242. The deterministic verify command is the plan's v1-mandatory metric and was completely
// untimed before this — `timedVerify` wraps `runVerify` with the monotonic seam and reports the
// duration through a callback (never a bare number) so a caller can log it without changing
// `runVerify`'s own return shape.
describe('timedVerify', () => {
  const clockAt = (...readings: number[]): Clock => {
    const q = [...readings];
    return () => (q.length > 1 ? (q.shift() as number) : (q[0] as number));
  };

  it('records elapsed time for a FAILING verify — a failure is not a reason to lose the duration', async () => {
    const durations: IntelligenceDurationMs[] = [];
    const result = await timedVerify({ cmd: 'x' }, '/wt', (d) => durations.push(d), {
      exec: async () => ({ exitCode: 1, output: 'boom', timedOut: false }),
      clock: clockAt(1_000, 2_500),
    });
    expect(result.passed).toBe(false);
    expect(durations).toHaveLength(1);
    expect(durations[0]).toMatchObject({ status: 'complete', value: 1_500 });
  });

  it('uses the injected clock rather than a real timer, so the reported duration is exact', async () => {
    const durations: IntelligenceDurationMs[] = [];
    await timedVerify({ cmd: 'x' }, '/wt', (d) => durations.push(d), {
      exec: async () => ({ exitCode: 0, output: 'ok', timedOut: false }),
      clock: clockAt(10_000, 10_007),
    });
    expect(durations[0]?.value).toBe(7);
  });

  // The "boundary lost" case: an exec that throws instead of resolving (never happens with the
  // real `defaultExec`, which always resolves — see its own doc — but an injected one can, and a
  // future exec implementation might). try/finally means the duration is still recorded, marked
  // `unavailable` rather than `complete` since we no longer know how long it actually ran, and the
  // original error is never swallowed — it still propagates to the caller.
  it('a stage that throws mid-flight still records its elapsed time, as unavailable', async () => {
    const durations: IntelligenceDurationMs[] = [];
    const onDuration = vi.fn((d: IntelligenceDurationMs) => durations.push(d));
    await expect(
      timedVerify({ cmd: 'x' }, '/wt', onDuration, {
        exec: async () => {
          throw new Error('exec crashed');
        },
        clock: clockAt(1_000, 3_000),
      }),
    ).rejects.toThrow('exec crashed');
    expect(onDuration).toHaveBeenCalledTimes(1);
    expect(durations[0]).toMatchObject({ status: 'unavailable', value: null });
    expect(durations[0]?.reason).toMatch(/exec crashed/);
  });
});

describe('verifyNotApplicable', () => {
  // "A repo with no [verify].cmd yields not_applicable with value: null" — asserted directly
  // against the schema-shaped envelope, not inferred from the absence of a call.
  it('reports not_applicable with value forced to null', () => {
    const d = verifyNotApplicable('no [verify].cmd configured for this repo');
    expect(d.status).toBe('not_applicable');
    expect(d.value).toBeNull();
    expect(d.reason).toBe('no [verify].cmd configured for this repo');
  });
});

describe('verifyFailureComment', () => {
  it('names the command + reason and includes the output tail', () => {
    const c = verifyFailureComment(
      { cmd: 'tsc --noEmit' },
      { passed: false, exitCode: 2, output: 'TS2322 error', timedOut: false },
    );
    expect(c).toContain('tsc --noEmit');
    expect(c).toContain('exited 2');
    expect(c).toContain('TS2322 error');
    expect(c).toMatch(/did not pass the floor gate/);
  });
});

describe('runVerify (real shell)', () => {
  let cwd: string;
  beforeAll(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'noriq-verify-'));
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('runs the command in cwd and passes on exit 0', async () => {
    const r = await runVerify({ cmd: 'echo verified && exit 0' }, cwd);
    expect(r.passed).toBe(true);
    expect(r.output).toContain('verified');
  });

  it('captures output and fails on a non-zero exit', async () => {
    const r = await runVerify({ cmd: 'echo failing 1>&2 && exit 3' }, cwd);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('failing');
  });
});
