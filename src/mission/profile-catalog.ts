import { createHash } from 'node:crypto';
import { validateProjectMcpSession } from '../drivers/types';
import type { ProjectMcpBundle } from '../project-mcp';
import { validateMissionAction } from './action-schema';
import type {
  CreateMissionAction,
  MissionExecutionProfile,
  MissionGuideProfile,
  MissionValidationPolicy,
} from './protocol';
import { MAX_MISSION_ACTION_BYTES, canonicalMissionJson } from './store';

export const MISSION_PROFILE_CATALOG_SCHEMA_VERSION = 3 as const;

export interface MissionProfileCatalogInput {
  guide: MissionGuideProfile;
  profiles: readonly MissionExecutionProfile[];
  validationPolicy: MissionValidationPolicy;
}

/**
 * Immutable authority snapshot embedded into `create-mission`. The fingerprint covers the exact
 * guide and child authority plus the portable project MCP declaration they were validated against.
 */
export interface MissionProfileCatalogSnapshot extends MissionProfileCatalogInput {
  schemaVersion: typeof MISSION_PROFILE_CATALOG_SCHEMA_VERSION;
  fingerprint: string;
  projectMcpDeclarationFingerprint: string | null;
}

export class MissionProfileCatalogError extends Error {
  override readonly name = 'MissionProfileCatalogError';
}

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const SYNTHETIC_MCP_FINGERPRINT = '0'.repeat(64);
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
// Mission creation also carries the objective, resource capacities, completion policy, and cleanup.
// Keep at least half of the durable action envelope available for those task-specific fields.
export const MAX_MISSION_PROFILE_CATALOG_BYTES = Math.floor(MAX_MISSION_ACTION_BYTES / 2);

function invalid(detail: string): never {
  throw new MissionProfileCatalogError(`invalid mission profile catalog: ${detail}`);
}

/** Read an unknown local configuration without invoking accessors. */
function extractInput(candidate: unknown): {
  guide: unknown;
  profiles: unknown;
  validationPolicy: unknown;
} {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return invalid('root must be a plain object');
  }
  if (Object.getPrototypeOf(candidate) !== Object.prototype) {
    return invalid('root must be a plain object');
  }
  if (Object.getOwnPropertySymbols(candidate).length > 0) {
    return invalid('root must not contain symbol keys');
  }

  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Object.keys(descriptors);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(descriptors, 'guide') ||
    !Object.hasOwn(descriptors, 'profiles') ||
    !Object.hasOwn(descriptors, 'validationPolicy')
  ) {
    return invalid('root must contain exactly guide, profiles, and validationPolicy');
  }
  for (const key of ['guide', 'profiles', 'validationPolicy'] as const) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      return invalid(`${key} must be an enumerable data property`);
    }
  }
  return {
    guide: (descriptors.guide as PropertyDescriptor & { value: unknown }).value,
    profiles: (descriptors.profiles as PropertyDescriptor & { value: unknown }).value,
    validationPolicy: (descriptors.validationPolicy as PropertyDescriptor & { value: unknown }).value,
  };
}

/** Reuse the kernel's strict schema without granting this local catalogue its own looser dialect. */
function parseProfiles(input: {
  guide: unknown;
  profiles: unknown;
  validationPolicy: unknown;
}): MissionProfileCatalogInput {
  const base = {
    type: 'create-mission',
    budget: { tokens: null, usd: null, activeSeconds: null },
    resources: {},
    guide: input.guide,
    profiles: input.profiles,
    validationPolicy: input.validationPolicy,
  } as const;

  for (const projectMcpDeclarationFingerprint of [null, SYNTHETIC_MCP_FINGERPRINT] as const) {
    const result = validateMissionAction({ ...base, projectMcpDeclarationFingerprint });
    if (result.success && result.action.type === 'create-mission') {
      return {
        guide: result.action.guide,
        profiles: result.action.profiles,
        validationPolicy: result.action.validationPolicy,
      };
    }
  }
  return invalid('guide, execution profiles, or validation policy do not match the strict mission schema');
}

function validateProfileId(profileId: string, owner: string): void {
  if (!PROFILE_ID.test(profileId) || UNSAFE_IDS.has(profileId)) {
    invalid(
      `${owner} profileId '${profileId}' is unsafe; use 1-128 ASCII letters, digits, '.', '_', ':', or '-'`,
    );
  }
}

function validateProfileAuthority(input: MissionProfileCatalogInput): void {
  validateProfileId(input.guide.profileId, 'guide');
  if (!input.guide.agent.model || !SAFE_MODEL_ID.test(input.guide.agent.model)) {
    invalid(`guide profile '${input.guide.profileId}' must pin an exact model id`);
  }
  validateActivationBudget(input.guide.budget, `guide profile '${input.guide.profileId}'`);

  const seenIds = new Set([input.guide.profileId]);
  for (const profile of input.profiles) {
    validateProfileId(profile.profileId, 'execution');
    if (seenIds.has(profile.profileId)) {
      invalid(`profileId '${profile.profileId}' is duplicated across the catalogue`);
    }
    seenIds.add(profile.profileId);
    if (!profile.agent.model || !SAFE_MODEL_ID.test(profile.agent.model)) {
      invalid(`execution profile '${profile.profileId}' must pin an exact model id`);
    }
    if (
      !Number.isSafeInteger(profile.assurance.rank) ||
      profile.assurance.rank <= 0 ||
      !PROFILE_ID.test(profile.assurance.independenceClass) ||
      UNSAFE_IDS.has(profile.assurance.independenceClass)
    ) {
      invalid(
        `execution profile '${profile.profileId}' must declare a positive assurance rank and safe independence class`,
      );
    }
    validateActivationBudget(profile.budget, `execution profile '${profile.profileId}'`);
    if (profile.driverPosture.permission.write !== (profile.permission === 'write')) {
      invalid(`execution profile '${profile.profileId}' has inconsistent write authority`);
    }
  }

  for (const subject of input.profiles.filter((profile) => profile.permission === 'write')) {
    if (!input.profiles.some((reviewer) => profileCanIndependentlyReview(subject, reviewer))) {
      invalid(
        `write profile '${subject.profileId}' has no authorized reviewer with a higher assurance rank, different independence class, and different driver/model coordinate`,
      );
    }
  }
}

function isAuthorizedReviewProfile(profile: MissionExecutionProfile): boolean {
  return (
    profile.permission === 'read' &&
    profile.driverPosture.kind === 'verify' &&
    !profile.driverPosture.permission.write &&
    ['reviewer', 'verifier'].includes(profile.driverPosture.lineageRole)
  );
}

/** The sole vendor-neutral relation used by both catalogue admission and plan validation. */
export function profileCanIndependentlyReview(
  subject: MissionExecutionProfile,
  reviewer: MissionExecutionProfile,
): boolean {
  return (
    isAuthorizedReviewProfile(reviewer) &&
    reviewer.assurance.rank > subject.assurance.rank &&
    reviewer.assurance.independenceClass !== subject.assurance.independenceClass &&
    (reviewer.agent.driver !== subject.agent.driver || reviewer.agent.model !== subject.agent.model)
  );
}

/**
 * Trusted catalogues are an activation boundary, not the recovery schema. A persisted low-level
 * mission may still contain nullable ceilings for compatibility, but locally configured work must
 * always have enforceable token and wall-clock limits before it can reach a model.
 */
function validateActivationBudget(budget: MissionGuideProfile['budget'], owner: string): void {
  if (!Number.isSafeInteger(budget.tokens) || (budget.tokens ?? 0) <= 0) {
    invalid(`${owner} token budget must be a finite positive safe integer`);
  }
  if (
    typeof budget.activeSeconds !== 'number' ||
    !Number.isFinite(budget.activeSeconds) ||
    budget.activeSeconds <= 0 ||
    budget.activeSeconds > Number.MAX_SAFE_INTEGER
  ) {
    invalid(`${owner} activeSeconds budget must be finite and positive`);
  }
  if (
    budget.usd !== null &&
    (typeof budget.usd !== 'number' ||
      !Number.isFinite(budget.usd) ||
      budget.usd < 0 ||
      budget.usd > Number.MAX_SAFE_INTEGER)
  ) {
    invalid(`${owner} USD budget must be null or finite and non-negative`);
  }
}

const compareCodeUnits = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function sortedUnique(values: readonly string[]): string[] {
  return [...values].sort(compareCodeUnits);
}

function normalizeProfile(profile: MissionExecutionProfile): MissionExecutionProfile {
  return {
    ...profile,
    agent: { ...profile.agent },
    assurance: { ...profile.assurance },
    driverPosture: {
      ...profile.driverPosture,
      permission: {
        ...profile.driverPosture.permission,
        allow: sortedUnique(profile.driverPosture.permission.allow),
        deny: sortedUnique(profile.driverPosture.permission.deny),
      },
    },
    budget: { ...profile.budget },
    resources: { ...profile.resources },
    projectMcp: [...profile.projectMcp]
      .sort((left, right) => compareCodeUnits(left.server, right.server))
      .map((grant) => ({ server: grant.server, tools: sortedUnique(grant.tools) })),
  };
}

function requireProjectMcpBinding(
  profiles: readonly MissionExecutionProfile[],
  projectMcpBundle: ProjectMcpBundle | undefined,
): string | null {
  const profilesWithGrants = profiles.filter((profile) => profile.projectMcp.length > 0);
  if (profilesWithGrants.length === 0) return null;
  if (!projectMcpBundle) invalid('project MCP grants require a validated project MCP bundle');
  if (!SHA256.test(projectMcpBundle.declarationFingerprint)) {
    invalid('project MCP bundle has an invalid declaration fingerprint');
  }

  for (const profile of profilesWithGrants) {
    const toolGrants: Record<string, readonly string[]> = Object.create(null) as Record<
      string,
      readonly string[]
    >;
    for (const grant of profile.projectMcp) {
      if (UNSAFE_IDS.has(grant.server)) {
        invalid(`execution profile '${profile.profileId}' grants unsafe server '${grant.server}'`);
      }
      toolGrants[grant.server] = grant.tools;
    }
    try {
      validateProjectMcpSession({ bundle: projectMcpBundle, toolGrants });
    } catch (error) {
      invalid(
        `execution profile '${profile.profileId}' has invalid project MCP grants: ${
          error instanceof Error ? error.message : 'validation failed'
        }`,
      );
    }
  }
  return projectMcpBundle.declarationFingerprint;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateCatalogAggregateBytes(authority: unknown): void {
  const bytes = Buffer.byteLength(canonicalMissionJson(authority), 'utf8');
  if (bytes > MAX_MISSION_PROFILE_CATALOG_BYTES) {
    invalid(
      `canonical authority is ${bytes} bytes; maximum is ${MAX_MISSION_PROFILE_CATALOG_BYTES} so mission creation retains bounded task payload capacity`,
    );
  }
}

/**
 * Validate and snapshot a trusted, locally supplied profile catalogue. Project declarations only
 * provide transports; each profile must name its exact tool subset, and the resulting mission is
 * bound to the declaration fingerprint before any guide can select a profile.
 */
export function snapshotMissionProfileCatalog(
  candidate: unknown,
  projectMcpBundle?: ProjectMcpBundle,
): MissionProfileCatalogSnapshot {
  const parsed = parseProfiles(extractInput(candidate));
  validateProfileAuthority(parsed);

  const profiles = parsed.profiles
    .map(normalizeProfile)
    .sort((left, right) => compareCodeUnits(left.profileId, right.profileId));
  const projectMcpDeclarationFingerprint = requireProjectMcpBinding(profiles, projectMcpBundle);
  const authority = {
    schemaVersion: MISSION_PROFILE_CATALOG_SCHEMA_VERSION,
    projectMcpDeclarationFingerprint,
    guide: {
      ...parsed.guide,
      agent: { ...parsed.guide.agent },
      budget: { ...parsed.guide.budget },
    },
    profiles,
    validationPolicy: { ...parsed.validationPolicy },
  };
  validateCatalogAggregateBytes(authority);
  const fingerprint = createHash('sha256').update(canonicalMissionJson(authority), 'utf8').digest('hex');

  // Canonical JSON is also the detachment boundary: no references to mutable caller objects or a
  // mutable ProjectMcpBundle survive into the authority embedded in `create-mission`.
  const detached = JSON.parse(
    canonicalMissionJson({ ...authority, fingerprint }),
  ) as MissionProfileCatalogSnapshot;
  return deepFreeze(detached);
}

/**
 * Revalidate a persisted or dependency-injected authority snapshot before registering it. Types
 * are not a trust boundary: this verifies the strict profile schema, canonical ordering, project
 * binding shape, and the content fingerprint, then returns a detached frozen copy.
 */
export function validateMissionProfileCatalogSnapshot(candidate: unknown): MissionProfileCatalogSnapshot {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return invalid('snapshot root must be a plain object');
  }
  if (Object.getPrototypeOf(candidate) !== Object.prototype) {
    return invalid('snapshot root must be a plain object');
  }
  if (Object.getOwnPropertySymbols(candidate).length > 0) {
    return invalid('snapshot root must not contain symbol keys');
  }

  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const expectedKeys = [
    'schemaVersion',
    'fingerprint',
    'projectMcpDeclarationFingerprint',
    'guide',
    'profiles',
    'validationPolicy',
  ] as const;
  if (
    Object.keys(descriptors).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    return invalid(`snapshot root must contain exactly ${expectedKeys.join(', ')}`);
  }
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      return invalid(`snapshot ${key} must be an enumerable data property`);
    }
  }

  const snapshotField = (key: (typeof expectedKeys)[number]): unknown =>
    (descriptors[key] as PropertyDescriptor & { value: unknown }).value;
  if (snapshotField('schemaVersion') !== MISSION_PROFILE_CATALOG_SCHEMA_VERSION) {
    return invalid(`snapshot schemaVersion must be ${MISSION_PROFILE_CATALOG_SCHEMA_VERSION}`);
  }
  const suppliedFingerprint = snapshotField('fingerprint');
  if (typeof suppliedFingerprint !== 'string' || !SHA256.test(suppliedFingerprint)) {
    return invalid('snapshot fingerprint is invalid');
  }
  const projectMcpDeclarationFingerprint = snapshotField('projectMcpDeclarationFingerprint');
  if (
    projectMcpDeclarationFingerprint !== null &&
    (typeof projectMcpDeclarationFingerprint !== 'string' || !SHA256.test(projectMcpDeclarationFingerprint))
  ) {
    return invalid('snapshot project MCP declaration fingerprint is invalid');
  }

  const parsed = parseProfiles({
    guide: snapshotField('guide'),
    profiles: snapshotField('profiles'),
    validationPolicy: snapshotField('validationPolicy'),
  });
  validateProfileAuthority(parsed);
  const profiles = parsed.profiles
    .map(normalizeProfile)
    .sort((left, right) => compareCodeUnits(left.profileId, right.profileId));
  const hasProjectGrants = profiles.some((profile) => profile.projectMcp.length > 0);
  if (hasProjectGrants !== (projectMcpDeclarationFingerprint !== null)) {
    return invalid('snapshot project MCP grants do not match its declaration binding');
  }

  const authority = {
    schemaVersion: MISSION_PROFILE_CATALOG_SCHEMA_VERSION,
    projectMcpDeclarationFingerprint,
    guide: {
      ...parsed.guide,
      agent: { ...parsed.guide.agent },
      budget: { ...parsed.guide.budget },
    },
    profiles,
    validationPolicy: { ...parsed.validationPolicy },
  };
  validateCatalogAggregateBytes(authority);
  const originalAuthority = {
    schemaVersion: snapshotField('schemaVersion'),
    projectMcpDeclarationFingerprint,
    guide: snapshotField('guide'),
    profiles: snapshotField('profiles'),
    validationPolicy: snapshotField('validationPolicy'),
  };
  if (canonicalMissionJson(originalAuthority) !== canonicalMissionJson(authority)) {
    return invalid('snapshot authority is not in canonical normalized form');
  }
  const expectedFingerprint = createHash('sha256')
    .update(canonicalMissionJson(authority), 'utf8')
    .digest('hex');
  if (suppliedFingerprint !== expectedFingerprint) {
    return invalid('snapshot fingerprint does not match its authority');
  }

  const detached = JSON.parse(
    canonicalMissionJson({ ...authority, fingerprint: suppliedFingerprint }),
  ) as MissionProfileCatalogSnapshot;
  return deepFreeze(detached);
}

/** Direct fields consumed by `CreateMissionAction`, useful to keep integration code mechanical. */
export function missionProfileCatalogCreateFields(
  snapshot: MissionProfileCatalogSnapshot,
): Pick<CreateMissionAction, 'guide' | 'profiles' | 'validationPolicy' | 'projectMcpDeclarationFingerprint'> {
  return {
    guide: snapshot.guide,
    profiles: snapshot.profiles,
    validationPolicy: snapshot.validationPolicy,
    projectMcpDeclarationFingerprint: snapshot.projectMcpDeclarationFingerprint,
  };
}

/**
 * Sequential missions need at most the largest one-child reservation for each key. Deriving this
 * capacity from immutable local profiles prevents a dispatch request or guide from inflating the
 * mission-local admission ceiling. Machine-wide availability is enforced separately by the
 * durable external resource coordinator.
 */
export function missionProfileCatalogResourceCapacities(
  snapshot: MissionProfileCatalogSnapshot,
): Readonly<Record<string, number>> {
  const capacities: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const profile of snapshot.profiles) {
    for (const [key, units] of Object.entries(profile.resources)) {
      capacities[key] = Math.max(capacities[key] ?? 0, units);
    }
  }
  return Object.freeze({ ...capacities });
}
