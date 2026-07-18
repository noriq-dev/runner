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
export { type DiscoveredRepo, discoverRepos, loadManifest, manifestPath, repoId } from './discovery';
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
  parseFindings,
  parseFindingResponses,
  buildLedger,
  renderLedger,
  type Finding,
  type FindingResponse,
  type FindingStatus,
  type LedgerEntry,
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
export { detectTools } from './tools';
export { buildRegistration, type RegistrationParams, type RunnerRegistration } from './registration';
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
export {
  RunSupervisor,
  RunTally,
  assemblePrompt,
  cmdVerify,
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
  parseVerdict,
  verifyAgentComment,
  type Verdict,
  type VerifyVerdict,
} from './verify-agent';
export {
  assembleReviewerPrompt,
  reviewerFeedbackPrompt,
  reviewerRejectionComment,
  type ReviewerPromptContext,
} from './verify-reviewer';
export type {
  IntegrateResult,
  LeaseOptions,
  PublishResult,
  ShareResult,
  VcsBackend,
  Workspace,
} from './vcs/types';
export { GitBackend, type GitOps } from './vcs/git';
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
