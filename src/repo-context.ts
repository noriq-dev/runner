import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectContext } from '@noriq-dev/shared';

/**
 * `[context]` (RUN-128) — the repo's own orientation, resolved off disk and rendered into the
 * brief. Until now a build agent's prompt carried the task and nothing else, so every run
 * re-derived the same facts about the repo and derived them slightly differently each time.
 *
 * Two rules govern what a committed manifest may point the daemon at:
 *
 *   1. **Confinement.** A declared path is resolved against the repo root and must stay inside
 *      it. `.noriq/project.toml` is committed and travels — a repo naming `../../.ssh/id_rsa`
 *      is asking the daemon to read outside the checkout it was invited into, and a symlink
 *      pointing out is the same request wearing a hat, so both are refused. RUN-129 inlines
 *      these files' CONTENTS into the prompt, which is what makes this a boundary rather than
 *      tidiness: without it, a committed marker becomes an arbitrary-file-read primitive
 *      against the operator's box.
 *   2. **No silent drops.** A path that does not resolve is REPORTED. A required-reading list
 *      that quietly shrinks to nothing is worse than one that was never configured: the repo
 *      believes its agents are oriented, and nothing says otherwise.
 */

/** Why a declared path did not make it into the brief. */
export type ContextRejection = 'outside-repo' | 'missing';

export interface UnresolvedPath {
  /** As written in the manifest — what an operator has to go and fix. */
  declared: string;
  reason: ContextRejection;
}

export interface ResolvedRepoContext {
  /** Repo-relative, existing, confined. Order is the manifest's — it encodes priority. */
  requiredReading: string[];
  entryPoints: string[];
  conventions: string[];
  unresolved: UnresolvedPath[];
}

/** Existence probe, injected so tests never touch a real tree (the `GitRunner`/`VerifyExec`
 *  convention). Resolves true iff the absolute path exists AND stays inside the repo once
 *  symlinks are followed. */
export type PathProbe = (absPath: string, root: string) => Promise<boolean | ContextRejection>;

const contains = (root: string, abs: string): boolean => {
  const rel = path.relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * The real probe. `stat` (not `lstat`) follows symlinks on purpose — then the RESOLVED target is
 * re-checked against the root, so an in-repo symlink pointing at `/etc/shadow` is refused rather
 * than followed. A path that cannot be statted is simply missing.
 */
export const defaultPathProbe: PathProbe = async (abs, root) => {
  try {
    const s = await stat(abs);
    if (!s.isFile() && !s.isDirectory()) return 'missing';
    // `stat` already followed the link chain; resolve it explicitly and re-check containment,
    // so an in-repo symlink pointing outside is refused rather than silently followed.
    return contains(root, await realpath(abs)) ? true : 'outside-repo';
  } catch {
    return 'missing';
  }
};

async function resolveList(
  root: string,
  declared: string[],
  probe: PathProbe,
  unresolved: UnresolvedPath[],
): Promise<string[]> {
  const kept: string[] = [];
  for (const d of declared) {
    const abs = path.resolve(root, d);
    if (!contains(root, abs)) {
      unresolved.push({ declared: d, reason: 'outside-repo' });
      continue;
    }
    const ok = await probe(abs, root);
    if (ok === true) kept.push(path.relative(root, abs));
    else unresolved.push({ declared: d, reason: ok === false ? 'missing' : ok });
  }
  return kept;
}

/** Resolve a manifest's `[context]` against a repo root. Never throws: a broken declaration
 *  degrades the brief, it does not fail the run. */
export async function resolveRepoContext(
  root: string,
  ctx: ProjectContext | null | undefined,
  probe: PathProbe = defaultPathProbe,
): Promise<ResolvedRepoContext> {
  const unresolved: UnresolvedPath[] = [];
  if (!ctx) return { requiredReading: [], entryPoints: [], conventions: [], unresolved };
  return {
    requiredReading: await resolveList(root, ctx.requiredReading, probe, unresolved),
    entryPoints: await resolveList(root, ctx.entryPoints, probe, unresolved),
    // Conventions are the repo's own words, not paths — nothing to resolve, nothing to reject.
    conventions: ctx.conventions.filter((c) => c.trim() !== ''),
    unresolved,
  };
}

// ---------------------------------------------------------------------------
// Inlining the required reading (RUN-129)
// ---------------------------------------------------------------------------

/**
 * The conventional agent-instruction files, tried in order when a repo declares no
 * `requiredReading` of its own.
 *
 * Most marked repos already carry one of these, written precisely to steer a coding agent — and
 * the runner ignored them, so every agent it spawned worked from less than the repo had already
 * written down. Reading both regardless of driver stays neutral (README "stay agnostic"): these
 * are the REPO's instructions, not a driver feature. A repo that wants something else says so in
 * `[context].requiredReading`, which always wins.
 */
export const AGENT_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

/**
 * Total characters of inlined documentation allowed into one brief.
 *
 * A budget rather than a cap per file, because the failure being prevented is crowding out the
 * task: a repo with a 100KB instructions file would otherwise push the actual brief past the
 * point where a model reliably attends to it. Deliberately NOT a manifest knob — a default that
 * holds is worth more than a dial nobody tunes, and the escape hatch (order `requiredReading` by
 * priority) already exists.
 */
export const CONTEXT_BUDGET_CHARS = 16_000;

export interface InlinedDoc {
  /** Repo-relative, as it will be labelled in the brief. */
  path: string;
  text: string;
  /** Set when the budget cut this file short — surfaced in the brief, never silent. The original
   *  size is deliberately NOT recorded: the reader stops at the budget, so it was never measured,
   *  and a number we did not measure is worse than no number. */
  truncated?: boolean;
}

export interface LoadedRepoDocs {
  docs: InlinedDoc[];
  /** Declared and resolvable, but the budget was already spent. Named in the brief so the agent
   *  knows to read them itself rather than assuming they did not exist. */
  skipped: string[];
}

/**
 * Reads at most `limit` characters of a file. The limit is part of the CONTRACT, not a courtesy:
 * a committed marker names these paths, so reading a file whole and truncating afterwards lets any
 * repo hand the daemon a multi-gigabyte in-repo file and stall or OOM it before a single budget
 * character is spent. Injected so tests never touch a real tree.
 */
export type DocReader = (absPath: string, limit: number) => Promise<string>;

/**
 * `limit` is in CHARACTERS, and the byte/character distinction is the whole subtlety here.
 *
 * Reading `limit + 1` BYTES and comparing the decoded length is wrong the moment a file is not
 * pure ASCII: this repo's own docs are full of em dashes, so 6191 bytes decode to 6167 characters,
 * land under the limit, and a plainly truncated document gets reported as complete — the exact
 * "you have the whole rule" lie this budget exists to avoid. Caught by dogfooding, not by tests.
 *
 * UTF-8 is at most 4 bytes per character, so reading `4 * (limit + 1)` bytes guarantees that a
 * file with more than `limit` characters decodes to more than `limit` — which is all the caller
 * needs to detect the cut. Memory stays bounded at four times the budget.
 */
export const defaultDocReader: DocReader = async (abs, limit) => {
  const want = (limit + 1) * 4;
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(want);
    // LOOP. `read()` may return fewer bytes than asked for without being at EOF, and treating a
    // short read as EOF is how a fragment gets reported as a complete document — the same lie the
    // byte/character bug produced, reached by a different route.
    let filled = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, filled, want - filled, filled);
      if (bytesRead === 0) break; // genuine EOF
      filled += bytesRead;
      if (filled >= want) break;
    }
    // A trailing partial character at the buffer edge decodes to U+FFFD; harmless, since anything
    // near the edge is beyond `limit` and gets sliced away by the caller anyway.
    return buf.subarray(0, filled).toString('utf8');
  } finally {
    await fh.close();
  }
};

/** Cut to `n` UTF-16 units without severing a surrogate pair — slicing an emoji in half emits a
 *  lone surrogate, which is a malformed character in the prompt rather than a shortened one. */
const sliceWhole = (s: string, n: number): string => {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  // A high surrogate in the last kept position means its partner is the first dropped one.
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
};

/** The conventional instruction files this repo actually has. Only consulted when the manifest
 *  declared no `requiredReading` — an explicit list is never silently extended. */
export async function discoverAgentInstructions(
  root: string,
  probe: PathProbe = defaultPathProbe,
): Promise<string[]> {
  const found: string[] = [];
  for (const name of AGENT_INSTRUCTION_FILES) {
    if ((await probe(path.resolve(root, name), root)) === true) found.push(name);
  }
  return found;
}

/**
 * Read the required reading into the brief, in priority order, until the budget is spent.
 *
 * Files are consumed in the order the manifest listed them, so a repo controls what survives
 * truncation by ordering its list. The file that crosses the line is cut and MARKED; everything
 * after it is skipped and named. Silence in either case would be the worst outcome: an agent that
 * believes it has read a document it only received half of will confidently apply half a rule.
 */
export async function loadRepoDocs(
  root: string,
  relPaths: string[],
  read: DocReader = defaultDocReader,
  budget = CONTEXT_BUDGET_CHARS,
): Promise<LoadedRepoDocs> {
  const docs: InlinedDoc[] = [];
  const skipped: string[] = [];
  let left = budget;

  for (const rel of relPaths) {
    if (left <= 0) {
      skipped.push(rel);
      continue;
    }
    const abs = path.resolve(root, rel);
    // Confine HERE too, not only at probe time. `resolveRepoContext` checks a path and this opens
    // it — two operations, so the check does not bind the open. This is also the public entry
    // point (it is exported), and an unconfined exported reader is a footgun regardless of who
    // calls it. It does not close the TOCTOU race on its own; it closes the lexical hole.
    if (!contains(root, abs)) {
      skipped.push(rel);
      continue;
    }
    let text: string;
    try {
      text = await read(abs, left);
    } catch {
      // Resolvable at probe time, unreadable now (permissions, a race with a checkout). Treat it
      // as skipped rather than failing the run — a brief missing one document still works.
      skipped.push(rel);
      continue;
    }
    if (text.length <= left) {
      docs.push({ path: rel, text });
      left -= text.length;
    } else {
      // The reader returns at most `left + 1`, so a longer result means the file was cut. We know
      // it was cut but NOT how big it actually is — and claiming a size we did not measure would
      // be worse than not naming one.
      docs.push({ path: rel, text: sliceWhole(text, left), truncated: true });
      left = 0;
    }
  }
  return { docs, skipped };
}

/**
 * Render the resolved context as the brief's orientation block. Empty when the repo declared
 * nothing AND no instruction file was discovered. Note that a marker without `[context]` is NOT
 * automatically silent: `loadRepoContext` falls back to the repo's CLAUDE.md / AGENTS.md, which is
 * the point of RUN-129. Silence requires a repo that declares nothing and carries neither file.
 *
 * Inlined documents come LAST within the block and the brief follows them, which is the shape
 * long-context models attend to best: bulk reference first, the actual ask last.
 */
export function renderRepoContext(c: ResolvedRepoContext, loaded?: LoadedRepoDocs): string {
  const lines: string[] = [];
  if (c.entryPoints.length) lines.push(`Start here: ${c.entryPoints.join(', ')}`);
  if (c.conventions.length) lines.push(`Conventions (non-negotiable): ${c.conventions.join('; ')}`);

  const inlined = loaded?.docs ?? [];
  // Suppress the NAME only of a file reproduced IN FULL — naming that invites a wasted tool call.
  // A TRUNCATED file is the opposite case: the agent holds a fragment, and unless it is told to go
  // and read the rest it will apply half a rule believing it read the whole one.
  const whole = new Set(inlined.filter((d) => !d.truncated).map((d) => d.path));
  const named = c.requiredReading.filter((p) => !whole.has(p));
  if (named.length) lines.push(`Read before changing anything: ${named.join(', ')}`);
  if (loaded?.skipped.length) {
    lines.push(`Declared reading not included below: ${loaded.skipped.join(', ')}`);
  }

  if (!lines.length && !inlined.length) return '';

  // Introduced as the REPO's claims rather than the daemon's: an agent that knows these came from
  // the committed marker weighs them correctly against what it finds in the code.
  let out = '\n\nThis repo says of itself:';
  if (lines.length) out += `\n${lines.map((l) => `- ${l}`).join('\n')}`;
  for (const d of inlined) {
    const mark = d.truncated ? ` (FIRST ${d.text.length} characters only — the rest was not read)` : '';
    out += `\n\n----- ${d.path}${mark} -----\n${d.text}`;
  }
  if (inlined.length) {
    out += '\n----- end of included files -----\n';
    // Two different instructions, because they are two different situations. Telling an agent not
    // to re-read a file it only half received is how a half-read rule gets applied with confidence.
    out += inlined.some((d) => d.truncated)
      ? 'The files above are complete unless marked otherwise — do not spend a turn re-reading a complete one. Any file marked as cut short is a FRAGMENT: read the rest yourself before relying on it.'
      : 'Those files are reproduced above in full — do not spend a turn re-reading them.';
  }
  return out;
}

/**
 * The single entry point the supervisor uses: resolve `[context]`, fall back to the repo's
 * conventional instruction files when it declared no reading of its own, and inline what fits.
 *
 * The fallback keys off what the manifest DECLARED, not off what survived resolution. A repo that
 * named three documents and typo'd all three has still made a choice, and quietly substituting
 * `CLAUDE.md` for it would be the silent-widening move this codebase refuses elsewhere — the
 * operator would see an oriented agent and never learn their list is broken (the warnings say so).
 */
export async function loadRepoContext(
  root: string,
  ctx: ProjectContext | null | undefined,
  deps: { probe?: PathProbe; read?: DocReader; budget?: number } = {},
): Promise<{ resolved: ResolvedRepoContext; loaded: LoadedRepoDocs; rendered: string }> {
  const resolved = await resolveRepoContext(root, ctx, deps.probe);
  const declaredReading = (ctx?.requiredReading?.length ?? 0) > 0;
  const reading = declaredReading
    ? resolved.requiredReading
    : await discoverAgentInstructions(root, deps.probe);
  const loaded = await loadRepoDocs(root, reading, deps.read, deps.budget);
  // A discovered file was never in `requiredReading`; surface it there so the block can name or
  // inline it under the same rules a declared one gets.
  const merged: ResolvedRepoContext = { ...resolved, requiredReading: reading };
  return { resolved: merged, loaded, rendered: renderRepoContext(merged, loaded) };
}
