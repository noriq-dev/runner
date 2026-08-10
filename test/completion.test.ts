import { describe, expect, it } from 'vitest';
import { COMMANDS, FILE_SENTINEL, completionCandidates, completionScript } from '../src/completion';

describe('completionCandidates', () => {
  it('offers every command (plus top-level flags) on an empty word', () => {
    const out = completionCandidates(['']);
    for (const c of COMMANDS) expect(out).toContain(c);
    expect(out).toContain('--help');
    expect(out).toContain('--version');
  });

  it('filters the command list by the current prefix', () => {
    expect(completionCandidates(['ini'])).toEqual(['init', 'init-project']);
    expect(completionCandidates(['sta'])).toEqual(['start']);
    expect(completionCandidates(['disc'])).toEqual(['discover']);
  });

  it('offers a command its own flags once it is chosen', () => {
    const out = completionCandidates(['auth', '']);
    expect(out).toContain('--server');
    expect(out).toContain('--browser');
    expect(out).toContain('--device');
    // global flags ride along...
    expect(out).toContain('--config');
    expect(out).toContain('--log-level');
    // ...but the command list does not reappear
    expect(out).not.toContain('start');
  });

  it('does not offer another command a foreign command flag', () => {
    expect(completionCandidates(['start', '--'])).not.toContain('--browser');
    expect(completionCandidates(['start', '--'])).toEqual(['--config', '--log-level']);
  });

  it('completes --advanced only under init-project', () => {
    expect(completionCandidates(['init-project', '--adv'])).toEqual(['--advanced']);
    expect(completionCandidates(['auth', '--adv'])).toEqual([]);
  });

  it('completes the --log-level enum after the flag', () => {
    expect(completionCandidates(['--log-level', ''])).toEqual(['debug', 'info', 'warn', 'error']);
    expect(completionCandidates(['start', '--log-level', 'w'])).toEqual(['warn']);
  });

  it('signals file completion after --config', () => {
    expect(completionCandidates(['--config', ''])).toEqual([FILE_SENTINEL]);
    expect(completionCandidates(['auth', '--config', './r'])).toEqual([FILE_SENTINEL]);
  });

  it('offers nothing to complete for a --server URL', () => {
    expect(completionCandidates(['auth', '--server', ''])).toEqual([]);
  });

  it('finds the command past a consumed flag value', () => {
    // --config eats ./x, so `auth` is still recognized as the command
    const out = completionCandidates(['--config', './x', 'auth', '--']);
    expect(out).toContain('--browser');
  });

  it('narrows to flags when the current word starts with a dash', () => {
    const out = completionCandidates(['--']);
    expect(out).not.toContain('start');
    expect(out).toContain('--help');
    expect(out).toContain('--config');
  });

  it('offers index-repo’s own flags once it is chosen, and signals file completion for --path', () => {
    const out = completionCandidates(['index-repo', '--']);
    expect(out).toContain('--force');
    expect(out).toContain('--json');
    expect(out).toContain('--limit');
    expect(out).toContain('--show-content');
    expect(out).toContain('--check-determinism');
    expect(completionCandidates(['index-repo', '--path', ''])).toEqual([FILE_SENTINEL]);
    expect(completionCandidates(['index-repo', '--limit', ''])).toEqual([]);
  });

  // RUN-223: every new command is a real command the completion vocabulary must list, and every
  // flag it accepts (--path/--server/--json, all reused from existing commands — no new parseArgs
  // surface) must complete under it.
  it('lists every RUN-223 command on an empty word', () => {
    const out = completionCandidates(['']);
    for (const c of [
      'index-status',
      'index-reindex',
      'index-retry',
      'index-cancel',
      'index-forget-journal',
    ]) {
      expect(out).toContain(c);
    }
  });

  it('offers --path/--server/--json under index-status, and signals file completion for --path', () => {
    const out = completionCandidates(['index-status', '--']);
    expect(out).toContain('--path');
    expect(out).toContain('--server');
    expect(out).toContain('--json');
    expect(completionCandidates(['index-status', '--path', ''])).toEqual([FILE_SENTINEL]);
  });

  it('offers --path/--server under index-reindex/index-retry/index-cancel/index-forget-journal', () => {
    for (const cmd of ['index-reindex', 'index-retry', 'index-cancel', 'index-forget-journal']) {
      const out = completionCandidates([cmd, '--']);
      expect(out).toContain('--path');
      expect(out).toContain('--server');
      // None of these take --json — asking for a nonexistent flag is exactly what would let a
      // stray flag from index-status silently leak into an unrelated command.
      expect(out).not.toContain('--json');
    }
  });

  it('does not offer index-status’ --json under a foreign command', () => {
    expect(completionCandidates(['start', '--'])).not.toContain('--json');
  });
});

describe('completionScript', () => {
  it('emits a sourceable bash wrapper wired to __complete', () => {
    const s = completionScript('bash');
    expect(s).toContain('complete -F _noriq_runner_complete noriq-runner');
    expect(s).toContain('noriq-runner __complete');
    expect(s).toContain('compgen -f');
    expect(s).toContain(FILE_SENTINEL);
  });

  it('emits a zsh wrapper that registers via compdef and falls back to _files', () => {
    const s = completionScript('zsh');
    expect(s).toContain('compdef _noriq_runner noriq-runner');
    expect(s).toContain('noriq-runner __complete');
    expect(s).toContain('_files');
    expect(s).toContain(FILE_SENTINEL);
  });
});
