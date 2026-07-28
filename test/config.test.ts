import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, parseRunnerConfig } from '../src/config';

describe('parseRunnerConfig', () => {
  it('parses a minimal config and fills contract defaults', () => {
    const cfg = parseRunnerConfig(`
      label = "my-laptop"
      server = "https://noriq.example"
      scanRoots = ["/home/you/code"]
    `);
    expect(cfg.label).toBe('my-laptop');
    expect(cfg.server).toBe('https://noriq.example');
    expect(cfg.concurrency).toBe(1); // default
    expect(cfg.tools).toBeNull(); // default
    expect(cfg.budget).toEqual({ maxTokens: null, maxUsd: null, maxDurationSeconds: null, maxRounds: null });
    expect(cfg.scanRoots).toEqual([path.resolve('/home/you/code')]);
  });

  it('expands ~ in scan roots to absolute paths', () => {
    const cfg = parseRunnerConfig(`
      label = "l"
      server = "https://a.b"
      scanRoots = ["~/git", "~"]
    `);
    expect(cfg.scanRoots[0]).toBe(path.join(os.homedir(), 'git'));
    expect(cfg.scanRoots[1]).toBe(os.homedir());
  });

  it('rejects a config with a non-URL server (names the field)', () => {
    expect(() =>
      parseRunnerConfig(`
        label = "l"
        server = "not-a-url"
        scanRoots = ["/tmp"]
      `),
    ).toThrow(/server/);
  });

  it('rejects an empty scanRoots', () => {
    expect(() =>
      parseRunnerConfig(`
        label = "l"
        server = "https://a.b"
        scanRoots = []
      `),
    ).toThrow(/scanRoots|failed validation/);
  });

  it('throws a helpful error on malformed TOML', () => {
    expect(() => parseRunnerConfig('this is = = not toml')).toThrow(/not valid TOML/);
  });

  it('carries an explicit concurrency + budget + tools through', () => {
    const cfg = parseRunnerConfig(`
      label = "l"
      server = "https://a.b"
      scanRoots = ["/tmp"]
      concurrency = 4
      tools = ["claude", "codex"]

      [budget]
      maxTokens = 500000
    `);
    expect(cfg.concurrency).toBe(4);
    expect(cfg.tools).toEqual(['claude', 'codex']);
    expect(cfg.budget.maxTokens).toBe(500000);
  });
});

describe('expandHome', () => {
  it('expands bare ~ and ~/ but leaves absolute + relative paths alone', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~/x')).toBe(path.join(os.homedir(), 'x'));
    expect(expandHome('/abs')).toBe('/abs');
    expect(expandHome('rel/path')).toBe('rel/path');
  });
});
