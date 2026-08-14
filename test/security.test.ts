import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PermissionProfile, RunKind } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { mapPermission } from '../src/drivers/claude';
import { mapSandbox } from '../src/drivers/codex';
import {
  STAGE_NORIQ_TOOLS,
  noriqToolNamesFor,
  projectMcpProcessEnv,
  sanitizedAgentEnv,
} from '../src/security';

const perm = (over: Partial<PermissionProfile> = {}): PermissionProfile => ({
  write: false,
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

describe('projectMcpProcessEnv', () => {
  it('canonicalizes nested launcher PATH aliases independently of the parent process environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-mcp-env-'));
    const runtime = path.join(root, 'runtime');
    const alias = path.join(root, 'runtime-alias');
    try {
      await mkdir(runtime);
      await symlink(runtime, alias, 'dir');

      const env = projectMcpProcessEnv({ PATH: alias });

      expect(env.PATH).toBe(runtime);
      expect(env.HOME).toBe('/tmp/noriq-project-mcp');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    expect(verify).not.toContain('update_tasks');
    expect(noriqToolNamesFor('scope')).not.toContain('claim_task');
    expect(noriqToolNamesFor('build')).not.toContain('create_plan');
  });

  it('a build can TAKE a lock, because the daemon takes them as the run (RUN-177)', () => {
    // The reactive per-edit hook and the hard floor before landing both authenticate with the
    // RUN's token. Omitting this made the daemon refuse itself: the floor could not complete,
    // reported `unchecked`, and failed two builds that had done nothing wrong.
    expect(noriqToolNamesFor('build')).toContain('acquire_lock');
  });

  it('but NO kind may release one — the agent shares the run’s identity (RUN-177)', () => {
    // The load-bearing half. Since RUN-47 the floor IS the catalogue, so anything the daemon may
    // call the agent may call. Granting release would let the agent drop the hard floor's own
    // locks mid-run, before landing — and RUN-105 holds them THROUGH the rebase→verify→
    // fast-forward precisely so a peer cannot take a file mid-merge. The guarantee has to be
    // something the agent cannot opt out of, so the tool is simply absent.
    //
    // The daemon loses nothing it needs: the server releases a task-anchored run's locks on
    // settle, on any status change off in_progress, and on claim TTL.
    for (const kind of KINDS) {
      expect(noriqToolNamesFor(kind), kind).not.toContain('release_lock');
      expect(noriqToolNamesFor(kind), kind).not.toContain('list_locks');
    }
  });

  it('the kinds that never write take no locks either', () => {
    // Locks exist to stop two writers colliding. A posture that cannot edit has nothing to
    // reserve, and the floor rations authority to what the job needs.
    for (const kind of ['scope', 'verify'] as RunKind[]) {
      expect(noriqToolNamesFor(kind), kind).not.toContain('acquire_lock');
      expect(noriqToolNamesFor(kind), kind).not.toContain('check_locks');
    }
  });

  it('scope can TEND the plan it mints, but not mint claimable work outside the gate (RUN-69)', () => {
    const scope = noriqToolNamesFor('scope');
    // A live scope run promised to cut its plan's artifact phase-edges, found the floor said
    // no, and could only raise_alert — the human then hand-cut five edges at approval.
    expect(scope).toContain('update_plan');
    expect(scope).toContain('update_tasks');
    expect(scope).toContain('update_tasks');
    // The RUN-23 gate is why the above is safe — and why these two stay out: both create
    // claimable work that no human ever approved.
    expect(scope).not.toContain('create_task');
    expect(scope).not.toContain('decompose_task');
  });

  it('build and verify can SPIN OFF work they found but may not do — scope cannot (RUN-188)', () => {
    // RUN-186's landing run did everything right — contested with evidence, raised an alert with
    // a full design sketch — and still failed, because an alert records a concern and creates no
    // work the gate can point at; a human folded it into a task by hand. create_tasks is that
    // manual step made first-class. Its product is a PROPOSED task — visible, carrying
    // provenance, not claimable and not pumpable until a human accepts it (the RUN-23 gate) —
    // which is what makes it safe to advertise to a prompt-injected builder.
    expect(noriqToolNamesFor('build')).toContain('create_tasks');
    expect(noriqToolNamesFor('verify')).toContain('create_tasks');
    // Scope's product IS a proposed plan: work it surfaces belongs in the plan it is minting.
    expect(noriqToolNamesFor('scope')).not.toContain('create_tasks');
  });

  it('the spin-off grant does not reopen RUN-69: create_task stays off EVERY floor', () => {
    // create_tasks is a new tool with a gated product, not create_task by another name — the
    // tools that mint CLAIMABLE work outside the human plan-approval gate stay absent everywhere.
    for (const kind of KINDS) {
      expect(noriqToolNamesFor(kind), kind).not.toContain('create_task');
      expect(noriqToolNamesFor(kind), kind).not.toContain('decompose_task');
    }
  });
});

describe('the stage escalation pair (RUN-190)', () => {
  it('is exactly reach-a-human — the tools whose own rationale says they ration nothing', () => {
    expect([...STAGE_NORIQ_TOOLS]).toEqual(['raise_alert', 'request_input']);
  });

  it('Claude: a narrowed session allows the pair and DENIES the rest of the kind floor', () => {
    const p = mapPermission(perm({ write: true }), 'build', STAGE_NORIQ_TOOLS);
    expect(p.allowedTools).toContain('mcp__noriq__request_input');
    expect(p.allowedTools).toContain('mcp__noriq__raise_alert');
    expect(p.allowedTools).not.toContain('mcp__noriq__claim_task');
    // DENIED, not merely un-allowed: deny outranks bypass, so this half holds under auto.
    expect(p.disallowedTools).toContain('mcp__noriq__claim_task');
    expect(p.disallowedTools).toContain('mcp__noriq__update_tasks');
  });

  it('…and the denial survives auto, which is the case that matters (RUN-68)', () => {
    const p = mapPermission(perm({ write: true, auto: true }), 'build', STAGE_NORIQ_TOOLS);
    expect(p.permissionMode).toBe('bypassPermissions');
    expect(p.disallowedTools).toContain('mcp__noriq__claim_task');
    expect(p.disallowedTools).not.toContain('mcp__noriq__request_input');
  });

  it('an un-narrowed session keeps its kind floor exactly as before', () => {
    const p = mapPermission(perm({ write: true }), 'build');
    expect(p.allowedTools).toContain('mcp__noriq__claim_task');
    expect(p.disallowedTools).not.toContain('mcp__noriq__claim_task');
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
