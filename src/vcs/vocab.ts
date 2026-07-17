import type { VcsDetection } from './detect';

/**
 * The words a human-facing SETUP surface (init-project) uses to describe what a backend does
 * (RUN-84). The VcsBackend seam (types.ts) names the daemon's OPERATIONS backend-neutrally —
 * `integrate`, `publish`, `share` — and that is right for code. But the wizard has to speak to a
 * person, and a person on Diversion does not have a "rebase", does not "push to a remote", and
 * does not `git commit`. Detection (`detectVcs`) already knows which backend owns the repo; this
 * table turns that `kind` into the vocabulary the setup copy needs, so init-project carries no
 * `if (kind === 'diversion')` ladder and every backend's phrasing lives in ONE place.
 *
 * This is a LEXICON, not behavior: pure data, no I/O. The manifest it helps write is still
 * backend-neutral — these words only change what the operator reads while choosing.
 */

export type VcsKind = VcsDetection['kind'];

export interface VcsVocab {
  kind: VcsKind;
  /** For prose: the backend's proper name. */
  label: string;
  /**
   * The unit of work a landing writes to — git/Diversion "branch", Perforce "stream". Used
   * where the wizard says "this repo lands only at <target>" and "<Target> globs a dispatch may
   * land on".
   */
  targetNoun: string;
  /**
   * How `integrate`'s result reads to a human: git "rebased", the server-backed backends
   * "merged" (they have no rebase — `integrate` merges the target in, VCS-SPIKE §2). The [land]
   * gate question ("verify passes on the <integrated> result") and its rendered comment.
   */
  integratedAdj: string;
  /** The conflict flavour the build agent might resolve: git "rebase", the others "merge". */
  conflictAdj: string;
  /**
   * Can the build agent resolve a landing conflict at all? Git edits files in the worktree and
   * Perforce runs `p4 resolve` headless (both measured, git.ts / perforce.ts), so both true.
   * Diversion's conflicts live SERVER-SIDE and come back as a `resolveUrl`, never editable paths
   * (types.ts IntegrateResult, diversion.ts) — so its answer is false and the wizard must not
   * offer the agent a job it cannot do.
   */
  agentResolvesConflicts: boolean;
  /**
   * Does landing leave work on a REMOTE a separate publish step must reach (git), or did
   * publishing already reach the server (Diversion/Perforce, where `share` is a no-op —
   * diversion.ts / perforce.ts)? This is the RUN-27 boundary: on git, `autoPush` crosses it and
   * is the whole point of the question; on a server-backed VCS the crossing happened on the
   * first write (the same fact the top-of-flow Diversion warning states), so there is no
   * separate push to opt into — the wizard drops the git-only autoPush/merge-request tail.
   */
  landingReachesRemote: boolean;
  /**
   * The "what did the agents do since the last landing?" command, meaningful only while landings
   * stay local to this machine (git). Absent on server-backed backends: there is no local-vs-
   * server gap to diff, so naming one would teach a check that always comes back empty.
   */
  auditHint?: string;
  /** A paste-ready command line that commits the freshly-written marker in this backend's CLI. */
  commitMarker: (relPath: string) => string;
}

const COMMIT_MSG = 'Add Noriq marker';

/**
 * One entry per backend `detectVcs` can return. Every string here was grounded in what the
 * matching VcsBackend actually runs — the commitMarker verbs mirror each backend's `checkpoint`
 * (git commit / dv commit -a / p4 add+submit), so the setup copy and the daemon agree.
 */
export const VCS_VOCAB: Record<VcsKind, VcsVocab> = {
  git: {
    kind: 'git',
    label: 'git',
    targetNoun: 'branch',
    integratedAdj: 'rebased',
    conflictAdj: 'rebase',
    agentResolvesConflicts: true,
    landingReachesRemote: true,
    auditHint: 'git log origin/main..main',
    commitMarker: (p) => `git add ${p} && git commit -m "${COMMIT_MSG}"`,
  },
  diversion: {
    kind: 'diversion',
    label: 'Diversion',
    targetNoun: 'branch',
    integratedAdj: 'merged',
    conflictAdj: 'merge',
    agentResolvesConflicts: false,
    landingReachesRemote: false,
    // dv syncs the whole workspace continuously; `dv commit -a` records the reviewable commit
    // (diversion.ts checkpoint), so the new marker rides along without a separate add.
    commitMarker: () => `dv commit -a -m "${COMMIT_MSG}"`,
  },
  perforce: {
    kind: 'perforce',
    label: 'Perforce',
    targetNoun: 'stream',
    integratedAdj: 'merged',
    conflictAdj: 'merge',
    agentResolvesConflicts: true,
    landingReachesRemote: false,
    commitMarker: (p) => `p4 add ${p} && p4 submit -d "${COMMIT_MSG}"`,
  },
};

/** The lexicon for a detected backend, defaulting to git — the same fallback `detectVcs` makes
 *  when it cannot prove otherwise, so an undetected repo reads exactly as it did before RUN-84. */
export const vocabFor = (kind: VcsKind | undefined): VcsVocab => VCS_VOCAB[kind ?? 'git'];
