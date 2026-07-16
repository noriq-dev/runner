import type { PermissionProfile, RunKind } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { mapPermission } from '../src/drivers/claude';
import { mapSandbox } from '../src/drivers/codex';
import { noriqToolNamesFor, sanitizedAgentEnv } from '../src/security';

const perm = (over: Partial<PermissionProfile> = {}): PermissionProfile => ({
  write: false,
  network: 'restricted',
  allow: [],
  deny: [],
  auto: false,
  ...over,
});

describe('sanitizedAgentEnv', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    NORIQ_TOKEN: 'secret-oauth',
    GITHUB_TOKEN: 'ghp_x',
    AWS_SECRET_ACCESS_KEY: 'aws-x',
  } as NodeJS.ProcessEnv;

  it('strips the Noriq token and cloud/git secrets from the shell env', () => {
    const env = sanitizedAgentEnv(base);
    expect(env.NORIQ_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin'); // non-secrets preserved
    expect(base.NORIQ_TOKEN).toBe('secret-oauth'); // does not mutate the input
  });

  it('blocks git push: no credential prompt, no askpass, helper disabled', () => {
    const env = sanitizedAgentEnv(base);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('/bin/false');
    // git env-config channel disables the credential helper for the child
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
  });
});

describe('the per-kind Noriq tool floor (RUN-46/47)', () => {
  const KINDS: RunKind[] = ['scope', 'build', 'verify'];

  it('every kind can reach a human and stay alive — the two things curation must never ration', () => {
    for (const kind of KINDS) {
      const tools = noriqToolNamesFor(kind);
      expect(tools).toContain('raise_alert'); // "a human should know" (RUN-32)
      expect(tools).toContain('request_input'); // "I need a decision" → park/resume (RUN-30)
      // A build agent that works 40 min without touching Noriq loses its claim silently —
      // heartbeat is the one tool whose job is "I am still here" (RUN-47's "also").
      expect(tools).toContain('heartbeat');
    }
  });

  it('every kind can orient itself — since RUN-47 the floor is also the ADVERTISED catalogue, so an omission is invisibility, not a denied call', () => {
    for (const kind of KINDS) {
      expect(noriqToolNamesFor(kind)).toContain('get_briefing');
    }
  });

  it('authority stays rationed: verify cannot move work, scope cannot claim it', () => {
    const verify = noriqToolNamesFor('verify');
    expect(verify).not.toContain('claim_task');
    expect(verify).not.toContain('release_task');
    expect(verify).not.toContain('update_task');
    expect(noriqToolNamesFor('scope')).not.toContain('claim_task');
    expect(noriqToolNamesFor('build')).not.toContain('create_plan');
  });

  it('scope can TEND the plan it mints, but not mint claimable work outside the gate (RUN-69)', () => {
    const scope = noriqToolNamesFor('scope');
    // A live scope run promised to cut its plan's artifact phase-edges, found the floor said
    // no, and could only raise_alert — the human then hand-cut five edges at approval.
    expect(scope).toContain('update_plan');
    expect(scope).toContain('add_dependency');
    expect(scope).toContain('remove_dependency');
    // The RUN-23 gate is why the above is safe — and why these two stay out: both create
    // claimable work that no human ever approved.
    expect(scope).not.toContain('create_task');
    expect(scope).not.toContain('decompose_task');
  });
});

describe('permission profiles never grant a dangerous mode UNINVITED (RUN-68)', () => {
  it('Claude: dontAsk by default; build never gets bare Bash', () => {
    for (const write of [false, true]) {
      const p = mapPermission(perm({ write }), write ? 'build' : 'scope');
      expect(p.permissionMode).toBe('dontAsk'); // never bypassPermissions without auto
      expect(p.allowedTools).not.toContain('Bash'); // bare bash never granted
    }
  });

  it('Codex: only read-only or workspace-write by default — never danger-full-access', () => {
    expect(mapSandbox(perm({ write: false }))).toBe('read-only');
    expect(mapSandbox(perm({ write: true }))).toBe('workspace-write');
    // exhaustive over the write flag — no auto-less input yields danger-full-access
    for (const write of [false, true]) {
      expect(mapSandbox(perm({ write }))).not.toBe('danger-full-access');
    }
  });

  it('auto is the committed opt-in: Claude goes bypass, codex build goes full access', () => {
    expect(mapPermission(perm({ write: true, auto: true }), 'build').permissionMode).toBe(
      'bypassPermissions',
    );
    expect(mapSandbox(perm({ write: true, auto: true }))).toBe('danger-full-access');
  });

  it('the write axis SURVIVES auto — trust loosens command gating, never read-only', () => {
    // Claude: deny outranks bypass, so a read-only kind keeps its edit-tool denials.
    const p = mapPermission(perm({ write: false, auto: true }), 'verify');
    expect(p.permissionMode).toBe('bypassPermissions');
    expect(p.disallowedTools).toContain('Edit');
    expect(p.disallowedTools).toContain('Write');
    // ...but bare Bash is no longer denied — unrestricted EXECUTION is what auto means.
    expect(p.disallowedTools).not.toContain('Bash');
    // Codex: the sandbox is its only enforcement; auto must not turn read-only into write.
    expect(mapSandbox(perm({ write: false, auto: true }))).toBe('read-only');
  });

  it('manifest deny rules still bind under auto', () => {
    const p = mapPermission(perm({ write: true, auto: true, deny: ['WebFetch'] }), 'build');
    expect(p.disallowedTools).toContain('WebFetch');
  });
});
