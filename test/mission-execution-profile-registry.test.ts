import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommissionedExecutionProfile, ExecutionProfileOffer } from '@noriq-dev/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type MissionExecutionProfileActivationFactory,
  type MissionExecutionProfileActivationRequest,
  MissionExecutionProfileRegistry,
} from '../src/mission/execution-profile-registry';
import { snapshotMissionProfileCatalog } from '../src/mission/profile-catalog';
import { composeMcpBundles, loadProjectMcpBundle } from '../src/project-mcp';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeRemovable(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function makeRemovable(candidate: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    await chmod(candidate, 0o600);
    return;
  }
  await chmod(candidate, 0o700);
  await Promise.all((await readdir(candidate)).map((entry) => makeRemovable(path.join(candidate, entry))));
}

interface Layout {
  root: string;
  repo: string;
  snapshots: string;
  codex: string;
  claude: string;
}

async function layout(): Promise<Layout> {
  const root = await mkdtemp(path.join(tmpdir(), 'noriq-profile-registry-'));
  roots.push(root);
  const result = {
    root,
    repo: path.join(root, 'repo'),
    snapshots: path.join(root, 'snapshots'),
    codex: path.join(root, 'codex'),
    claude: path.join(root, 'claude'),
  };
  await Promise.all([
    mkdir(path.join(result.repo, '.noriq', 'execution-profiles'), { recursive: true }),
    mkdir(result.codex, { recursive: true }),
    mkdir(result.claude, { recursive: true }),
  ]);
  return result;
}

const budget = { tokens: 2_000, usd: null, activeSeconds: 60 } as const;

function catalog(drivers: readonly ('codex' | 'claude')[] = ['codex']) {
  const guideDriver = drivers[0] ?? 'codex';
  return {
    guide: {
      profileId: 'guide',
      agent: {
        driver: guideDriver,
        model: guideDriver === 'codex' ? 'gpt-5.6-sol' : 'claude-opus-4-8',
        effort: 'high',
      },
      budget,
      turnLimit: 8,
    },
    profiles: drivers.map((driver, index) => ({
      profileId: `reader-${driver}-${index}`,
      role: 'reader',
      permission: 'read',
      agent: {
        driver,
        model: driver === 'codex' ? 'gpt-5.6-sol' : 'claude-opus-4-8',
        effort: 'medium',
      },
      assurance: { rank: index + 1, independenceClass: `read-${driver}-${index}` },
      driverPosture: {
        kind: 'scope',
        permission: { write: false, allow: ['Read'], deny: ['Edit'], auto: false },
        lineageRole: 'worker',
      },
      budget,
      resources: { workspace: 1 },
      projectMcp: [],
    })),
    validationPolicy: { kind: 'none', policyId: 'test-none', reason: 'read-only fixture' },
  };
}

function declaration(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'default',
    generation: 1,
    maxConcurrency: 2,
    missionBudget: { tokens: 20_000, usd: null, activeSeconds: 900 },
    externalResourceCapacities: {},
    catalog: catalog(),
    ...overrides,
  };
}

async function putProfile(target: Layout, name: string, value: unknown, text?: string): Promise<string> {
  const filename = path.join(target.repo, '.noriq', 'execution-profiles', name);
  await writeFile(filename, text ?? JSON.stringify(value, null, 2));
  return filename;
}

function effective(input: string): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function validatingFactory(
  observe?: (request: MissionExecutionProfileActivationRequest) => void | Promise<void>,
): MissionExecutionProfileActivationFactory<{ profile: string }> {
  return async (request) => {
    snapshotMissionProfileCatalog(request.declaration.catalog);
    await observe?.(request);
    return {
      runtime: { profile: request.declaration.id },
      effectiveFingerprint: effective(request.declarationFingerprint),
    };
  };
}

function registry<R>(
  target: Layout,
  activationFactory: MissionExecutionProfileActivationFactory<R>,
  clock: () => Date = () => new Date('2026-08-13T01:00:00.000Z'),
) {
  return new MissionExecutionProfileRegistry({
    repoRoot: target.repo,
    snapshotDirectory: target.snapshots,
    codexHome: target.codex,
    claudeHome: target.claude,
    activationFactory,
    clock,
  });
}

function commission(offer: ExecutionProfileOffer): CommissionedExecutionProfile {
  if (!offer.effectiveFingerprint) throw new Error('test offer was not activated');
  return {
    id: offer.id,
    generation: offer.generation,
    declarationFingerprint: offer.declarationFingerprint,
    effectiveFingerprint: offer.effectiveFingerprint,
    attestationCapable: true,
  };
}

describe('MissionExecutionProfileRegistry', () => {
  it('does not create machine-private state when a repository declares no profiles', async () => {
    const target = await layout();
    const subject = registry(target, validatingFactory());

    expect(await subject.refresh()).toEqual([]);
    await expect(lstat(target.snapshots)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('discovers strict declarations, snapshots exact bytes, and activates their runtime authority', async () => {
    const target = await layout();
    const profile = declaration({
      id: 'project.default',
      generation: 3,
      externalResourceCapacities: { 'external:editor': 1 },
    });
    const exact = `${JSON.stringify(profile, null, 4)}\n`;
    await putProfile(target, 'default.json', profile, exact);
    let request: MissionExecutionProfileActivationRequest | null = null;
    const subject = registry(
      target,
      validatingFactory((candidate) => {
        request = candidate;
      }),
    );

    const [offer] = await subject.refresh();

    expect(offer).toMatchObject({
      id: 'project.default',
      generation: 3,
      resolution: 'resolved',
      health: 'healthy',
      attestationCapable: true,
      capacity: { maxConcurrency: 2, freeSlots: 2 },
    });
    expect(offer?.declarationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(request).not.toBeNull();
    const captured = request as unknown as MissionExecutionProfileActivationRequest;
    expect(await readFile(captured.declarationSnapshotPath, 'utf8')).toBe(exact);
    expect(captured.snapshotRoot).toContain(offer!.declarationFingerprint.slice('sha256:'.length));
    expect(captured.declaration.missionBudget).toEqual({
      tokens: 20_000,
      usd: null,
      activeSeconds: 900,
    });
    expect(captured.declaration.externalResourceCapacities).toEqual({ 'external:editor': 1 });
    expect(Object.isFrozen(captured.declaration)).toBe(true);
  });

  it('automatically selects only the project and referenced Noriq agent-home MCP declarations', async () => {
    const target = await layout();
    await putProfile(target, 'codex.json', declaration({ catalog: catalog(['codex']) }));
    await writeFile(path.join(target.repo, '.mcp.json'), '{"mcpServers":{"project":{}}}');
    await writeFile(path.join(target.codex, '.mcp.json'), '{"mcpServers":{"codex":{}}}');
    await writeFile(path.join(target.claude, '.mcp.json'), '{"mcpServers":{"claude":{}}}');
    let sources: readonly string[] = [];
    const subject = registry(
      target,
      validatingFactory(async (request) => {
        sources = request.mcpDeclarations.map((item) => item.sourceKind);
        for (const item of request.mcpDeclarations) {
          expect(await readFile(path.join(item.declarationRoot, '.mcp.json'), 'utf8')).toContain(
            item.sourceKind === 'project' ? 'project' : 'codex',
          );
          expect(item.declarationRoot).toContain(target.snapshots);
          expect(item.declarationRoot).not.toContain(target.repo);
          expect(item.declarationRoot).not.toContain(target.codex);
        }
      }),
    );

    await subject.refresh();

    expect(sources).toEqual(['project', 'codex-home']);
  });

  it('rejects duplicate or malformed outer declarations and clears previously advertised authority', async () => {
    const target = await layout();
    await putProfile(target, 'one.json', declaration());
    const subject = registry(target, validatingFactory());
    const [healthy] = await subject.refresh();
    expect(subject.match(commission(healthy!))).not.toBeNull();

    await putProfile(target, 'two.json', declaration({ generation: 2 }));
    await expect(subject.refresh()).rejects.toThrow(/declared more than once/);
    expect(subject.offers()).toEqual([]);
    expect(subject.match(commission(healthy!))).toBeNull();

    await rm(path.join(target.repo, '.noriq', 'execution-profiles', 'two.json'));
    await putProfile(target, 'one.json', { ...declaration(), mcpPath: '/tmp/forbidden' });
    await expect(subject.refresh()).rejects.toThrow(/strict schema/);
    expect(subject.offers()).toEqual([]);
  });

  it.each([
    { label: 'mission budget', override: { missionBudget: { tokens: null, usd: null, activeSeconds: 60 } } },
    { label: 'external resource namespace', override: { externalResourceCapacities: { workspace: 1 } } },
    {
      label: 'positive resource capacity',
      override: { externalResourceCapacities: { 'external:editor': 0 } },
    },
  ])('fails closed on invalid $label', async ({ override }) => {
    const target = await layout();
    await putProfile(target, 'invalid.json', declaration(override));
    const subject = registry(target, validatingFactory());

    await expect(subject.refresh()).rejects.toThrow(/strict schema/);
    expect(subject.offers()).toEqual([]);
  });

  it('turns activation and MCP-composition failures into opaque unavailable offers', async () => {
    const target = await layout();
    await putProfile(target, 'default.json', declaration());
    const duplicateServer = JSON.stringify({
      mcpServers: { shared: { type: 'http', url: 'https://example.test/mcp' } },
    });
    await writeFile(path.join(target.repo, '.mcp.json'), duplicateServer);
    await writeFile(path.join(target.codex, '.mcp.json'), duplicateServer);
    const endpointPolicy = {
      policyId: 'test-endpoint-v1',
      authorize: ({ declaredUrl }: { declaredUrl: string }) => ({
        policyId: 'test-endpoint-v1',
        endpointIdentity: effective(declaredUrl),
        resolvedUrl: declaredUrl,
      }),
    };
    const subject = registry(target, async (request) => {
      const bundles = await Promise.all(
        request.mcpDeclarations.map((item) => loadProjectMcpBundle(item.declarationRoot, { endpointPolicy })),
      );
      composeMcpBundles(bundles);
      throw new Error('secret diagnostic /home/operator/token');
    });

    const [offer] = await subject.refresh();

    expect(offer).toMatchObject({
      id: 'default',
      effectiveFingerprint: null,
      resolution: 'unresolved',
      health: 'unavailable',
      attestationCapable: false,
      capacity: { maxConcurrency: 2, freeSlots: 0 },
    });
    const serialized = JSON.stringify(subject.offers());
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('/home/');
    expect(serialized).not.toContain('example.test');
    expect(
      subject.match({
        id: 'default',
        declarationFingerprint: offer!.declarationFingerprint,
        effectiveFingerprint: effective('forged'),
        generation: 1,
        attestationCapable: true,
      }),
    ).toBeNull();
  });

  it('matches only an exact healthy commission and enforces bounded concurrent leases', async () => {
    const target = await layout();
    await putProfile(target, 'default.json', declaration());
    const subject = registry(target, validatingFactory());
    const [offer] = await subject.refresh();
    const selected = commission(offer!);

    expect(subject.match(selected)?.runtime).toEqual({ profile: 'default' });
    expect(subject.match({ ...selected, generation: 2 })).toBeNull();
    expect(subject.match({ ...selected, declarationFingerprint: effective('other') })).toBeNull();
    expect(subject.match({ ...selected, effectiveFingerprint: effective('other') })).toBeNull();

    const first = subject.acquire(selected);
    const second = subject.acquire(selected);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(subject.offers()[0]?.capacity.freeSlots).toBe(0);
    expect(subject.acquire(selected)).toBeNull();
    first!.release();
    first!.release();
    expect(subject.offers()[0]?.capacity.freeSlots).toBe(1);
    expect(subject.acquire(selected)).not.toBeNull();
    second!.release();
  });

  it('keeps portable fingerprints stable across paths, JSON layout, and exact snapshot variants', async () => {
    const first = await layout();
    const second = await layout();
    const value = declaration({ id: 'portable' });
    const reordered = {
      catalog: value.catalog,
      externalResourceCapacities: value.externalResourceCapacities,
      missionBudget: value.missionBudget,
      maxConcurrency: value.maxConcurrency,
      generation: value.generation,
      id: value.id,
      schemaVersion: value.schemaVersion,
    };
    await putProfile(first, 'portable.json', value, JSON.stringify(value));
    await putProfile(second, 'portable.json', reordered, `\n${JSON.stringify(reordered, null, 4)}\n`);
    await writeFile(path.join(first.repo, '.mcp.json'), '{"mcpServers":{}}\n');
    await writeFile(path.join(second.repo, '.mcp.json'), '{"mcpServers":{}}\n');
    const firstRegistry = registry(first, validatingFactory());
    const secondRegistry = registry(second, validatingFactory());

    const [[firstOffer], [secondOffer]] = await Promise.all([
      firstRegistry.refresh(),
      secondRegistry.refresh(),
    ]);

    expect(firstOffer?.declarationFingerprint).toBe(secondOffer?.declarationFingerprint);
    expect(firstOffer?.declarationFingerprint).not.toContain(first.root);
    expect(secondOffer?.declarationFingerprint).not.toContain(second.root);
  });

  it('reruns attestation on later observations and coalesces overlapping refreshes', async () => {
    const target = await layout();
    await putProfile(target, 'default.json', declaration());
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let tick = 0;
    const subject = registry(
      target,
      async (request) => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return { runtime: calls, effectiveFingerprint: effective(request.declarationFingerprint) };
      },
      () => new Date(`2026-08-13T01:00:0${tick++}.000Z`),
    );

    const first = subject.refresh();
    const overlapping = subject.refresh();
    expect(first).toBe(overlapping);
    const [[initial], [sameObservation]] = await Promise.all([first, overlapping]);
    expect(calls).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(initial?.observedAt).toBe(sameObservation?.observedAt);

    const [observedAgain] = await subject.refresh();
    expect(calls).toBe(2);
    expect(observedAgain?.observedAt).not.toBe(initial?.observedAt);
  });

  it('re-attests an exact immutable snapshot for restart recovery after the live declaration disappears', async () => {
    const target = await layout();
    const profilePath = await putProfile(target, 'default.json', declaration());
    let activations = 0;
    const subject = registry(target, async (request) => {
      activations += 1;
      return {
        runtime: { activation: activations },
        effectiveFingerprint: effective(request.declarationFingerprint),
      };
    });
    const [offer] = await subject.refresh();
    const selected = commission(offer!);
    await rm(profilePath);
    expect(await subject.refresh()).toEqual([]);
    expect(subject.acquire(selected)).toBeNull();

    const recovered = await subject.acquireSnapshot(selected);

    expect(recovered?.runtime).toEqual({ activation: 2 });
    expect(recovered?.declarationFingerprint).toBe(selected.declarationFingerprint);
    expect(recovered?.effectiveFingerprint).toBe(selected.effectiveFingerprint);
    recovered?.release();
  });

  it('refuses a historical snapshot when current machine attestation no longer matches the commission', async () => {
    const target = await layout();
    const profilePath = await putProfile(target, 'default.json', declaration());
    let machineIdentity = 'one';
    const subject = registry(target, async () => ({
      runtime: { machineIdentity },
      effectiveFingerprint: effective(machineIdentity),
    }));
    const [offer] = await subject.refresh();
    const selected = commission(offer!);
    await rm(profilePath);
    await subject.refresh();
    machineIdentity = 'two';

    expect(await subject.acquireSnapshot(selected)).toBeNull();
  });
});
