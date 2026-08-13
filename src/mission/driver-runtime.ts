import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PermissionProfile, RunBudget, RunEffort } from '@noriq-dev/shared';
import { superviseBudget, totalTokens } from '../drivers/budget';
import {
  type AgentDriver,
  type DriverSession,
  type DriverStartOptions,
  type DriverTelemetry,
  type ProjectMcpSession,
  validateProjectMcpSession,
} from '../drivers/types';
import { type ProjectMcpBundle, bindProjectMcpBundle } from '../project-mcp';
import { missionAgentEnv } from '../security';
import {
  type MissionExternalResourceCoordinator,
  isExternalMissionResourceKey,
} from './global-resource-coordinator';
import {
  MissionChildAttemptError,
  type MissionChildExecution,
  type MissionChildExecutor,
  type MissionChildResult,
  type MissionChildStartRequest,
  type MissionGuide,
  MissionGuidePreflightError,
  type MissionGuideRequest,
  type MissionGuideResult,
} from './harness';
import {
  type MissionCheckpointState,
  type MissionChildState,
  type MissionState,
  childIsTerminal,
} from './model';
import { missionPlanStepKey } from './plan-identity';
import type {
  MissionBudget,
  MissionChildArtifact,
  MissionExecutionPlanArtifact,
  MissionExecutionProfile,
  MissionGuideProfile,
  MissionReviewArtifact,
  MissionUsage,
} from './protocol';
import {
  MAX_MISSION_EXECUTION_PLAN_BYTES,
  MAX_MISSION_PLAN_ACCEPTANCE_CHARS,
  MAX_MISSION_PLAN_ACCEPTANCE_ITEMS,
  MAX_MISSION_PLAN_INSTRUCTION_CHARS,
  MAX_MISSION_PLAN_REPAIR_ROUNDS,
  MAX_MISSION_PLAN_STEPS,
  MAX_MISSION_PLAN_SUMMARY_CHARS,
  MAX_MISSION_REVIEW_SUMMARY_CHARS,
} from './protocol';
import { canonicalMissionJson } from './store';

const DRIVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_MODELS_PER_DRIVER = 256;
const RUN_EFFORTS = new Set<RunEffort>(['low', 'medium', 'high', 'xhigh', 'max']);
const REPOSITORY_MARKERS = ['.git', '.hg', '.jj', '.svn'] as const;
const DEFAULT_MAX_GUIDE_OUTPUT_BYTES = 60_000;
const DEFAULT_MAX_CHILD_SUMMARY_CHARS = 64_000;
const DEFAULT_MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_PROMPT_CHARS = 256_000;
const DEFAULT_ATTEMPT_TRANSACTION_TIMEOUT_MS = 10_000;
const TRUNCATED = '[truncated]';

export type MissionTelemetryAvailability = 'reported' | 'unknown';

/**
 * Driver telemetry is not uniform: for example, a provider may report tokens but no monetary
 * cost. This trusted, local declaration prevents a numeric placeholder from becoming fake zero
 * spend in the mission ledger.
 */
export interface MissionDriverMetering {
  tokens: MissionTelemetryAvailability;
  usd: MissionTelemetryAvailability;
}

export interface TrustedMissionDriverRegistration {
  /** Local execution-profile key. It need not be the driver's vendor tool name. */
  driverId: string;
  /** Exact model coordinates this local driver registration is authorized to launch. */
  models: readonly string[];
  driver: AgentDriver;
  metering: MissionDriverMetering;
}

/** An immutable, string-keyed registry populated only from trusted Runner configuration. */
export class TrustedMissionDriverRegistry {
  private readonly entries: ReadonlyMap<string, TrustedMissionDriverRegistration>;

  constructor(registrations: readonly TrustedMissionDriverRegistration[]) {
    const entries = new Map<string, TrustedMissionDriverRegistration>();
    for (const registration of registrations) {
      if (!DRIVER_ID.test(registration.driverId)) {
        throw new Error(`invalid mission driver id '${registration.driverId}'`);
      }
      if (entries.has(registration.driverId)) {
        throw new Error(`duplicate mission driver id '${registration.driverId}'`);
      }
      if (
        !Array.isArray(registration.models) ||
        registration.models.length === 0 ||
        registration.models.length > MAX_MODELS_PER_DRIVER
      ) {
        throw new Error(
          `mission driver '${registration.driverId}' must declare 1-${MAX_MODELS_PER_DRIVER} exact model ids`,
        );
      }
      const models = [...registration.models];
      if (models.some((model) => typeof model !== 'string' || !MODEL_ID.test(model))) {
        throw new Error(`mission driver '${registration.driverId}' declares an invalid model id`);
      }
      if (new Set(models).size !== models.length) {
        throw new Error(`mission driver '${registration.driverId}' declares duplicate model ids`);
      }
      if (
        (registration.metering.tokens !== 'reported' && registration.metering.tokens !== 'unknown') ||
        (registration.metering.usd !== 'reported' && registration.metering.usd !== 'unknown')
      ) {
        throw new Error(`invalid metering declaration for mission driver '${registration.driverId}'`);
      }
      entries.set(
        registration.driverId,
        Object.freeze({
          driverId: registration.driverId,
          models: Object.freeze(models),
          driver: registration.driver,
          metering: Object.freeze({ ...registration.metering }),
        }),
      );
    }
    this.entries = entries;
  }

  require(driverId: string, model: string): TrustedMissionDriverRegistration {
    const registration = this.entries.get(driverId);
    if (!registration) throw new Error(`mission driver '${driverId}' is not in the trusted registry`);
    if (!registration.models.includes(model)) {
      throw new Error(`mission model '${model}' is not in the trusted allowlist for driver '${driverId}'`);
    }
    return registration;
  }
}

export interface MissionGuideWorkspace {
  cwd: string;
  /** Attestation by the trusted workspace allocator; Runner verifies basic facts again below. */
  privateNonRepository: true;
  /** Re-attest the commissioned boundary immediately before the guide provider is activated. */
  verifyLaunchAuthority(): Promise<void>;
}

export interface DriverMissionGuideOptions {
  drivers: TrustedMissionDriverRegistry;
  profile: MissionGuideProfile;
  resolveWorkspace: () => Promise<MissionGuideWorkspace>;
  /** Optional base environment. It is always sanitized again at this boundary. */
  env?: NodeJS.ProcessEnv;
  /** Maximum UTF-8 bytes accepted from one guide response. */
  maxOutputBytes?: number;
  /** @deprecated Use maxOutputBytes. This compatibility alias is also interpreted as bytes. */
  maxOutputChars?: number;
  maxPromptChars?: number;
  /** Bound workspace and commissioned-authority checks before the guide provider is activated. */
  launchAuthorityTimeoutMs?: number;
}

export interface MissionChildWorkspaceResolution {
  /** The one mission-owned workspace in which this child operates. */
  cwd: string;
  /** Backend-native immutable revision that is present before this exact attempt starts. */
  revisionId: string;
  /** Stable identity for this materialization of the mission-owned workspace. */
  leaseGeneration: string;
  /**
   * Recheck the exact lease and revision immediately before attempt ownership is claimed. A
   * trusted VCS workspace coordinator supplies this; a path alone is never launch authority.
   */
  verifyLaunchAuthority(): Promise<void>;
  /** Portable declaration loaded by the trusted project preparation path, before binding. */
  projectMcp: ProjectMcpBundle | null;
  /** Optional base environment. It is always sanitized again at this boundary. */
  env?: NodeJS.ProcessEnv;
  /** Exact VCS-view variables from the trusted workspace adapter, applied after sanitization. */
  trustedEnv?: Readonly<Record<string, string>>;
  containmentReadOnlyRoots?: readonly string[];
  /** Workspace-relative backend metadata paths protected from write-capable agents. */
  protectedWorkspaceReadOnlyPaths?: readonly string[];
  containmentWriteRoots?: readonly string[];
}

export type MissionChildWorkspaceResolver = (
  state: MissionState,
  child: MissionChildState,
) => Promise<MissionChildWorkspaceResolution>;

/** Durable identity only: this lookup cannot authorize a new launch. */
export interface MissionAttemptRecoveryRequest {
  missionId: string;
  childId: string;
  attemptId: string;
}

export type MissionAttemptRegistryRecovery =
  | { status: 'absent' }
  | { status: 'attached'; execution: MissionChildExecution }
  | { status: 'ambiguous'; reason: string };

export interface MissionAttemptRegistryRequest {
  missionId: string;
  childId: string;
  attemptId: string;
  /** Canonical digest of child authority, instruction, workspace, and effective MCP launch. */
  authorityFingerprint: string;
  /** Trusted renderer/schema revision and exact rendered prompt digest are attach authority. */
  promptRendererVersion: string;
  promptFingerprint: string;
  workspace: string;
  workspaceRevisionId: string;
  workspaceLeaseGeneration: string;
  projectMcpEffectiveFingerprint: string | null;
  onUsage: MissionChildStartRequest['onUsage'];
}

export interface MissionAttemptStartReservation {
  status: 'start';
  /** Publish a dormant wrapper before the harness is allowed to activate its provider. */
  publish(execution: MissionChildExecution): Promise<void>;
  /** Preserve ambiguity after a spawn/publish failure; never silently free it for a duplicate. */
  markAmbiguous(reason: string): Promise<void>;
}

export type MissionAttemptRegistryClaim =
  | MissionAttemptStartReservation
  | { status: 'attached'; execution: MissionChildExecution }
  | { status: 'ambiguous'; reason: string };

/**
 * The AgentDriver API has no attach-by-attempt operation. A correct runtime therefore needs an
 * atomic, independently owned registry in front of process creation. `start` authorizes only
 * publication of a dormant execution; the harness activates it after registration. `attached`
 * returns the exact wrapper wired to this request; `ambiguous` refuses a potentially duplicating
 * launch.
 */
export interface MissionAttemptSessionRegistry {
  /**
   * Recover an already-claimed exact durable attempt without consulting current launch
   * configuration. `absent` is the only result that permits the full-authority claim below.
   */
  recover?(request: MissionAttemptRecoveryRequest): Promise<MissionAttemptRegistryRecovery>;
  claim(request: MissionAttemptRegistryRequest): Promise<MissionAttemptRegistryClaim>;
}

export interface DriverMissionChildExecutorOptions {
  drivers: TrustedMissionDriverRegistry;
  resolveWorkspace: MissionChildWorkspaceResolver;
  attemptRegistry?: MissionAttemptSessionRegistry;
  /** Durable cross-mission authority for every non-empty profile resource reservation. */
  resources?: MissionExternalResourceCoordinator;
  /** Required trusted frame. Raw guide instructions are never a production prompt fallback. */
  renderPrompt: MissionChildPromptRenderer;
  /** Explicit immutable renderer/schema revision included in every attempt identity. */
  promptRendererVersion: string;
  maxSummaryChars?: number;
  /** Aggregate streamed JSON/result bound, distinct from the persisted summary bound. */
  maxOutputBytes?: number;
  /** @deprecated Use maxOutputBytes. This compatibility alias is also interpreted as bytes. */
  maxOutputChars?: number;
  maxPromptChars?: number;
  /** Journal-facing usage updates are coalesced; local driver enforcement still sees every tick. */
  usageReportIntervalMs?: number;
  /** Bound every pre-launch resource/attempt transaction. A timeout never launches a model. */
  attemptTransactionTimeoutMs?: number;
}

export interface MissionChildPromptContext {
  objective: MissionState['objective'];
  childId: string;
  role: string;
  permission: MissionChildState['permission'];
  lineageRole: MissionChildState['driverPosture']['lineageRole'];
  /** Guide-authored evidence, never trusted instructions to the renderer. */
  guideInstruction: { trust: 'untrusted'; text: string };
  /** Exact durable review subject, including immutable revision, when commissioned. */
  subjectCheckpoint: MissionCheckpointState | null;
  /** Kernel-derived facts and output contract. Never merge this object with guide-authored text. */
  trustedFrame: MissionChildTrustedPromptFrame;
}

export interface MissionChildPromptProfileDescriptor {
  profileId: string;
  role: string;
  permission: MissionChildState['permission'];
  kind: MissionExecutionProfile['driverPosture']['kind'];
  lineageRole: MissionExecutionProfile['driverPosture']['lineageRole'];
  assuranceRank: number;
  independenceClass: string;
  /** Worst-case per-attempt reservation used by deterministic plan admission. */
  budgetCeiling: MissionBudget;
  /** Capability hint only. Exact tools and launch authority stay outside model-visible context. */
  projectMcpServers: readonly string[];
}

export const MISSION_EXECUTION_PLAN_OUTPUT_SCHEMA = Object.freeze({
  schemaVersion: 'mission-child-artifact.v1',
  type: 'execution-plan',
  maxCanonicalBytes: MAX_MISSION_EXECUTION_PLAN_BYTES,
  exactFields: ['type', 'summary', 'steps'],
  summary: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_MISSION_PLAN_SUMMARY_CHARS,
  },
  steps: {
    type: 'array',
    minItems: 1,
    maxItems: MAX_MISSION_PLAN_STEPS,
    uniqueBy: 'id',
    item: {
      requiredFields: ['id', 'title', 'profileId', 'instruction', 'acceptance'],
      optionalFields: ['reviewProfileId'],
      reviewPolicy:
        'Every write profile requires a reviewProfileId whose advertised assurance rank is higher, independence class differs, and driver/model coordinate differs.',
      bounds: {
        id: 128,
        title: 256,
        profileId: 256,
        reviewProfileId: 256,
        instruction: MAX_MISSION_PLAN_INSTRUCTION_CHARS,
      },
      acceptance: {
        minItems: 1,
        maxItems: MAX_MISSION_PLAN_ACCEPTANCE_ITEMS,
        maxTextLength: MAX_MISSION_PLAN_ACCEPTANCE_CHARS,
      },
    },
  },
} as const);

export const MISSION_REVIEW_OUTPUT_SCHEMA = Object.freeze({
  schemaVersion: 'mission-child-artifact.v1',
  type: 'review',
  exactFields: ['type', 'checkpointId', 'revisionId', 'verdict', 'highestSeverity', 'summary'],
  verdict: ['passed', 'changes-requested'],
  highestSeverity: ['none', 'low', 'medium', 'high', 'critical'],
  bounds: {
    checkpointId: 512,
    revisionId: 512,
    summary: MAX_MISSION_REVIEW_SUMMARY_CHARS,
  },
} as const);

export type MissionChildTrustedPromptFrame =
  | {
      kind: 'planner';
      outputSchema: typeof MISSION_EXECUTION_PLAN_OUTPUT_SCHEMA;
      eligibleBuildProfiles: readonly MissionChildPromptProfileDescriptor[];
      eligibleReviewProfiles: readonly MissionChildPromptProfileDescriptor[];
      budgetPlanning: {
        missionCeiling: MissionBudget;
        missionUsage: MissionUsage;
        /**
         * Capacity guaranteed after all current reservations and the approval/completion guide
         * turns. Null means that the mission itself is unbounded on that axis.
         */
        guaranteedAvailableForPlan: MissionBudget;
        unprovableAxes: readonly (keyof MissionBudget)[];
        guideTurnCeiling: MissionBudget | null;
        reservedGuideTurns: 2;
        repairRoundsPerStep: typeof MAX_MISSION_PLAN_REPAIR_ROUNDS;
        maximumAttemptsPerStep: number;
      };
    }
  | {
      kind: 'reviewer';
      outputSchema: typeof MISSION_REVIEW_OUTPUT_SCHEMA;
      /** Null for a direct exact-checkpoint review outside an adopted execution plan. */
      planStep: { id: string; acceptance: readonly string[] } | null;
    }
  | { kind: 'worker'; outputSchema: null };

export type MissionChildPromptRenderer = (context: MissionChildPromptContext) => string | Promise<string>;

const positiveLimit = (
  value: number | undefined,
  fallback: number,
  name: string,
  maximum = 1024 * 1024,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return resolved;
};

const outputByteLimit = (
  byteValue: number | undefined,
  legacyCharValue: number | undefined,
  fallback: number,
  maximum: number,
): number => {
  if (byteValue !== undefined && legacyCharValue !== undefined) {
    throw new Error('specify maxOutputBytes or maxOutputChars, not both');
  }
  return positiveLimit(byteValue ?? legacyCharValue, fallback, 'maxOutputBytes', maximum);
};

const nonNegativeInterval = (value: number | undefined, fallback: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 60_000) {
    throw new Error('usageReportIntervalMs must be a safe integer from 0 through 60000');
  }
  return resolved;
};

class MissionAttemptTransactionTimeoutError extends Error {
  override readonly name = 'MissionAttemptTransactionTimeoutError';
}

async function boundedAttemptTransaction<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new MissionAttemptTransactionTimeoutError(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

function missionUsage(
  telemetry: DriverTelemetry,
  metering: MissionDriverMetering,
  activeSeconds: number,
): MissionUsage {
  const tokenTotal = totalTokens(telemetry);
  return {
    tokens:
      metering.tokens === 'reported' && Number.isSafeInteger(tokenTotal) && tokenTotal >= 0
        ? tokenTotal
        : null,
    usd: metering.usd === 'reported' && finiteNonNegative(telemetry.costUsd) ? telemetry.costUsd : null,
    activeSeconds: Math.max(0, activeSeconds),
  };
}

function highWater(previous: MissionUsage, next: MissionUsage): MissionUsage {
  return {
    tokens: previous.tokens === null || next.tokens === null ? null : Math.max(previous.tokens, next.tokens),
    usd: previous.usd === null || next.usd === null ? null : Math.max(previous.usd, next.usd),
    activeSeconds:
      previous.activeSeconds === null || next.activeSeconds === null
        ? null
        : Math.max(previous.activeSeconds, next.activeSeconds),
  };
}

function validRegistryAttachUsage(value: MissionUsage | null | undefined): boolean {
  if (value === undefined) return false;
  if (value === null) return true;
  return (
    (value.tokens === null || (Number.isSafeInteger(value.tokens) && value.tokens >= 0)) &&
    (value.usd === null || finiteNonNegative(value.usd)) &&
    (value.activeSeconds === null || finiteNonNegative(value.activeSeconds))
  );
}

const elapsedSeconds = (startedAt: number): number => Math.max(0, (performance.now() - startedAt) / 1_000);

function toRunBudget(budget: MissionBudget): RunBudget {
  return {
    maxTokens: budget.tokens,
    maxUsd: budget.usd,
    maxDurationSeconds: budget.activeSeconds,
    maxRounds: null,
  };
}

function effort(value: string | undefined): RunEffort | undefined {
  if (value === undefined) return undefined;
  if (!RUN_EFFORTS.has(value as RunEffort)) {
    throw new Error(`mission profile names unsupported effort '${value}'`);
  }
  return value as RunEffort;
}

function assertMeteringCanEnforce(
  registration: TrustedMissionDriverRegistration,
  budgets: readonly { scope: string; budget: MissionBudget }[],
): void {
  if (registration.driver.capabilities.commissionedExecutionBoundary !== true) {
    throw new Error(`mission driver '${registration.driverId}' lacks a commissioned execution boundary`);
  }
  if (
    budgets.some(({ budget }) => budget.tokens !== null) &&
    registration.driver.capabilities.hardTokenEnvelope !== true
  ) {
    throw new Error(
      `mission driver '${registration.driverId}' cannot enforce a provider-side hard token envelope`,
    );
  }
  for (const { scope, budget } of budgets) {
    if (budget.tokens !== null && registration.metering.tokens === 'unknown') {
      throw new Error(
        `mission driver '${registration.driverId}' cannot enforce the finite ${scope} token budget because token telemetry is unknown`,
      );
    }
    if (budget.usd !== null && registration.metering.usd === 'unknown') {
      throw new Error(
        `mission driver '${registration.driverId}' cannot enforce the finite ${scope} USD budget because cost telemetry is unknown`,
      );
    }
  }
}

function missionTokenEnvelope(
  prompt: string,
  budget: MissionBudget,
  maxTurns: number,
): NonNullable<DriverStartOptions['tokenEnvelope']> {
  const totalTokens = budget.tokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens === null || totalTokens < 1) {
    throw new Error('mission launch requires a finite positive token budget');
  }
  // One token per UTF-8 byte is a deliberately conservative tokenizer-independent upper bound
  // for the known user frame. Provider/system/cache context remains covered by the hard total.
  const promptUpperBound = Buffer.byteLength(prompt, 'utf8');
  if (promptUpperBound > totalTokens) {
    throw new Error(
      `mission prompt cannot fit its hard token envelope (${promptUpperBound} > ${totalTokens})`,
    );
  }
  return { totalTokens, maxTurns };
}

function childMaxTurns(tokens: number): number {
  return Math.max(1, Math.min(64, Math.floor(tokens / 256)));
}

function remainingTokenAllowance(
  sessionTokens: number | null,
  sessionUsedTokens: number | null,
  missionTokens: number | null,
  usedTokens: number | null,
): number {
  if (!Number.isSafeInteger(sessionTokens) || sessionTokens === null || sessionTokens < 1) {
    throw new Error('mission session lacks a finite positive token allowance');
  }
  if (!Number.isSafeInteger(sessionUsedTokens) || sessionUsedTokens === null || sessionUsedTokens < 0) {
    throw new Error('remaining session token allowance cannot be proven');
  }
  const sessionRemaining = sessionTokens - sessionUsedTokens;
  if (sessionRemaining < 1) throw new Error('mission session token allowance is exhausted');
  if (missionTokens === null) return sessionRemaining;
  if (
    !Number.isSafeInteger(missionTokens) ||
    missionTokens < 1 ||
    !Number.isSafeInteger(usedTokens) ||
    usedTokens === null ||
    usedTokens < 0
  ) {
    throw new Error('remaining mission token allowance cannot be proven');
  }
  const remaining = missionTokens - usedTokens;
  if (remaining < 1) throw new Error('mission token allowance is exhausted');
  return Math.min(sessionRemaining, remaining);
}

const clipped = (value: string, limit: number): string =>
  value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - TRUNCATED.length))}${TRUNCATED}`.slice(0, limit);

function boundedCollector(limitBytes: number): {
  add(text: string): void;
  value(): string;
  overflowed(): boolean;
} {
  const output: string[] = [];
  let outputBytes = 0;
  let overflow = false;
  let pendingHighSurrogate = '';

  const append = (text: string): void => {
    let acceptedCodeUnits = 0;
    let acceptedBytes = 0;
    for (const codePoint of text) {
      const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
      if (codePointBytes > limitBytes - outputBytes - acceptedBytes) {
        overflow = true;
        break;
      }
      acceptedCodeUnits += codePoint.length;
      acceptedBytes += codePointBytes;
    }
    if (acceptedCodeUnits > 0) output.push(text.slice(0, acceptedCodeUnits));
    outputBytes += acceptedBytes;
  };

  const flushPending = (): void => {
    if (pendingHighSurrogate === '' || overflow) return;
    const pending = pendingHighSurrogate;
    pendingHighSurrogate = '';
    append(pending);
  };

  return {
    add(text) {
      if (overflow || text.length === 0) return;
      const combined = pendingHighSurrogate + text;
      pendingHighSurrogate = '';
      const lastCodeUnit = combined.charCodeAt(combined.length - 1);
      const endsWithHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
      const completeText = endsWithHighSurrogate ? combined.slice(0, -1) : combined;
      if (endsWithHighSurrogate) pendingHighSurrogate = combined.slice(-1);
      append(completeText);
      if (overflow) pendingHighSurrogate = '';
    },
    value: () => {
      flushPending();
      return output.join('');
    },
    overflowed: () => {
      flushPending();
      return overflow;
    },
  };
}

const REVIEW_ARTIFACT_KEYS = [
  'checkpointId',
  'highestSeverity',
  'revisionId',
  'summary',
  'type',
  'verdict',
] as const;
const REVIEW_VERDICTS = new Set(['passed', 'changes-requested']);
const REVIEW_SEVERITIES = new Set(['none', 'low', 'medium', 'high', 'critical']);
const PLAN_ARTIFACT_KEYS = ['steps', 'summary', 'type'] as const;
const PLAN_STEP_REQUIRED_KEYS = ['acceptance', 'id', 'instruction', 'profileId', 'title'] as const;
const PLAN_STEP_OPTIONAL_KEYS = [...PLAN_STEP_REQUIRED_KEYS, 'reviewProfileId'].sort();

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactBoundedReviewText = (value: unknown, maxLength: number): string | null => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    value !== value.trim() ||
    value.includes('\0')
  ) {
    return null;
  }
  return value;
};

const boundedArtifactText = (value: unknown, maxLength: number): string | null =>
  typeof value === 'string' && value.length <= maxLength && value.trim().length > 0 && !value.includes('\0')
    ? value
    : null;
const boundedArtifactIdentifier = (value: unknown, maxLength: number): string | null => {
  const text = boundedArtifactText(value, maxLength);
  return text && text === text.trim() && !Object.getOwnPropertyNames(Object.prototype).includes(text)
    ? text
    : null;
};

const isPlanBuildProfile = (profile: MissionExecutionProfile): boolean =>
  profile.permission === 'write' &&
  profile.driverPosture.kind === 'build' &&
  profile.driverPosture.permission.write &&
  (profile.driverPosture.lineageRole === 'worker' || profile.driverPosture.lineageRole === 'repair');

const isPlanReviewProfile = (profile: MissionExecutionProfile): boolean =>
  profile.permission === 'read' &&
  profile.driverPosture.kind === 'verify' &&
  !profile.driverPosture.permission.write &&
  (profile.driverPosture.lineageRole === 'reviewer' || profile.driverPosture.lineageRole === 'verifier');

function parseReviewArtifact(
  output: string,
  state: MissionState,
  child: MissionChildState,
  maxSummaryChars: number,
): { ok: true; artifact: MissionReviewArtifact } | { ok: false; reason: string } {
  if (child.permission !== 'read' || child.subjectCheckpointId === null) {
    return {
      ok: false,
      reason: 'child is not authorized to emit a review artifact',
    };
  }
  const checkpoint = state.checkpoints[child.subjectCheckpointId];
  if (!checkpoint) {
    return {
      ok: false,
      reason: `review subject checkpoint '${child.subjectCheckpointId}' is unavailable`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {
      ok: false,
      reason: 'review child did not emit exactly one valid JSON artifact',
    };
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, reason: 'review artifact must be one JSON object' };
  }
  const keys = Object.keys(parsed).sort();
  if (canonicalMissionJson(keys) !== canonicalMissionJson(REVIEW_ARTIFACT_KEYS)) {
    return {
      ok: false,
      reason: 'review artifact fields do not match the exact protocol schema',
    };
  }

  const checkpointId = exactBoundedReviewText(parsed.checkpointId, 512);
  const revisionId = exactBoundedReviewText(parsed.revisionId, 512);
  const summary = exactBoundedReviewText(parsed.summary, maxSummaryChars);
  if (parsed.type !== 'review' || checkpointId === null || revisionId === null || summary === null) {
    return {
      ok: false,
      reason: 'review artifact contains invalid bounded fields',
    };
  }
  if (!REVIEW_VERDICTS.has(String(parsed.verdict))) {
    return { ok: false, reason: 'review artifact contains an invalid verdict' };
  }
  if (!REVIEW_SEVERITIES.has(String(parsed.highestSeverity))) {
    return {
      ok: false,
      reason: 'review artifact contains an invalid highestSeverity',
    };
  }
  if (
    (parsed.verdict === 'passed' && parsed.highestSeverity !== 'none') ||
    (parsed.verdict === 'changes-requested' && parsed.highestSeverity === 'none')
  ) {
    return {
      ok: false,
      reason: 'review verdict and highestSeverity are inconsistent',
    };
  }
  if (checkpointId !== checkpoint.checkpointId || revisionId !== checkpoint.revisionId) {
    return {
      ok: false,
      reason: 'review artifact does not name the exact commissioned checkpoint and revision',
    };
  }

  return {
    ok: true,
    artifact: {
      type: 'review',
      checkpointId,
      revisionId,
      verdict: parsed.verdict as MissionReviewArtifact['verdict'],
      highestSeverity: parsed.highestSeverity as MissionReviewArtifact['highestSeverity'],
      summary,
    },
  };
}

function parseExecutionPlanArtifact(
  output: string,
  state: MissionState,
): { ok: true; artifact: MissionExecutionPlanArtifact } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {
      ok: false,
      reason: 'planner child did not emit exactly one valid JSON artifact',
    };
  }
  if (
    !isPlainRecord(parsed) ||
    canonicalMissionJson(Object.keys(parsed).sort()) !== canonicalMissionJson(PLAN_ARTIFACT_KEYS) ||
    parsed.type !== 'execution-plan' ||
    boundedArtifactText(parsed.summary, MAX_MISSION_PLAN_SUMMARY_CHARS) === null ||
    !Array.isArray(parsed.steps) ||
    parsed.steps.length < 1 ||
    parsed.steps.length > MAX_MISSION_PLAN_STEPS
  ) {
    return {
      ok: false,
      reason: 'execution-plan artifact does not match the exact protocol schema',
    };
  }

  const ids = new Set<string>();
  const steps: MissionExecutionPlanArtifact['steps'][number][] = [];
  for (const candidate of parsed.steps) {
    if (!isPlainRecord(candidate)) {
      return {
        ok: false,
        reason: 'execution-plan contains an invalid step object',
      };
    }
    const keys = Object.keys(candidate).sort();
    if (
      canonicalMissionJson(keys) !== canonicalMissionJson(PLAN_STEP_REQUIRED_KEYS) &&
      canonicalMissionJson(keys) !== canonicalMissionJson(PLAN_STEP_OPTIONAL_KEYS)
    ) {
      return {
        ok: false,
        reason: 'execution-plan step fields do not match the exact protocol schema',
      };
    }
    const id = boundedArtifactIdentifier(candidate.id, 128);
    const title = boundedArtifactText(candidate.title, 256);
    const profileId = boundedArtifactIdentifier(candidate.profileId, 256);
    const reviewProfileId =
      candidate.reviewProfileId === undefined
        ? undefined
        : boundedArtifactIdentifier(candidate.reviewProfileId, 256);
    const instruction = boundedArtifactText(candidate.instruction, MAX_MISSION_PLAN_INSTRUCTION_CHARS);
    const buildProfile =
      profileId !== null && Object.hasOwn(state.profiles, profileId) ? state.profiles[profileId] : undefined;
    const reviewProfile =
      reviewProfileId === undefined ||
      reviewProfileId === null ||
      !Object.hasOwn(state.profiles, reviewProfileId)
        ? undefined
        : state.profiles[reviewProfileId];
    if (
      id === null ||
      title === null ||
      profileId === null ||
      reviewProfileId === null ||
      instruction === null ||
      ids.has(id) ||
      !buildProfile ||
      !isPlanBuildProfile(buildProfile) ||
      (reviewProfileId !== undefined && (!reviewProfile || !isPlanReviewProfile(reviewProfile))) ||
      !Array.isArray(candidate.acceptance) ||
      candidate.acceptance.length < 1 ||
      candidate.acceptance.length > MAX_MISSION_PLAN_ACCEPTANCE_ITEMS
    ) {
      return {
        ok: false,
        reason: 'execution-plan contains an invalid or unauthorized step',
      };
    }
    const acceptance = candidate.acceptance.map((item) =>
      boundedArtifactText(item, MAX_MISSION_PLAN_ACCEPTANCE_CHARS),
    );
    if (acceptance.some((item) => item === null)) {
      return {
        ok: false,
        reason: 'execution-plan contains invalid acceptance text',
      };
    }
    ids.add(id);
    steps.push({
      id,
      title,
      profileId,
      ...(reviewProfileId ? { reviewProfileId } : {}),
      instruction,
      acceptance: acceptance as string[],
    });
  }

  const artifact: MissionExecutionPlanArtifact = {
    type: 'execution-plan',
    summary: parsed.summary as string,
    steps,
  };
  const artifactBytes = Buffer.byteLength(canonicalMissionJson(artifact), 'utf8');
  if (artifactBytes > MAX_MISSION_EXECUTION_PLAN_BYTES) {
    return {
      ok: false,
      reason: `execution-plan artifact exceeds ${MAX_MISSION_EXECUTION_PLAN_BYTES} canonical UTF-8 bytes`,
    };
  }
  return { ok: true, artifact };
}

function parseExpectedChildArtifact(
  output: string,
  state: MissionState,
  child: MissionChildState,
  maxSummaryChars: number,
):
  | { expected: false }
  | { expected: true; ok: true; artifact: MissionChildArtifact }
  | { expected: true; ok: false; reason: string } {
  if (child.driverPosture.kind === 'scope' && child.driverPosture.lineageRole === 'planner') {
    const parsed = parseExecutionPlanArtifact(output, state);
    return parsed.ok
      ? { expected: true, ok: true, artifact: parsed.artifact }
      : { expected: true, ...parsed };
  }
  if (
    child.permission === 'read' &&
    child.driverPosture.kind === 'verify' &&
    !child.driverPosture.permission.write &&
    (child.driverPosture.lineageRole === 'reviewer' || child.driverPosture.lineageRole === 'verifier') &&
    child.subjectCheckpointId !== null
  ) {
    const parsed = parseReviewArtifact(
      output,
      state,
      child,
      Math.min(maxSummaryChars, MAX_MISSION_REVIEW_SUMMARY_CHARS),
    );
    return parsed.ok
      ? { expected: true, ok: true, artifact: parsed.artifact }
      : { expected: true, ...parsed };
  }
  return { expected: false };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function verifiedGuideCwd(workspace: MissionGuideWorkspace): Promise<string> {
  if (workspace.privateNonRepository !== true) {
    throw new Error('guide workspace lacks a trusted private non-repository attestation');
  }
  if (!path.isAbsolute(workspace.cwd)) throw new Error('guide workspace cwd must be absolute');
  const cwd = await realpath(workspace.cwd);
  const metadata = await stat(cwd);
  if (!metadata.isDirectory()) throw new Error('guide workspace cwd must be a directory');
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('guide workspace cwd must not grant group or other permissions');
  }

  let cursor = cwd;
  for (;;) {
    for (const marker of REPOSITORY_MARKERS) {
      if (await pathExists(path.join(cursor, marker))) {
        throw new Error(`guide workspace must not be inside a repository (${marker} found)`);
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return cwd;
}

async function verifiedChildCwd(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) throw new Error('mission child workspace cwd must be absolute');
  const canonical = await realpath(cwd);
  if (!(await stat(canonical)).isDirectory())
    throw new Error('mission child workspace cwd must be a directory');
  return canonical;
}

function fixedGuidePermission(): PermissionProfile {
  return { write: false, allow: [], deny: [], auto: false };
}

/** A guide-model adapter with no repository, project MCP, or Noriq MCP authority. */
export class DriverMissionGuide implements MissionGuide {
  private readonly maxOutputBytes: number;
  private readonly maxPromptChars: number;
  private readonly launchAuthorityTimeoutMs: number;

  constructor(private readonly options: DriverMissionGuideOptions) {
    this.maxOutputBytes = outputByteLimit(
      options.maxOutputBytes,
      options.maxOutputChars,
      DEFAULT_MAX_GUIDE_OUTPUT_BYTES,
      DEFAULT_MAX_GUIDE_OUTPUT_BYTES,
    );
    this.maxPromptChars = positiveLimit(options.maxPromptChars, DEFAULT_MAX_PROMPT_CHARS, 'maxPromptChars');
    this.launchAuthorityTimeoutMs = positiveLimit(
      options.launchAuthorityTimeoutMs,
      DEFAULT_ATTEMPT_TRANSACTION_TIMEOUT_MS,
      'launchAuthorityTimeoutMs',
      60_000,
    );
  }

  async next(request: MissionGuideRequest): Promise<MissionGuideResult> {
    let cwd: string;
    let workspace: MissionGuideWorkspace;
    let profile: MissionGuideProfile;
    let registration: TrustedMissionDriverRegistration;
    let selectionEffort: RunEffort | undefined;
    let tokenEnvelope: NonNullable<DriverStartOptions['tokenEnvelope']>;
    try {
      if (request.signal.aborted) throw new Error('mission guide invocation was cancelled before launch');
      if (request.prompt.length > this.maxPromptChars) throw new Error('mission guide prompt is oversized');
      workspace = await boundedAttemptTransaction(
        this.options.resolveWorkspace(),
        this.launchAuthorityTimeoutMs,
        'guide workspace resolution',
      );
      cwd = await boundedAttemptTransaction(
        verifiedGuideCwd(workspace),
        this.launchAuthorityTimeoutMs,
        'guide workspace verification',
      );
      if (canonicalMissionJson(request.profile) !== canonicalMissionJson(this.options.profile)) {
        throw new Error('mission guide authority differs from its durable profile snapshot');
      }
      profile = request.profile;
      registration = this.options.drivers.require(profile.agent.driver, profile.agent.model);
      if (registration.driver.capabilities.toolFreeSession !== true) {
        throw new Error(
          `mission guide driver '${registration.driverId}' cannot attest a tool-free inference session`,
        );
      }
      if (registration.driver.capabilities.terminationAcknowledgement !== 'process-tree') {
        throw new Error(
          `mission guide driver '${registration.driverId}' cannot prove termination of its complete managed process tree`,
        );
      }
      assertMeteringCanEnforce(registration, [
        { scope: 'guide', budget: profile.budget },
        { scope: 'mission', budget: request.projection.budget.ceiling },
      ]);
      selectionEffort = effort(profile.agent.effort);
      tokenEnvelope = missionTokenEnvelope(
        request.prompt,
        {
          ...profile.budget,
          tokens: remainingTokenAllowance(
            profile.budget.tokens,
            0,
            request.projection.budget.ceiling.tokens,
            request.projection.budget.used.tokens,
          ),
        },
        1,
      );
      if (request.signal.aborted) throw new Error('mission guide invocation was cancelled before launch');
      await boundedAttemptTransaction(
        workspace.verifyLaunchAuthority(),
        this.launchAuthorityTimeoutMs,
        'guide launch authority verification',
      );
      if (request.signal.aborted) throw new Error('mission guide invocation was cancelled before launch');
    } catch (error) {
      throw new MissionGuidePreflightError(String(error));
    }
    const output = boundedCollector(this.maxOutputBytes);
    const startedAt = performance.now();
    let latest = missionUsage(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        numTurns: 0,
      },
      registration.metering,
      0,
    );
    const run = superviseBudget(registration.driver, {
      runId: `${request.projection.missionId}:guide:${request.projection.guideEpoch}`,
      kind: 'scope',
      cwd,
      workspaceRoot: cwd,
      prompt: request.prompt,
      permission: fixedGuidePermission(),
      toolAccess: 'none',
      model: profile.agent.model,
      effort: selectionEffort,
      budget: toRunBudget(profile.budget),
      tokenEnvelope,
      env: missionAgentEnv(this.options.env),
      // Explicitly empty: the guide acts through bounded proposals handled by the kernel.
      noriqTools: [],
      handlers: {
        onText: (text) => output.add(text),
        onTelemetry: (telemetry) => {
          latest = highWater(
            latest,
            missionUsage(telemetry, registration.metering, elapsedSeconds(startedAt)),
          );
        },
      },
    });

    const abort = () => {
      // A shutdown rejection means death was not proved. Keep the guide attempt unsettled and let
      // the harness retain its ambiguity; never turn the detached request into an unhandled rejection.
      void run.stop().catch(() => undefined);
    };
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
    try {
      const exit = await run.done;
      latest = highWater(
        latest,
        missionUsage(exit.telemetry, registration.metering, elapsedSeconds(startedAt)),
      );
      // A failed driver or an overflow must never smuggle a syntactically valid prefix through as
      // a guide proposal. Empty output is intentionally rejected by the harness parser while its
      // real usage remains journalable.
      return {
        output: exit.outcome === 'done' && !exit.isError && !output.overflowed() ? output.value() : '',
        usage: latest,
      };
    } finally {
      request.signal.removeEventListener('abort', abort);
    }
  }
}

function profileAuthority(child: MissionChildState): unknown {
  return {
    profileId: child.profileId,
    role: child.role,
    permission: child.permission,
    agent: child.agent,
    driverPosture: child.driverPosture,
    budget: child.budget,
    resources: child.resources,
    projectMcp: child.projectMcp,
  };
}

function attemptAuthorityFingerprint(
  request: MissionChildStartRequest,
  workspace: MissionChildWorkspaceResolution,
  projectMcp: ProjectMcpSession | undefined,
  promptRendererVersion: string,
  promptFingerprint: string,
): string {
  return createHash('sha256')
    .update(
      canonicalMissionJson({
        missionId: request.state.missionId,
        child: {
          childId: request.child.childId,
          instruction: request.child.instruction,
          subjectCheckpointId: request.child.subjectCheckpointId,
          planStepId: request.child.planStepId,
          authority: profileAuthority(request.child),
        },
        workspace: {
          cwd: workspace.cwd,
          revisionId: workspace.revisionId,
          leaseGeneration: workspace.leaseGeneration,
          env: workspace.env ?? {},
          trustedEnv: workspace.trustedEnv ?? {},
          containmentReadOnlyRoots: workspace.containmentReadOnlyRoots ?? [],
          protectedWorkspaceReadOnlyPaths: workspace.protectedWorkspaceReadOnlyPaths ?? [],
          containmentWriteRoots: workspace.containmentWriteRoots ?? [],
        },
        promptRendererVersion,
        promptFingerprint,
        projectMcpDeclarationFingerprint: request.state.projectMcpDeclarationFingerprint,
        projectMcpEffectiveFingerprint: projectMcp?.bundle.effectiveFingerprint ?? null,
      }),
      'utf8',
    )
    .digest('hex');
}

function assertProfileSnapshot(state: MissionState, child: MissionChildState): void {
  const profile = Object.hasOwn(state.profiles, child.profileId)
    ? state.profiles[child.profileId]
    : undefined;
  if (!profile) throw new Error(`child '${child.childId}' names missing profile '${child.profileId}'`);
  const { assurance: _assurance, ...executionAuthority } = profile;
  if (canonicalMissionJson(profileAuthority(child)) !== canonicalMissionJson(executionAuthority)) {
    throw new Error(`child '${child.childId}' authority differs from its durable profile snapshot`);
  }
  if (child.driverPosture.permission.write !== (child.permission === 'write')) {
    throw new Error(`child '${child.childId}' permission label disagrees with its driver posture`);
  }
}

const promptProfileDescriptor = (profile: MissionExecutionProfile): MissionChildPromptProfileDescriptor => ({
  profileId: profile.profileId,
  role: profile.role,
  permission: profile.permission,
  kind: profile.driverPosture.kind,
  lineageRole: profile.driverPosture.lineageRole,
  assuranceRank: profile.assurance.rank,
  independenceClass: profile.assurance.independenceClass,
  budgetCeiling: profile.budget,
  projectMcpServers: profile.projectMcp.map((grant) => grant.server),
});

function plannerBudgetFrame(
  state: MissionState,
): Extract<MissionChildTrustedPromptFrame, { kind: 'planner' }>['budgetPlanning'] {
  const guaranteedAvailableForPlan: Record<keyof MissionBudget, number | null> = {
    tokens: null,
    usd: null,
    activeSeconds: null,
  };
  const unprovableAxes: (keyof MissionBudget)[] = [];
  for (const axis of ['tokens', 'usd', 'activeSeconds'] as const) {
    const ceiling = state.budget[axis];
    if (ceiling === null) continue;
    const observed = state.usage[axis];
    let reserved = 0;
    let provable = observed !== null;
    for (const child of Object.values(state.children)) {
      if (childIsTerminal(child.status)) continue;
      const childCeiling = child.budget[axis];
      const childUsage = child.usage[axis];
      if (childCeiling === null || childUsage === null) {
        provable = false;
        break;
      }
      reserved += Math.max(0, childCeiling - childUsage);
    }
    if (provable) {
      for (const turn of Object.values(state.guideTurns)) {
        if (turn.status !== 'running') continue;
        const turnCeiling = turn.budget[axis];
        const turnUsage = turn.usage[axis];
        if (turnCeiling === null || turnUsage === null) {
          provable = false;
          break;
        }
        reserved += Math.max(0, turnCeiling - turnUsage);
      }
    }
    const guideCeiling = state.guide?.budget[axis];
    if (guideCeiling === undefined || guideCeiling === null) provable = false;
    else reserved += guideCeiling * 2;
    const remaining = (observed ?? 0) + reserved;
    if (!provable || !Number.isFinite(remaining) || (axis === 'tokens' && !Number.isSafeInteger(remaining))) {
      guaranteedAvailableForPlan[axis] = 0;
      unprovableAxes.push(axis);
      continue;
    }
    guaranteedAvailableForPlan[axis] = Math.max(0, ceiling - remaining);
  }
  return {
    missionCeiling: state.budget,
    missionUsage: state.usage,
    guaranteedAvailableForPlan,
    unprovableAxes,
    guideTurnCeiling: state.guide?.budget ?? null,
    reservedGuideTurns: 2,
    repairRoundsPerStep: MAX_MISSION_PLAN_REPAIR_ROUNDS,
    maximumAttemptsPerStep: MAX_MISSION_PLAN_REPAIR_ROUNDS + 1,
  };
}

function trustedChildPromptFrame(
  state: MissionState,
  child: MissionChildState,
  subjectCheckpoint: MissionCheckpointState | null,
): MissionChildTrustedPromptFrame {
  if (child.driverPosture.lineageRole === 'planner') {
    if (
      child.permission !== 'read' ||
      child.driverPosture.kind !== 'scope' ||
      child.driverPosture.permission.write ||
      subjectCheckpoint !== null
    ) {
      throw new Error('planner child lacks the trusted read-only scope posture');
    }
    const profiles = Object.values(state.profiles).sort((left, right) =>
      left.profileId.localeCompare(right.profileId),
    );
    return {
      kind: 'planner',
      outputSchema: MISSION_EXECUTION_PLAN_OUTPUT_SCHEMA,
      eligibleBuildProfiles: profiles.filter(isPlanBuildProfile).map(promptProfileDescriptor),
      eligibleReviewProfiles: profiles.filter(isPlanReviewProfile).map(promptProfileDescriptor),
      budgetPlanning: plannerBudgetFrame(state),
    };
  }

  if (child.driverPosture.lineageRole === 'reviewer' || child.driverPosture.lineageRole === 'verifier') {
    if (
      child.permission !== 'read' ||
      child.driverPosture.kind !== 'verify' ||
      child.driverPosture.permission.write ||
      !subjectCheckpoint
    ) {
      throw new Error('review child lacks an exact subject and trusted read-only verify posture');
    }
    if (!state.activePlan || !child.planStepId) {
      return {
        kind: 'reviewer',
        outputSchema: MISSION_REVIEW_OUTPUT_SCHEMA,
        planStep: null,
      };
    }
    const activePlan = state.activePlan;
    const step = activePlan.plan.steps.find(
      (candidate) =>
        missionPlanStepKey(state.missionId, activePlan.plannerChildId, candidate.id) === child.planStepId,
    );
    if (!step || step.reviewProfileId !== child.profileId) {
      throw new Error('review child cannot be bound to its trusted adopted execution-plan step');
    }
    const author = subjectCheckpoint.authorChildId
      ? state.children[subjectCheckpoint.authorChildId]
      : undefined;
    if (!author || author.planStepId !== child.planStepId || author.profileId !== step.profileId) {
      throw new Error('review checkpoint author does not match the trusted adopted execution-plan step');
    }
    return {
      kind: 'reviewer',
      outputSchema: MISSION_REVIEW_OUTPUT_SCHEMA,
      planStep: { id: step.id, acceptance: [...step.acceptance] },
    };
  }

  return { kind: 'worker', outputSchema: null };
}

function exactProjectMcpSession(
  state: MissionState,
  child: MissionChildState,
  resolution: MissionChildWorkspaceResolution,
): ProjectMcpSession | undefined {
  const expected = state.projectMcpDeclarationFingerprint;
  if (expected === null) {
    if (child.projectMcp.length > 0) {
      throw new Error('child has project MCP grants but the mission has no declaration fingerprint');
    }
    return undefined;
  }
  if (!resolution.projectMcp) throw new Error('mission project MCP declaration is unavailable');
  if (resolution.projectMcp.declarationFingerprint !== expected) {
    throw new Error(
      `project MCP declaration fingerprint changed (expected ${expected}, got ${resolution.projectMcp.declarationFingerprint})`,
    );
  }
  if (child.projectMcp.length === 0) return undefined;

  const toolGrants = Object.create(null) as Record<string, readonly string[]>;
  for (const grant of child.projectMcp) {
    if (Object.hasOwn(toolGrants, grant.server)) {
      throw new Error(`child repeats project MCP grant '${grant.server}'`);
    }
    toolGrants[grant.server] = [...grant.tools];
  }
  const session: ProjectMcpSession = {
    bundle: bindProjectMcpBundle(resolution.projectMcp, resolution.cwd),
    toolGrants,
  };
  validateProjectMcpSession(session);
  return session;
}

function driverStartOptions(
  request: MissionChildStartRequest,
  resolution: MissionChildWorkspaceResolution,
  projectMcp: ProjectMcpSession | undefined,
  prompt: string,
): Omit<DriverStartOptions, 'handlers'> {
  const { child } = request;
  const effectiveTokens = remainingTokenAllowance(
    child.budget.tokens,
    child.usage.tokens,
    request.state.budget.tokens,
    request.state.usage.tokens,
  );
  const tokenEnvelope = missionTokenEnvelope(
    prompt,
    { ...child.budget, tokens: effectiveTokens },
    childMaxTurns(effectiveTokens),
  );
  return {
    runId: request.attemptId,
    kind: child.driverPosture.kind,
    cwd: resolution.cwd,
    workspaceRoot: resolution.cwd,
    prompt,
    permission: {
      write: child.driverPosture.permission.write,
      allow: [...child.driverPosture.permission.allow],
      deny: [...child.driverPosture.permission.deny],
      auto: child.driverPosture.permission.auto,
    },
    model: child.agent.model,
    effort: effort(child.agent.effort),
    budget: toRunBudget(child.budget),
    tokenEnvelope,
    env: {
      ...missionAgentEnv(resolution.env),
      ...trustedWorkspaceEnvironment(resolution.trustedEnv),
    },
    containmentReadOnlyRoots: resolution.containmentReadOnlyRoots,
    protectedWorkspaceReadOnlyPaths: resolution.protectedWorkspaceReadOnlyPaths,
    containmentWriteRoots: resolution.containmentWriteRoots,
    noriqTools: [],
    ...(projectMcp ? { projectMcp } : {}),
  };
}

const TRUSTED_WORKSPACE_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_OPTIONAL_LOCKS',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
]);

function trustedWorkspaceEnvironment(
  input: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!TRUSTED_WORKSPACE_ENV.has(key)) {
      throw new Error(`trusted workspace environment key '${key}' is not allowed`);
    }
    if (typeof value !== 'string' || value.length > 16_384 || value.includes('\0')) {
      throw new Error(`trusted workspace environment value '${key}' is invalid`);
    }
    result[key] = value;
  }
  return result;
}

function startDriverChild(
  registration: TrustedMissionDriverRegistration,
  request: MissionChildStartRequest,
  startOptions: Omit<DriverStartOptions, 'handlers'>,
  maxSummaryChars: number,
  maxOutputBytes: number,
  usageReportIntervalMs: number,
  verifyActivation: () => Promise<void>,
): MissionChildExecution {
  const output = boundedCollector(maxOutputBytes);
  let startedAt: number | null = null;
  let latest = missionUsage(
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      numTurns: 0,
    },
    registration.metering,
    0,
  );
  let observerError: string | null = null;
  let usageQueue = Promise.resolve();
  let pendingUsage: MissionUsage | null = null;
  let lastReportedUsage: MissionUsage | null = null;
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let usageTimer: NodeJS.Timeout | null = null;
  const held: { session?: DriverSession } = {};
  let run: ReturnType<typeof superviseBudget> | null = null;
  let cancellationReason: string | null = null;
  let cancellation: Promise<void> | null = null;
  let prelaunchResult: MissionChildResult | null = null;
  let resolveActivationDecision!: () => void;
  const activationDecision = new Promise<void>((resolve) => {
    resolveActivationDecision = resolve;
  });
  let activationDecided = false;
  let activationPromise: Promise<void> | null = null;

  const activeSeconds = (): number => (startedAt === null ? 0 : elapsedSeconds(startedAt));
  const settlePrelaunch = (outcome: 'failed' | 'cancelled', summary: string): void => {
    if (activationDecided) return;
    prelaunchResult = {
      outcome,
      summary: clipped(summary, maxSummaryChars),
      usage: { ...latest },
    };
    activationDecided = true;
    resolveActivationDecision();
  };

  const cancel = (reason: string): Promise<void> => {
    cancellationReason ??= clipped(reason, 16_384);
    if (!held.session) {
      if (!activationPromise) settlePrelaunch('cancelled', cancellationReason);
      return Promise.resolve();
    }
    if (cancellation) return cancellation;
    cancellation = (async () => {
      const session = held.session;
      if (!session) return;
      await session.interrupt().catch(() => undefined);
      await session.stop();
    })();
    return cancellation;
  };

  const reportPendingUsage = (force: boolean): void => {
    if (usageTimer) {
      clearTimeout(usageTimer);
      usageTimer = null;
    }
    const observed = pendingUsage;
    if (!observed) return;
    if (!force && performance.now() - lastReportAt < usageReportIntervalMs) {
      const delay = Math.max(1, usageReportIntervalMs - (performance.now() - lastReportAt));
      usageTimer = setTimeout(() => reportPendingUsage(false), delay);
      usageTimer.unref?.();
      return;
    }
    pendingUsage = null;
    if (lastReportedUsage && canonicalMissionJson(lastReportedUsage) === canonicalMissionJson(observed)) {
      return;
    }
    lastReportAt = performance.now();
    lastReportedUsage = observed;
    usageQueue = usageQueue.then(async () => {
      if (observerError) return;
      try {
        const disposition = await request.onUsage(observed);
        if (disposition === 'cancel') await cancel('mission usage observer requested cancellation');
      } catch (error) {
        observerError = `mission usage observer failed: ${String(error)}`;
        // Request shutdown, but a rejection is not process settlement. `done` and the attempt
        // registry remain the only authority that may release this execution.
        await cancel(observerError).catch(() => undefined);
      }
    });
  };

  const observe = (telemetry: DriverTelemetry, force = false): void => {
    latest = highWater(latest, missionUsage(telemetry, registration.metering, activeSeconds()));
    pendingUsage = pendingUsage ? highWater(pendingUsage, latest) : latest;
    if (force || usageReportIntervalMs === 0 || lastReportAt === Number.NEGATIVE_INFINITY) {
      reportPendingUsage(force);
      return;
    }
    if (!usageTimer) reportPendingUsage(false);
  };

  const activate = (): Promise<void> => {
    activationPromise ??= (async () => {
      if (cancellationReason !== null) {
        settlePrelaunch('cancelled', cancellationReason);
        return;
      }
      try {
        await verifyActivation();
      } catch (error) {
        if (cancellationReason !== null) settlePrelaunch('cancelled', cancellationReason);
        else settlePrelaunch('failed', `child launch authority changed before activation: ${String(error)}`);
        return;
      }
      if (cancellationReason !== null) {
        settlePrelaunch('cancelled', cancellationReason);
        return;
      }
      startedAt = performance.now();
      // `superviseBudget` invokes driver.start synchronously. If it throws after an opaque vendor
      // spawn, do not resolve `done`: the durable reservation must remain ambiguous and block a
      // duplicate until owner-death/reconciliation proves the process tree gone.
      run = superviseBudget(registration.driver, {
        ...startOptions,
        handlers: {
          onText: (text) => output.add(text),
          onTelemetry: observe,
        },
      });
      held.session = run.session;
      activationDecided = true;
      resolveActivationDecision();
      if (cancellationReason !== null) await cancel(cancellationReason);
    })();
    return activationPromise;
  };

  let donePromise: Promise<MissionChildResult> | null = null;
  const done = (): Promise<MissionChildResult> => {
    donePromise ??= (async () => {
      await activationDecision;
      if (prelaunchResult) return prelaunchResult;
      const activeRun = run;
      if (!activeRun) throw new Error('child activation settled without a managed driver session');
      const exit = await activeRun.done;
      observe(exit.telemetry, true);
      await usageQueue;
      latest = highWater(latest, missionUsage(exit.telemetry, registration.metering, activeSeconds()));
      const rawOutput = output.value().trim();
      let artifact: MissionChildArtifact | undefined;
      let artifactError: string | null = null;
      if (exit.outcome === 'done' && !exit.isError) {
        const parsed = parseExpectedChildArtifact(rawOutput, request.state, request.child, maxSummaryChars);
        if (parsed.expected && parsed.ok) artifact = parsed.artifact;
        else if (parsed.expected) artifactError = parsed.reason;
      }
      const summary = clipped(
        artifact?.summary ||
          artifactError ||
          rawOutput ||
          observerError ||
          exit.reason ||
          'No summary was reported.',
        maxSummaryChars,
      );
      if (observerError) return { outcome: 'failed', summary: observerError, usage: latest };
      if (cancellationReason !== null) return { outcome: 'cancelled', summary, usage: latest };
      if (output.overflowed()) {
        return {
          outcome: 'failed',
          summary: 'child output exceeded its bounded result limit',
          usage: latest,
        };
      }
      if (artifactError) return { outcome: 'failed', summary, usage: latest };
      return {
        outcome: exit.outcome === 'done' && !exit.isError ? 'succeeded' : 'failed',
        summary,
        usage: latest,
        ...(artifact ? { artifact } : {}),
      };
    })();
    return donePromise;
  };

  return {
    attemptId: request.attemptId,
    get usageAtAttach() {
      // Fresh wrappers are dormant until durable publication and harness registration complete.
      // Attached live wrappers retain their real cumulative high-water through this same getter.
      return { ...latest };
    },
    get sessionId() {
      return held.session?.sessionId ?? null;
    },
    activate,
    cancel,
    done,
  };
}

/**
 * Generic mission child adapter. It deliberately cannot invent restart attachment from a vendor
 * session id: without an injected registry that atomically owns the attempt, it refuses to spawn.
 */
export class DriverMissionChildExecutor implements MissionChildExecutor {
  private readonly maxSummaryChars: number;
  private readonly maxOutputBytes: number;
  private readonly maxPromptChars: number;
  private readonly usageReportIntervalMs: number;
  private readonly attemptTransactionTimeoutMs: number;

  constructor(private readonly options: DriverMissionChildExecutorOptions) {
    this.maxSummaryChars = positiveLimit(
      options.maxSummaryChars,
      DEFAULT_MAX_CHILD_SUMMARY_CHARS,
      'maxSummaryChars',
      DEFAULT_MAX_CHILD_SUMMARY_CHARS,
    );
    this.maxOutputBytes = outputByteLimit(
      options.maxOutputBytes,
      options.maxOutputChars,
      DEFAULT_MAX_CHILD_OUTPUT_BYTES,
      DEFAULT_MAX_CHILD_OUTPUT_BYTES,
    );
    this.maxPromptChars = positiveLimit(options.maxPromptChars, DEFAULT_MAX_PROMPT_CHARS, 'maxPromptChars');
    this.usageReportIntervalMs = nonNegativeInterval(options.usageReportIntervalMs, 1_000);
    this.attemptTransactionTimeoutMs = positiveLimit(
      options.attemptTransactionTimeoutMs,
      DEFAULT_ATTEMPT_TRANSACTION_TIMEOUT_MS,
      'attemptTransactionTimeoutMs',
      60_000,
    );
    if (!DRIVER_ID.test(options.promptRendererVersion)) {
      throw new Error('promptRendererVersion must be a bounded stable identifier');
    }
  }

  async startOrAttach(request: MissionChildStartRequest): Promise<MissionChildExecution> {
    if (request.child.attemptId !== request.attemptId) {
      throw new MissionChildAttemptError('durable child attempt id does not match the start request', false);
    }
    const durableChild = Object.hasOwn(request.state.children, request.child.childId)
      ? request.state.children[request.child.childId]
      : undefined;
    if (!durableChild || durableChild.attemptId !== request.attemptId) {
      throw new MissionChildAttemptError(
        'start request does not name the durable mission child attempt',
        false,
      );
    }

    const registry = this.options.attemptRegistry;
    if (registry?.recover) {
      let recovered: MissionAttemptRegistryRecovery;
      try {
        recovered = await boundedAttemptTransaction(
          registry.recover({
            missionId: request.state.missionId,
            childId: request.child.childId,
            attemptId: request.attemptId,
          }),
          this.attemptTransactionTimeoutMs,
          'attempt registry recovery',
        );
      } catch (error) {
        throw new MissionChildAttemptError(`attempt registry recovery failed: ${String(error)}`, false);
      }
      if (recovered.status === 'ambiguous') {
        throw new MissionChildAttemptError(
          `attempt registry recovery is ambiguous: ${recovered.reason}`,
          false,
        );
      }
      if (recovered.status === 'attached') {
        if (recovered.execution.attemptId !== request.attemptId) {
          throw new MissionChildAttemptError(
            `attempt registry recovered '${recovered.execution.attemptId}', expected '${request.attemptId}'`,
            false,
          );
        }
        if (!validRegistryAttachUsage(recovered.execution.usageAtAttach)) {
          throw new MissionChildAttemptError(
            'attempt registry recovery lacks a trusted absolute usage high-water snapshot',
            false,
          );
        }
        return recovered.execution;
      }
    }

    try {
      assertProfileSnapshot(request.state, request.child);
    } catch (error) {
      throw new MissionChildAttemptError(String(error), false);
    }
    const registration = (() => {
      try {
        return this.options.drivers.require(request.child.agent.driver, request.child.agent.model);
      } catch (error) {
        throw new MissionChildAttemptError(String(error), false);
      }
    })();
    if (registration.driver.capabilities.workspaceIsolatedSession !== true) {
      throw new MissionChildAttemptError(
        `mission driver '${registration.driverId}' cannot attest workspace-isolated child execution`,
        false,
      );
    }
    if (registration.driver.capabilities.terminationAcknowledgement !== 'process-tree') {
      throw new MissionChildAttemptError(
        `mission driver '${registration.driverId}' cannot prove termination of the agent and every managed tool process`,
        false,
      );
    }
    if (
      request.child.projectMcp.length > 0 &&
      registration.driver.capabilities.projectMcpProcessContainment !== true
    ) {
      throw new MissionChildAttemptError(
        `mission driver '${registration.driverId}' cannot contain project MCP subprocesses inside the managed mission process tree`,
        false,
      );
    }

    let resolution: MissionChildWorkspaceResolution;
    let prompt: string;
    let projectMcp: ProjectMcpSession | undefined;
    let promptFingerprint: string;
    try {
      assertMeteringCanEnforce(registration, [
        { scope: 'child', budget: request.child.budget },
        { scope: 'mission', budget: request.state.budget },
      ]);
      resolution = await boundedAttemptTransaction(
        (async () => {
          const resolved = await this.options.resolveWorkspace(request.state, request.child);
          return {
            ...resolved,
            cwd: await verifiedChildCwd(resolved.cwd),
          };
        })(),
        this.attemptTransactionTimeoutMs,
        'mission workspace resolution',
      );
      if (
        typeof resolution.revisionId !== 'string' ||
        resolution.revisionId.length < 1 ||
        resolution.revisionId.length > 512
      ) {
        throw new Error('mission workspace revisionId must be a bounded non-empty string');
      }
      if (
        typeof resolution.leaseGeneration !== 'string' ||
        resolution.leaseGeneration.length < 1 ||
        resolution.leaseGeneration.length > 512
      ) {
        throw new Error('mission workspace leaseGeneration must be a bounded non-empty string');
      }
      if (typeof resolution.verifyLaunchAuthority !== 'function') {
        throw new Error('mission workspace lacks an exact launch-authority verifier');
      }
      const subjectCheckpoint = request.child.subjectCheckpointId
        ? request.state.checkpoints[request.child.subjectCheckpointId]
        : null;
      if (request.child.subjectCheckpointId && !subjectCheckpoint) {
        throw new Error(
          `review child '${request.child.childId}' references missing checkpoint '${request.child.subjectCheckpointId}'`,
        );
      }
      prompt = await boundedAttemptTransaction(
        Promise.resolve(
          this.options.renderPrompt({
            objective: request.state.objective,
            childId: request.child.childId,
            role: request.child.role,
            permission: request.child.permission,
            lineageRole: request.child.driverPosture.lineageRole,
            guideInstruction: {
              trust: 'untrusted',
              text: request.child.instruction,
            },
            subjectCheckpoint: subjectCheckpoint ?? null,
            trustedFrame: trustedChildPromptFrame(request.state, request.child, subjectCheckpoint ?? null),
          }),
        ),
        this.attemptTransactionTimeoutMs,
        'mission prompt rendering',
      );
      if (typeof prompt !== 'string' || prompt.trim() === '')
        throw new Error('mission child prompt is empty');
      if (prompt.length > this.maxPromptChars) throw new Error('mission child prompt is oversized');
      promptFingerprint = createHash('sha256').update(prompt, 'utf8').digest('hex');
      projectMcp = exactProjectMcpSession(request.state, request.child, resolution);
      await boundedAttemptTransaction(
        resolution.verifyLaunchAuthority(),
        this.attemptTransactionTimeoutMs,
        'pre-claim launch authority verification',
      );
    } catch (error) {
      throw new MissionChildAttemptError(String(error), false);
    }

    if (!registry) {
      throw new MissionChildAttemptError(
        'no attempt session registry can prove this durable attempt is safe to start or attach',
        false,
      );
    }

    if (Object.keys(request.child.resources).some(isExternalMissionResourceKey) && !this.options.resources) {
      throw new MissionChildAttemptError(
        'resource-bearing child has no durable cross-mission resource coordinator',
        false,
      );
    }
    try {
      if (this.options.resources) {
        await boundedAttemptTransaction(
          this.options.resources.acquire(request.state, request.child, request.attemptId),
          this.attemptTransactionTimeoutMs,
          'global resource acquisition',
        );
      }
    } catch (error) {
      throw new MissionChildAttemptError(`global resource acquisition failed: ${String(error)}`, false);
    }

    let claim: MissionAttemptRegistryClaim;
    try {
      claim = await boundedAttemptTransaction(
        registry.claim({
          missionId: request.state.missionId,
          childId: request.child.childId,
          attemptId: request.attemptId,
          authorityFingerprint: attemptAuthorityFingerprint(
            request,
            resolution,
            projectMcp,
            this.options.promptRendererVersion,
            promptFingerprint,
          ),
          promptRendererVersion: this.options.promptRendererVersion,
          promptFingerprint,
          workspace: resolution.cwd,
          workspaceRevisionId: resolution.revisionId,
          workspaceLeaseGeneration: resolution.leaseGeneration,
          projectMcpEffectiveFingerprint: projectMcp?.bundle.effectiveFingerprint ?? null,
          onUsage: request.onUsage,
        }),
        this.attemptTransactionTimeoutMs,
        'attempt registry claim',
      );
    } catch (error) {
      throw new MissionChildAttemptError(`attempt registry claim failed: ${String(error)}`, false);
    }
    if (claim.status === 'ambiguous') {
      throw new MissionChildAttemptError(`attempt registry is ambiguous: ${claim.reason}`, false);
    }
    if (claim.status === 'attached') {
      if (claim.execution.attemptId !== request.attemptId) {
        throw new MissionChildAttemptError(
          `attempt registry attached '${claim.execution.attemptId}', expected '${request.attemptId}'`,
          false,
        );
      }
      if (!validRegistryAttachUsage(claim.execution.usageAtAttach)) {
        throw new MissionChildAttemptError(
          'attempt registry attachment lacks a trusted absolute usage high-water snapshot',
          false,
        );
      }
      return claim.execution;
    }

    let execution: MissionChildExecution;
    try {
      execution = startDriverChild(
        registration,
        request,
        driverStartOptions(request, resolution, projectMcp, prompt),
        this.maxSummaryChars,
        this.maxOutputBytes,
        this.usageReportIntervalMs,
        () =>
          boundedAttemptTransaction(
            resolution.verifyLaunchAuthority(),
            this.attemptTransactionTimeoutMs,
            'pre-activation launch authority verification',
          ),
      );
    } catch (error) {
      await claim.markAmbiguous(`driver start failed: ${String(error)}`).catch(() => undefined);
      throw new MissionChildAttemptError(`driver start is ambiguous: ${String(error)}`, false);
    }
    try {
      await boundedAttemptTransaction(
        claim.publish(execution),
        this.attemptTransactionTimeoutMs,
        'attempt registry publication',
      );
      return execution;
    } catch (error) {
      // The dormant execution has not activated a provider. Preserve the reservation and return
      // control even if durable publication itself is wedged; a late publication remains dormant
      // (and cancelled) until registry recovery classifies it.
      void execution.cancel('attempt registry publish failed').catch(() => undefined);
      void boundedAttemptTransaction(
        claim.markAmbiguous(`attempt registry publish failed: ${String(error)}`),
        this.attemptTransactionTimeoutMs,
        'attempt ambiguity persistence',
      ).catch(() => undefined);
      throw new MissionChildAttemptError(`attempt registry publish is ambiguous: ${String(error)}`, false);
    }
  }
}
