import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli';
import { VERSION } from '../src/version';

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void out.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void err.push(String(m)));
});
afterEach(() => vi.restoreAllMocks());

describe('cli', () => {
  it('version prints the version and exits 0', async () => {
    expect(await run(['version'])).toBe(0);
    expect(out.join('\n')).toContain(VERSION);
  });

  it('help (default) prints usage and exits 0', async () => {
    expect(await run([])).toBe(0);
    expect(out.join('\n')).toContain('Usage:');
  });

  it('an unknown command exits 2', async () => {
    expect(await run(['frobnicate'])).toBe(2);
  });

  it('an unknown option exits 2', async () => {
    expect(await run(['--nope'])).toBe(2);
  });

  it('start with a missing config fails gracefully (exit 1, no throw)', async () => {
    expect(await run(['start', '--config', '/no/such/runner.toml'])).toBe(1);
    expect(err.join('\n')).toMatch(/no runner config/);
  });
});
