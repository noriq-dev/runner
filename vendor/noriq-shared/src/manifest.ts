import { z } from 'zod';
import { AgentTool, RunBudget, RunEffort, RunKind } from './runner';

// ===========================================================================
// PENDING PLANAR PORT (RUN-113/RUN-119): the `agent` coordinate fields added to
// ModelDefault and VerifyReviewer below were authored HERE first so the runner
// could compile and test against them. They must be ported verbatim into planar
// `packages/shared/src/manifest.ts` and re-vendored — do NOT run `npm run
// vendor:shared` before that port, or these deltas are overwritten from planar.
// Reconciliation is RUN-119 (Phase 5).
// ===========================================================================
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
  /**
   * Opt this kind into the driver's own AUTO mode (RUN-68): Claude's bypass-permissions,
   * codex's unsandboxed full access — instead of the curated allowlist. Default FALSE, and the
   * default is the floor; this is the committed, per-kind trust escape hatch for repos whose
   * work the allowlist fits badly. Two axes it deliberately does NOT loosen: `write` survives
   * auto (a read-only kind stays read-only — edit-tool denials on Claude, read-only sandbox on
   * codex), and `deny` still binds. Push credentials and the per-kind Noriq tool floor are
   * enforced elsewhere (env stripping; server-side registration, RUN-47) and are untouched by
   * this. See THREAT-MODEL.md — this moves a boundary that used to be absolute.
   */
  auto: z.boolean().default(false),
});
export type PermissionProfile = z.infer<typeof PermissionProfile>;

export const KindPermissions = z.object({
  scope: PermissionProfile,
  build: PermissionProfile,
  verify: PermissionProfile,
});
export type KindPermissions = z.infer<typeof KindPermissions>;

/**
 * A repo's default model + effort for one kind (RUN-33).
 *
 * Per KIND, because that is where the difference actually lives: a scope run is exploration and
 * judgment, a build is execution, a verify is adversarial reasoning. One repo-wide value gets at
 * least one of them wrong. This lets a repo say "scope with something strong, build with
 * something cheap" once, in the commit, rather than every dispatcher remembering to.
 *
 * Both nullable and independent: wanting a higher effort while inheriting the tool's model is
 * an ordinary thing to want, and so is the reverse.
 */
export const ModelDefault = z.object({
  // The agent coordinate (RUN-113): `claude.opus-4_8.high` — the canonical per-kind selector.
  // When set it WINS; `model`/`effort` below are the legacy triple, kept as the fallback for one
  // deprecation window. A free string (the runner's coordinate parser validates it), not an enum —
  // model ids are the vendor's and change weekly, exactly the reason `model` is a free string.
  agent: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  effort: RunEffort.nullable().default(null),
});
export type ModelDefault = z.infer<typeof ModelDefault>;

export const KindDefaults = z.object({
  scope: ModelDefault.prefault({}),
  build: ModelDefault.prefault({}),
  verify: ModelDefault.prefault({}),
});
export type KindDefaults = z.infer<typeof KindDefaults>;

// Security-model defaults: scope/verify are read-only, build gets worktree write.
// No agent ever gets push credentials (enforced by the daemon, not expressible here).
// A factory (not a shared literal) so each parse gets fresh, non-aliased arrays.
const defaultPermissions = (): KindPermissions => ({
  scope: { write: false, network: 'restricted', allow: [], deny: [], auto: false },
  build: { write: true, network: 'restricted', allow: [], deny: [], auto: false },
  verify: { write: false, network: 'restricted', allow: [], deny: [], auto: false },
});

/**
 * The inline reviewer half of the verify stage (RUN-61): a FRESH agent — never the session
 * that wrote the code — reviews the build's diff read-only and files a verdict; a FAIL report
 * is handed back to the live builder to fix, bounded, then re-reviewed. Configurable model /
 * effort because adversarial review is exactly where a repo may want a stronger model than it
 * builds with; both fall back to `[defaults.verify]`, then the tool's own default.
 */
export const VerifyReviewer = z.object({
  /**
   * Run the reviewer on a DIFFERENT driver than the builder (RUN-70) — the strongest form of
   * its independence: not just a fresh session, a different vendor's model judging the work.
   * Null = the run's own driver, today's behavior. When set, `[defaults.verify].model` is NOT
   * inherited (model names are vendor-specific and the repo default may name the other
   * vendor's) — name `model` here or take the tool's own default. A tool with no driver on the
   * machine fails the gate loudly rather than silently reviewing with the builder's vendor.
   */
  // The reviewer's agent coordinate (RUN-113): `codex.gpt-5_6-sol.high` names tool+model+effort in
  // one string. When set it WINS over `tool`/`model`/`effort` below (the legacy triple), and its
  // tool segment IS honored — a reviewer on a different vendor is the whole point of RUN-70.
  agent: z.string().nullable().default(null),
  tool: AgentTool.nullable().default(null),
  model: z.string().nullable().default(null),
  effort: RunEffort.nullable().default(null),
  // How many FAIL→fix→re-review rounds before the run stops and a human picks it up. Same
  // bound-by-default shape as RUN-21's K=2: an agent that cannot satisfy the reviewer in two
  // rounds is not going to on the third — it is going to keep spending. 0 = one review, no
  // hand-back (a pure gate).
  maxRounds: z.number().int().min(0).max(5).default(2),
});
export type VerifyReviewer = z.infer<typeof VerifyReviewer>;

// The verify stage, a CHOICE per repo (RUN-61) expressed by what this section contains:
// omit `[verify]` entirely = no verify stage; `cmd` = the deterministic floor (zero tokens,
// daemon-run — RUN-19); `[verify.agent]` = the inline reviewer; both = floor first (cheap
// screen), then the reviewer. A section with neither is a config error, refused at parse —
// silently meaning "none" would read as a gate that isn't there.
export const VerifySpec = z
  .object({
    cmd: z.string().min(1).nullable().default(null), // e.g. "cd apps/api && npx tsc --noEmit && npm test"
    timeoutSeconds: z.number().int().positive().nullable().default(null),
    /**
     * Pin the shell `cmd` runs under. Null = the platform's own: `sh` on POSIX, **cmd.exe on
     * Windows** (RUN-42).
     *
     * That difference is a real cost, and this field exists to give a repo a way out of it. This
     * manifest is COMMITTED, so `cmd` travels to teammates on other operating systems. `&&`
     * happens to mean the same thing in both shells, so the common `npm run check && npm test`
     * is portable by luck — but `2>&1`, `$VAR`, quoting, and globs are not. A team on mixed OSes
     * whose verify command needs any of those can pin `shell = "bash"` (Git for Windows ships
     * one, and this daemon already requires git) and get one behaviour everywhere.
     *
     * Not the default, because a pin that is absent fails the gate outright, which is worse than
     * cmd.exe handling the common case correctly.
     */
    shell: z.string().min(1).nullable().default(null),
    /**
     * How many FAIL→fix→re-verify rounds the daemon hands a failing `cmd` back to the LIVE
     * builder before the run stops and a human picks it up (RUN-94). The floor half of the
     * knob `[verify.agent]` already commits: RUN-29 wired the feedback loop but hardcoded
     * RUN-21's K=2, so a repo whose suite needs a wider bound (or a pure gate) had no say.
     * 0 = one verify, no hand-back. The budget still applies underneath — a loop cannot
     * outrun its ceiling. Only meaningful with `cmd`; the reviewer's loop is `agent.maxRounds`.
     */
    maxRounds: z.number().int().min(0).max(5).default(2),
    agent: VerifyReviewer.nullable().default(null),
  })
  .refine((v) => v.cmd !== null || v.agent !== null, {
    message: '[verify] needs `cmd`, `[verify.agent]`, or to be omitted entirely',
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
  //
  // May contain `<planKey>` (RUN-28) — e.g. "noriq/plan-<planKey>" — giving each plan its own
  // working branch, which is what makes a merge request mean something: a human reviews one
  // coherent plan's worth of work rather than a click per run or a surprise on main. A run with
  // no plan (a one-off dispatch) falls back to the literal branch with the placeholder stripped,
  // so a template never produces a branch called "plan-<planKey>".
  branch: z.string().min(1),
  // Where the working branch's merge request goes when its plan completes (RUN-28). NO default
  // and null = no MR: the protected branch is named by the REPO, never inferred and never chosen
  // by whoever dispatched. Requires autoPush — a merge request cannot exist without the branch
  // reaching the remote.
  mergeTarget: z.string().min(1).nullable().default(null),
  // What a DISPATCH may override `branch` with (RUN-41). Globs: ["feature/**", "wip/*"].
  //
  // EMPTY MEANS NO OVERRIDE, and that default is load-bearing. Today a repo saying
  // `branch = "agents"` can only ever be written at `agents`; if a per-dispatch branch defaulted
  // to "anywhere", every existing repo would silently become writable at `main` by anyone who can
  // dispatch. That is a live security envelope widening because a field appeared — the same
  // silent widening refused in RUN-38 (a refresh must not broaden scope) and RUN-35 (an offboard
  // must not evaporate on reconnect). The repo owner and the dispatcher are not always the same
  // person, so the repo opts into being steerable.
  allowedBranches: z.array(z.string().min(1)).default([]),
  // Land only if the deterministic verify passes on the REBASED result. Off means an
  // unverified diff reaches `branch` — permitted, never assumed.
  onlyWhenVerifyPasses: z.boolean().default(true),
  // Let the build agent resolve a rebase conflict in its own worktree, under the same
  // permission floor, when the conflict is mechanical. Structural ones still fail out.
  resolveConflicts: z.boolean().default(true),
  // Push `branch` to its remote after a successful landing (RUN-27). DEFAULT FALSE, and the
  // default is the point: this crosses the one boundary the daemon otherwise has. Every other
  // defence rests on "nothing an agent writes leaves this machine" — auto-landing was
  // defensible precisely because `git push` stayed human, and `git log origin/main..main` was
  // the operator's "what did the agents do while I wasn't looking?" check. This removes that
  // checkpoint, so it must be chosen, never inferred. See THREAT-MODEL.md.
  autoPush: z.boolean().default(false),
});
export type LandPolicy = z.infer<typeof LandPolicy>;

/**
 * A repo-defined workflow (RUN-119): a NAMED variant of a built-in run kind. It inherits the
 * built-in `base`'s security POSTURE verbatim — a `docs` workflow based on `scope` is read-only
 * because scope is, and no field here can change that (the write floor is enforced in the runner,
 * RUN-118). What a custom workflow may vary is the PROMPT the agent gets, so a repo can shape "how"
 * a read-only exploration or a build is briefed without minting a new posture. The three built-ins
 * (scope/build/verify) are always present and need no declaration.
 *
 * PENDING PLANAR PORT (RUN-119/RUN-122): authored in the vendored copy first — see the top marker.
 */
export const WorkflowDef = z.object({
  // Which built-in posture this workflow IS — the floor-safe foundation it cannot escape.
  base: RunKind,
  // A prompt template name or inline text overriding the base's default brief (RUN-121). Null =
  // use the base's own prompt, exactly as the built-in kind would.
  prompt: z.string().nullable().default(null),
});
export type WorkflowDef = z.infer<typeof WorkflowDef>;

// A committed KEY must satisfy the same shape as Project.key (short prefix).
export const ProjectKey = z.string().min(1).max(8);

export const ProjectManifest = z.object({
  // Committed, portable identifier. Resolved to a prj_… id per configured server
  // (see the resolution contract below) — NOT a server-local id, so the checkout
  // is portable across instances/forks without editing this file.
  key: ProjectKey,
  // Lock this repo's work to one BOARD within the project (RUN-71) — `key` one level down: a
  // project can host several repos, and without this every task a repo's agents create piles
  // onto the default board. A NAME, not an id, for the same reason key is not a prj_… id:
  // ids are server-local and this file is committed. Resolved per server at registration
  // (case-insensitive); an unknown name resolves to null — visible in the dashboard, never
  // silently rebound. Null = the project's default board, exactly as before.
  board: z.string().min(1).max(80).nullable().default(null),
  verify: VerifySpec.nullable().default(null),
  tool: AgentTool.nullable().default(null), // default driver for this repo; null = runner default
  defaultBranch: z.string().nullable().default(null),
  // null = no auto-landing; every run's diff waits on its own branch for a human.
  land: LandPolicy.nullable().default(null),
  permissions: KindPermissions.default(defaultPermissions),
  // Per-kind model + effort (RUN-33). Empty = whatever the tool defaults to; a dispatch can
  // still override per run. Not part of the security floor — unlike `permissions`, getting this
  // wrong costs money or quality, never safety.
  defaults: KindDefaults.prefault({}),
  // Repo-defined workflows (RUN-119), keyed by name: named variants of a built-in kind with their
  // own prompt. The three built-ins are always available and are NOT listed here; a name that
  // collides with a built-in is ignored in favour of the built-in (a repo cannot redefine `build`).
  workflows: z.record(z.string(), WorkflowDef).default({}),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

// ---------------------------------------------------------------------------
// Machine config
// ---------------------------------------------------------------------------

/**
 * How this machine keeps up with releases (RUN-37).
 *
 * There is NO `apply` / `enabled` self-replacement key here, and its absence is the design.
 * Shipping one that did nothing would repeat exactly the mistake RUN-38 had to undo: a stored
 * setting that reads as working while nothing consults it. An operator would set
 * `apply = true`, believe the box self-updates, and be wrong.
 *
 * Self-replacement is blocked on judgement, not mechanics: @noriq-dev/runner is published, so it
 * COULD npm-install itself. But the daemon holds the operator's OAuth token, spawns agents at a
 * permission floor it chooses, and with [land] writes branches — so whoever controls the version
 * feed controls all of that on every opted-in box. The package has npm's registry signatures (as
 * every package does) but no provenance attestation, so nothing proves an artifact came from
 * this repo's CI rather than someone's laptop. It also has to drain live runs and be restarted
 * by something. Both are solvable; neither is solved. See THREAT-MODEL.md.
 *
 * So this is the checking half, which is safe and useful on its own: a public GET, and a runner
 * that says out loud when it is behind.
 */
export const UpdatePolicy = z.object({
  /** Check whether this runner is behind and say so (log + the dashboard's version badge).
   *  Nothing is downloaded, nothing is replaced. */
  check: z.boolean().default(true),
  checkIntervalHours: z.number().positive().default(24),
});
export type UpdatePolicy = z.infer<typeof UpdatePolicy>;

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
  // Staying current (RUN-37). Machine-local on purpose: updating the daemon is a property of
  // the BOX, not of a repo — a repo must never be able to update the daemon supervising it.
  update: UpdatePolicy.prefault({}),
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
