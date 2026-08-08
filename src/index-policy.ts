import type { IndexSpec } from '@noriq-dev/shared';
import { z } from 'zod';
import { logger as defaultLogger } from './logger';

/**
 * The runner-owned half of `[index]` (RUN-208, Project Memory §7).
 *
 * The vendored `IndexSpec` (`vendor/noriq-shared/src/manifest.ts`) owns exactly three keys —
 * `enabled`, `include`, `exclude` — and its own comment draws the line: "Execution semantics
 * (parser selection, the non-overridable sensitive-file deny list, batching) belong to the
 * Runner indexer that reads this, not to this schema." This file is that half: the EXECUTION
 * knobs (languages, content mode, bounds, reindex cadence), parsed from the RAW `[index]` table
 * rather than added to the vendored schema — VENDORED-CONTRACT.md's rule that a field the daemon
 * reads for POSTURE is authoritative on the daemon, never on the wire. None of these knobs cross
 * the wire; a later phase that needs one to cross promotes it to shared THEN.
 *
 * `resolveIndexConfig` is the merge point: vendored `enabled`/`include`/`exclude` (read verbatim
 * — decision: do not redefine them) plus this schema's knobs, into one config later phases
 * (RUN-209's indexer) consume. It is deliberately NOT cached anywhere by this module — re-parse
 * per call, the same "no restart needed" contract `ManifestStore` gives the rest of the marker
 * (see `loadIndexConfig` in `discovery.ts`, the re-readable entry point).
 */

/**
 * The settled initial language set (discretion, RUN-208). An unknown name REFUSES rather than
 * warns: `languages` feeds a per-language parser selection later (Phase 3), and a typo'd name
 * silently ignored there would index nothing for that language while looking configured — the
 * same "policy reads as a control and isn't" failure this task's other refusals exist to avoid.
 */
export const INDEX_LANGUAGES = ['typescript', 'javascript', 'markdown', 'json', 'toml'] as const;
const IndexLanguage = z.enum(INDEX_LANGUAGES);
export type IndexLanguage = z.infer<typeof IndexLanguage>;

/**
 * `full` stores the read file content (bounded by the size knobs below) for later phases to
 * parse; `metadata` records only path/language/symbol facts, never raw source text — the opt-down
 * for a repo willing to be indexed but unwilling to have its source text land in the memory
 * store. Default `full`: the opt-in is `[index].enabled`, so a repo that reached this knob at all
 * has already decided its content may be read — the useful default for a code-search graph.
 */
export const IndexContentMode = z.enum(['full', 'metadata']);
export type IndexContentMode = z.infer<typeof IndexContentMode>;

/**
 * The EXECUTION knobs this daemon owns (decision 2/3) — parsed strictly, so a typo'd key (e.g.
 * `maxFileByte`) is a visible refusal rather than a silently-ignored table entry. `enabled` /
 * `include` / `exclude` are deliberately absent from this schema: they are the vendored
 * `IndexSpec`'s fields, stripped out of the raw table BEFORE it reaches this parse (see
 * `resolveIndexConfig`) so this schema never has to re-validate — or accidentally narrow — what
 * the wire contract already owns.
 */
export const IndexPolicy = z
  .object({
    languages: z.array(IndexLanguage).default([...INDEX_LANGUAGES]),
    contentMode: IndexContentMode.default('full'),
    // Bounds a large monorepo without truncating an ordinary repo: most repos are well under
    // 20k files once non-source dirs (node_modules, dist, .git) and the language filter apply.
    maxFiles: z.number().int().positive().default(20_000),
    // Excludes generated/minified/binary-shaped files without excluding ordinary source — 1 MB
    // is generous for hand-written code and stingy for a bundled asset or a data dump.
    maxFileBytes: z.number().int().positive().default(1_000_000),
    // A second, AGGREGATE bound: maxFiles × maxFileBytes could still total several GB for a huge
    // repo of medium files, so this caps the whole pass independently of the per-file limit.
    maxTotalBytes: z.number().int().positive().default(500_000_000),
    // Wall-clock ceiling on one indexing pass, so a slow or huge filesystem walk cannot hang the
    // daemon indefinitely — 2 minutes covers an ordinary repo with room to spare.
    readDeadlineMs: z.number().int().positive().default(120_000),
    // Reindex poll cadence — PARSED ONLY here (Phase 4 owns scheduling on it). Hourly is frequent
    // enough that a repo's index does not go stale for a working day, without polling a
    // filesystem that, per repo, changes far less often than that.
    pollIntervalMinutes: z.number().int().positive().default(60),
  })
  .strict();
export type IndexPolicy = z.infer<typeof IndexPolicy>;

/** The merged, ready-to-consume shape: the vendored scope (`include`/`exclude`) beside this
 *  daemon's execution knobs. Never returned unless indexing is actually ON for this repo. */
export type ResolvedIndexConfig = IndexPolicy & {
  include: string[];
  exclude: string[];
};

const VENDOR_OWNED_KEYS = new Set(['enabled', 'include', 'exclude']);

function isAbsoluteGlob(glob: string): boolean {
  // POSIX absolute, or a Windows drive-rooted path (`C:\…`, `C:/…`) — this daemon already
  // requires git and runs on both, so both spellings are checked.
  return glob.startsWith('/') || /^[A-Za-z]:[\\/]/.test(glob);
}

/** True if walking `glob`'s segments (wildcards count as ordinary descents) would climb above
 *  the root at any point — `../secrets/**` refuses, `src/../lib/**` does not (still inside). */
function globEscapesRoot(glob: string): boolean {
  let depth = 0;
  for (const seg of glob.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      depth += 1;
    }
  }
  return false;
}

/**
 * Why an `[index].include`/`.exclude` glob is refused, or null when it is fine (RUN-208).
 *
 * The vendored `IndexSpec` validates only that these are non-empty strings — confinement to the
 * repository root is this daemon's own concern, the same split `openConfined` (repo-context.ts)
 * already draws for `[context]` paths: a committed glob naming `../../.ssh/**` or `/etc/**` is a
 * repo asking this daemon to read outside the checkout it was pointed at, and the answer is no.
 * This is confinement only, deliberately — NOT the sensitive-file deny list (RUN-209's own).
 */
export function refuseIndexGlob(glob: string): string | null {
  if (isAbsoluteGlob(glob)) return `must be relative to the repository root, not absolute: "${glob}"`;
  if (globEscapesRoot(glob)) return `escapes the repository root via "..": "${glob}"`;
  return null;
}

/**
 * Merge the vendored `IndexSpec` (`enabled`/`include`/`exclude`, read verbatim — decision: never
 * redefined here) with this daemon's own execution policy, parsed from the RAW `[index]` table.
 *
 * Returns null — indexing OFF for this repo — on every invalid path: not explicitly enabled
 * (decision 4: no inference, no default-on, present-but-empty still off), an unparseable policy
 * table (bad bound, unknown key, non-numeric cadence — decision 5), or an include/exclude glob
 * that escapes the root. Every refusal is an `error`-level log naming the offending key, and NONE
 * of them touch `manifest`/`readManifest` — a typo in an index bound must not take a repo's whole
 * dispatch path down with it (decision 5). Indexing is an enrichment; the run path is the product.
 */
export function resolveIndexConfig(
  manifestIndex: IndexSpec | null,
  rawIndexTable: unknown,
  log: Pick<typeof defaultLogger, 'error'> = defaultLogger,
): ResolvedIndexConfig | null {
  if (!manifestIndex?.enabled) return null;

  const table =
    rawIndexTable && typeof rawIndexTable === 'object' ? (rawIndexTable as Record<string, unknown>) : {};
  // Strip the vendor-owned keys before parsing: they are already validated by `IndexSpec` (as
  // part of `ProjectManifest.safeParse`), and re-typing them here would be exactly the
  // redefinition decision 2 forbids. What is left is this schema's own EXECUTION knobs, parsed
  // `.strict()` so a typo (`maxFileByte`) surfaces as a refusal instead of silently vanishing.
  const policyRaw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table)) {
    if (!VENDOR_OWNED_KEYS.has(key)) policyRaw[key] = value;
  }
  const parsedPolicy = IndexPolicy.safeParse(policyRaw);
  if (!parsedPolicy.success) {
    const issue = parsedPolicy.error.issues[0];
    log.error('project.toml [index] policy is invalid — indexing is OFF for this repo until it is fixed', {
      key: issue?.path.join('.') || '(index table)',
      reason: issue?.message ?? 'invalid [index] table',
    });
    return null;
  }

  for (const field of ['include', 'exclude'] as const) {
    for (const glob of manifestIndex[field]) {
      const reason = refuseIndexGlob(glob);
      if (reason) {
        log.error(`project.toml [index].${field} is invalid — indexing is OFF for this repo`, {
          field,
          glob,
          reason,
        });
        return null;
      }
    }
  }

  return {
    ...parsedPolicy.data,
    include: manifestIndex.include,
    exclude: manifestIndex.exclude,
  };
}
