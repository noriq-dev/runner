import { describe, expect, it } from 'vitest';
import { parseMissionAction } from '../src/mission/action-schema';
import {
  MissionProfileCatalogError,
  missionProfileCatalogCreateFields,
  snapshotMissionProfileCatalog as snapshotMissionProfileCatalogRaw,
  validateMissionProfileCatalogSnapshot,
} from '../src/mission/profile-catalog';
import type { MissionExecutionProfile, MissionGuideProfile } from '../src/mission/protocol';
import type { ProjectMcpBundle } from '../src/project-mcp';

const DECLARATION_FINGERPRINT = 'a'.repeat(64);
const budget = { tokens: 10_000, usd: 20, activeSeconds: 600 } as const;
const validationPolicy = {
  kind: 'command',
  policyId: 'focused-tests-v1',
  command: 'npm test',
  timeoutSeconds: 300,
  shell: null,
} as const;

const guide: MissionGuideProfile = {
  profileId: 'guide',
  agent: { driver: 'guide-driver', model: 'guide-model', effort: 'high' },
  budget,
  turnLimit: 20,
};

const builder: MissionExecutionProfile = {
  profileId: 'builder',
  role: 'builder',
  permission: 'write',
  agent: { driver: 'worker-driver', model: 'worker-model', effort: 'medium' },
  assurance: { rank: 1, independenceClass: 'build' },
  driverPosture: {
    kind: 'build',
    permission: {
      write: true,
      allow: ['Write', 'Read'],
      deny: ['Push', 'Network'],
      auto: false,
    },
    lineageRole: 'worker',
  },
  budget,
  resources: { workspace: 1 },
  projectMcp: [{ server: 'project-tools', tools: ['write_asset', 'read_asset'] }],
};

const reviewer: MissionExecutionProfile = {
  profileId: 'reviewer',
  role: 'reviewer',
  permission: 'read',
  agent: { driver: 'review-driver', model: 'review-model' },
  assurance: { rank: 2, independenceClass: 'independent-review' },
  driverPosture: {
    kind: 'verify',
    permission: { write: false, allow: ['Read'], deny: ['Write'], auto: false },
    lineageRole: 'reviewer',
  },
  budget,
  resources: { workspace: 1 },
  projectMcp: [{ server: 'project-tools', tools: ['read_asset'] }],
};

const bundle = (): ProjectMcpBundle => ({
  source: '/project/.mcp.json',
  declarationFingerprint: DECLARATION_FINGERPRINT,
  effectiveFingerprint: 'b'.repeat(64),
  launcherAuthorizations: {
    'project-tools': {
      policyId: 'test-policy',
      executableIdentity: 'test:project-tools',
      runtimeClosureIdentity: 'test:runtime:project-tools',
      authorizedArgvIdentity: `sha256:${'a'.repeat(64)}`,
      resolvedCommand: process.execPath,
      readOnlyRoots: [],
    },
  },
  endpointAuthorizations: {
    dormant: {
      policyId: 'test-endpoint-policy',
      endpointIdentity: 'test:dormant',
      resolvedUrl: 'https://mcp.example.test/',
    },
  },
  servers: {
    'project-tools': { transport: 'stdio', command: 'tool-server', args: [], env: {} },
    dormant: { transport: 'http', url: 'https://mcp.example.test/', headers: {} },
  },
});

const clone = <T>(value: T): T => structuredClone(value);

/** Add the required trusted policy to legacy-shaped fixture objects without invoking accessors. */
function snapshotMissionProfileCatalog(candidate: unknown, projectMcpBundle?: ProjectMcpBundle) {
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    Object.getPrototypeOf(candidate) === Object.prototype &&
    !Object.hasOwn(candidate, 'validationPolicy')
  ) {
    const augmented = Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(candidate),
        validationPolicy: {
          value: clone(validationPolicy),
          enumerable: true,
          configurable: true,
          writable: true,
        },
      },
    );
    return snapshotMissionProfileCatalogRaw(augmented, projectMcpBundle);
  }
  return snapshotMissionProfileCatalogRaw(candidate, projectMcpBundle);
}

describe('trusted mission profile catalog', () => {
  it('returns a detached, frozen create-mission authority bound to the project declaration', () => {
    const input = { guide: clone(guide), profiles: [clone(reviewer), clone(builder)] };
    const snapshot = snapshotMissionProfileCatalog(input, bundle());

    expect(snapshot.projectMcpDeclarationFingerprint).toBe(DECLARATION_FINGERPRINT);
    expect(snapshot.validationPolicy).toEqual(validationPolicy);
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.profiles.map((profile) => profile.profileId)).toEqual(['builder', 'reviewer']);
    expect(snapshot.profiles[0]?.projectMcp[0]?.tools).toEqual(['read_asset', 'write_asset']);
    expect(snapshot.profiles[0]?.driverPosture.permission.allow).toEqual(['Read', 'Write']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.profiles[0]?.projectMcp[0]?.tools)).toBe(true);

    input.profiles[1]!.role = 'mutated';
    expect(snapshot.profiles[0]?.role).toBe('builder');

    const fields = missionProfileCatalogCreateFields(snapshot);
    expect(
      parseMissionAction({
        type: 'create-mission',
        ...fields,
        budget: { tokens: null, usd: null, activeSeconds: null },
        resources: { workspace: 1 },
      }),
    ).toMatchObject({ type: 'create-mission', ...fields });
  });

  it('fingerprints equivalent authority independently of set and object construction order', () => {
    const first = snapshotMissionProfileCatalog({ guide, profiles: [builder, reviewer] }, bundle());
    const reorderedBuilder: MissionExecutionProfile = {
      ...clone(builder),
      resources: { workspace: 1 },
      projectMcp: [{ server: 'project-tools', tools: ['read_asset', 'write_asset'] }],
      driverPosture: {
        ...builder.driverPosture,
        permission: {
          ...builder.driverPosture.permission,
          allow: ['Read', 'Write'],
          deny: ['Network', 'Push'],
        },
      },
    };
    const second = snapshotMissionProfileCatalog(
      { profiles: [clone(reviewer), reorderedBuilder], guide: clone(guide) },
      bundle(),
    );

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second).toEqual(first);
  });

  it('uses null project binding when every profile grants zero project tools', () => {
    const noMcp = { ...clone(reviewer), projectMcp: [] };
    const withoutBundle = snapshotMissionProfileCatalog({ guide, profiles: [noMcp] });
    const withDormantBundle = snapshotMissionProfileCatalog({ guide, profiles: [noMcp] }, bundle());

    expect(withoutBundle.projectMcpDeclarationFingerprint).toBeNull();
    expect(withDormantBundle.projectMcpDeclarationFingerprint).toBeNull();
    expect(withDormantBundle.fingerprint).toBe(withoutBundle.fingerprint);
  });

  it('requires a bundle and its exact fingerprint whenever a profile grants project tools', () => {
    expect(() => snapshotMissionProfileCatalog({ guide, profiles: [builder, reviewer] })).toThrow(
      /grants require a validated project MCP bundle/,
    );
    expect(() =>
      snapshotMissionProfileCatalog(
        { guide, profiles: [builder, reviewer] },
        {
          ...bundle(),
          declarationFingerprint: 'not-a-fingerprint',
        },
      ),
    ).toThrow(/invalid declaration fingerprint/);
  });

  it('rejects undeclared servers, empty grants, duplicates, and wildcard grants', () => {
    const cases: MissionExecutionProfile[] = [
      {
        ...clone(builder),
        projectMcp: [{ server: 'undeclared', tools: ['read_asset'] }],
      },
      { ...clone(builder), projectMcp: [{ server: 'project-tools', tools: [] }] },
      {
        ...clone(builder),
        projectMcp: [{ server: 'project-tools', tools: ['read_asset', 'read_asset'] }],
      },
      { ...clone(builder), projectMcp: [{ server: 'project-tools', tools: ['read_*'] }] },
    ];

    for (const profile of cases) {
      expect(() => snapshotMissionProfileCatalog({ guide, profiles: [profile] }, bundle())).toThrow(
        MissionProfileCatalogError,
      );
    }
  });

  it('rejects duplicate, colliding, or unsafe profile ids', () => {
    const cases = [
      { guide, profiles: [builder, clone(builder)] },
      { guide, profiles: [{ ...clone(builder), profileId: guide.profileId }] },
      { guide: { ...clone(guide), profileId: '__proto__' }, profiles: [builder] },
      { guide, profiles: [{ ...clone(builder), profileId: '../builder' }] },
      { guide, profiles: [{ ...clone(builder), profileId: ' builder ' }] },
    ];

    for (const candidate of cases) {
      expect(() => snapshotMissionProfileCatalog(candidate, bundle())).toThrow(MissionProfileCatalogError);
    }
  });

  it('rejects inconsistent write authority and strict-schema extensions', () => {
    expect(() =>
      snapshotMissionProfileCatalog(
        {
          guide,
          profiles: [
            {
              ...clone(builder),
              permission: 'read',
            },
          ],
        },
        bundle(),
      ),
    ).toThrow(/inconsistent write authority/);

    expect(() =>
      snapshotMissionProfileCatalog({ guide, profiles: [builder], extra: true }, bundle()),
    ).toThrow(/exactly guide, profiles, and validationPolicy/);
    expect(() =>
      snapshotMissionProfileCatalog({ guide: { ...guide, extra: true }, profiles: [builder] }, bundle()),
    ).toThrow(/strict mission schema/);
  });

  it('requires exact model ids for guide and child authority', () => {
    expect(() =>
      snapshotMissionProfileCatalog(
        { guide: { ...clone(guide), agent: { driver: 'guide-driver' } }, profiles: [builder] },
        bundle(),
      ),
    ).toThrow(/strict mission schema|must pin an exact model id/);
    expect(() =>
      snapshotMissionProfileCatalog(
        { guide, profiles: [{ ...clone(builder), agent: { driver: 'worker-driver' } }] },
        bundle(),
      ),
    ).toThrow(/strict mission schema|must pin an exact model id/);
    expect(() =>
      snapshotMissionProfileCatalog(
        {
          guide: { ...clone(guide), agent: { driver: 'guide-driver', model: 'safe\nmodel="escape"' } },
          profiles: [builder],
        },
        bundle(),
      ),
    ).toThrow(/strict mission schema|must pin an exact model id/);
    expect(() =>
      snapshotMissionProfileCatalog(
        {
          guide,
          profiles: [{ ...clone(builder), agent: { driver: 'worker-driver', model: 'worker model' } }],
        },
        bundle(),
      ),
    ).toThrow(/strict mission schema|must pin an exact model id/);
  });

  it.each([
    [
      'higher rank',
      { ...clone(reviewer), assurance: { ...reviewer.assurance, rank: builder.assurance.rank } },
    ],
    [
      'different independence class',
      {
        ...clone(reviewer),
        assurance: {
          ...reviewer.assurance,
          independenceClass: builder.assurance.independenceClass,
        },
      },
    ],
    ['different driver/model coordinate', { ...clone(reviewer), agent: { ...builder.agent } }],
  ])('requires every write profile to have a reviewer with a %s', (_criterion, candidateReviewer) => {
    expect(() =>
      snapshotMissionProfileCatalog({ guide, profiles: [builder, candidateReviewer] }, bundle()),
    ).toThrow(/write profile 'builder' has no authorized reviewer/);
  });

  it('requires explicit bounded review assurance and fingerprints it as durable authority', () => {
    expect(() =>
      snapshotMissionProfileCatalog(
        {
          guide,
          profiles: [{ ...clone(builder), assurance: { rank: 0, independenceClass: 'build' } }, reviewer],
        },
        bundle(),
      ),
    ).toThrow(/strict mission schema|positive assurance rank/);

    const first = snapshotMissionProfileCatalog({ guide, profiles: [builder, reviewer] }, bundle());
    const second = snapshotMissionProfileCatalog(
      {
        guide,
        profiles: [
          { ...clone(builder), assurance: { ...builder.assurance, independenceClass: 'build-v2' } },
          reviewer,
        ],
      },
      bundle(),
    );
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('requires and fingerprints one immutable validation policy in trusted authority', () => {
    expect(() =>
      snapshotMissionProfileCatalogRaw({ guide, profiles: [builder, reviewer] }, bundle()),
    ).toThrow(/exactly guide, profiles, and validationPolicy/);

    const command = snapshotMissionProfileCatalog(
      { guide, profiles: [builder, reviewer], validationPolicy },
      bundle(),
    );
    const explicitNone = snapshotMissionProfileCatalog(
      {
        guide,
        profiles: [builder, reviewer],
        validationPolicy: {
          kind: 'none',
          policyId: 'explicit-none-v1',
          reason: 'This trusted project has no deterministic validation command.',
        },
      },
      bundle(),
    );
    expect(explicitNone.fingerprint).not.toBe(command.fingerprint);
    expect(missionProfileCatalogCreateFields(explicitNone).validationPolicy).toEqual(
      explicitNone.validationPolicy,
    );
  });

  it('requires finite positive token and active-time budgets for every configured model', () => {
    const cases = [
      {
        guide: { ...clone(guide), budget: { ...budget, tokens: null } },
        profiles: [builder, reviewer],
        message: /guide profile .* token budget must be a finite positive safe integer/,
      },
      {
        guide: { ...clone(guide), budget: { ...budget, activeSeconds: 0 } },
        profiles: [builder, reviewer],
        message: /guide profile .* activeSeconds budget must be finite and positive/,
      },
      {
        guide,
        profiles: [{ ...clone(builder), budget: { ...budget, tokens: 0 } }, reviewer],
        message: /execution profile .* token budget must be a finite positive safe integer/,
      },
      {
        guide,
        profiles: [{ ...clone(builder), budget: { ...budget, activeSeconds: null } }, reviewer],
        message: /execution profile .* activeSeconds budget must be finite and positive/,
      },
    ];

    for (const { message, ...candidate } of cases) {
      expect(() => snapshotMissionProfileCatalog(candidate, bundle())).toThrow(message);
    }

    const nullUsd = snapshotMissionProfileCatalog(
      {
        guide: { ...clone(guide), budget: { ...budget, usd: null } },
        profiles: [{ ...clone(builder), budget: { ...budget, usd: null } }, reviewer],
      },
      bundle(),
    );
    expect(nullUsd.guide.budget.usd).toBeNull();
    expect(nullUsd.profiles[0]?.budget.usd).toBeNull();
  });

  it('rejects a per-field-valid catalog that cannot fit a durable mission creation action', () => {
    const huge = Array.from(
      { length: 63 },
      (_, profileIndex): MissionExecutionProfile => ({
        ...clone(builder),
        profileId: `builder-${profileIndex}`,
        driverPosture: {
          ...clone(builder.driverPosture),
          permission: {
            ...clone(builder.driverPosture.permission),
            allow: Array.from(
              { length: 64 },
              (_, ruleIndex) => `allow-${profileIndex}-${ruleIndex}-${'x'.repeat(480)}`,
            ),
          },
        },
        projectMcp: [],
      }),
    );

    expect(() =>
      snapshotMissionProfileCatalog({
        guide,
        profiles: [...huge, { ...clone(reviewer), projectMcp: [] }],
      }),
    ).toThrow(/canonical authority is .* maximum is .* task payload capacity/);
  });

  it('does not invoke accessors while rejecting an untrusted catalog object', () => {
    let invoked = false;
    const candidate = { profiles: [builder] } as Record<string, unknown>;
    Object.defineProperty(candidate, 'guide', {
      enumerable: true,
      get() {
        invoked = true;
        return guide;
      },
    });

    expect(() => snapshotMissionProfileCatalog(candidate, bundle())).toThrow(/data property/);
    expect(invoked).toBe(false);
  });

  it('revalidates and detaches a registered authority snapshot', () => {
    const snapshot = snapshotMissionProfileCatalog({ guide, profiles: [builder, reviewer] }, bundle());
    const validated = validateMissionProfileCatalogSnapshot(structuredClone(snapshot));

    expect(validated).toEqual(snapshot);
    expect(validated).not.toBe(snapshot);
    expect(Object.isFrozen(validated.profiles[0])).toBe(true);
  });

  it('rejects forged, mutated, and non-canonical authority snapshots', () => {
    const snapshot = snapshotMissionProfileCatalog({ guide, profiles: [builder, reviewer] }, bundle());

    expect(() =>
      validateMissionProfileCatalogSnapshot({ ...structuredClone(snapshot), fingerprint: 'f'.repeat(64) }),
    ).toThrow(/fingerprint does not match/);

    const mutated = structuredClone(snapshot);
    mutated.profiles[0]!.role = 'widened';
    expect(() => validateMissionProfileCatalogSnapshot(mutated)).toThrow(/fingerprint does not match/);

    const reordered = { ...structuredClone(snapshot), profiles: [...snapshot.profiles].reverse() };
    expect(() => validateMissionProfileCatalogSnapshot(reordered)).toThrow(/canonical normalized form/);

    const unbounded = structuredClone(snapshot);
    unbounded.guide.budget.tokens = null;
    expect(() => validateMissionProfileCatalogSnapshot(unbounded)).toThrow(
      /token budget must be a finite positive safe integer/,
    );
  });
});
