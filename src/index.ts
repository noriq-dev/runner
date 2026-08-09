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
  loadIndexConfig,
  loadManifest,
  manifestPath,
  repoId,
} from './discovery';
export {
  INDEX_LANGUAGES,
  IndexContentMode,
  IndexPolicy,
  refuseIndexGlob,
  resolveIndexConfig,
  type IndexLanguage,
  type ResolvedIndexConfig,
} from './index-policy';
export { isDeniedIndexPath } from './index-deny';
export {
  MAX_STATUS_RECORDS,
  scanIndexSource,
  scanRepoForIndex,
  type IndexFileCandidate,
  type IndexFileCandidateFull,
  type IndexFileCandidateMetadata,
  type IndexScanDeps,
  type IndexScanResult,
  type IndexStatusReason,
  type IndexStatusRecord,
} from './index-scan';
export {
  FakeIndexSource,
  FilesystemIndexSource,
  comparePaths,
  type FakeIndexSourceItem,
  type FakeIndexSourceReadOverrides,
  type IndexSource,
  type IndexSourceEntry,
  type IndexSourceListItem,
  type IndexSourceReadOutcome,
  type IndexSourceRefusalReason,
  type ShouldDescend,
} from './index-source';
// The indexer proper (RUN-215): identity, the adapter registry RUN-216/217/218 plug into, the
// deterministic batch model, and the orchestrator. Both RUN-215 and RUN-220 ran in parallel and
// were fenced off this file to avoid conflicting on one import block, so their exports land here.
export {
  DiagnosticsCollector,
  MAX_PARSE_DIAGNOSTICS,
  buildFileEntityUri,
  buildSymbolEntityUri,
  computeDeletions,
  decodeSymbolPath,
  decodeUriPath,
  dedupeSymbolPaths,
  encodeSymbolPath,
  encodeUriPath,
  normalizeRepoPath,
  type EdgeRecord,
  type EntityRecord,
  type IndexDiagnostic,
  type IndexRecord,
  type SymbolLikeKind,
  type UriScope,
} from './index-entity';
export {
  IndexAdapterRegistry,
  NOOP_ADAPTER,
  createDefaultAdapterRegistry,
  type AdapterParseInput,
  type AdapterParseResult,
  type EdgeConfidence,
  type IndexParserAdapter,
  type ParsedCall,
  type ParsedDiagnostic,
  type ParsedImport,
  type ParsedSymbol,
  type SymbolNodeType,
} from './index-adapters';
export {
  TreeSitterRuntime,
  grammarIdForPath,
  loadGrammarBytes,
  type GrammarId,
  type TreeSitterRuntimeStats,
} from './treesitter-runtime';
export {
  createTreeSitterAdapter,
  createTreeSitterAdapterRegistry,
} from './index-treesitter';
// The `[index].languages` gate (RUN-219) — the ONE place that filters an adapter into (or out of)
// a registry by policy; `index-repo` and `index-selftest` both build their registry through this,
// so they cannot silently disagree about which adapters exist.
export { buildIndexAdapterRegistry, type BuiltIndexAdapterRegistry } from './index-registry';
// The local debug CLI's own pure report/render/determinism layer (RUN-219) — see `index-repo.ts`
// for the orchestrator that actually calls `runIndexer` and hands this module the result.
export {
  DEFAULT_DEBUG_LIMIT,
  DEBUG_CONTENT_PREVIEW_CHARS,
  bounded,
  buildDebugReport,
  compareGenerations,
  displaySafeContent,
  renderDebugReport,
  type BoundedList,
  type BuildDebugReportOptions,
  type DeterminismCheck,
  type EdgeView,
  type EntityView,
  type IndexDebugReport,
} from './index-debug';
export {
  buildIndexRepoReport,
  buildVcsIgnoredPredicate,
  checkIndexRepoDeterminism,
  resolveIndexRepoConfig,
  runIndexRepo,
  type IndexRepoConfigSource,
  type IndexRepoOptions,
  type IndexRepoRun,
  type VcsIgnoreWalkDeps,
} from './index-repo';
export {
  MAX_INGEST_BATCH_BYTES,
  assembleManifest,
  computeBatchHash,
  computeContentHash,
  deriveGenerationId,
  encodeBatches,
  sortRecords,
  toStagedRow,
  type AssembleManifestInput,
  type EncodeBatchesOptions,
  type EncodedBatch,
  type GenerationIdentity,
  type StagedEdgeRow,
  type StagedNodeRow,
  type StagedRow,
} from './index-batch';
export { runIndexer, type IndexRunTarget, type IndexerDeps, type IndexerResult } from './indexer';
export {
  IngestError,
  IngestUpload,
  openIngestUpload,
  type BeginEpisodeIngestInput,
  type BeginIndexIngestInput,
  type IngestBatchResult,
  type IngestCompleteEpisodeResult,
  type IngestCompleteIndexResult,
  type IngestFailureReason,
  type IngestPurpose,
  type IngestStatusResult,
} from './ingest-client';
// The two backend-native sources (RUN-254/255). Neither materializes a tree — Perforce reads the
// depot with no client workspace, Diversion reads its REST API with no checkout — so they are the
// reason `IndexSnapshot.source` exists at all. On the surface because RUN-214's coordinator is the
// first caller that has to construct one, and a public symbol reachable only through its own
// backend is a symbol the next subsystem re-exports by hand.
export {
  PerforceDepotIndexSource,
  realP4RawCli,
  stripDepotPrefix,
  type P4RawCli,
  type PerforceDepotIndexSourceOpts,
} from './vcs/perforce-index-source';
export {
  DiversionIndexSource,
  decodeObjectStatus,
  isDirectoryMode,
  type DvChangeVerb,
} from './vcs/diversion-index-source';
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
export {
  promptTemplate,
  renderPrompt,
  renderTemplate,
  renderUserTemplate,
  type PromptVars,
  type UserTemplateOptions,
} from './prompts';
export {
  DEFAULT_USER_WORKFLOWS_DIR,
  WORKFLOW_TEMPLATE_MAX_CHARS,
  WorkflowStore,
  type LoadedWorkflowDefinition,
  type WorkflowCatalog,
  type WorkflowSourceTier,
  type WorkflowStoreDeps,
} from './workflow-store';
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
  effectiveStatus,
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
  continuationResumePrompt,
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
  type StageCoordinateKey,
  type Workflow,
  type WorkflowStage,
  clampPermissionToWorkflow,
  isStageCoordinateKey,
  resolveWorkflow,
  runWorkflow,
  stageCoordinate,
  stageOf,
  workflowFor,
} from './workflow';
export {
  type AgentCoordinate,
  coordinateFromParts,
  foldStageCoordinate,
  formatCoordinate,
  mergeCoordinate,
  parseCoordinate,
  tryParseCoordinate,
} from './agent-coordinate';
export { detectTools } from './tools';
export {
  advertisedWorkflows,
  agentCatalog,
  buildRegistration,
  repoReport,
  type AdvertisedAgent,
  type AdvertisedWorkflowEntry,
  type RegistrationParams,
  type RepoReport,
  type RunnerRegistration,
} from './registration';
export {
  NoriqClient,
  NoriqHttpError,
  type IngestCapabilityGrant,
  type MintIngestCapabilityInput,
  type NoriqClientOptions,
  type RegisteredRunner,
  type HeartbeatInput,
} from './client';
export {
  INDEXER_VERSION,
  associationNotice,
  reconcile,
  type IndexReconcileOutcome,
  type ReconcileInput,
  type ResumeCandidate,
} from './index-reconcile';
export {
  DEFAULT_JOURNAL_PATH,
  IndexJournal,
  fileJournalStore,
  type IndexJournalEntry,
  type IndexJournalKey,
  type JournalStore,
} from './index-journal';
// Local staging + the upload phase itself (RUN-221) — the journal above records job/batch
// progress; these two land alongside it as the disposable on-disk copy and the orchestration
// that drives begin/batch/complete resumably against it. Neither has a caller in `daemon.ts` yet
// (RUN-222 owns wiring a trigger to reach them) — see VENDORED-CONTRACT.md's phase list.
export {
  DEFAULT_STAGING_ROOT,
  fileStagingStore,
  stagingDirFor,
  stagingId,
  sweepOrphanedStaging,
  type StagingStore,
} from './index-stage';
export {
  DEFAULT_MAX_STAGED_BYTES,
  uploadGeneration,
  type UploadGenerationDeps,
  type UploadGenerationInput,
  type UploadOutcome,
  type UploadProgress,
} from './index-upload';
export {
  IndexCoordinator,
  type IndexCoordinatorDeps,
  type IndexTarget,
  type IndexWorkContext,
  type IndexWorkOutcome,
  type IndexWorkStep,
} from './index-coordinator';
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
  executeChain,
  LOG_TAIL_CAP,
  type PrepareHost,
  type PrepareOutcome,
  type PreparedRun,
  type ExecuteHost,
  type ExecuteOutcome,
  type ExecutePlan,
  type ChainOutcome,
  type ChainPlan,
  type ChainWave,
  type StepSummary,
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
  SETUP_MARKER_DIR,
  clearSetupMarker,
  runSetup,
  setupBriefNote,
  setupMilestone,
  type SetupResult,
  type SetupCommandResult,
} from './setup';
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
export { buildEpisode, normalizeSeverity, type EpisodeExtra } from './episode';
export {
  checkSteps,
  planWaves,
  renderSteps,
  stepWorkspaceId,
  owningRunId,
  MAX_STEPS,
  STEP_WORKSPACE_SEP,
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
  ChangesBetweenResult,
  IgnoreQueryResult,
  IndexSnapshot,
  IndexSnapshotResult,
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
  realDvBlobHttp,
  type DiversionBackendOpts,
  type DvBlobHttp,
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
  CHANGES_BETWEEN_MAX_PATHS,
  type WorktreeInfo,
  type CreateWorktreeOptions,
  type GitRunner,
  type IndexSnapshotHandle,
} from './worktree';
export * from './repo-intel';
export {
  RepositoryKey,
  parseRepositoryKey,
  type AuthorityLevel,
  type BaseId,
  type BranchRef,
  type ContextPack,
  type ContextPackCitation,
  type ContextPackEpisodeExcerpt,
  type ContextPackExcerpt,
  type ContextPackMemoryExcerpt,
  type ContextPackMode,
  type ContextPackNotice,
  type ContextPackRole,
  type ContextPackSection,
  type ContextPackTaskFacts,
  type EffortEpisode,
  type EpisodeFinding,
  type EpisodeLandingOutcome,
  type EpisodeSelfSummary,
  type EpisodeTimelineEntry,
  type EvidenceRef,
  type IndexBatch,
  type IndexGenerationManifest,
  type MemoryItem,
  type MemoryKind,
  type ParseRepositoryKeyResult,
  type RunnerCheckoutId,
  type VerificationState,
} from './memory-contract';
export {
  RunnerIndexCursor,
  type RunnerCheckoutAssociationState,
  type RunnerIndexGeneration,
  type RunnerStagedGeneration,
} from './memory-contract';
