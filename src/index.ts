// Library surface of the Noriq Runner daemon. The CLI (src/cli.ts) is the binary
// entry point; this module re-exports the pieces so they can be imported/tested.
export { VERSION } from './version';
export { logger, setLogLevel, type LogLevel } from './logger';
export {
  DEFAULT_CONFIG_PATH,
  expandHome,
  loadRunnerConfig,
  parseRunnerConfig,
} from './config';
export {
  type DiscoveredRepo,
  discoverRepos,
  legacyNetworkKinds,
  loadManifest,
  manifestPath,
  repoId,
} from './discovery';
export { ManifestStore, changedSections, type ManifestStoreDeps } from './manifest-store';
export {
  DEFAULT_TOKEN_PATH,
  NO_TOKEN_MESSAGE,
  TokenSource,
  loadToken,
  type TokenSourceOptions,
} from './token';
export {
  DEFAULT_CREDENTIALS_PATH,
  expiryFrom,
  loadCredentials,
  sameServer,
  saveCredentials,
  type StoredCredentials,
} from './credentials';
export {
  DEVICE_GRANT,
  discover,
  pkcePair,
  postToken,
  randomState,
  refreshToken,
  registerClient,
  type AsMetadata,
  type OAuthError,
  type RegisterOptions,
  type TokenResponse,
} from './oauth';
export { authorize, resolveMode, type AuthMode, type AuthorizeOptions } from './auth';
export {
  LOOPBACK_REDIRECT,
  hasBrowser,
  loopbackAuthorize,
  openBrowser,
  type LoopbackOptions,
} from './auth-loopback';
export {
  deviceAuthorize,
  requestDeviceCode,
  type DeviceAuthorizeOptions,
  type DeviceCodeResponse,
} from './auth-device';
export { DEFAULT_STATE_PATH, loadState, saveState, type RunnerState } from './state';
export { promptTemplate, renderPrompt, renderTemplate, type PromptVars } from './prompts';
export {
  AGENT_INSTRUCTION_FILES,
  CONTEXT_BUDGET_CHARS,
  REVIEWER_CONTEXT_MAX_CHARS,
  defaultDocReader,
  defaultPathProbe,
  discoverAgentInstructions,
  loadRepoContext,
  loadRepoContextBrief,
  loadRepoDocs,
  openConfined,
  renderRepoContext,
  resolveRepoContext,
  type ContextRejection,
  type DocReader,
  type InlinedDoc,
  type LoadedRepoDocs,
  type PathProbe,
  type ResolvedRepoContext,
  type UnresolvedPath,
} from './repo-context';
export {
  MAX_TASK_POINTERS,
  parseFindings,
  parseFindingResponses,
  applyContestResponses,
  buildLedger,
  reconciledEntry,
  renderContestRecord,
  renderLedger,
  spinOffsHold,
  spinOffsOf,
  subclaimLetter,
  subclaimsOf,
  taskRefsIn,
  type AdjudicatedSubClaim,
  type Finding,
  type FindingResponse,
  type FindingStatus,
  type LedgerEntry,
  type SpinOffCheck,
  type TaskPointerScan,
} from './adjudication';
export {
  DEFAULT_PARKED_PATH,
  DEFAULT_PARK_TTL_HOURS,
  ParkedStore,
  expiredParks,
  resumePrompt,
  type ParkedRun,
} from './parked';
export { ContinuableStore, DEFAULT_CONTINUABLE_PATH, type ContinuableRun } from './continuable';
export {
  defaultKey,
  detectEcosystem,
  renderProjectManifest,
  runInitProject,
  scanRootWarning,
  type DefaultsChoice,
  type Ecosystem,
  type InitProjectDeps,
  type InitProjectResult,
  type KindDefaultChoice,
  type LandChoices,
  type ManifestChoices,
} from './init-project';
export { COMMANDS, FILE_SENTINEL, completionCandidates, completionScript } from './completion';
export {
  BUILTIN_WORKFLOWS,
  type Workflow,
  type WorkflowStage,
  clampPermissionToWorkflow,
  resolveWorkflow,
  runWorkflow,
  stageOf,
  workflowFor,
} from './workflow';
export {
  type AgentCoordinate,
  coordinateFromParts,
  formatCoordinate,
  mergeCoordinate,
  parseCoordinate,
  tryParseCoordinate,
} from './agent-coordinate';
export { detectTools } from './tools';
export {
  agentCatalog,
  buildRegistration,
  type AdvertisedAgent,
  type RegistrationParams,
  type RunnerRegistration,
} from './registration';
export {
  NoriqClient,
  type NoriqClientOptions,
  type RegisteredRunner,
  type HeartbeatInput,
} from './client';
export {
  WsClient,
  runnerWsUrl,
  type WsClientOptions,
  type WsHandlers,
  type WsIdentity,
  type WsFactory,
  type WsSocket,
} from './ws-client';
export { Daemon, type DaemonHandle } from './daemon';
export { sanitizedAgentEnv } from './security';
export { type ProcDeps, killProcessTree, treeSpawnOptions } from './proc';
export {
  SteeringBridge,
  steerModeForKind,
  type Steer,
  type SteerResult,
  type SteerMode,
  type SteerDelivery,
} from './steering';
export { AsyncQueue } from './async-queue';
export {
  type AgentDriver,
  type DriverCapabilities,
  type DriverCatalog,
  type DriverSession,
  type DriverStartOptions,
  type DriverHandlers,
  type DriverTelemetry,
  type DriverExit,
  type DriverOutcome,
  type ModelUsage,
  zeroTelemetry,
} from './drivers/types';
export {
  ClaudeDriver,
  mapPermission,
  type ClaudeDriverDeps,
  type QueryFn,
  type SdkMessage,
  type SdkUserMessage,
} from './drivers/claude';
export {
  CodexDriver,
  mapSandbox,
  normalizeNotification,
  type CodexDriverDeps,
  type CodexTransport,
  type CodexEvent,
  type SpawnCodex,
  type CodexSandbox,
} from './drivers/codex';
export { superviseBudget, totalTokens, type BudgetRun, type BudgetBreach } from './drivers/budget';
export { reserveFromRun, exceedsRun, type BudgetReservation, type RunSpend } from './run-budget';
export {
  RUN_STAGES,
  declaredTerminals,
  clampStagesToWorkflow,
  stage,
  stagesFor,
  type RunStage,
  type StageActor,
  type StageBudget,
  type StageName,
  type StageRetry,
} from './run-machine';
export {
  prepareRun,
  executeRun,
  LOG_TAIL_CAP,
  type PrepareHost,
  type PrepareOutcome,
  type PreparedRun,
  type ExecuteHost,
  type ExecuteOutcome,
  type ExecutePlan,
  type RunPipeline,
  type StageHost,
  type StageImpl,
} from './stages';
export {
  RunSupervisor,
  RunTally,
  assemblePrompt,
  cmdVerify,
  runCommitMessage,
  runCoordinate,
  resolveAgentTool,
  resolveModel,
  effectiveKind,
  mergeBudget,
  mergeModelUsage,
  telemetryFromSpent,
  type RunSupervisorDeps,
  type ResolvedRepo,
  type RunReport,
} from './supervisor';
export { RunTranscript, nullTranscript, type RunLogRole, type RunLogSegment } from './transcript';
export {
  runVerify,
  verifyFailureComment,
  verifyFixRounds,
  MAX_VERIFY_FIXES,
  DEFAULT_VERIFY_TIMEOUT_SECONDS,
  type VerifySpec,
  type VerifyResult,
  type VerifyExec,
} from './verify';
export {
  assembleVerifyPrompt,
  judgeWithAcceptance,
  parseVerdict,
  readEscalation,
  verifyAgentComment,
  ESCALATION_INSTANCE_FLOOR,
  type EscalationReading,
  type ReviewEscalation,
  type Verdict,
  type VerifyVerdict,
} from './verify-agent';
export {
  acceptanceOverflow,
  acceptanceSummary,
  enumerateAcceptance,
  failedAcceptance,
  reconcileAcceptance,
  renderAcceptanceChecklist,
  renderAcceptanceReport,
  unverifiedAcceptance,
  MAX_ACCEPTANCE_ITEMS,
  type AcceptanceEvidence,
  type AcceptanceItem,
  type AcceptanceKind,
  type AcceptanceOutcome,
  type AcceptanceReport,
} from './acceptance';
export { buildRepairSpec, renderRepairSpec, type RepairSpec } from './repair';
export {
  checkSteps,
  planWaves,
  renderSteps,
  MAX_STEPS,
  type CheckedSteps,
  type StepFinding,
} from './steps';
export {
  assembleReviewerPrompt,
  reviewerContestPrompt,
  reviewerEscalationComment,
  reviewerFeedbackPrompt,
  reviewerRejectionComment,
  type ReviewerPromptContext,
} from './verify-reviewer';
export type {
  IntegrateResult,
  LeaseOptions,
  LockContext,
  LockOutcome,
  PublishResult,
  ReviewRequest,
  ReviewResult,
  ShareResult,
  VcsBackend,
  Workspace,
} from './vcs/types';
export {
  LockClient,
  parseToolReply,
  type AcquireInput,
  type AcquireResult,
  type CheckResult,
  type LockClientOptions,
  type LockConflict,
  type LockGrant,
} from './lock-client';
export { GitBackend, type GitOps, type LockDelegate } from './vcs/git';
export {
  LockEnforcer,
  lockFloorComment,
  denyReason,
  extractPaths,
  parseBashTargets,
  lockPathsForTool,
  toRepoRelative,
  type LockEnforcerDeps,
  type LockAcquireOutcome,
} from './lock-hooks';
export { detectVcs, parseDvRepoList, type DetectDeps, type VcsDetection } from './vcs/detect';
export { VCS_VOCAB, vocabFor, type VcsKind, type VcsVocab } from './vcs/vocab';
export { PerforceBackend, realP4Cli, type P4Cli, type PerforceBackendOpts } from './vcs/perforce';
export {
  DiversionBackend,
  DV_API_BASE,
  dvMergeUrl,
  dvStoredToken,
  realDvHttp,
  type DiversionBackendOpts,
  type DvCli,
  type DvHttp,
  type DvHttpResponse,
} from './vcs/diversion';
export {
  WorktreeManager,
  runBranch,
  setReadOnly,
  setWritable,
  comparableWorktreePath,
  DEFAULT_WORKTREES_DIR,
  WORKTREE_BRANCH_PREFIX,
  type WorktreeInfo,
  type CreateWorktreeOptions,
  type GitRunner,
} from './worktree';
export * from './repo-intel';
