import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { NOOP_ADAPTER } from './index-adapters';
import type { IndexAdapterRegistry, ParsedSymbol } from './index-adapters';
import { INDEX_LANGUAGES } from './index-policy';
import { buildIndexAdapterRegistry } from './index-registry';
import type {
  ContextPack,
  ContextPackCitation,
  ContextPackEpisodeExcerpt,
  ContextPackExcerpt,
  ContextPackMemoryExcerpt,
  ContextPackSection,
  VerificationState,
} from './memory-contract';
import { openConfined } from './repo-context';
import type { ChangesBetweenResult, VcsBackend, Workspace } from './vcs/types';

/**
 * RUN-229: the gate that makes RUN-228's silently-fetched `ContextPack` safe to show anyone.
 * Classifies every citation against the ACTUAL leased worktree — never against what the server
 * believed, and never on path existence alone — and attaches the verdict to the excerpt it backs,
 * so a renderer (RUN-230/231) cannot read one without the other. Zero model tokens: nothing in
 * this module's signature can reach a driver, and every read stays inside the leased workspace,
 * through the same confined-open floor `[context]`/`[index]` already use (`openConfined`,
 * RUN-151). Rendering, prompt insertion, and lead-demotion are RUN-230/231's job, not this one's.
 *
 * **The mechanism, not a content hash** (this task's own locked decision, verified before it was
 * written): `ContextPackCitation` carries no `contentHash` — the wire has nowhere to put one, and
 * the index does not upload per-file hashes either (a generation's `contentHash` covers the WHOLE
 * generation, `vendor/noriq-shared/src/memory.ts`). `VcsBackend.changesBetween` (RUN-212) answers
 * the real question directly: is the cited path in the change set between the citation's own base
 * and this workspace's — and per `ChangesBetweenResult`'s own locked decision 2, `{ok:true}` with
 * the path in NEITHER list is a real, distinct answer — byte-identical, not "could not tell".
 *
 * **`moved` is UNREACHABLE here, and this module never synthesizes it.** `ChangesBetweenResult`'s
 * own locked decision 3 decomposes a rename into a deletion of the old path plus a change at the
 * new one, deliberately — so a renamed citation arrives indistinguishable from a genuine deletion.
 * Reporting `moved` would mean guessing which new path a deleted citation became, a similarity
 * heuristic this layer has no business inventing. It reads `missing`, honestly, until a backend
 * carries a real rename signal this seam can pass through unchanged.
 *
 * **A citation naming a DIFFERENT repository is `unverifiable`, not silently skipped or run
 * against the wrong tree** — the locked decision list this task shipped with never named this
 * check, and it is not optional: `ContextPackCitation.repositoryKey` is per-citation, not
 * inherited from the request (a memory can cite evidence from a sibling repo in a multi-repo
 * project — measured against the server's own `evidence` rows, which carry `repositoryKey`
 * per-row). Handing a foreign citation's `path`/`baseId` to THIS workspace's `changesBetween`
 * would ask a real question of the wrong repository and could answer `valid` by coincidence (the
 * path happens to exist in both trees). Caught here, before any local read or VCS call.
 */

// ---------------------------------------------------------------------------
// The confined, bounded local read (locked decision 5: "the same posture `openConfined`
// establishes elsewhere" — reused, not reinvented).
// ---------------------------------------------------------------------------

/** A citation naming a file larger than this reads as PRESENT (existence still answers `missing`
 *  correctly) with its content withheld — generous for real source, bounded against a citation
 *  pointing at a committed multi-megabyte generated artifact. Only a SYMBOL claim about such a
 *  file is affected (demoted to `unverifiable`); a bare path citation needs no content at all. */
export const MAX_CITATION_READ_BYTES = 4 * 1024 * 1024;

export type CitationFileRead =
  | { kind: 'present'; content: string | null }
  | { kind: 'missing' }
  | { kind: 'refused'; reason: string };

/** Injected so tests never touch a real filesystem (the `GitRunner`/`VerifyExec` convention).
 *  `root` is the leased workspace's own `localPath`; `relPath` is the citation's own untrusted
 *  `path` — server-supplied text this daemon has no reason to trust (locked decision 5). */
export type CitationFileReader = (relPath: string, root: string) => Promise<CitationFileRead>;

/** Escaping is a whole `..` SEGMENT or an absolute path, not a `..`-prefixed filename —
 *  `repo-context.ts`'s own `escapes()` predicate, restated here rather than imported (that
 *  function is private to its module, and the two-line check is cheaper to restate than to widen
 *  a security-sensitive module's exports for one caller). */
function escapesWorkspace(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * The default reader: confined, bounded, never throws. A lexical out-of-bounds check runs BEFORE
 * any syscall — a citation path that resolves outside the workspace is refused without an `open`
 * ever being attempted, never merely "happened not to exist" (a `..`/absolute path that resolves
 * to something ABSENT must still read as refused, not as `missing`, so the two never collapse into
 * one indistinguishable outcome for a caller auditing this floor). `openConfined` then re-checks
 * containment by INODE identity (RUN-151) for everything the lexical check could not catch — a
 * symlink inside the repo pointing out.
 */
export const readCitationFile: CitationFileReader = async (relPath, root) => {
  const abs = path.resolve(root, relPath);
  if (escapesWorkspace(root, abs)) {
    return { kind: 'refused', reason: `citation path "${relPath}" resolves outside the leased workspace` };
  }
  let fh: FileHandle;
  try {
    fh = await openConfined(abs, root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT is the ordinary "not there" case; anything else — a containment/identity refusal
    // from `openConfined` itself, a symlink loop, EACCES, a non-regular file — is a REFUSAL, never
    // a guess at what the operator meant.
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'refused', reason: (err as Error).message };
  }
  try {
    const st = await fh.stat();
    if (st.size > MAX_CITATION_READ_BYTES) return { kind: 'present', content: null };
    const buf = await fh.readFile();
    return { kind: 'present', content: buf.toString('utf8') };
  } finally {
    await fh.close();
  }
};

// ---------------------------------------------------------------------------
// Symbol resolution — the SAME adapter registry the indexer uses (locked decision 4), never a
// fresh regex, so what counts as a declaration here cannot drift from what the index recorded.
// ---------------------------------------------------------------------------

/**
 * Every language `[index].languages` can ever admit, unconditionally — never the REPO's own
 * `[index]` config. Citation verification is not gated by whether (or how) this particular repo
 * opted into indexing: the citation already exists, which means SOME index run, on SOME machine,
 * extracted it with SOME language set — and using the full set here can only ever find symbols a
 * narrower production config also would have (never fewer), so it never manufactures a false
 * match a restricted indexer could not also have produced.
 */
function defaultAdapterRegistry(): IndexAdapterRegistry {
  return buildIndexAdapterRegistry({ languages: [...INDEX_LANGUAGES] }).registry;
}

/** A cited symbol matches a declaration by its LEAF name (`label`) or its full dot-joined nested
 *  path (`symbolPath.join('.')`, unencoded — `citation.symbol` is agent-authored free text via
 *  `record_memory`, never guaranteed to be the indexer's own percent-encoded `encodeSymbolPath`
 *  form, so matching the human-readable join is what actually corresponds to how a symbol gets
 *  cited in practice). Two declarations sharing a leaf name in one file (an overload, a nested
 *  class reusing an outer method name) collide on the FIRST rule and disambiguate only via the
 *  second — exactly the shape this task's acceptance means by "ambiguous". */
function matchesSymbol(symbol: ParsedSymbol, cited: string): boolean {
  return symbol.label === cited || symbol.symbolPath.join('.') === cited;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export interface CitationVerdict {
  /** This module's own, independently-computed classification. Never `moved` — see module doc. */
  state: VerificationState;
  /** Why, for logs and (RUN-230/231's) lead-demotion reasons — never shown to a model verbatim
   *  without going through that task's quoted-evidence frame; this is diagnostic text, not
   *  content a citation's own author wrote. */
  reason: string;
  /** The server's own `verificationState`, carried through UNCHANGED — recorded, never trusted as
   *  the answer (locked decision: "record them, then verify independently"). */
  serverState: VerificationState;
  /** Whether this module's independent verdict agrees with what the server already believed. A
   *  mismatch is not itself evidence of anything — it is what a caller building RUN-234's metrics
   *  would want to count without recomputing this comparison. */
  agreesWithServer: boolean;
}

export interface VerifiedCitation extends ContextPackCitation {
  verification: CitationVerdict;
}

/** A memory excerpt with its evidence array's citations replaced by their verified counterparts.
 *  An episode excerpt carries no `ContextPackCitation[]` at all — `support` is a differently-typed
 *  `{kind, detail}[]` describing overlap, not citations — so it passes through unchanged; there is
 *  nothing here for this module to verify. */
export type VerifiedContextPackExcerpt =
  | (Omit<ContextPackMemoryExcerpt, 'evidence'> & { evidence: VerifiedCitation[] })
  | ContextPackEpisodeExcerpt;

export interface VerifiedContextPackSection extends Omit<ContextPackSection, 'excerpts'> {
  excerpts: VerifiedContextPackExcerpt[];
}

/**
 * A `ContextPack` whose every memory excerpt's evidence is verified in place (locked decision:
 * "verdicts travel with the pack, and a consumer must not be able to read an excerpt without
 * them"). There is no separate verdict lookup to forget — `excerpt.evidence[i].verification` sits
 * on the exact object a renderer already has to walk to read `excerpt.evidence[i].path`.
 */
export interface VerifiedContextPack extends Omit<ContextPack, 'sections'> {
  sections: VerifiedContextPackSection[];
}

export interface CitationVerifyContext {
  /** The backend that leased THIS workspace — `changesBetween` only, the minimal seam this module
   *  needs (DI: never the whole `VcsBackend`, so a test double is three lines). */
  vcs: Pick<VcsBackend, 'changesBetween'>;
  /** Passed to `changesBetween` verbatim — the repo root the leasing backend already knows. */
  repoRoot: string;
  /** This run's own leased workspace — what every citation is verified AGAINST. */
  worktree: Pick<Workspace, 'baseId' | 'localPath'>;
  /** `repo.manifest.repositoryKey` — the canonical identity this workspace actually IS. Citations
   *  naming a different one are `unverifiable` by construction (see module doc); `null` on a repo
   *  with no canonical key, which also makes every citation `unverifiable` for the same reason
   *  (there is nothing here to compare against) — though in practice `retrieveContextPack` never
   *  fetches a pack for such a repo, so this arm is defensive, not load-bearing. */
  repositoryKey: string | null;
  /** Defaults to `readCitationFile` — override only in tests. */
  readFile?: CitationFileReader;
  /** Defaults to the full real adapter registry (`defaultAdapterRegistry`) — override in tests to
   *  avoid touching real tree-sitter WASM, or to pin a controlled symbol list. */
  adapters?: IndexAdapterRegistry;
}

function settle(citation: ContextPackCitation, state: VerificationState, reason: string): CitationVerdict {
  return {
    state,
    reason,
    serverState: citation.verificationState,
    agreesWithServer: state === citation.verificationState,
  };
}

/**
 * Classify one citation. The locked decision order, verbatim, with the repository-identity check
 * (module doc) inserted FIRST — before any local read or VCS call, since nothing past it means
 * anything for a citation about a different repo:
 *
 *   1. wrong repository            -> unverifiable
 *   2. path absent (current tree)  -> missing
 *   3. bases equal, path present   -> verify the symbol claim
 *   4. bases differ -> `changesBetween`:
 *        refuses                  -> unverifiable
 *        path in `deleted`        -> missing
 *        path in `changed`        -> changed
 *        in neither (byte-ident.) -> verify the symbol claim
 */
async function classifyCitation(
  citation: ContextPackCitation,
  ctx: CitationVerifyContext,
  lookups: {
    readCached: (relPath: string) => Promise<CitationFileRead>;
    symbolsFor: (relPath: string, content: string) => Promise<readonly ParsedSymbol[] | null>;
    changesBetweenCached: (from: string) => Promise<ChangesBetweenResult>;
  },
): Promise<CitationVerdict> {
  if (ctx.repositoryKey == null) {
    return settle(
      citation,
      'unverifiable',
      'this workspace has no canonical repositoryKey to verify citations against',
    );
  }
  if (citation.repositoryKey !== ctx.repositoryKey) {
    return settle(
      citation,
      'unverifiable',
      `citation cites repository "${citation.repositoryKey}", not this workspace's "${ctx.repositoryKey}" — a different repo's evidence cannot be checked against this checkout`,
    );
  }

  const local = await lookups.readCached(citation.path);
  if (local.kind === 'refused') return settle(citation, 'unverifiable', local.reason);
  if (local.kind === 'missing')
    return settle(citation, 'missing', 'path does not exist in the leased workspace');

  const symbolVerdict = async (): Promise<CitationVerdict> => {
    if (citation.symbol == null) {
      return settle(citation, 'valid', 'path present at the verified base; citation names no symbol');
    }
    if (local.content == null) {
      return settle(
        citation,
        'unverifiable',
        'file exceeds the citation read bound — cannot check the symbol claim',
      );
    }
    const symbols = await lookups.symbolsFor(citation.path, local.content);
    if (symbols == null) {
      return settle(
        citation,
        'unverifiable',
        `no symbol-capable adapter recognises "${citation.path}" — this language has no symbol support here`,
      );
    }
    const matches = symbols.filter((s) => matchesSymbol(s, citation.symbol as string));
    if (matches.length === 0) {
      return settle(citation, 'changed', `symbol "${citation.symbol}" no longer resolves in this file`);
    }
    if (matches.length > 1) {
      return settle(
        citation,
        'unverifiable',
        `symbol "${citation.symbol}" matches ${matches.length} declarations in this file — ambiguous`,
      );
    }
    return settle(citation, 'valid', 'path and symbol both confirmed at the verified base');
  };

  if (citation.baseId === ctx.worktree.baseId) return symbolVerdict();

  const cb = await lookups.changesBetweenCached(citation.baseId);
  if (!cb.ok) {
    return settle(
      citation,
      'unverifiable',
      `backend could not relate base "${citation.baseId}" to this workspace: ${cb.detail}`,
    );
  }
  if (cb.deleted.includes(citation.path)) {
    return settle(citation, 'missing', `deleted between "${citation.baseId}" and this workspace's base`);
  }
  if (cb.changed.includes(citation.path)) {
    return settle(
      citation,
      'changed',
      `content changed between "${citation.baseId}" and this workspace's base`,
    );
  }
  // Neither list: `ChangesBetweenResult`'s own locked decision 2 — a real, distinct answer,
  // byte-identical between the two bases. Path existence alone still never proves a symbol claim
  // (this task's stated acceptance), so that half runs exactly as it does on the bases-equal path.
  return symbolVerdict();
}

/**
 * Verify every citation in `pack` against `ctx.worktree`, returning a pack shaped identically
 * except that each memory excerpt's evidence carries its own verdict. Run-scoped caching only
 * (locked decision: "cache for THIS run only") — every `Map` here is created fresh inside this
 * call and discarded when it returns; nothing survives to a second invocation, and nothing here
 * makes a network call, spawns a process, or reads outside `ctx.worktree.localPath`.
 *
 * **Decomposed rather than one cache keyed on `(path, baseId)`, and deliberately so.** The locked
 * decision's own reasoning — "two citations can name the same path at different bases and have
 * different answers, so a path-keyed cache would serve one citation's verdict to the other" — is
 * right, but a single cache keyed on the FINISHED verdict at `(path, baseId)` alone reproduces the
 * same bug one field over: two citations can also name the same `(path, baseId)` pair with
 * DIFFERENT `symbol` claims (two memories citing the same file at the same base, about two
 * different declarations in it), and a verdict cache blind to `symbol` would hand one citation's
 * ambiguous-or-valid answer to the other. So the caching happens at the layer BELOW the verdict,
 * where each answer genuinely depends only on the key it is cached under: local file content
 * depends only on `path` (this workspace's tree is fixed for the whole pass); `changesBetween`
 * depends only on the citation's own `baseId` (never on `path` — one call answers for every
 * citation sharing a historical base); parsed symbols depend only on `path` (re-parsing the same
 * file once per citation that cites a different symbol in it would be wasted tree-sitter work).
 * The final per-citation verdict is then always computed fresh from those cached answers, so no
 * two citations can ever collide on a shared cache slot that owes its answer to one of them alone.
 */
export async function verifyContextPack(
  pack: ContextPack,
  ctx: CitationVerifyContext,
): Promise<VerifiedContextPack> {
  const readFile = ctx.readFile ?? readCitationFile;
  const adapters = ctx.adapters ?? defaultAdapterRegistry();

  const fileCache = new Map<string, Promise<CitationFileRead>>();
  const readCached = (relPath: string): Promise<CitationFileRead> => {
    let p = fileCache.get(relPath);
    if (!p) {
      p = readFile(relPath, ctx.worktree.localPath);
      fileCache.set(relPath, p);
    }
    return p;
  };

  const symbolCache = new Map<string, Promise<readonly ParsedSymbol[] | null>>();
  const symbolsFor = (relPath: string, content: string): Promise<readonly ParsedSymbol[] | null> => {
    let p = symbolCache.get(relPath);
    if (!p) {
      p = (async () => {
        const adapter = adapters.select(relPath);
        if (!adapter || adapter.id === NOOP_ADAPTER.id) return null;
        const parsed = await adapter.parse({ path: relPath, content });
        return parsed.symbols;
      })();
      symbolCache.set(relPath, p);
    }
    return p;
  };

  const changesCache = new Map<string, Promise<ChangesBetweenResult>>();
  const changesBetweenCached = (from: string): Promise<ChangesBetweenResult> => {
    let p = changesCache.get(from);
    if (!p) {
      p = ctx.vcs.changesBetween(ctx.repoRoot, from, ctx.worktree.baseId);
      changesCache.set(from, p);
    }
    return p;
  };

  const lookups = { readCached, symbolsFor, changesBetweenCached };

  const verifyExcerpt = async (excerpt: ContextPackExcerpt): Promise<VerifiedContextPackExcerpt> => {
    if (excerpt.excerptKind === 'episode') return excerpt;
    const evidence = await Promise.all(
      excerpt.evidence.map(
        async (citation): Promise<VerifiedCitation> => ({
          ...citation,
          verification: await classifyCitation(citation, ctx, lookups),
        }),
      ),
    );
    return { ...excerpt, evidence };
  };

  const verifySection = async (section: ContextPackSection): Promise<VerifiedContextPackSection> => ({
    ...section,
    excerpts: await Promise.all(section.excerpts.map(verifyExcerpt)),
  });

  return { ...pack, sections: await Promise.all(pack.sections.map(verifySection)) };
}
