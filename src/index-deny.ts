/**
 * The non-overridable sensitive-file deny list (RUN-209, Project Memory §5/§7).
 *
 * A committed `.noriq/project.toml` may declare `[index].include`/`.exclude`, and RUN-208 already
 * confines those globs to the repository root — but confinement to the repo says nothing about
 * WHAT inside the repo a committed file may point the indexer at. `[index]` is still committed,
 * untrusted-in-intent input, exactly like `[context]`'s paths (THREAT-MODEL.md: "Committed context
 * or workflow config turns the daemon into an arbitrary-file-read primitive"). This module reads
 * bytes that later phases ship to a SERVER — a wider consequence than `[context]`'s prompt
 * inlining that motivated `openConfined` (RUN-151): a leaked secret here does not stay on the
 * operator's own box.
 *
 * So this list is deliberately not just another exclude default. `index-scan.ts` runs it as a
 * SEPARATE, LAST filter stage — after `include`/`exclude`, never before (see that file's pipeline
 * comment) — with no override input at all. An `include` glob naming `**\/.env*` or `**\/*` cannot
 * re-admit anything here, because nothing this module reads ever consults the manifest to ask
 * whether it was wanted anyway.
 *
 * Split into its own file on purpose, per RUN-209's execution spec: a reviewer asking "can a repo
 * make this daemon ship its own secrets" should be able to read THIS file top to bottom and be
 * done, rather than reconstruct the answer from the walker's control flow.
 *
 * Matching rules (locked, RUN-209 decision 3):
 *   - The repository-RELATIVE path, separators normalised to `/` — never the host's `path.sep`.
 *     `repo-context.ts`'s `repoRelative` draws the same line for the same reason: this is a
 *     CONTRACT shape, not a display one.
 *   - Case-INSENSITIVE. `.ENV` slipping past a case-sensitive check on macOS or Windows (both
 *     case-insensitive filesystems by default) is a real bypass, not a theoretical one.
 *   - Directory denies (`.ssh/`, `.git/`, …) match against EVERY path segment, not only the
 *     first — `foo/.ssh/id_rsa` is denied exactly like `.ssh/id_rsa`. A repo does not get to
 *     relocate a credential directory one level down and out from under a root-only check.
 *   - This is a FLOOR, not a ceiling: extend it when a new category turns up, never remove an
 *     entry so a repo's index can cover more.
 *
 * `.noriq/project.toml` and `.noriq/workflows/*.toml` are DELIBERATELY not denied — they are
 * committed configuration this daemon already reads and trusts elsewhere (`ManifestStore`,
 * `WorkflowStore`), not secrets. Denying them here would not add safety, only inconsistency with
 * every other reader of the same files. That is why `.noriq/` itself is not a denied directory —
 * only the two specific files under it that actually hold daemon state are.
 */

/**
 * Directory names that deny everything reachable through them, checked against every path
 * segment (see the module comment). `index-scan.ts` also uses this set to PRUNE the walk itself:
 * once a directory's own relative path is denied, nothing under it can ever be admitted, so there
 * is no reason to enumerate its contents just to deny each file inside one at a time.
 */
const DENIED_DIR_SEGMENTS = new Set([
  // VCS internals — a working copy's own history/index, never source the repo intends to ship for
  // indexing. `.git` alone can hold more than the visible tree: stashes, reflogs, unpacked blobs
  // from a branch nobody has checked out.
  '.git',
  '.hg',
  '.svn',
  '.p4root', // Perforce server-side metadata root, when a client maps one locally.
  // Diversion has no LOCAL metadata directory this codebase's own detection (`vcs/detect.ts`)
  // relies on — it registers workspaces server-side via `dv repo-list`, not a checked-in marker.
  // Denied anyway: the list is a floor, and a future Diversion layout that DOES drop a local
  // directory should not have to wait on a second task to be covered.
  '.diversion',
  // Credential directories a repo's own tooling — or an operator's careless `cp -r ~/.ssh repo/`
  // — can leave inside a working copy. Segment-matched so `tools/.aws/credentials` is denied too.
  '.ssh',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  // A `secrets/` directory holds what its name says regardless of what its individual files are
  // called — the `secrets*` basename pattern below only catches a file NAMED that way, and a repo
  // keeping `secrets/db.txt` should not need every file inside to also spell "secrets".
  'secrets',
]);

/** Basename patterns, checked against the FINAL path segment only (case-insensitive — the
 *  segments feeding this are already lower-cased by `isDeniedIndexPath`). */
const DENIED_BASENAME_PATTERNS: RegExp[] = [
  // dotenv files: `.env`, `.env.local`, `.env.production`, … — the single most common
  // secret-bearing file this daemon will ever walk past.
  /^\.env(\..+)?$/i,
  // SSH private keys AND their `.pub` siblings. Over-denying the public half is the safe
  // direction: a false refusal costs an index nothing it needed; a false admission costs a key.
  /^id_(rsa|ed25519|ecdsa|dsa)(\..*)?$/i,
  // Key/cert material by extension. Content-sniffing a `.pem` to see if it is "really" secret is
  // not a distinction worth drawing — the extension already answers what the file is FOR.
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  // Shell/package-manager credential files — plaintext tokens by design, not by accident.
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  // Perforce's local config file. Not always a secret by itself, but it names server/user
  // topology, and the list is a floor.
  /^\.p4config$/i,
  // The daemon's own state shape, and anything a repo happens to carry that looks like it.
  // `.noriq/credentials.json` is covered by THIS pattern already — it is not repeated in the
  // exact-tail list below, to avoid asserting the same fact twice in two places.
  /^credentials.*\.json$/i,
  /^secrets.*/i,
];

/**
 * Exact repo-relative TAILS (final two segments) — for entries that are one specific file inside
 * an otherwise-legitimate, NOT-denied directory. `.noriq/` itself is not a denied directory (see
 * the module comment), so the files that actually hold daemon secrets have to be named precisely.
 */
const DENIED_EXACT_TAILS = new Set([
  '.docker/config.json', // holds registry auth tokens, sometimes plaintext.
  '.noriq/parked-runs.json', // may embed a park's bound session state.
]);

function segmentsOf(relPath: string): string[] {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.');
}

/**
 * Why a repository-relative path is denied, or `null` when it is fine.
 *
 * Deliberately takes no `include`/`exclude` input of any kind — see the module comment for why an
 * override parameter here would defeat the entire point of a NON-overridable list.
 */
export function isDeniedIndexPath(relPath: string): string | null {
  const segs = segmentsOf(relPath).map((s) => s.toLowerCase());
  if (segs.length === 0) return null;

  for (const seg of segs) {
    if (DENIED_DIR_SEGMENTS.has(seg)) return `inside a denied directory: ${seg}/`;
  }

  const basename = segs[segs.length - 1]!;
  for (const pattern of DENIED_BASENAME_PATTERNS) {
    if (pattern.test(basename)) return `matches a denied filename pattern (${pattern.source})`;
  }

  if (segs.length >= 2) {
    const tail = segs.slice(-2).join('/');
    if (DENIED_EXACT_TAILS.has(tail)) return `denied path: ${tail}`;
  }

  return null;
}
