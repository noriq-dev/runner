import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type VerifyExec, runVerify, verifyFailureComment } from '../src/verify';

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
