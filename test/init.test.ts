import { existsSync } from 'node:fs';
// RUN-40: the guided setup. A new user used to hit two cliffs, each only revealing the next —
// `start` → "no runner config"; hand-write TOML → `start` → "no Noriq token". The sequence was
// the bug, so these tests are mostly about ORDER and about not destroying things.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultLabel, normalizeServer, renderConfig, runInit } from '../src/init';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'noriq-init-'));

/** Canned answers, in prompt order. */
const answers = (...list: string[]) => {
  let i = 0;
  return async (_q: string, fallback?: string) => list[i++] ?? fallback ?? '';
};

describe('normalizeServer', () => {
  it('accepts what a human actually types', () => {
    expect(normalizeServer('noriq.example')).toBe('https://noriq.example');
    expect(normalizeServer('https://noriq.example/')).toBe('https://noriq.example');
    expect(normalizeServer('  http://localhost:8787  ')).toBe('http://localhost:8787');
  });
});

describe('renderConfig', () => {
  it('emits config the real parser accepts', async () => {
    // A generated file that our own loader rejects would be the worst possible outcome here.
    const { parseRunnerConfig } = await import('../src/config');
    const text = renderConfig({
      label: 'box',
      server: 'https://noriq.example',
      scanRoots: ['/tmp/a'],
      concurrency: 3,
    });
    const cfg = parseRunnerConfig(text);
    expect(cfg.label).toBe('box');
    expect(cfg.server).toBe('https://noriq.example');
    expect(cfg.concurrency).toBe(3);
  });

  it('escapes a quote in a label instead of emitting broken TOML', async () => {
    const { parseRunnerConfig } = await import('../src/config');
    const text = renderConfig({
      label: 'my "box"',
      server: 'https://n.example',
      scanRoots: ['/tmp/a'],
      concurrency: 1,
    });
    expect(parseRunnerConfig(text).label).toBe('my "box"');
  });
});

describe('defaultLabel', () => {
  it('is the machine name a human will recognize in the Runners panel', () => {
    expect(defaultLabel('Montanas-Laptop.local')).toBe('montanas-laptop');
    expect(defaultLabel('')).toBe('my-runner');
  });
});

describe('runInit', () => {
  it('validates the server BEFORE writing anything', async () => {
    // The whole reason to prompt rather than let someone hand-write TOML: a typo'd URL is
    // caught in a second, pointing at the URL — instead of surfacing later as a mystery auth
    // failure, with broken config already on disk.
    const dir = await tmp();
    const configPath = path.join(dir, 'runner.toml');
    const lines: string[] = [];
    const res = await runInit({
      configPath,
      ask: answers('box', 'https://not-a-noriq-server.example'),
      out: (l) => lines.push(l),
      verifyServer: async () => {
        throw new Error('404 from /.well-known/oauth-authorization-server');
      },
    });
    expect(res.wroteConfig).toBe(false);
    expect(existsSync(configPath)).toBe(false); // nothing written
    expect(lines.join('\n')).toContain('Nothing was written');
  });

  it('never clobbers an existing config', async () => {
    // Re-running must not eat a tuned runner.toml.
    const dir = await tmp();
    const configPath = path.join(dir, 'runner.toml');
    const original = renderConfig({
      label: 'tuned',
      server: 'https://noriq.example',
      scanRoots: [dir],
      concurrency: 9,
    });
    await writeFile(configPath, original, 'utf8');

    const res = await runInit({
      configPath,
      ask: answers('N'), // declines the overwrite
      out: () => {},
      skipAuth: true,
      findRepos: async () => [],
    });
    expect(res.wroteConfig).toBe(false);
    expect(await readFile(configPath, 'utf8')).toBe(original); // byte-identical
  });

  it('writes config, authorizes, then shows what it found — in that order', async () => {
    const dir = await tmp();
    const configPath = path.join(dir, 'runner.toml');
    const lines: string[] = [];
    let authorizedWith: string | null = null;
    const res = await runInit({
      configPath,
      ask: answers('my-box', 'noriq.example', dir, '4'),
      out: (l) => lines.push(l),
      verifyServer: async () => {},
      runAuthorize: async (server) => {
        authorizedWith = server;
        return { expiresAt: null };
      },
      findRepos: async () => [{ name: 'alpha', projectKey: 'ALPHA', root: '/code/alpha' }],
    });

    expect(res).toMatchObject({ wroteConfig: true, authorized: true, reposFound: 1 });
    // Authorized against the value the FILE holds, not the raw answer — if they differ, the
    // file is what `start` will use, so it is what init must act on.
    expect(authorizedWith).toBe('https://noriq.example');
    const written = await readFile(configPath, 'utf8');
    expect(written).toContain('label = "my-box"');
    expect(written).toContain('concurrency = 4');

    const out = lines.join('\n');
    expect(out.indexOf('wrote')).toBeLessThan(out.indexOf('authorized'));
    expect(out.indexOf('authorized')).toBeLessThan(out.indexOf('alpha')); // discovery last
    expect(out).toContain('ALPHA');
  });

  it('says so loudly when it finds no repos', async () => {
    // The highest-value moment in onboarding: learning your scanRoots are wrong BEFORE
    // dispatching, not while wondering why the dashboard is empty.
    const dir = await tmp();
    const lines: string[] = [];
    await runInit({
      configPath: path.join(dir, 'runner.toml'),
      ask: answers('box', 'noriq.example', dir, '1'),
      out: (l) => lines.push(l),
      verifyServer: async () => {},
      skipAuth: true,
      findRepos: async () => [],
    });
    const out = lines.join('\n');
    expect(out).toContain('Found no repos');
    expect(out).toContain('.noriq/project.toml');
    expect(out).toContain('Nothing can be dispatched');
  });

  it('keeps the config when authorization fails, so `auth` can finish the job', async () => {
    const dir = await tmp();
    const configPath = path.join(dir, 'runner.toml');
    const lines: string[] = [];
    const res = await runInit({
      configPath,
      ask: answers('box', 'noriq.example', dir, '1'),
      out: (l) => lines.push(l),
      verifyServer: async () => {},
      runAuthorize: async () => {
        throw new Error('user closed the browser');
      },
      findRepos: async () => [],
    });
    expect(res.wroteConfig).toBe(true);
    expect(res.authorized).toBe(false);
    expect(existsSync(configPath)).toBe(true); // the work done is not thrown away
    expect(lines.join('\n')).toContain('noriq-runner auth');
  });

  it('refuses to run without a terminal instead of silently succeeding', async () => {
    // Found by running the real command, not by testing it: piped or under CI, readline hits
    // EOF, the pending question() never settles, the event loop empties, and node exits **0**
    // having written nothing. A setup command that silently reports success while doing nothing
    // is worse than one that fails. Note every other test here injects `ask` and therefore
    // never touches the real readline path — which is exactly how this survived.
    const dir = await tmp();
    const configPath = path.join(dir, 'runner.toml');
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await expect(runInit({ configPath, out: () => {} })).rejects.toThrow(
        /interactive and needs a terminal/,
      );
      expect(existsSync(configPath)).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
    }
  });
});
