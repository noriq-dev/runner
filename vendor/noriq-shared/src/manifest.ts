import { z } from 'zod';
import { AgentTool, RunBudget } from './runner';

// ---------------------------------------------------------------------------
// The two manifests (RUN plan, Phase 1). The daemon reads TOML off disk; these
// schemas validate the *parsed* object (shared stays runtime-neutral — no TOML
// parser or fs here). Two files by design:
//
//   .noriq/project.toml  — COMMITTED, travels with the repo, team-shareable.
//     Declares the project KEY (not a server-local id), the deterministic verify
//     command, the default tool, and the per-kind permission profiles.
//
//   ~/.noriq/runner.toml — MACHINE-local, never committed. The daemon's own
//     identity + wiring: label, which server to dial, where to scan for repos,
//     concurrency, and default budget ceilings.
// ---------------------------------------------------------------------------

// What network access an agent process gets. Enforced by the daemon/driver, not
// declared for decoration — part of the load-bearing security model.
export const NetworkPolicy = z.enum(['none', 'restricted', 'full']);
export type NetworkPolicy = z.infer<typeof NetworkPolicy>;

// A per-kind permission profile. Tool-agnostic *intent*; the driver translates
// it to claude/codex specifics. `write` gates filesystem mutation in the Run's
// worktree — the core scope↔build distinction.
export const PermissionProfile = z.object({
  write: z.boolean(),
  network: NetworkPolicy.default('restricted'),
  allow: z.array(z.string()).default([]), // extra allow rules handed to the driver
  deny: z.array(z.string()).default([]),
});
export type PermissionProfile = z.infer<typeof PermissionProfile>;

export const KindPermissions = z.object({
  scope: PermissionProfile,
  build: PermissionProfile,
  verify: PermissionProfile,
});
export type KindPermissions = z.infer<typeof KindPermissions>;

// Security-model defaults: scope/verify are read-only, build gets worktree write.
// No agent ever gets push credentials (enforced by the daemon, not expressible here).
// A factory (not a shared literal) so each parse gets fresh, non-aliased arrays.
const defaultPermissions = (): KindPermissions => ({
  scope: { write: false, network: 'restricted', allow: [], deny: [] },
  build: { write: true, network: 'restricted', allow: [], deny: [] },
  verify: { write: false, network: 'restricted', allow: [], deny: [] },
});

// The deterministic verify floor: a daemon-run command (zero tokens) that must
// pass before a build's phase advances. null = no deterministic verify configured.
export const VerifySpec = z.object({
  cmd: z.string().min(1), // e.g. "cd apps/api && npx tsc --noEmit && npm test"
  timeoutSeconds: z.number().int().positive().nullable().default(null),
});
export type VerifySpec = z.infer<typeof VerifySpec>;

/**
 * Where a passing build's diff goes, and whether the daemon puts it there itself.
 *
 * The point is to stop charging a human per run. A build that clears the gate is rebased
 * onto `branch`, RE-VERIFIED there, then fast-forwarded in — and its worktree + throwaway
 * branch are reaped. Work accumulates on one integration branch that a human merges
 * onward into main/protected branches on their own schedule, reviewing a batch instead of
 * clicking through every run.
 *
 * Verify runs AFTER the rebase, not before: two runs can each be green at their own fork
 * point and broken together, and a gate that never sees the combination cannot catch it.
 *
 * SECURITY: the daemon merges LOCALLY and still never pushes — agent output reaches the
 * operator's disk and nowhere else, so `git push` remains the human boundary. Pointing
 * `branch` at something push-triggered or auto-deploying hands agents production; that is
 * an explicit choice, never a default. Omit this section and nothing auto-lands.
 */
export const LandPolicy = z.object({
  // The integration branch; created from defaultBranch if it doesn't exist. NO default,
  // on purpose: auto-landing is opt-in per repo and must never silently choose `main`.
  branch: z.string().min(1),
  // Land only if the deterministic verify passes on the REBASED result. Off means an
  // unverified diff reaches `branch` — permitted, never assumed.
  onlyWhenVerifyPasses: z.boolean().default(true),
  // Let the build agent resolve a rebase conflict in its own worktree, under the same
  // permission floor, when the conflict is mechanical. Structural ones still fail out.
  resolveConflicts: z.boolean().default(true),
});
export type LandPolicy = z.infer<typeof LandPolicy>;

// A committed KEY must satisfy the same shape as Project.key (short prefix).
export const ProjectKey = z.string().min(1).max(8);

export const ProjectManifest = z.object({
  // Committed, portable identifier. Resolved to a prj_… id per configured server
  // (see the resolution contract below) — NOT a server-local id, so the checkout
  // is portable across instances/forks without editing this file.
  key: ProjectKey,
  verify: VerifySpec.nullable().default(null),
  tool: AgentTool.nullable().default(null), // default driver for this repo; null = runner default
  defaultBranch: z.string().nullable().default(null),
  // null = no auto-landing; every run's diff waits on its own branch for a human.
  land: LandPolicy.nullable().default(null),
  permissions: KindPermissions.default(defaultPermissions),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

// ---------------------------------------------------------------------------
// Machine config
// ---------------------------------------------------------------------------

export const RunnerConfig = z.object({
  label: z.string().min(1), // human name for this runner, e.g. "my-laptop"
  server: z.string().url(), // the Noriq server this runner dials (control plane)
  scanRoots: z.array(z.string()).min(1), // dirs walked to discover .noriq/project.toml markers
  concurrency: z.number().int().positive().default(1), // → Runner.capabilities.maxConcurrency
  // default ceilings applied to Runs lacking their own. zod v4: `.default({})` now
  // wants the full OUTPUT value, so use `.prefault({})` — it parses `{}` through
  // RunBudget, applying each field's inner default (the v3 `.default({})` behavior).
  budget: RunBudget.prefault({}),
  // Installed drivers. Optional — the daemon may auto-detect; when set it pins
  // what this runner advertises (Runner.capabilities.tools).
  tools: z.array(AgentTool).nullable().default(null),
  // NOTE: the OAuth token is a local secret and intentionally NOT part of this
  // schema — it lives outside the config file (credential store / token file);
  // only the token crosses the wire, per the security model. See RUN-5/RUN-9.
});
export type RunnerConfig = z.infer<typeof RunnerConfig>;

// ---------------------------------------------------------------------------
// key → projectId resolution contract
//
// The manifest commits a KEY; the daemon never hardcodes a prj_… id. At
// discovery/registration the daemon advertises the committed key (see
// RunnerRepo.projectKey, RUN-1); the server maps it to a project on *that*
// server and returns the id (RunnerRepo.projectId). Because the mapping is
// server-local, the same committed checkout resolves correctly on a fork or a
// different instance that has its own project under the same key — portability
// without editing the repo. A key with no project on the server resolves to
// null (unresolved) and yields no dispatchable target there.
// ---------------------------------------------------------------------------

// Canonical form of a committed key for comparison/lookup (keys are
// case-insensitive prefixes; store/compare uppercased + trimmed).
export const normalizeProjectKey = (key: string): string => key.trim().toUpperCase();

// The result the server returns when resolving a repo's committed key.
export const ProjectKeyResolution = z.object({
  key: ProjectKey, // the committed key (normalized)
  projectId: z.string().nullable(), // null = no project with this key on this server
  server: z.string().url(), // which server produced this resolution (portability audit)
});
export type ProjectKeyResolution = z.infer<typeof ProjectKeyResolution>;
