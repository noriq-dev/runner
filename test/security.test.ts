import type { PermissionProfile } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { mapPermission } from '../src/drivers/claude';
import { mapSandbox } from '../src/drivers/codex';
import { sanitizedAgentEnv } from '../src/security';

const perm = (over: Partial<PermissionProfile> = {}): PermissionProfile => ({
  write: false,
  network: 'restricted',
  allow: [],
  deny: [],
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

describe('permission profiles never grant a dangerous mode', () => {
  it('Claude: always dontAsk; build never gets bare Bash', () => {
    for (const write of [false, true]) {
      const p = mapPermission(perm({ write }), write ? 'build' : 'scope');
      expect(p.permissionMode).toBe('dontAsk'); // never bypassPermissions
      expect(p.allowedTools).not.toContain('Bash'); // bare bash never granted
    }
  });

  it('Codex: only read-only or workspace-write — never danger-full-access', () => {
    expect(mapSandbox(perm({ write: false }))).toBe('read-only');
    expect(mapSandbox(perm({ write: true }))).toBe('workspace-write');
    // exhaustive over the write flag — no input yields danger-full-access
    for (const write of [false, true]) {
      expect(mapSandbox(perm({ write }))).not.toBe('danger-full-access');
    }
  });
});
