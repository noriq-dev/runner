import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { RunKind } from '@noriq-dev/shared';

// Security hardening for the "autonomous agent with a shell on a user machine"
// surface (RUN-24). The load-bearing defenses live elsewhere — per-kind permission
// profiles (drivers/claude mapPermission, drivers/codex mapSandbox), one throwaway
// worktree per Run with scope read-only (worktree.ts), daemon-enforced budgets
// (drivers/budget), and output landing as a review diff a human merges. Note the daemon
// may push the working branch when a repo opts in (RUN-27) — the agent never can, which
// is this module's job: the credential is absent from the child env, not merely unused.
// This module hardens the PROCESS ENVIRONMENT the spawned agent inherits.

// Env vars that must never reach the agent's shell — the agent reaches Noriq via
// its MCP connection (credential injected at the transport, not the shell), so the
// raw token has no business in the environment where `bash` can read it.
const STRIPPED_ENV = [
  'NORIQ_TOKEN', // the daemon's OAuth token — MCP supplies Noriq access, not the shell
  'NORIQ_MCP_TOKEN', // see agentEnvWithMcpToken: only the codex driver may re-add this
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];

/** The env var codex reads its MCP bearer token from (`bearer_token_env_var`). */
export const CODEX_MCP_TOKEN_ENV = 'NORIQ_MCP_TOKEN';

/**
 * Build the environment a spawned agent process runs under. Strips known secrets
 * and neutralizes git's ability to push or prompt for credentials — so even if a
 * build agent runs `git push` inside its allowlist, it has no credentials and no
 * way to acquire them. Model/git creds stay on the box; only the Noriq OAuth token
 * crosses the wire (over MCP), never into the agent's shell.
 */
export function sanitizedAgentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];

  // No interactive credential prompt, no askpass fallback.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '/bin/false';
  env.SSH_ASKPASS = '/bin/false';
  // Disable any configured credential helper for this process via git's env-config
  // channel (GIT_CONFIG_* overrides ~/.gitconfig for the child only).
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'credential.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  return env;
}

const MISSION_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const;

/**
 * Minimal environment for the mission execution plane. Provider/project credentials belong in
 * broker handles or driver-owned transports, never in an agent-readable inherited environment.
 * `HOME` and vendor config roots are deliberately absent; drivers add their private managed home
 * explicitly where needed.
 */
export function missionAgentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of MISSION_ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined) selected[key] = value;
  }
  return sanitizedAgentEnv(selected);
}

/**
 * Project MCP processes are less trusted than the vendor parent. Give them the already-sanitized
 * execution environment but never the provider/Noriq homes or bearer-token variable. Their
 * writable state belongs to the containment tmpfs and disappears with the attempt.
 */
export function projectMcpProcessEnv(
  base: NodeJS.ProcessEnv,
  declared: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env = sanitizedAgentEnv({ ...base, ...declared });
  // This table is serialized into vendor MCP configuration before the outer containment provider
  // canonicalizes the vendor process environment. Canonicalize it independently so a nested
  // launcher does not inherit an unreachable host alias such as /home -> /var/home.
  if (env.PATH !== undefined) {
    env.PATH = env.PATH.split(path.delimiter)
      .map((entry) => {
        if (!path.isAbsolute(entry)) return entry;
        try {
          return realpathSync(entry);
        } catch {
          return entry;
        }
      })
      .join(path.delimiter);
  }
  env.HOME = '/tmp/noriq-project-mcp';
  env.CODEX_HOME = '/tmp/noriq-project-mcp/codex-denied';
  env.CLAUDE_CONFIG_DIR = '/tmp/noriq-project-mcp/claude-denied';
  env[CODEX_MCP_TOKEN_ENV] = '';
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Why codex re-adds ONE token to the sanitized env, deliberately (the exception the codex driver
 * makes on top of `sanitizedAgentEnv`).
 *
 * This bends the rule above and it is worth being honest about why. The Claude driver puts
 * the credential on the MCP transport's Authorization header, so it never touches the shell.
 * Codex offers no such option: `codex mcp add` exposes only `--bearer-token-env-var`, so a
 * streamable-HTTP MCP server's token is read from the process environment or codex cannot
 * authenticate at all. There is no third choice short of a local proxy.
 *
 * What makes the trade acceptable is WHICH token this is (RUN-43). It is minted per Run,
 * bound to exactly one agent in one project, and revoked by the server the moment the Run
 * goes terminal — so a build agent that reads it out of its own env gains the ability to act
 * as itself, in the project it is already working, until its run ends. Before this, codex got
 * no MCP config at all: every codex agent was anonymous and could not report its work, which
 * is a worse failure and a silent one. The alternative — passing the DAEMON's token, which
 * can register runners and reach every project its human can — is the thing this replaces.
 *
 * Since RUN-109 the codex driver composes `{ ...opts.env, [CODEX_MCP_TOKEN_ENV]: token }` on the
 * supervisor-sanitized base rather than re-sanitizing here. If codex ever grows header support,
 * drop the re-add entirely.
 */

/**
 * Reaching a human — available to EVERY kind (RUN-32).
 *
 * Deliberately outside the per-kind curation below, because it is not the same sort of thing.
 * The rest of that list rations *authority* (who may claim work, who may mint a plan); this
 * rations nothing. Notifying a human is the cheapest action an agent can take, it is exactly
 * what we want an uncertain agent to do, and withholding it pushes agents toward guessing —
 * the one behaviour the whole security model exists to prevent. An agent with a permission
 * question and no way to ask does not stop; it decides.
 *
 * - raise_alert    — "this looks wrong and a human should know" (non-blocking; keep working)
 * - request_input  — "I need a decision to continue" → the entry point for RUN-30's park/resume
 */
const REACH_A_HUMAN = ['raise_alert', 'request_input'];

/**
 * The Noriq tools a STAGE ACTOR may call — the planner, the plan checker, the pattern mapper, and
 * the inline reviewer. Exactly the reach-a-human pair, nothing else.
 *
 * These actors run under the RUN's one identity (RUN-43: the credential is not re-issuable, so
 * there is no second identity to mint) and were originally spawned with no Noriq connection at
 * all: the full kind floor grants writes the filesystem clamp says nothing about — `update_task`,
 * `claim_task`, `post_comment` — and RUN-140/141 rightly refused to hand a "read-only" actor
 * those. But the refusal threw out the two tools this file's own REACH_A_HUMAN paragraph says
 * must never be rationed, and a week of live dogfood showed the cost: planners guessing at
 * decisions a human had never made, reviewers unable to say "I cannot judge this without knowing
 * X" in any form that stopped the run. An actor with a question and no way to ask does not stop;
 * it decides.
 *
 * So the narrow set: `raise_alert` moves no work, `request_input` moves no work — it PAUSES the
 * run, which is the daemon's own machinery answering, not the actor acting. Authorship separation
 * survives intact: the reviewer still cannot claim, move, comment, or edit anything.
 */
export const STAGE_NORIQ_TOOLS: readonly string[] = [...REACH_A_HUMAN];

/**
 * Staying alive — also every kind (RUN-47's "also"). Every Noriq call renews a claim, so
 * heartbeat looks redundant; but a build agent that works 40 minutes without touching Noriq
 * loses its claim and nothing tells it. Denying the one tool whose whole job is "I am still
 * here" rations nothing and creates exactly that silent expiry.
 */
const STAY_ALIVE = ['heartbeat'];

/**
 * The Noriq tools each kind may call, curated to its job — the per-kind floor extended to
 * Noriq itself, not just the filesystem. A scope agent can propose a plan but not claim work;
 * a build agent can claim/report but not mint plans; verify can read and comment but never
 * mutate — that last one is the point of the adversarial gate: the reviewer must not be able
 * to MOVE the work it is judging.
 *
 * This lives HERE and not in a driver (RUN-46), because it is a policy about what a run kind
 * may reach, and the first year it lived in drivers/claude.ts it was quietly a property of one
 * driver: the same verify run on codex had all 28 tools, claim_task included. Each driver
 * translates these names into its own enforcement (Claude: the dontAsk allowlist; Codex: the
 * MCP server's enabled_tools) — neither driver decides the list.
 *
 * Since RUN-47 this list is also what the agent SEES: the daemon declares it at run-agent
 * creation and the server advertises exactly these tools over MCP, so the catalogue and the
 * allowlist are two views of one policy instead of two policies that disagree. That raises
 * the stakes of an omission — before, a missing tool was advertised-then-denied (a wasted
 * turn); now it does not exist for the agent at all. Which is why verify has get_briefing:
 * the server's own contract opens with "call get_briefing first", and a read that orients
 * the reviewer mutates nothing.
 */
const NORIQ_TOOLS: Record<RunKind, string[]> = {
  // Scope can TEND the plan it mints, not just mint it (RUN-69): update_plan is what the
  // server's own playbook instructs, and the dependency pair prunes the artifact edges that
  // enforced phase ordering creates — a live scope run had to raise_alert and hand a human
  // five edges to cut because this floor said no. Safe because the RUN-23 gate still holds:
  // plans arrive PROPOSED and a human approves them after the tidying. Still excluded, on
  // purpose: create_task/decompose_task (mint claimable work outside the proposed-plan gate)
  // and claim/release (scope plans, never executes). spin_off_task (RUN-188, granted to
  // build/verify below) also stays out of scope's floor — not for the gate's reason, but
  // because scope's product IS a proposed plan: work a scope run surfaces belongs in the plan
  // it is already minting, not filed beside it.
  scope: [
    'set_agent_identity',
    'get_briefing',
    'get_task',
    'get_plans',
    'create_plan',
    'update_plan',
    'add_dependency',
    'remove_dependency',
  ],
  // No release_task (RUN-83): a build agent claims its anchor task (→ in_progress) and works,
  // but it does NOT move the task onward — the RUN's terminal outcome does, server-side. The
  // agent used to call release_task(review) when it finished, which happened BEFORE the daemon's
  // verify/reviewer gate ran; a gate FAILURE then left the task stranded in `review`,
  // indistinguishable from work genuinely awaiting a human. Now the task stays in_progress
  // through the gate and transitionRun sets it: gate passed → review, gate failed → failed.
  build: [
    'set_agent_identity',
    'get_briefing',
    'get_task',
    'claim_task',
    'post_comment',
    'read_open_comments',
    'resolve_comment',
    'attach_ref',
    'update_task',
    // File locking (RUN-97..107, granted at RUN-177) — and ONLY the acquire half, deliberately.
    //
    // The daemon takes locks AS the run's agent: the reactive per-edit hook and the hard floor
    // before landing both authenticate with the run's token. Without this the daemon is refused by
    // a floor it declared itself, which is what gated two finished builds on the first live
    // dispatch — the floor could not complete, reported `unchecked`, and failed runs that had done
    // nothing wrong.
    //
    // `release_lock` and `list_locks` stay OUT, and the reason is the whole design. Since RUN-47
    // the floor IS the advertised catalogue, so anything the daemon may call, the agent may call —
    // they are one identity. Granting release would let the agent drop the very locks the hard
    // floor took, mid-run, before landing: RUN-105 holds those locks THROUGH the
    // rebase→verify→fast-forward precisely so a peer cannot take a file mid-merge, and an agent
    // that can release them makes that guarantee something the agent may opt out of. The daemon
    // loses nothing it needs — the server already releases a task-anchored run's locks when the
    // run settles (`releaseLocksForTask`, "run settled: <outcome>"), on any status change off
    // in_progress, and on claim TTL. Its own terminal release was always documented as
    // promptness, never correctness; it now no-ops, and the server does the work.
    //
    // `check_locks` stays out because nothing in the daemon calls it on this path.
    //
    // What this does still hand a build agent is the ability to acquire broadly — `paths: ["**"]`
    // would block cooperating peers for the run's life. That is unavoidable while daemon and agent
    // share one identity, and it is bounded by run-settle and TTL rather than indefinite.
    'acquire_lock',
    // Spinning work off instead of absorbing or arguing it (RUN-188). When a run surfaces work
    // that is real but not THIS task's — a hardening gap, a missing seam, a follow-up — its only
    // moves were absorb it (scope creep), contest it (prose), or eat the FAIL. RUN-186's landing
    // run took the honest path — contested with evidence, raised an evidence-backed alert with a
    // full design sketch — and still failed, because an alert records a concern and creates no
    // work a gate can point at; a human had to fold it into a task BY HAND. This tool is that
    // manual step made first-class, and it does NOT reopen the hole the exclusion above guards:
    // its product is a PROPOSED task — on the board, carrying provenance (source task, source
    // run, the finding) — but not claimable and not pumpable until a human accepts it, the same
    // RUN-23 gate that keeps create_task off every floor. Distinct from raise_alert on purpose:
    // an alert is a concern that is NOT work; a spin-off is work that is not mine.
    //
    // What the grant still hands a hostile or lazy agent: volume — ten spin-offs to dodge ten
    // findings. Each is inert until a human touches it, and a spin-off offered against a finding
    // clears nothing by itself: the reviewer adjudicates every such pointer, and a criterion the
    // diff owed cannot be spun off.
    'spin_off_task',
  ],
  verify: [
    'set_agent_identity',
    'get_briefing',
    'get_task',
    'get_plans',
    'post_comment',
    'read_open_comments',
    // Same grant, same gate as build's (RUN-188): the verifier is the actor most likely to
    // SURFACE work that is real but out of this diff's scope, and raise_alert (concern-not-work)
    // was its only channel. The product stays a PROPOSED task a human gates, so the grant does
    // not let the reviewer MOVE the work it is judging — the line this floor exists to hold.
    'spin_off_task',
  ],
};

/** The BARE Noriq tool names a kind may call — its curated job, the ability to reach a human,
 *  and the ability to stay alive. Drivers add their own prefixes/config shape, and the daemon
 *  declares this same list to the server at run-agent creation (RUN-47); the policy is
 *  driver-neutral. */
export const noriqToolNamesFor = (kind: RunKind): string[] => [
  ...new Set([...(NORIQ_TOOLS[kind] ?? []), ...REACH_A_HUMAN, ...STAY_ALIVE]),
];
